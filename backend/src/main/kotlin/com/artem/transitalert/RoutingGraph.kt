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
        val thisCost = this.currentMin + this.accumulatedPenalty
        val otherCost = other.currentMin + other.accumulatedPenalty
        
        if (thisCost != otherCost) return thisCost.compareTo(otherCost)
        return this.lastTransferMin.compareTo(other.lastTransferMin)
    }
}

object TransitGraph {
    private val logger = LoggerFactory.getLogger("TransitGraph")

    @Volatile var edges: Map<String, List<RouteEdge>> = emptyMap() // <-- ПОВЕРНУЛИ!
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
                    buildGraph() // <-- ВИПРАВЛЕНО
                } catch (e: Exception) {
                    logger.error("❌ Помилка нічного оновлення графа: ${e.message}")
                }
            }
        }
    }

   fun buildGraph() {
        transaction {
            val newDailyServices = mutableMapOf<LocalDate, MutableSet<String>>()
            // Твій старий механізм отримання сервісів:
            val today = LocalDate.now(LUBLIN_ZONE)
            // Завантажимо вікно дат (наприклад, від вчора до +7 днів), 
            // щоб алгоритм мав з чим працювати.
            for (i in -1..7L) {
                val d = today.plusDays(i)
                newDailyServices[d] = activeServiceIds(d).toMutableSet()
            }
            dailyServices = newDailyServices 

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

            val newEdges = mutableMapOf<String, MutableList<RouteEdge>>()
            for ((tripId, stops) in tripsData) {
                stops.sortBy { it.seq }
                val routeInfo = validTrips[tripId] ?: continue 
                
                for (i in 0 until stops.size - 1) {
                    val current = stops[i]
                    val next = stops[i + 1]
                    
                    val edge = RouteEdge(
                        fromStopId = current.stopId,
                        toStopId = next.stopId,
                        route = routeInfo.first,
                        tripId = tripId,
                        serviceId = routeInfo.second, 
                        departureMin = current.min,
                        arrivalMin = next.min,
                        stopSequence = current.seq
                    )
                    newEdges.getOrPut(current.stopId) { mutableListOf() }.add(edge)
                }
            }

            val allStops = Stops.selectAll().map { 
                Triple(it[Stops.stopId], it[Stops.lat], it[Stops.lon]) 
            }
            
            activeStops = allStops.map { StopCoords(it.first, it.second, it.third) }
            
            for (s1 in allStops) {
                for (s2 in allStops) {
                    if (s1.first == s2.first) continue 
                    if (abs(s1.second - s2.second) > 0.006) continue
                    if (abs(s1.third - s2.third) > 0.010) continue 

                    val dist = calculateDistance(s1.second, s1.third, s2.second, s2.third)
                    if (dist <= 600.0) { 
                        val walkMinutes = (dist / 60.0).toInt().coerceAtLeast(1)
                        val walkEdge = RouteEdge(
                            fromStopId = s1.first,
                            toStopId = s2.first,
                            route = "Пішки",
                            tripId = "WALK",
                            serviceId = "WALK",
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
            logger.info("Граф побудовано! Вузлів: ${edges.size}, Зв'язків: ${edges.values.sumOf { it.size }}")
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
        val yesterdayServices = dailyServices[searchDate.minusDays(1)] ?: emptySet()
        val todayServices = dailyServices[searchDate] ?: emptySet()
        val tomorrowServices = dailyServices[searchDate.plusDays(1)] ?: emptySet()
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

        // ПОВЕРНУЛИ ОСНОВНИЙ ЦИКЛ!
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

            val outgoingEdges = edges[state.stopId] ?: emptyList()
            
            for (edge in outgoingEdges) {
                val isWalk = edge.tripId == "WALK"
                
                var absDepMin = edge.departureMin
                var absArrMin = edge.arrivalMin

                if (!isWalk) {
                    val isValidYesterday = yesterdayServices.contains(edge.serviceId)
                    val isValidToday = todayServices.contains(edge.serviceId)
                    val isValidTomorrow = tomorrowServices.contains(edge.serviceId)

                    var foundValidTime = false

                    if (isValidYesterday) {
                        val candidateDep = edge.departureMin - 1440 
                        if (candidateDep >= state.currentMin) {
                            absDepMin = candidateDep
                            absArrMin = edge.arrivalMin - 1440
                            foundValidTime = true
                        }
                    }
                    
                    if (!foundValidTime && isValidToday) {
                        val candidateDep = edge.departureMin 
                        if (candidateDep >= state.currentMin) {
                            absDepMin = candidateDep
                            absArrMin = edge.arrivalMin
                            foundValidTime = true
                        }
                    }
                    
                    if (!foundValidTime && isValidTomorrow) {
                        val candidateDep = edge.departureMin + 1440 
                        if (candidateDep >= state.currentMin) {
                            absDepMin = candidateDep
                            absArrMin = edge.arrivalMin + 1440
                            foundValidTime = true
                        }
                    }

                    if (!foundValidTime) continue
                }
                
                val isSameTrip = state.tripId == edge.tripId
                val newLastTransferMin = if (!isSameTrip && state.tripId != null) state.currentMin else state.lastTransferMin
                val newTransfers = if (state.tripId == null || isSameTrip) state.transfers else state.transfers + 1
                val hasUsedBus = state.path.any { it.tripId != "WALK" && it.tripId != "START_COORD" }

                if (isWalk) {
                    if (state.tripId == "WALK") continue 
                    val arrivalTime = state.currentMin + absArrMin 
                    val walkLeg = edge.copy(departureMin = state.currentMin, arrivalMin = arrivalTime)
                    val newPath = state.path + walkLeg
                    
                    var stepPenalty = 0.0
                    if (hasUsedBus) stepPenalty += edge.arrivalMin * 1.5 else stepPenalty += edge.arrivalMin * 1.0 
                    
                    val newPenalty = state.accumulatedPenalty + stepPenalty
                    pq.add(RoutingState(edge.toStopId, arrivalTime, "WALK", newPath, newTransfers, newPenalty, newLastTransferMin))
                    
                } else {
                    if (absDepMin >= state.currentMin) {
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
                            val initialWait = absDepMin - state.currentMin
                            stepPenalty += (initialWait * 0.3).coerceAtMost(12.0)
                        }
                        
                        val travelTime = absArrMin - absDepMin
                        stepPenalty += travelTime * 0.3
                        
                        val newPenalty = state.accumulatedPenalty + stepPenalty
                        val adjustedEdge = edge.copy(departureMin = absDepMin, arrivalMin = absArrMin)
                        val newPath = state.path + adjustedEdge
                        
                        pq.add(RoutingState(edge.toStopId, absArrMin, edge.tripId, newPath, newTransfers, newPenalty, newLastTransferMin))
                    }
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
