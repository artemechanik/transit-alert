package com.artem.transitalert

import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.LocalDate
import kotlin.math.abs
import kotlinx.coroutines.*
import org.slf4j.LoggerFactory

// Це "ребро" нашого графа - фізичний переїзд від однієї зупинки до наступної
data class RouteEdge(
    val fromStopId: String,     // Звідки їдемо
    val toStopId: String,       // Куди їдемо
    val route: String,          // Номер маршруту
    val tripId: String,         // Конкретний рейс
    val departureMin: Int,      // Час відправлення з поточної зупинки
    val arrivalMin: Int,        // Час прибуття на наступну
    val stopSequence: Int       // Порядковий номер зупинки
)

// Допоміжний клас для тимчасового зберігання зупинок рейсу під час завантаження
data class TripStopRecord(
    val stopId: String,
    val seq: Int,
    val min: Int
)
// Кеш координат зупинки для A-to-B маршрутизації
data class StopCoords(
    val id: String,
    val lat: Double,
    val lon: Double
)
// Стан нашого віртуального "пасажира" під час пошуку
data class RoutingState(
    val stopId: String,
    val currentMin: Int,
    val tripId: String?,
    val path: List<RouteEdge>,
    val transfers: Int,
    val accumulatedPenalty: Double = 0.0, // <-- Додали це поле
    val lastTransferMin: Int
) : Comparable<RoutingState> {
    
    override fun compareTo(other: RoutingState): Int {
        val thisCost = this.currentMin + this.accumulatedPenalty
        val otherCost = other.currentMin + other.accumulatedPenalty
        
        if (thisCost != otherCost) {
            return thisCost.compareTo(otherCost)
        }
        
        return this.lastTransferMin.compareTo(other.lastTransferMin)
    }
}

// Наш головний кеш-граф, який житиме в оперативній пам'яті сервера
object TransitGraph {
	private val logger = LoggerFactory.getLogger("TransitGraph")
// ДОДАЄМО @Volatile до обох змінних:
    @Volatile var edges: Map<String, List<RouteEdge>> = emptyMap()
    @Volatile var isLoaded = false
    @Volatile var activeStops: List<StopCoords> = emptyList()
    // Фоновий процес для нічного оновлення
    fun startNightlyRebuild() {
        CoroutineScope(Dispatchers.IO).launch {
            while (true) {
                val now = java.time.LocalDateTime.now(LUBLIN_ZONE)
                var nextRun = now.withHour(3).withMinute(0).withSecond(0).withNano(0)
                
                if (now.isAfter(nextRun) || now.isEqual(nextRun)) {
                    nextRun = nextRun.plusDays(1)
                }
                
                val delayMs = java.time.Duration.between(now, nextRun).toMillis()
                
                logger.info("🌙 Наступне оновлення графа заплановано на $nextRun")
                delay(delayMs) // <--- Без довгого префіксу
                
                try {
                    logger.info("🔄 Починаємо нічне оновлення графа...")
                    buildGraphForToday()
                } catch (e: Exception) {
                    logger.error("❌ Помилка нічного оновлення графа: ${e.message}")
                }
            }
        }
    }

