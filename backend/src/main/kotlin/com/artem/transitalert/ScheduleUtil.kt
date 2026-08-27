package com.artem.transitalert

import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.andWhere
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.innerJoin
import org.jetbrains.exposed.sql.JoinType
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
/** 
 * Масовий запит планового часу для списку (tripId, stopSequence).
 * Робить лише 1 запит до бази замість N. Викликати всередині transaction {}. 
 */
fun scheduledDepartureMinutesBulk(requests: List<Pair<String, Int>>): Map<Pair<String, Int>, Int> {
    if (requests.isEmpty()) return emptyMap()
    
    // Дістаємо унікальні tripId, щоб не тягнути зайвого
    val targetTripIds = requests.map { it.first }.distinct()
    val requestSet = requests.toSet()
    
    val result = HashMap<Pair<String, Int>, Int>()
    
    TripStops.selectAll()
        .where { TripStops.tripId inList targetTripIds }
        .forEach { row ->
            val tripId = row[TripStops.tripId]
            val seq = row[TripStops.stopSequence]
            val pair = tripId to seq
            
            // Записуємо в словник лише ті зупинки, які нас просили знайти
            if (pair in requestSet) {
                result[pair] = row[TripStops.departureMinutes]
            }
        }
        
    return result
}
/** Шукає прямі рейси між двома групами зупинок */
fun findDirectTrips(fromIds: List<String>, toIds: List<String>, activeServices: List<String>, currentMin: Int): List<DirectRoute> {
    // Якщо немає активних сервісів на сьогодні — повертаємо порожнечу
    if (fromIds.isEmpty() || toIds.isEmpty() || activeServices.isEmpty()) return emptyList()
// Якщо немає активних сервісів на сьогодні — повертаємо порожнечу
    if (fromIds.isEmpty() || toIds.isEmpty() || activeServices.isEmpty()) return emptyList()

   // --- НОВИЙ БЛОК: Витягуємо красиві назви зупинок з номерами платформ ---
    val stopNames = mutableMapOf<String, String>()
    Stops.selectAll().where { Stops.stopId inList (fromIds + toIds) }.forEach {
        val name = it[Stops.name]
        val code = it[Stops.code] // <--- ВИКОРИСТОВУЄМО Stops.code
        
        stopNames[it[Stops.stopId]] = "$name $code"
    }
    // 1. Збираємо відправлення з точок А (тільки ТІ, ЩО БУДУТЬ)
    val fromStops = mutableMapOf<String, Triple<Int, Int, String>>()
    
    TripStops.join(StopDepartures, JoinType.INNER, onColumn = TripStops.tripId, otherColumn = StopDepartures.tripId)
        .selectAll()
        .where { 
            (TripStops.stopId inList fromIds) and 
            (StopDepartures.stopId eq TripStops.stopId) and
            (StopDepartures.serviceId inList activeServices) and // Відсікаємо клонів (інші дні)
            (TripStops.departureMinutes greaterEq currentMin)    // Відсікаємо минуле (машину часу)
        }
        .forEach {
            val tripId = it[TripStops.tripId]
            val seq = it[TripStops.stopSequence]
            val min = it[TripStops.departureMinutes]
            val sId = it[TripStops.stopId]
            
            if (!fromStops.containsKey(tripId) || seq < fromStops[tripId]!!.first) {
                fromStops[tripId] = Triple(seq, min, sId)
            }
        }

    if (fromStops.isEmpty()) return emptyList()

    // 2. Збираємо прибуття в точки Б
    val validTripIds = fromStops.keys.toList()
    val results = mutableListOf<DirectRoute>()

    TripStops.join(StopDepartures, JoinType.INNER, onColumn = TripStops.tripId, otherColumn = StopDepartures.tripId)
        .selectAll()
        .where { 
            (TripStops.stopId inList toIds) and 
            (TripStops.tripId inList validTripIds) and
            (StopDepartures.stopId eq TripStops.stopId)
        }
        .forEach { row ->
            val tripId = row[TripStops.tripId]
            val toSeq = row[TripStops.stopSequence]
            val toMin = row[TripStops.departureMinutes]
            val toStopId = row[TripStops.stopId]
            val routeNumber = row[StopDepartures.route]

            val fromData = fromStops[tripId] ?: return@forEach
            val fromSeq = fromData.first
            val fromMin = fromData.second
            val fromStopId = fromData.third

           // 3. ПЕРЕВІРКА ФІЗИКИ
            if (fromSeq < toSeq) {
                results.add(
                    DirectRoute(
                        route = routeNumber,
                        tripId = tripId,
                        fromStopId = fromStopId,
                        fromStopName = stopNames[fromStopId] ?: fromStopId, // <--- ДОДАЛИ
                        toStopId = toStopId,
                        toStopName = stopNames[toStopId] ?: toStopId,       // <--- ДОДАЛИ
                        departureMin = fromMin,
                        arrivalMin = toMin
                    )
                )
            }
        }

    // Сортуємо за часом і беремо тільки 15 найближчих рейсів (щоб не вантажити інтерфейс)
    return results.sortedBy { it.departureMin }.take(15)
}
