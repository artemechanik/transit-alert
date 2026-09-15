package com.artem.transitalert

import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.LocalDate
import java.time.LocalDateTime
import kotlin.math.abs
import kotlinx.coroutines.*
import org.slf4j.LoggerFactory

data class RouteEdge(
    val fromStopId: String,     
    val toStopId: String,       
    val route: String,          
    val tripId: String,         
    val serviceId: String,      
    val departureMin: Int,      
    val arrivalMin: Int,        
    val stopSequence: Int       
)

data class TripStopRecord(
    val stopId: String,
    val seq: Int,
    val min: Int
)

data class StopCoords(
    val id: String,
    val lat: Double,
    val lon: Double
)

data class RoutingState(
    val stopId: String,
    val currentMin: Int,
    val tripId: String?,
    val path: List<RouteEdge>,
    val transfers: Int,
    val accumulatedPenalty: Double = 0.0, 
    val lastTransferMin: Int
) : Comparable<RoutingState> {
    override fun compareTo(other: RoutingState): Int {
        // Віртуальний час прибуття: +1 хвилина за кожну пересадку.
        // Пересадка виграє ТІЛЬКИ якщо економить реальні 2+ хвилини.
        // Якщо економія лише 1 хвилина — нічия, і прямий рейс перемагає.
        val thisScore = this.currentMin + this.transfers
        val otherScore = other.currentMin + other.transfers
        
        if (thisScore != otherScore) {
            return thisScore.compareTo(otherScore)
        }
        
        // Тай-брейк: якщо час однаковий, перемагає комфортніший маршрут
        if (this.accumulatedPenalty != other.accumulatedPenalty) {
            return this.accumulatedPenalty.compareTo(other.accumulatedPenalty)
        }
        
        return this.lastTransferMin.compareTo(other.lastTransferMin)
    }
}

object TransitGraph {
    private val logger = LoggerFactory.getLogger("TransitGraph")

    // НОВА АРХІТЕКТУРА: Окремий підготовлений граф для кожної дати
    @Volatile var edgesByDate: Map<LocalDate, Map<String, List<RouteEdge>>> = emptyMap()
    @Volatile var dailyServices: Map<LocalDate, Set<String>> = emptyMap()
    @Volatile var isLoaded = false
    @Volatile var activeStops: List<StopCoords> = emptyList()

    fun startNightlyRebuild() {
        CoroutineScope(Dispatchers.IO).launch {
            while (true) {
                val now = LocalDateTime.now(LUBLIN_ZONE)
                var nextRun = now.withHour(3).withMinute(0).withSecond(0).withNano(0)
                
                if (now.isAfter(nextRun) || now.isEqual(nextRun)) {
                    nextRun = nextRun.plusDays(1)
                }
                
                val delayMs = java.time.Duration.between(now, nextRun).toMillis()
                
                logger.info("🌙 Наступне оновлення графа заплановано на $nextRun")
                delay(delayMs) 
                
                try {
                    logger.info("🔄 Починаємо нічне оновлення графа...")
                    buildGraph()
                } catch (e: Exception) {
                    logger.error("❌ Помилка нічного оновлення графа: ${e.message}")
                }
            }
        }
    }

