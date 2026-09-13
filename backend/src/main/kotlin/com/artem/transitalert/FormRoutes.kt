package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.inList
import org.jetbrains.exposed.sql.SqlExpressionBuilder.lessEq
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime // <-- Додали цей імпорт

// Вікно, в якому шукаємо "актуальні зараз" напрямки лінії.
private const val DIRECTIONS_WINDOW_MINUTES = 90

fun String.normalizePL(): String {
    return this.lowercase()
        .replace("ą", "a").replace("ć", "c").replace("ę", "e")
        .replace("ł", "l").replace("ń", "n").replace("ó", "o")
        .replace("ś", "s").replace("ź", "z").replace("ż", "z")
}

var cachedStops: List<StopSuggestion>? = null

fun invalidateStopsCache() {
    cachedStops = null
}

fun Application.formRoutes() {
    routing {

        get("/routes") {
            val routes = ActiveRoutesCache.getTodayRoutes()
            call.respond(routes)
        }

        get("/stops/search") {
            val queryParam = call.parameters["q"]?.trim()?.lowercase() ?: return@get call.respond(emptyList<StopSuggestion>())
            if (queryParam.length < 2) return@get call.respond(emptyList<StopSuggestion>())
            
            val searchQ = queryParam.normalizePL()

            val results = transaction {
                if (cachedStops == null) {
                    cachedStops = Stops.selectAll().map {
                        StopSuggestion(
                            stopId = it[Stops.stopId],
                            name = it[Stops.name],
                            code = it[Stops.code],
                            lat = it[Stops.lat],
                            lon = it[Stops.lon]
                        )
                    }
                }

                val baseStops = cachedStops!!.filter {
                    it.name.normalizePL().contains(searchQ) || 
                    it.code.normalizePL().contains(searchQ)
                }.sortedBy { stop ->
                    val normName = stop.name.normalizePL()
                    val normCode = stop.code.normalizePL()
                    
                    when {
                        normName.startsWith(searchQ) -> 1
                        normName.contains(" $searchQ") || normName.contains("-$searchQ") -> 2
                        normCode.startsWith(searchQ) -> 3
                        else -> 4
                    }
                }.take(10)

                if (baseStops.isEmpty()) return@transaction emptyList<StopSuggestion>()
                val stopIds = baseStops.map { it.stopId }
                val activeServices = activeServiceIds(LocalDate.now(LUBLIN_ZONE))

                val stopRoutesMap = mutableMapOf<String, MutableSet<StopRouteDto>>()

                if (activeServices.isNotEmpty()) {
                    StopDepartures.join(TripHeadsigns, JoinType.INNER, onColumn = StopDepartures.tripId, otherColumn = TripHeadsigns.tripId)
                        .select(StopDepartures.stopId, StopDepartures.route, TripHeadsigns.headsign)
                        .where {
                            (StopDepartures.stopId inList stopIds) and
                            (StopDepartures.serviceId inList activeServices)
                        }
                        .withDistinct(true)
                        .forEach { row ->
                            val sId = row[StopDepartures.stopId]
                            val r = row[StopDepartures.route]
                            val h = java.text.Normalizer.normalize(row[TripHeadsigns.headsign], java.text.Normalizer.Form.NFC).trim()
                            
                            stopRoutesMap.getOrPut(sId) { mutableSetOf() }.add(StopRouteDto(r, h))
                        }
                }

                baseStops.map { stop ->
                    val routesList: List<StopRouteDto> = stopRoutesMap[stop.stopId]
                        ?.toList()
                        ?.sortedBy { it.route.toIntOrNull() ?: 9999 }
                        ?: emptyList<StopRouteDto>()
                        
                    stop.copy(routes = routesList)
                }
            }
            call.respond(results)
        }
        
        get("/route/search") {
            val fromParam = call.parameters["from"]
            val toParam = call.parameters["to"]

            if (fromParam.isNullOrBlank() || toParam.isNullOrBlank()) {
                call.respond(emptyList<DirectRoute>())
                return@get
            }

            val fromIds = fromParam.split(",")
            val toIds = toParam.split(",")

            val now = java.time.LocalTime.now(LUBLIN_ZONE)
            val currentMin = now.hour * 60 + now.minute
            val today = java.time.LocalDate.now(LUBLIN_ZONE)

            val routes = transaction {
                val activeServices = activeServiceIds(today) 
                findDirectTrips(fromIds, toIds, activeServices, currentMin)
            }
            
            call.respond(routes)
        }
        
        get("/route/complex") {
            val fromParam = call.request.queryParameters["from"]
            val toParam = call.request.queryParameters["to"]
            val fromLat = call.request.queryParameters["fromLat"]?.toDoubleOrNull()
            val fromLon = call.request.queryParameters["fromLon"]?.toDoubleOrNull()
            val toLat = call.request.queryParameters["toLat"]?.toDoubleOrNull()
            val toLon = call.request.queryParameters["toLon"]?.toDoubleOrNull()
            val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 8 

            val starts: List<Pair<String, Int>> = when {
                fromLat != null && fromLon != null -> TransitGraph.getNearbyStopsWalkTimes(fromLat, fromLon)
                !fromParam.isNullOrBlank() -> fromParam.split(",").map { Pair(it.trim(), 0) }
                else -> return@get call.respond(emptyList<JourneyResponse>())
            }

            val targets: Map<String, Int> = when {
                toLat != null && toLon != null -> TransitGraph.getNearbyStopsWalkTimes(toLat, toLon).toMap()
                !toParam.isNullOrBlank() -> toParam.split(",").associate { it.trim() to 0 }
                else -> return@get call.respond(emptyList<JourneyResponse>())
            }

            if (starts.isEmpty() || targets.isEmpty()) {
                call.respond(emptyList<JourneyResponse>())
                return@get
            }

            val now = LocalDateTime.now(LUBLIN_ZONE)
            val timeParam = call.request.queryParameters["time"]?.toIntOrNull()
            
            val baseSearchDate = now.toLocalDate()
            var currentSearchMin = timeParam ?: (now.hour * 60 + now.minute)
            
            val allJourneys = mutableListOf<JourneyResponse>()
            var attempts = 0
            val MAX_ATTEMPTS = 150

            while (allJourneys.size < limit && attempts < MAX_ATTEMPTS) {
                attempts++
                
                val searchTime = baseSearchDate.atStartOfDay().plusMinutes(currentSearchMin.toLong())
                
                // ВИПРАВЛЕННЯ 1: Змінили назву змінної з path на foundPath
                val foundPath = TransitGraph.findBestRoute(starts, targets, searchTime)

                if (foundPath == null || foundPath.isEmpty()) {
                    break 
                }

                val stopIdsToFetch = foundPath.flatMap { listOf(it.fromStopId, it.toStopId) }.distinct()
                val stopNames = transaction {
                    Stops.select(Stops.stopId, Stops.name, Stops.code)
                        .where { Stops.stopId inList stopIdsToFetch }
                        .associate { it[Stops.stopId] to "${it[Stops.name]} ${it[Stops.code]}" }
                }

                // --- РАХУЄМО ЗМІЩЕННЯ ДНІВ ---
                val daysOffset = (searchTime.toLocalDate().toEpochDay() - baseSearchDate.toEpochDay()).toInt()
                val offsetMins = daysOffset * 1440
                // -----------------------------

                val legs = mutableListOf<JourneyLeg>()
                var currentLeg = mutableListOf<RouteEdge>()

                for (edge in foundPath) {
                    if (currentLeg.isEmpty() || currentLeg.last().tripId == edge.tripId) {
                        currentLeg.add(edge)
                    } else {
                        val first = currentLeg.first()
                        val last = currentLeg.last()
                        
                        // Обертаємо в try-catch на випадок якщо кеш ще порожній
                        val liveData = try { LiveVehiclesCache.byTripId(first.tripId) } catch (e: Exception) { null }
                        val delaySec = liveData?.delaySeconds ?: 0
                        val isRealTime = liveData?.delaySeconds != null
                        
                        legs.add(JourneyLeg(
                            route = first.route,
                            fromStopName = stopNames[first.fromStopId] ?: first.fromStopId,
                            toStopName = stopNames[last.toStopId] ?: last.toStopId,
                            departureMin = first.departureMin + offsetMins,
                            arrivalMin = last.arrivalMin + offsetMins,
                            tripId = first.tripId,
                            fromStopId = first.fromStopId,
                            toStopId = last.toStopId,
                            isRealTime = isRealTime,            
                            delayMinutes = delaySec / 60 
                        ))
                        currentLeg = mutableListOf(edge)
                    }
                }
                
                if (currentLeg.isNotEmpty()) {
                    val first = currentLeg.first()
                    val last = currentLeg.last()
                    
                    val liveData = try { LiveVehiclesCache.byTripId(first.tripId) } catch (e: Exception) { null }
                    val delaySec = liveData?.delaySeconds ?: 0
                    val isRealTime = liveData?.delaySeconds != null
                    
                    legs.add(JourneyLeg(
                        route = first.route,
                        fromStopName = stopNames[first.fromStopId] ?: first.fromStopId,
                        toStopName = stopNames[last.toStopId] ?: last.toStopId,
                        departureMin = first.departureMin + offsetMins,
                        arrivalMin = last.arrivalMin + offsetMins,
                        tripId = first.tripId,
                        fromStopId = first.fromStopId,
                        toStopId = last.toStopId,
                        isRealTime = isRealTime,            
                        delayMinutes = delaySec / 60
                    ))
                }
                
                if (legs.isNotEmpty() && legs.first().route == "Пішки" && legs.size > 1) {
                    val walkLeg = legs[0]
                    val firstBus = legs[1]
                    val walkDuration = walkLeg.arrivalMin - walkLeg.departureMin
                    val perfectDeparture = firstBus.departureMin - walkDuration - 2
                    
                    if (perfectDeparture > walkLeg.departureMin) {
                        legs[0] = walkLeg.copy(
                            departureMin = perfectDeparture,
                            arrivalMin = firstBus.departureMin - 2
                        )
                    }
                }
                
                if (legs.isEmpty()) {
                    break
                }
                
                val realTotalMinutes = legs.last().arrivalMin - legs.first().departureMin

                // ВИПРАВЛЕННЯ 2: Чітко вказали map { it.tripId } щоб уникнути ambiguity
                val currentSignature = legs.filter { it.route != "Пішки" }.map { it.tripId }.joinToString("|")

                val isDuplicate = allJourneys.any { journey ->
                    val existingSignature = journey.legs.filter { it.route != "Пішки" }.map { it.tripId }.joinToString("|")
                    existingSignature == currentSignature
                }
                
                if (!isDuplicate) {
                    allJourneys.add(
                        JourneyResponse(
                            totalMinutes = realTotalMinutes,
                            legs = legs
                        )
                    )
                }

                /// ЗСУВАЄМО ЧАС ТАК, ЩОБ ГАРАНТОВАНО ПРОПУСТИТИ ЦЕЙ АВТОБУС
                val walkDuration = if (legs.first().route == "Пішки") (legs.first().arrivalMin - legs.first().departureMin) else 0
                val firstBus = legs.find { it.route != "Пішки" }
                
                if (firstBus != null) {
                    currentSearchMin = firstBus.departureMin - walkDuration + 1
                } else {
                    currentSearchMin = legs.first().departureMin + 1
                }
            }
            
            call.respond(allJourneys.distinctBy { it.legs })
        }
        
        get("/routes/{route}/directions") {
            val routeNum = call.parameters["route"] ?: return@get call.respondText("Missing route", status = HttpStatusCode.BadRequest)
            val now = Instant.now()

            val directions = transaction {
                val bestPerDirection = mutableMapOf<String, Int>()

                for ((date, minuteBase) in timeCandidates(now)) {
                    val serviceIds = activeServiceIds(date)
                    if (serviceIds.isEmpty()) continue

                    val departures = StopDepartures.selectAll()
                        .where {
                            (StopDepartures.route eq routeNum) and
                                (StopDepartures.serviceId inList serviceIds) and
                                (StopDepartures.departureMinutes greaterEq (minuteBase - DIRECTIONS_WINDOW_MINUTES)) and
                                (StopDepartures.departureMinutes lessEq (minuteBase + DIRECTIONS_WINDOW_MINUTES))
                        }

                    for (row in departures) {
                        val headsign = headsignFor(row[StopDepartures.tripId])
                            ?.let { java.text.Normalizer.normalize(it, java.text.Normalizer.Form.NFC).trim() }
                            ?: continue
                        if (headsign.isEmpty()) continue
                        val diff = kotlin.math.abs(row[StopDepartures.departureMinutes] - minuteBase)
                        val existing = bestPerDirection[headsign]
                        if (existing == null || diff < existing) {
                            bestPerDirection[headsign] = diff
                        }
                    }
                }

                bestPerDirection.entries.sortedBy { it.value }.map { it.key }
            }

            if (directions.isNotEmpty()) {
                call.respond(directions)
                return@get
            }

            val fallback = transaction {
                val activeServices = activeServiceIds(LocalDate.now(LUBLIN_ZONE))
                if (activeServices.isEmpty()) return@transaction emptyList()

                val tripIds = StopDepartures.selectAll()
                    .where { (StopDepartures.route eq routeNum) and (StopDepartures.serviceId inList activeServices) }
                    .map { it[StopDepartures.tripId] }
                    .distinct()

                tripIds.mapNotNull { headsignFor(it) }
                    .map { java.text.Normalizer.normalize(it, java.text.Normalizer.Form.NFC).trim() }
                    .filter { it.isNotEmpty() }
                    .distinct()
                    .sorted()
            }

            call.respond(fallback)
        }
    }
}
