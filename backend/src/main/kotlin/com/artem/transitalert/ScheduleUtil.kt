package com.artem.transitalert

import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.andWhere
import org.jetbrains.exposed.sql.selectAll
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.math.abs

val LUBLIN_ZONE: ZoneId = ZoneId.of("Europe/Warsaw")
private val DATE_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd")

/**
 * Для довільного моменту часу повертає можливі пари (дата, хвилина-від-півночі),
 * які варто перевірити в розкладі. Друга пара покриває "нічний хвіст" GTFS
 * (рейси 24:xx-27:xx що логічно належать попередній календарній даті).
 */
fun timeCandidates(instant: Instant): List<Pair<LocalDate, Int>> {
    val zonedTime = instant.atZone(LUBLIN_ZONE)
    val minutes = zonedTime.hour * 60 + zonedTime.minute
    val candidates = mutableListOf(zonedTime.toLocalDate() to minutes)
    if (minutes < 4 * 60) {
        candidates.add(zonedTime.toLocalDate().minusDays(1) to minutes + 24 * 60)
    }
    return candidates
}

/** Активні service_id на конкретну дату. Викликати всередині transaction {}. */
fun activeServiceIds(date: LocalDate): List<String> {
    val dateStr = date.format(DATE_FMT)
    return ServiceCalendar.selectAll()
        .where { ServiceCalendar.date eq dateStr }
        .map { it[ServiceCalendar.serviceId] }
}

/** Напрямок (кінцева зупинка) рейсу. Викликати всередині transaction {}. */
fun headsignFor(tripId: String): String? =
    TripHeadsigns.selectAll()
        .where { TripHeadsigns.tripId eq tripId }
        .limit(1)
        .firstOrNull()
        ?.get(TripHeadsigns.headsign)

/** Плановий час (хвилини від півночі служби) конкретної зупинки в рейсі. Викликати всередині transaction {}. */
fun scheduledDepartureMinutes(tripId: String, stopSequence: Int): Int? =
    TripStops.selectAll()
        .where { (TripStops.tripId eq tripId) and (TripStops.stopSequence eq stopSequence) }
        .limit(1)
        .firstOrNull()
        ?.get(TripStops.departureMinutes)

data class DepartureMatch(val route: String, val tripId: String, val diffMinutes: Int)

/**
 * Найближчий рейс на зупинці біля заданого часу, опційно відфільтрований по лінії.
 * Викликати всередині transaction {}.
 */
fun findNearestDeparture(
    stopId: String,
    route: String?,
    at: Instant,
    windowMinutes: Int,
): DepartureMatch? {
    var best: DepartureMatch? = null
    for ((date, minuteBase) in timeCandidates(at)) {
        val serviceIds = activeServiceIds(date)
        if (serviceIds.isEmpty()) continue

        var query = StopDepartures.selectAll().where {
            (StopDepartures.stopId eq stopId) and
                (StopDepartures.serviceId inList serviceIds) and
                (StopDepartures.departureMinutes greaterEq (minuteBase - windowMinutes)) and
                (StopDepartures.departureMinutes lessEq (minuteBase + windowMinutes))
        }
        if (route != null) {
            query = query.andWhere { StopDepartures.route eq route }
        }

        for (row in query) {
            val diff = abs(row[StopDepartures.departureMinutes] - minuteBase)
            if (best == null || diff < best!!.diffMinutes) {
                best = DepartureMatch(
                    route = row[StopDepartures.route],
                    tripId = row[StopDepartures.tripId],
                    diffMinutes = diff,
                )
            }
        }
    }
    return best
}
