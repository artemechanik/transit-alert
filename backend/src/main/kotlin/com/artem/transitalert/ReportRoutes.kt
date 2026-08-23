package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.Instant
import java.time.temporal.ChronoUnit
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.lessEq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.inList
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

// Не давати одному пристрою постити частіше ніж раз на N хвилин
private const val RATE_LIMIT_MINUTES = 5L

// Скільки хвилин допис лишається "актуальним" у стрічці
private const val REPORT_TTL_MINUTES = 45L

fun Application.reportRoutes() {
    routing {

               // --- Стрічка: нові допис зверху, старі/приховані відфільтровані ---
        get("/reports") {
            val cutoff = Instant.now().minus(REPORT_TTL_MINUTES, ChronoUnit.MINUTES)
            val results = transaction {
                (Reports innerJoin Stops)
                    .selectAll()
                    .where { (Reports.hidden eq false) and (Reports.createdAt greaterEq cutoff) }
                    .orderBy(Reports.createdAt, SortOrder.DESC)
                    .limit(100)
                    .map {
                        ReportResponse(
                            id = it[Reports.id],
                            stopId = it[Reports.stopId],
                            stopName = it[Stops.name],
                            stopCode = it[Stops.code],
                            lat = it[Stops.lat],
                            lon = it[Stops.lon],
                            comment = it[Reports.comment],
                            route = it[Reports.route],
                            direction = it[Reports.direction],
                            createdAt = it[Reports.createdAt].toString(),
                            confirms = it[Reports.confirms],
                            denies = it[Reports.denies],
                            previousReportId = it[Reports.previousReportId]
                        )
                    }
            }
            call.respond(results)
        }

        // --- Один допис по id, незалежно від TTL/hidden — для рендеру цитат в апдейтах ---
        get("/reports/{id}") {
            val id = call.parameters["id"]?.toIntOrNull()
            if (id == null) {
                call.respond(HttpStatusCode.BadRequest)
                return@get
            }
            val result = transaction {
                (Reports innerJoin Stops)
                    .selectAll()
                    .where { Reports.id eq id }
                    .limit(1)
                    .firstOrNull()
                    ?.let {
                        ReportResponse(
                            id = it[Reports.id],
                            stopId = it[Reports.stopId],
                            stopName = it[Stops.name],
                            stopCode = it[Stops.code],
                            lat = it[Stops.lat],
                            lon = it[Stops.lon],
                            comment = it[Reports.comment],
                            route = it[Reports.route],
                            direction = it[Reports.direction],
                            createdAt = it[Reports.createdAt].toString(),
                            confirms = it[Reports.confirms],
                            denies = it[Reports.denies],
                            previousReportId = it[Reports.previousReportId],
                        )
                    }
            }
            if (result == null) call.respond(HttpStatusCode.NotFound) else call.respond(result)
        }

        // --- Створення допису ---
        post("/reports") {
            val req = call.receive<CreateReportRequest>()

            if (req.comment != null && req.comment.length > 200) {
                call.respond(HttpStatusCode.BadRequest, "Comment too long")
                return@post
            }

            if (req.previousReportId != null) {
                val ttlCutoff = Instant.now().minus(REPORT_TTL_MINUTES, ChronoUnit.MINUTES)
                val original = transaction {
                    Reports.selectAll().where { Reports.id eq req.previousReportId }.limit(1).firstOrNull()
                }
                when {
                    original == null -> {
                        call.respond(HttpStatusCode.BadRequest, "Оригінальний допис не знайдено")
                        return@post
                    }
                    original[Reports.createdAt] < ttlCutoff -> {
                        call.respond(HttpStatusCode.BadRequest, "Оригінал вже неактуальний (>45 хв) — це вже новий допис, не апдейт")
                        return@post
                    }
                    original[Reports.fingerprint] != req.fingerprint -> {
                        call.respond(HttpStatusCode.BadRequest, "Можна оновлювати лише власний допис")
                        return@post
                    }
                }
            }

            if (req.previousReportId != null) {
                val originalExists = transaction {
                    Reports.selectAll().where { Reports.id eq req.previousReportId }.limit(1).any()
                }
                if (!originalExists) {
                    call.respond(HttpStatusCode.BadRequest, "Оригінальний допис не знайдено")
                    return@post
                }
            }

            // Валідація: перевіряємо, з якої вкладки прийшли дані
            val isLiniaTab = req.route != null && req.direction != null && req.stopName != null
            val isPrzystanekTab = req.stopId != null && req.route == null && req.direction == null && req.stopName == null

            if (!isLiniaTab && !isPrzystanekTab) {
                call.respond(
                    HttpStatusCode.BadRequest, 
                    "Помилка валідації: дані мають відповідати або вкладці 'Linia' (route, direction, stopName), або 'Przystanek' (stopId)."
                )
                return@post
            }

            val recentCutoff = Instant.now().minus(RATE_LIMIT_MINUTES, ChronoUnit.MINUTES)
            val now = Instant.now()
            val zoneId = ZoneId.of("Europe/Warsaw")
            val localNow = LocalTime.now(zoneId)
            val todayString = LocalDate.now(zoneId).format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd"))
            val currentMinutes = localNow.hour * 60 + localNow.minute

            val created = transaction {
                // Rate limit: чи постив цей fingerprint нещодавно?
                if (req.previousReportId == null) {
                    val recentPost = Reports.selectAll()
                        .where { (Reports.fingerprint eq req.fingerprint) and (Reports.createdAt greaterEq recentCutoff) }
                        .limit(1)
                        .firstOrNull()

                    if (recentPost != null) return@transaction null
                }

                var finalStopId: String? = null
                var finalStopName: String? = null
                var finalStopCode: String? = null
                var finalLat: Double? = null // <--- ДОДАНО
                var finalLon: Double? = null // <--- ДОДАНО
                var finalRoute: String? = null
                var finalDirection: String? = null
                var finalTripId: String? = null

                if (isPrzystanekTab) {
                    // Сценарій "Przystanek": Точно знаємо платформу, перевіряємо чи існує зупинка
                    val stopExists = Stops.selectAll().where { Stops.stopId eq req.stopId!! }.limit(1).firstOrNull()
                    if (stopExists == null) return@transaction null

                    finalStopId = req.stopId
                    finalStopName = stopExists[Stops.name]
                    finalStopCode = stopExists[Stops.code]
                    finalLat = stopExists[Stops.lat]
                    finalLon = stopExists[Stops.lon]
                } else {
                    // Сценарій "Linia": Знаємо маршрут, напрям і загальну назву зупинки.
                    // Отримуємо активні сервіси на сьогодні
                    val activeServices = ServiceCalendar
                        .select(ServiceCalendar.serviceId)
                        .where { ServiceCalendar.date eq todayString }
                        .map { it[ServiceCalendar.serviceId] }

                    if (activeServices.isNotEmpty()) {
                        // Шукаємо рейс у вікні ±30 хвилин через innerJoin
                        // ЯВНО ВКАЗУЄМО КОЛОНКИ ДЛЯ З'ЄДНАННЯ:
                        val match = (StopDepartures crossJoin TripHeadsigns crossJoin Stops)
                            .selectAll()
                            .where {
                                // Тут ми чітко з'єднуємо таблиці
                                (StopDepartures.tripId eq TripHeadsigns.tripId) and
                                (StopDepartures.stopId eq Stops.stopId) and
                                // А далі твої звичні умови пошуку
                                (Stops.name eq req.stopName!!) and
                                (StopDepartures.route eq req.route!!) and
                                (TripHeadsigns.headsign eq req.direction!!) and
                                (StopDepartures.serviceId inList activeServices) and
                                (StopDepartures.departureMinutes greaterEq (currentMinutes - 30)) and
                                (StopDepartures.departureMinutes lessEq (currentMinutes + 30))
                            }
                            .orderBy(StopDepartures.departureMinutes, SortOrder.ASC)
                            .limit(1)
                            .firstOrNull()

                        if (match != null) {
                            finalStopId = match[Stops.stopId]
                            finalStopName = match[Stops.name]
                            finalStopCode = match[Stops.code]
                            finalLat = match[Stops.lat]
                            finalLon = match[Stops.lon]
                            finalRoute = req.route
                            finalDirection = req.direction
                            finalTripId = match[StopDepartures.tripId]
                        }
                    }

                    // Якщо в 30-хвилинному вікні рейсу нема (розклад рідкий/пізня ніч) —
                    // пробуємо знайти платформу, де ця route+direction комбінація взагалі трапляється.
                    if (finalStopId == null) {
                        val candidates = Stops.selectAll().where { Stops.name eq req.stopName!! }.map { it[Stops.stopId] to it }
                        var matchedStop: ResultRow? = null

                        for ((candidateId, stopRow) in candidates) {
                            // Шукаємо рейси для цієї лінії на цій платформі
                            val tripsForRouteOnThisStop = StopDepartures
                                .select(StopDepartures.tripId)
                                .where { (StopDepartures.stopId eq candidateId) and (StopDepartures.route eq req.route!!) }
                                .limit(50)
                                .map { it[StopDepartures.tripId] }

                            if (tripsForRouteOnThisStop.isNotEmpty()) {
                                // Перевіряємо, чи є серед них потрібний напрямок
                                val hasDirection = TripHeadsigns.selectAll()
                                    .where { (TripHeadsigns.tripId inList tripsForRouteOnThisStop) and (TripHeadsigns.headsign eq req.direction!!) }
                                    .limit(1)
                                    .empty().not()

                                if (hasDirection) {
                                    matchedStop = stopRow
                                    break
                                }
                            }
                        }

                        if (matchedStop != null) {
                            finalStopId = matchedStop[Stops.stopId]
                            finalStopName = matchedStop[Stops.name]
                            finalStopCode = matchedStop[Stops.code]
                            finalLat = matchedStop[Stops.lat]
                            finalLon = matchedStop[Stops.lon]
                            finalRoute = req.route
                            finalDirection = req.direction
                            // tripId лишається null
                        } else {
                            // Справді нема такого route+direction на цій зупинці взагалі —
                            // берем будь-яку платформу, але БЕЗ route/direction.
                            val fallbackStop = candidates.firstOrNull()?.second ?: return@transaction null
                            finalStopId = fallbackStop[Stops.stopId]
                            finalStopName = fallbackStop[Stops.name]
                            finalStopCode = fallbackStop[Stops.code]
                            finalLat = fallbackStop[Stops.lat]
                            finalLon = fallbackStop[Stops.lon]
                            finalRoute = null
                            finalDirection = null
                        }
                    }
                }
                // Зберігаємо допис у БД (з урахуванням поля previousReportId)
                val newId = Reports.insert {
                    it[stopId] = finalStopId!!
                    it[comment] = req.comment
                    it[route] = finalRoute
                    it[direction] = finalDirection
                    it[tripId] = finalTripId
                    it[fingerprint] = req.fingerprint
                    it[createdAt] = now
                    it[previousReportId] = req.previousReportId // Ланцюжок дописів
                } get Reports.id

                // Повертаємо сформовану відповідь для PWA-клієнта
                ReportResponse(
                    id = newId,
                    stopId = finalStopId!!,
                    stopName = finalStopName!!,
                    stopCode = finalStopCode!!,
                    lat = finalLat!!,
                    lon = finalLon!!,
                    comment = req.comment,
                    route = finalRoute,
                    direction = finalDirection,
                    createdAt = now.toString(),
                    confirms = 0,
                    denies = 0,
                    previousReportId = req.previousReportId
                )
            }

            if (created == null) {
                call.respond(HttpStatusCode.TooManyRequests, "Зачекай кілька хвилин перед новим дописом")
            } else {
                call.respond(HttpStatusCode.Created, created)
            }
        }

        // --- "Підтверджую" / "Вже нема" ---
        post("/reports/{id}/confirm") {
            handleVote(call, "confirm")
        }
        post("/reports/{id}/deny") {
            handleVote(call, "deny")
        }
    }
}

