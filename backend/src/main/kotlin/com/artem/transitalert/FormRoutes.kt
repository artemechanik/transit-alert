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

// Вікно, в якому шукаємо "актуальні зараз" напрямки лінії. Ширше за risk-window (10хв)
// і за вікно резолву при сабміті (45хв) — тут просто пропонуємо варіанти на вибір,
// не намагаємось точно прив'язати конкретний рейс.
private const val DIRECTIONS_WINDOW_MINUTES = 90

fun String.normalizePL(): String {
    return this.lowercase()
        .replace("ą", "a").replace("ć", "c").replace("ę", "e")
        .replace("ł", "l").replace("ń", "n").replace("ó", "o")
        .replace("ś", "s").replace("ź", "z").replace("ż", "z")
}

// Оголошуємо кеш прямо всередині formRoutes, перед routing { ... }
var cachedStops: List<StopSuggestion>? = null

/** Скидає кеш зупинок — викликати з GtfsStaticSync одразу після успішного реімпорту,
 *  інакше нові/змінені зупинки не з'являться в автокомпліті аж до перезапуску застосунку. */
fun invalidateStopsCache() {
    cachedStops = null
}

fun Application.formRoutes() {
    routing {

        // Віддаємо всі активні на сьогодні лінії для автокомпліту
        get("/routes") {
            val routes = ActiveRoutesCache.getTodayRoutes()
            call.respond(routes)
        }

        // Пошук зупинок для автокомпліту (з підтримкою польських літер і розумним сортуванням)
        get("/stops/search") {
            val queryParam = call.parameters["q"]?.trim()?.lowercase() ?: return@get call.respond(emptyList<StopSuggestion>())
            if (queryParam.length < 2) return@get call.respond(emptyList<StopSuggestion>())
            
            // Нормалізуємо те, що ввів користувач (mel -> mel)
            val searchQ = queryParam.normalizePL()

            val results = transaction {
                // 1. Кешуємо всі зупинки при першому запиті
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

                // 2. Блискавичний пошук з розумним сортуванням
                val baseStops = cachedStops!!.filter {
                    it.name.normalizePL().contains(searchQ) || 
                    it.code.normalizePL().contains(searchQ)
                }.sortedBy { stop ->
                    val normName = stop.name.normalizePL()
                    val normCode = stop.code.normalizePL()
                    
                    when {
                        // Найвищий пріоритет: назва прямо починається з цих літер ("Lotnicza")
                        normName.startsWith(searchQ) -> 1
                        
                        // Другий пріоритет: якесь слово всередині назви починається з цього ("Park Bronowice")
                        normName.contains(" $searchQ") || normName.contains("-$searchQ") -> 2
                        
                        // Третій пріоритет: пошук чітко по номеру платформи
                        normCode.startsWith(searchQ) -> 3
                        
                        // Найнижчий пріоритет: просто збіг десь усередині слова ("Młodej")
                        else -> 4
                    }
                }.take(10)

                // ОСЬ ЦІ ТРИ РЯДКИ ЗАГУБИЛИСЯ МИНУЛОГО РАЗУ:
                if (baseStops.isEmpty()) return@transaction emptyList<StopSuggestion>()
                val stopIds = baseStops.map { it.stopId }
                val activeServices = activeServiceIds(LocalDate.now(LUBLIN_ZONE))

                // 3. Витягуємо маршрути для знайдених зупинок
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

                // 4. З'єднуємо все разом
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
        
      // Пошук прямих маршрутів між зупинками
        get("/route/search") {
            val fromParam = call.parameters["from"]
            val toParam = call.parameters["to"]

            if (fromParam.isNullOrBlank() || toParam.isNullOrBlank()) {
                call.respond(emptyList<DirectRoute>())
                return@get
            }

            val fromIds = fromParam.split(",")
            val toIds = toParam.split(",")

            // Час можна дізнаватися і без бази даних
            val now = java.time.LocalTime.now(LUBLIN_ZONE)
            val currentMin = now.hour * 60 + now.minute
            val today = java.time.LocalDate.now(LUBLIN_ZONE)

            // А от усе, що стосується бази, ховаємо сюди:
            val routes = transaction {
                val activeServices = activeServiceIds(today) // <--- ТЕПЕР ВОНО В БЕЗПЕЦІ
                findDirectTrips(fromIds, toIds, activeServices, currentMin)
            }
            
            call.respond(routes)
        }
        
     // Новий розумний МУЛЬТИПОШУК з пересадками
        get("/route/complex") {
            val fromParam = call.parameters["from"]
            val toParam = call.parameters["to"]
            val limit = call.request.queryParameters["limit"]?.toIntOrNull() ?: 20 

            if (fromParam.isNullOrBlank() || toParam.isNullOrBlank()) {
                call.respond(emptyList<JourneyResponse>())
                return@get
            }

            val fromIds = fromParam.split(",")
            val toIds = toParam.split(",")
            val now = java.time.LocalTime.now(LUBLIN_ZONE)
            
            var currentSearchMin = now.hour * 60 + now.minute
            val allJourneys = mutableListOf<JourneyResponse>()
            
            // ЗАПОБІЖНИК ВІД ЗАВИСАННЯ
            var attempts = 0
            val MAX_ATTEMPTS = 150

            // --- ПОЧАТОК ЦИКЛУ МУЛЬТИПОШУКУ ---
            while (allJourneys.size < limit && attempts < MAX_ATTEMPTS) {
                attempts++
                
                // 1. Питаємо алгоритм Дейкстри!
                val path = TransitGraph.findBestRoute(fromIds, toIds, currentSearchMin)

                if (path == null || path.isEmpty()) {
                    break 
                }

                // 2. Витягуємо красиві назви зупинок
                val stopIdsToFetch = path.flatMap { listOf(it.fromStopId, it.toStopId) }.distinct()
                val stopNames = transaction {
                    Stops.select(Stops.stopId, Stops.name, Stops.code)
                        .where { Stops.stopId inList stopIdsToFetch }
                        .associate { it[Stops.stopId] to "${it[Stops.name]} ${it[Stops.code]}" }
                }

                // 3. СКЛЕЮЄМО ЗУПИНКИ
                val legs = mutableListOf<JourneyLeg>()
                var currentLeg = mutableListOf<RouteEdge>()

                for (edge in path) {
                    if (currentLeg.isEmpty() || currentLeg.last().tripId == edge.tripId) {
                        currentLeg.add(edge)
                    } else {
                        val first = currentLeg.first()
                        val last = currentLeg.last()
                        legs.add(JourneyLeg(
                            route = first.route,
                            fromStopName = stopNames[first.fromStopId] ?: first.fromStopId,
                            toStopName = stopNames[last.toStopId] ?: last.toStopId,
                            departureMin = first.departureMin,
                            arrivalMin = last.arrivalMin,
                            tripId = first.tripId,
                            fromStopId = first.fromStopId,
                            toStopId = last.toStopId // ← додав: без цього фронтенд не міг надійно
                                                      //   визначити реальну зупинку висадки
                        ))
                        currentLeg = mutableListOf(edge)
                    }
                }
                
                if (currentLeg.isNotEmpty()) {
                    val first = currentLeg.first()
                    val last = currentLeg.last()
                    legs.add(JourneyLeg(
                        route = first.route,
                        fromStopName = stopNames[first.fromStopId] ?: first.fromStopId,
                        toStopName = stopNames[last.toStopId] ?: last.toStopId,
                        departureMin = first.departureMin,
                        arrivalMin = last.arrivalMin,
                        tripId = first.tripId,
                        fromStopId = first.fromStopId,
                        toStopId = last.toStopId // ← додав, той самий фікс
                    ))
                }
                
                // 4. ЛОГІКА "ВЧАСНОГО ВИХОДУ З ДОМУ" (JUST-IN-TIME WALKING)
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
                
                val realTotalMinutes = legs.last().arrivalMin - legs.first().departureMin

                // 5. ФІЛЬТРУЄМО КЛОНІВ ЗА УНІКАЛЬНИМИ АВТОБУСАМИ (Ігноруємо час пішки)
                // Створюємо "відбиток" поточного маршруту: беремо тільки транспорт, клеїмо маршрут + час
                val currentSignature = legs.filter { it.route != "Пішки" }
                    .joinToString("|") { "${it.route}-${it.departureMin}" }

                val isDuplicate = allJourneys.any { journey ->
                    val existingSignature = journey.legs.filter { it.route != "Пішки" }
                        .joinToString("|") { "${it.route}-${it.departureMin}" }
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

                // 6. ЗСУВАЄМО ЧАС ДЛЯ НАСТУПНОЇ ІТЕРАЦІЇ
		// Зсуваємо пошук на 1 хвилину після ЧАСУ ВИХОДУ З ДОМУ попереднього маршруту
		if (legs.isNotEmpty()) {
		    currentSearchMin = legs.first().departureMin + 1
		} else {
		    break
		}
            }
            // --- КІНЕЦЬ ЦИКЛУ МУЛЬТИПОШУКУ ---

            // Віддаємо фронтенду цілий масив маршрутів!
            call.respond(allJourneys.distinctBy { it.legs })
        }
        
        // Напрямки для конкретної лінії — тільки ті, якими вона реально їде
        // біля поточного часу (±90 хв), відсортовані від найближчого рейсу.
        get("/routes/{route}/directions") {
            val routeNum = call.parameters["route"] ?: return@get call.respondText("Missing route", status = HttpStatusCode.BadRequest)
            val now = Instant.now()

            val directions = transaction {
                // headsign -> найменша різниця в хвилинах серед знайдених у вікні рейсів
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

            // Фолбек: рідкісна лінія (напр. раз на 2 год нічний рейс) — у вікні ±90хв
            // може нічого не бути, хоча лінія реально активна сьогодні. Тоді краще
            // показати повний список напрямків за день, ніж пустий вибір.
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