   fun buildGraph() {
        transaction {
            val baseToday = LocalDate.now(LUBLIN_ZONE)
            val servicesCache = mutableMapOf<LocalDate, Set<String>>()
            
            // Кешуємо сервіси з запасом (від -2 до +8 днів) для безпечної вибірки
            for (i in -2L..8L) {
                servicesCache[baseToday.plusDays(i)] = activeServiceIds(baseToday.plusDays(i)).toSet()
            }
            dailyServices = servicesCache

            val tripsData = mutableMapOf<String, MutableList<TripStopRecord>>()
            val validTrips = mutableMapOf<String, Pair<String, String>>() 

            StopDepartures
                .select(StopDepartures.tripId, StopDepartures.route, StopDepartures.serviceId) 
                .withDistinct(true)
                .forEach { 
                    validTrips[it[StopDepartures.tripId]] = Pair(it[StopDepartures.route], it[StopDepartures.serviceId])
                }

            val allTripIds = validTrips.keys.toList()

            allTripIds.chunked(500).forEach { chunk ->
                TripStops
                    .select(TripStops.tripId, TripStops.stopId, TripStops.stopSequence, TripStops.departureMinutes)
                    .where { TripStops.tripId inList chunk }
                    .forEach { row ->
                        tripsData.getOrPut(row[TripStops.tripId]) { mutableListOf() }.add(
                            TripStopRecord(
                                stopId = row[TripStops.stopId],
                                seq = row[TripStops.stopSequence],
                                min = row[TripStops.departureMinutes]
                            )
                        )
                    }
            }

            val allStops = Stops.selectAll().map { 
                Triple(it[Stops.stopId], it[Stops.lat], it[Stops.lon]) 
            }
            activeStops = allStops.map { StopCoords(it.first, it.second, it.third) }

            val newEdgesByDate = mutableMapOf<LocalDate, MutableMap<String, MutableList<RouteEdge>>>()

            // БУДУЄМО ГРАФИ ПО ДАТАХ (від вчора до +7 днів)
            for (i in -1L..7L) {
                val targetDate = baseToday.plusDays(i)
                val prevServices = servicesCache[targetDate.minusDays(1)] ?: emptySet()
                val currentServices = servicesCache[targetDate] ?: emptySet()
                val nextServices = servicesCache[targetDate.plusDays(1)] ?: emptySet()
                
                val dailyEdges = mutableMapOf<String, MutableList<RouteEdge>>()
                
                // 1. Піші ребра (однакові для всіх днів)
                for (s1 in allStops) {
                    for (s2 in allStops) {
                        if (s1.first == s2.first) continue 
                        if (abs(s1.second - s2.second) > 0.006) continue
                        if (abs(s1.third - s2.third) > 0.010) continue 

                        val dist = calculateDistance(s1.second, s1.third, s2.second, s2.third)
                        if (dist <= 600.0) { 
                            val walkMinutes = (dist / 60.0).toInt().coerceAtLeast(1)
                            val walkEdge = RouteEdge(
                                fromStopId = s1.first, toStopId = s2.first,
                                route = "Пішки", tripId = "WALK", serviceId = "WALK",
                                departureMin = 0, arrivalMin = walkMinutes, stopSequence = 0
                            )
                            dailyEdges.getOrPut(s1.first) { mutableListOf() }.add(walkEdge)
                        }
                    }
                }

                // 2. Автобусні ребра з нарізаними часовими зсувами
                for ((tripId, stops) in tripsData) {
                    stops.sortBy { it.seq }
                    val routeInfo = validTrips[tripId] ?: continue 
                    val serviceId = routeInfo.second
                    
                    val isPrev = prevServices.contains(serviceId)
                    val isCurrent = currentServices.contains(serviceId)
                    val isNext = nextServices.contains(serviceId)
                    
                    if (!isPrev && !isCurrent && !isNext) continue
                    
                    for (j in 0 until stops.size - 1) {
                        val current = stops[j]
                        val next = stops[j + 1]
                        
                        val baseEdge = RouteEdge(
                            fromStopId = current.stopId, toStopId = next.stopId,
                            route = routeInfo.first, tripId = tripId, serviceId = serviceId, 
                            departureMin = current.min, arrivalMin = next.min, stopSequence = current.seq
                        )

                        // А) Нічний хвіст з учора (-1440 хв)
                        if (isPrev && current.min >= 1440) {
                            dailyEdges.getOrPut(current.stopId) { mutableListOf() }.add(
                                baseEdge.copy(departureMin = current.min - 1440, arrivalMin = next.min - 1440)
                            )
                        }
                        
                        // Б) Сьогоднішній розклад (як є)
                        if (isCurrent) {
                            dailyEdges.getOrPut(current.stopId) { mutableListOf() }.add(baseEdge)
                        }
                        
                        // В) Ранок завтра (+1440 хв, до 5:00)
                        if (isNext && current.min < 720) {
                            dailyEdges.getOrPut(current.stopId) { mutableListOf() }.add(
                                baseEdge.copy(departureMin = current.min + 1440, arrivalMin = next.min + 1440)
                            )
                        }
                    }
                }
                newEdgesByDate[targetDate] = dailyEdges
            }
            
            edgesByDate = newEdgesByDate
            isLoaded = true
            logger.info("Графи по днях побудовано! Кеш тримає ${edgesByDate.size} днів.")
        }
    }