/**
 * Один пристрій — один голос на допис (toggle-поведінка як лайк):
 * повторний той самий голос знімає його; протилежний голос перемикає.
 * Немає жодного авто-приховування на основі результату — лічильники просто
 * показуються у стрічці, а рішення довіряти чи ні лишається за юзером.
 */
private suspend fun handleVote(call: ApplicationCall, voteType: String) {
    val id = call.parameters["id"]?.toIntOrNull()
    if (id == null) {
        call.respond(HttpStatusCode.BadRequest)
        return
    }
    val req = call.receive<VoteRequest>()

    val result = transaction {
        val currentReport = Reports.selectAll().where { Reports.id eq id }.limit(1).firstOrNull()
        if (currentReport == null) return@transaction null

        var confirms = currentReport[Reports.confirms]
        var denies = currentReport[Reports.denies]

        val existingVote = ReportVotes.selectAll()
            .where { (ReportVotes.reportId eq id) and (ReportVotes.fingerprint eq req.fingerprint) }
            .limit(1)
            .firstOrNull()

        when {
            existingVote == null -> {
                ReportVotes.insert {
                    it[ReportVotes.reportId] = id
                    it[ReportVotes.fingerprint] = req.fingerprint
                    it[ReportVotes.voteType] = voteType
                    it[ReportVotes.createdAt] = Instant.now()
                }
                if (voteType == "confirm") confirms += 1 else denies += 1
            }
            existingVote[ReportVotes.voteType] == voteType -> {
                // повторний той самий голос — знімаємо його (toggle off)
                ReportVotes.deleteWhere { ReportVotes.id eq existingVote[ReportVotes.id] }
                if (voteType == "confirm") confirms -= 1 else denies -= 1
            }
            else -> {
                // перемикання голосу: -1 старому типу, +1 новому
                ReportVotes.update({ ReportVotes.id eq existingVote[ReportVotes.id] }) {
                    it[ReportVotes.voteType] = voteType
                }
                if (voteType == "confirm") {
                    confirms += 1
                    denies -= 1
                } else {
                    denies += 1
                    confirms -= 1
                }
            }
        }

        Reports.update({ Reports.id eq id }) {
            it[Reports.confirms] = confirms
            it[Reports.denies] = denies
        }

        Pair(confirms, denies)
    }

    if (result == null) {
        call.respond(HttpStatusCode.NotFound)
    } else {
        call.respond(HttpStatusCode.OK, mapOf("confirms" to result.first, "denies" to result.second))
    }
}