   fun buildGraphForToday() {
        val today = java.time.LocalDate.now(LUBLIN_ZONE)
        
        transaction {
            // РОЗДІЛЯЄМО СЬОГОДНІ І ВЧОРА (щоб відсіяти привидів)
            val todayServices = activeServiceIds(today).toSet()
            // Беремо вчорашні сервіси, але віднімаємо ті, що діють і сьогодні, щоб не робити зайву роботу
            val yesterdayServices = activeServiceIds(today.minusDays(1)).toSet() - todayServices
            
            if (todayServices.isEmpty() && yesterdayServices.isEmpty()) {
                println("Немає активних сервісів на сьогодні, граф не побудовано.")
                return@transaction
            }

            // 1. БЕРЕМО ТІЛЬКИ УНІКАЛЬНІ РЕЙСИ
            val validTrips = mutableMapOf<String, String>()
            val yesterdayTripIds = mutableSetOf<String>() // Тут будуть лежати підозрювані "вчорашні" рейси

            // Додаємо сьогоднішні рейси
            if (todayServices.isNotEmpty()) {
                StopDepartures
                    .select(StopDepartures.tripId, StopDepartures.route)
                    .where { StopDepartures.serviceId inList todayServices }
                    .withDistinct(true)
                    .forEach { 
                        validTrips[it[StopDepartures.tripId]] = it[StopDepartures.route] 
                    }
            }

            // Додаємо вчорашні рейси (і помічаємо їх)
            if (yesterdayServices.isNotEmpty()) {
                StopDepartures
                    .select(StopDepartures.tripId, StopDepartures.route)
                    .where { StopDepartures.serviceId inList yesterdayServices }
                    .withDistinct(true)
                    .forEach { 
                        val tId = it[StopDepartures.tripId]
                        validTrips[tId] = it[StopDepartures.route]
                        yesterdayTripIds.add(tId) // ПОМІТКА: цей рейс з минулого
                    }
            }

            val allTripIds = validTrips.keys.toList()
            val tripsData = mutableMapOf<String, MutableList<TripStopRecord>>()

            // 2. CHUNKING (Завантажуємо безпечними порціями по 500 рейсів)
            allTripIds.chunked(500).forEach { chunk ->
                TripStops
                    .select(TripStops.tripId, TripStops.stopId, TripStops.stopSequence, TripStops.departureMinutes)
                    .where { TripStops.tripId inList chunk }
                    .forEach { row ->
                        val tripId = row[TripStops.tripId]
                        val depMin = row[TripStops.departureMinutes]

                        // ==========================================
                        // ФІЛЬТР "ПРИВИДІВ" (Ghost Trips Filter)
                        // Якщо рейс вчорашній, і час МЕНШЕ 24:00 (1440 хв) - це денний привид, викидаємо!
                        if (yesterdayTripIds.contains(tripId) && depMin < 1440) {
                            return@forEach 
                        }
                        // ==========================================

                        tripsData.getOrPut(tripId) { mutableListOf() }.add(
                            TripStopRecord(
                                stopId = row[TripStops.stopId],
                                seq = row[TripStops.stopSequence],
                                min = depMin
                            )
                        )
                    }
            }

            // 3. Зв'язуємо автобусні зупинки
            val newEdges = mutableMapOf<String, MutableList<RouteEdge>>()
            for ((tripId, stops) in tripsData) {
                stops.sortBy { it.seq }
                val route = validTrips[tripId] ?: continue // Замінив todayTrips на validTrips
                
                for (i in 0 until stops.size - 1) {
                    val current = stops[i]
                    val next = stops[i + 1]
                    
                    val edge = RouteEdge(
                        fromStopId = current.stopId,
                        toStopId = next.stopId,
                        route = route,
                        tripId = tripId,
                        departureMin = current.min,
                        arrivalMin = next.min,
                        stopSequence = current.seq
                    )
                    newEdges.getOrPut(current.stopId) { mutableListOf() }.add(edge)
                }
            }

            // 4. ДОДАЄМО ПІШІ ПЕРЕХОДИ З ГЕОМЕТРИЧНИМ ФІЛЬТРОМ
            val allStops = Stops.selectAll().map { 
                Triple(it[Stops.stopId], it[Stops.lat], it[Stops.lon]) 
            }
            
            activeStops = allStops.map { StopCoords(it.first, it.second, it.third) }
            
            for (s1 in allStops) {
                for (s2 in allStops) {
                    if (s1.first == s2.first) continue 
                    
                    if (kotlin.math.abs(s1.second - s2.second) > 0.006) continue
                    if (kotlin.math.abs(s1.third - s2.third) > 0.010) continue 

                    val dist = calculateDistance(s1.second, s1.third, s2.second, s2.third)
                    if (dist <= 600.0) { 
                        val walkMinutes = (dist / 60.0).toInt().coerceAtLeast(1)
                        
                        val walkEdge = RouteEdge(
                            fromStopId = s1.first,
                            toStopId = s2.first,
                            route = "Пішки",
                            tripId = "WALK",
                            departureMin = 0,
                            arrivalMin = walkMinutes,
                            stopSequence = 0
                        )
                        newEdges.getOrPut(s1.first) { mutableListOf() }.add(walkEdge)
                    }
                }
            }
            
            edges = newEdges
            isLoaded = true
            println("Граф побудовано! Вузлів: ${edges.size}, Зв'язків: ${edges.values.sumOf { it.size }}")
        }
    }
              //======Функція пошуку
     fun findBestRoute(
        starts: List<Pair<String, Int>>, 
        targets: Map<String, Int>,       
        startMin: Int
    ): List<RouteEdge>? {
        if (!isLoaded) return null
        
        val pq = java.util.PriorityQueue<RoutingState>()
        val visited = mutableSetOf<String>()

        // 1. Старт (твій код + підтримка часу пішки від GPS)
        for ((startId, walkMins) in starts) {
            val arrivalTime = startMin + walkMins
            val initialPath = if (walkMins > 0) {
                listOf(RouteEdge("START_COORD", startId, "Пішки", "WALK", startMin, arrivalTime, 0))
            } else emptyList()
            
            // "Людський" штраф: до 8 хв - вважаємо звичайним часом, далі - жорстко множимо на 5
            val initialPenalty = if (walkMins <= 8) {
                walkMins * 1.0 
            } else {
                8.0 + (walkMins - 8) * 5.0 
            }
            
            pq.add(RoutingState(startId, arrivalTime, if (walkMins > 0) "WALK" else null, initialPath, 0, initialPenalty, arrivalTime)) 
        }

        while (pq.isNotEmpty()) {
            val state = pq.poll()

            // 2. ФІНІШ (Оновлена логіка: завершуємо тільки якщо РЕАЛЬНО дійшли до фінішу)
            if (state.stopId == "FINISH_COORD") {
                return state.path
            }
            
            // Якщо ми шукали конкретну зупинку (класичний пошук без координат)
            if (targets.containsKey(state.stopId) && targets[state.stopId] == 0) {
                return state.path
            }

            val stateKey = "${state.stopId}_${state.tripId}"
            if (!visited.add(stateKey)) continue

            // --- Віртуальний перехід до координати ---
            // Якщо від цієї зупинки можна дійти до фінішу, ми НЕ зупиняємо пошук!
            // Ми додаємо фінальну прогулянку в загальну чергу, щоб вона отримала свій штраф.
                        val finalWalkMins = targets[state.stopId]
            if (finalWalkMins != null && finalWalkMins > 0) {
                val finalArrivalTime = state.currentMin + finalWalkMins
                val finalEdge = RouteEdge(state.stopId, "FINISH_COORD", "Пішки", "WALK", state.currentMin, finalArrivalTime, 0)
                
                // РЯТУЄМО ФІНІШ: Значно м'якший штраф!
                // До 10 хвилин йдемо взагалі без штрафу, далі - легка прогресія (x1.5 замість x5.0)
                val stepPenalty = if (finalWalkMins <= 10) {
                    finalWalkMins * 0.5 
                } else {
                    5.0 + (finalWalkMins - 10) * 1.5
                }
                val newPenalty = state.accumulatedPenalty + stepPenalty
                
                pq.add(RoutingState("FINISH_COORD", finalArrivalTime, "WALK", state.path + finalEdge, state.transfers, newPenalty, state.lastTransferMin))
            }


            val outgoingEdges = edges[state.stopId] ?: emptyList()
            
            // 3. Твоя оригінальна логіка циклу (БЕЗ моїх експериментів)
            for (edge in outgoingEdges) {
                val isWalk = edge.tripId == "WALK"
                val isSameTrip = state.tripId == edge.tripId
                val newLastTransferMin = if (!isSameTrip && state.tripId != null) state.currentMin else state.lastTransferMin
                val newTransfers = if (state.tripId == null || isSameTrip) state.transfers else state.transfers + 1
                
                // ГЛОБАЛЬНИЙ СТАТУС: чи ми вже сідали сьогодні в будь-який транспорт?
                val hasUsedBus = state.path.any { it.tripId != "WALK" && it.tripId != "START_COORD" }

                                if (isWalk) {
                    if (state.tripId == "WALK") continue 
                    val arrivalTime = state.currentMin + edge.arrivalMin 
                    val walkLeg = edge.copy(departureMin = state.currentMin, arrivalMin = arrivalTime)
                    val newPath = state.path + walkLeg
                    
                    var stepPenalty = 0.0
                    // ПРИБИРАЄМО ПОДВІЙНЕ ПОКАРАННЯ ЗА ХОДЬБУ
                    if (hasUsedBus) {
                        // Якщо це пересадка, просто рахуємо час пішки x1.5 (без шалених +5.0)
                        stepPenalty += edge.arrivalMin * 1.5 
                    } else {
                        // Йти на першу зупинку - звичайна справа
                        stepPenalty += edge.arrivalMin * 1.0 
                    }
                    
                    val newPenalty = state.accumulatedPenalty + stepPenalty
                    pq.add(RoutingState(edge.toStopId, arrivalTime, "WALK", newPath, newTransfers, newPenalty, newLastTransferMin))
                    
               } else {

                    // Пересадка миттєва: якщо приїхав о 14:00, можеш сісти на рейс о 14:00
                    val transferBuffer = 0 
                    
                    if (edge.departureMin >= state.currentMin + transferBuffer) {
                        val maxWaitTime = if (hasUsedBus) 60 else 600
                        if (edge.departureMin - state.currentMin > maxWaitTime) continue

                        var stepPenalty = 0.0
                        
                        // ЗАКРИТА ЛАЗІВКА: Справжня пересадка - це якщо ми не на тому ж рейсі, і ВЖЕ їздили раніше!
                        // (Неважливо, прийшли ми на цю зупинку пішки чи приїхали)
                                               // ЗАКРИТА ЛАЗІВКА: Справжня пересадка
                        val isRealTransfer = !isSameTrip && hasUsedBus
                        
                        if (isRealTransfer) {
                            // ЛОГІКА КІНЦЕВОЇ: Якщо ми сідаємо на той самий номер маршруту (напр. 14 -> 14), 
                            // це розворот на кінцевій. Робимо знижку на штраф!
                            val lastBusRoute = state.path.lastOrNull { it.tripId != "WALK" && it.tripId != "START_COORD" }?.route
                            val isSameRouteName = (lastBusRoute == edge.route)
                            
                            stepPenalty += if (isSameRouteName) 1.5 else 5.0 
                            
                            val waitTime = edge.departureMin - state.currentMin
                            if (waitTime > 10) {
                                stepPenalty += ((waitTime - 10) * 1.0).coerceAtMost(15.0)
                            }
                        } else if (!hasUsedBus) {

                            // МІКРО-ШТРАФ за очікування першого автобуса (0.1 бала за хвилину).
                            // Це змушує Дейкстру при рівних умовах сортувати ранні виїзди першими, 
                            // щоб цикл мультипошуку їх не пропустив!
                            val initialWait = edge.departureMin - state.currentMin
                            stepPenalty += initialWait * 0.3
                        }
                        // --- ФІКС ДЛЯ ПЕРШОЇ СПІЛЬНОЇ ЗУПИНКИ ---
                        // Легкий "податок" на час у дорозі (0.3 бала за хвилину).
                        // Змушує алгоритм уникати зайвих катань і виходити раніше.
                        val travelTime = edge.arrivalMin - edge.departureMin
                        stepPenalty += travelTime * 0.3
                        
                        val newPenalty = state.accumulatedPenalty + stepPenalty
                        val newPath = state.path + edge
                        
                        pq.add(RoutingState(edge.toStopId, edge.arrivalMin, edge.tripId, newPath, newTransfers, newPenalty, newLastTransferMin))
                    }
                }
            }
        }
        return null
    }
    // Функція шукає зупинки навколо будь-якої координати і рахує час пішки (хвилини)
    fun getNearbyStopsWalkTimes(lat: Double, lon: Double, maxRadiusMeters: Double = 800.0): List<Pair<String, Int>> {
        val result = mutableListOf<Pair<String, Int>>()
        
        for (stop in activeStops) {
            // Використовуємо твою існуючу функцію calculateDistance
            val dist = calculateDistance(lat, lon, stop.lat, stop.lon)
            
            if (dist <= maxRadiusMeters) {
                // Рахуємо хвилини (швидкість людини ~ 80 метрів на хвилину)
                val walkMinutes = (dist / 80.0).toInt().coerceAtLeast(1)
                result.add(Pair(stop.id, walkMinutes))
            }
        }
        return result
    }

}
