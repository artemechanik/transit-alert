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
       fun findBestRoute(fromIds: List<String>, toIds: List<String>, startMin: Int): List<RouteEdge>? {
        if (!isLoaded) return null
        
        val pq = java.util.PriorityQueue<RoutingState>()
        val visited = mutableSetOf<String>()

        // 1. Додали 0.0 для accumulatedPenalty при старті
        for (startId in fromIds) {
            pq.add(RoutingState(startId, startMin, null, emptyList(), 0, 0.0, startMin)) 
        }

        while (pq.isNotEmpty()) {
            val state = pq.poll()

            if (state.stopId in toIds) return state.path

            val stateKey = "${state.stopId}_${state.tripId}"
            if (!visited.add(stateKey)) continue

            val outgoingEdges = edges[state.stopId] ?: emptyList()
            
            for (edge in outgoingEdges) {
                val isWalk = edge.tripId == "WALK"
                val isSameTrip = state.tripId == edge.tripId
                val newLastTransferMin = if (!isSameTrip && state.tripId != null) state.currentMin else state.lastTransferMin
                val newTransfers = if (state.tripId == null || isSameTrip) state.transfers else state.transfers + 1
                
                if (isWalk) {
                    if (state.tripId == "WALK") continue 
                    val arrivalTime = state.currentMin + edge.arrivalMin 
                    val walkLeg = edge.copy(departureMin = state.currentMin, arrivalMin = arrivalTime)
                    val newPath = state.path + walkLeg
                    
                    // Передаємо існуючий state.accumulatedPenalty далі
                    pq.add(RoutingState(edge.toStopId, arrivalTime, "WALK", newPath, newTransfers, state.accumulatedPenalty, newLastTransferMin))
                    
                } else {
                    val transferBuffer = if (state.tripId == null || isSameTrip || state.tripId == "WALK") 0 else 2
                    
                    if (edge.departureMin >= state.currentMin + transferBuffer) {
                        // Перевіряємо, чи ми вже їхали на якомусь автобусі, чи це наш перший транспорт
val hasUsedBus = state.path.any { it.tripId != "WALK" }

// Якщо вже в дорозі (пересадка) - максимум 60 хв. Якщо ще вдома (перший рейс) - дозволяємо чекати хоч 10 годин (600 хв)
val maxWaitTime = if (hasUsedBus) 60 else 600

if (edge.departureMin - state.currentMin > maxWaitTime) continue


                        // --- СМАРТ-ШТРАФИ ---
                        var stepPenalty = 0.0
                        val isRealTransfer = !isSameTrip && state.tripId != null
			val transferBuffer = if (state.tripId == null || isSameTrip) 0 else 2
                        if (isRealTransfer) {
                            stepPenalty += 5.0 // Базовий штраф в 5 хвилин надійно вбиває "мікро-стрибки" на 1 зупинку
                            
                            val waitTime = edge.departureMin - state.currentMin
                            if (waitTime > 10) {
                                stepPenalty += (waitTime - 10) * 1.5 // Прогресивно караємо за довге стояння
                            }
                        }
                        
                        val newPenalty = state.accumulatedPenalty + stepPenalty
                        val newPath = state.path + edge
                        
                        pq.add(RoutingState(edge.toStopId, edge.arrivalMin, edge.tripId, newPath, newTransfers, newPenalty, newLastTransferMin))
                    }
                }
            }
        }
        return null
    }

}