    fun findBestRoute(
        starts: List<Pair<String, Int>>, 
        targets: Map<String, Int>,       
        searchTime: LocalDateTime 
    ): List<RouteEdge>? {
        if (!isLoaded) return null
        
        val searchDate = searchTime.toLocalDate()
        val startMin = searchTime.hour * 60 + searchTime.minute
        
        // БЕРЕМО ГОТОВИЙ ГРАФ САМЕ НА ПОТРІБНУ ДАТУ
        val currentEdges = edgesByDate[searchDate] ?: return null
        
        val pq = java.util.PriorityQueue<RoutingState>()
        val visited = mutableSetOf<String>()

        for ((startId, walkMins) in starts) {
            val arrivalTime = startMin + walkMins
            val initialPath = if (walkMins > 0) {
                listOf(RouteEdge("START_COORD", startId, "Пішки", "WALK", "WALK", startMin, arrivalTime, 0))
            } else emptyList()
            
            val initialPenalty = if (walkMins <= 8) walkMins * 1.0 else 8.0 + (walkMins - 8) * 5.0 
            pq.add(RoutingState(startId, arrivalTime, if (walkMins > 0) "WALK" else null, initialPath, 0, initialPenalty, arrivalTime)) 
        }

        while (pq.isNotEmpty()) {
            val state = pq.poll()

            if (state.stopId == "FINISH_COORD") return state.path
            if (targets.containsKey(state.stopId) && targets[state.stopId] == 0) return state.path

            val stateKey = "${state.stopId}_${state.tripId}"
            if (!visited.add(stateKey)) continue

            val finalWalkMins = targets[state.stopId]
            if (finalWalkMins != null && finalWalkMins > 0) {
                val finalArrivalTime = state.currentMin + finalWalkMins
                val finalEdge = RouteEdge(state.stopId, "FINISH_COORD", "Пішки", "WALK", "WALK", state.currentMin, finalArrivalTime, 0)
                
                val stepPenalty = if (finalWalkMins <= 10) finalWalkMins * 0.5 else 5.0 + (finalWalkMins - 10) * 1.5
                val newPenalty = state.accumulatedPenalty + stepPenalty
                
                pq.add(RoutingState("FINISH_COORD", finalArrivalTime, "WALK", state.path + finalEdge, state.transfers, newPenalty, state.lastTransferMin))
            }

            val outgoingEdges = currentEdges[state.stopId] ?: emptyList()
            
            for (edge in outgoingEdges) {
                val isWalk = edge.tripId == "WALK"
                
                // ШВИДКІСНИЙ ФІЛЬТР: якщо автобус відправився в минулому — одразу відкидаємо
                if (!isWalk && edge.departureMin < state.currentMin) continue

                val absDepMin = if (isWalk) state.currentMin else edge.departureMin
                val absArrMin = if (isWalk) state.currentMin + edge.arrivalMin else edge.arrivalMin

                val isSameTrip = state.tripId == edge.tripId
                val newLastTransferMin = if (!isSameTrip && state.tripId != null) state.currentMin else state.lastTransferMin
                val newTransfers = if (state.tripId == null || isSameTrip) state.transfers else state.transfers + 1
                if (newTransfers > 2) continue
                val hasUsedBus = state.path.any { it.tripId != "WALK" && it.tripId != "START_COORD" }

                if (isWalk) {
                    if (state.tripId == "WALK") continue 
                    val walkLeg = edge.copy(departureMin = absDepMin, arrivalMin = absArrMin)
                    val newPath = state.path + walkLeg
                    
                    var stepPenalty = 0.0
                    if (hasUsedBus) stepPenalty += edge.arrivalMin * 1.5 else stepPenalty += edge.arrivalMin * 1.0 
                    
                    val newPenalty = state.accumulatedPenalty + stepPenalty
                    pq.add(RoutingState(edge.toStopId, absArrMin, "WALK", newPath, newTransfers, newPenalty, newLastTransferMin))
                    
                } else {
                    val maxWaitTime = if (hasUsedBus) 60 else 600
                    if (absDepMin - state.currentMin > maxWaitTime) continue

                    var stepPenalty = 0.0
                    val isRealTransfer = !isSameTrip && hasUsedBus
                    
                    if (isRealTransfer) {
                        val lastBusRoute = state.path.lastOrNull { it.tripId != "WALK" && it.tripId != "START_COORD" }?.route
                        val isSameRouteName = (lastBusRoute == edge.route)
                        
                        stepPenalty += if (isSameRouteName) 1.5 else 5.0 
                        val waitTime = absDepMin - state.currentMin
                        if (waitTime > 10) {
                            stepPenalty += ((waitTime - 10) * 1.0).coerceAtMost(15.0)
                        }
                    } else if (!hasUsedBus) {
                        // Перший автобус у поїздці — не штрафуємо за очікування
                        stepPenalty += 0.0
                    }
                    
                    val travelTime = absArrMin - absDepMin
                    stepPenalty += travelTime * 0.3
                    
                    val newPenalty = state.accumulatedPenalty + stepPenalty
                    val newPath = state.path + edge // Ребро вже має готові, зміщені departureMin/arrivalMin
                    
                    pq.add(RoutingState(edge.toStopId, absArrMin, edge.tripId, newPath, newTransfers, newPenalty, newLastTransferMin))
                }
            }
        }
        return null
    }

    fun getNearbyStopsWalkTimes(lat: Double, lon: Double, maxRadiusMeters: Double = 800.0): List<Pair<String, Int>> {
        val result = mutableListOf<Pair<String, Int>>()
        for (stop in activeStops) {
            val dist = calculateDistance(lat, lon, stop.lat, stop.lon)
            if (dist <= maxRadiusMeters) {
                val walkMinutes = (dist / 80.0).toInt().coerceAtLeast(1)
                result.add(Pair(stop.id, walkMinutes))
            }
        }
        return result
    }
}
