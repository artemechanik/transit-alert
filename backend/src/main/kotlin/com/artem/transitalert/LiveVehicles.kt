package com.artem.transitalert

import com.google.transit.realtime.GtfsRealtime
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import kotlinx.coroutines.*
import org.jetbrains.exposed.sql.transactions.transaction
import org.slf4j.LoggerFactory
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs

private const val ZBIORKOM_LUBLIN_PB_URL = "https://cdn.zbiorkom.live/gtfs-rt/lublin.pb"
private const val POLL_INTERVAL_MS = 15_000L

data class VehiclePosition(
    val vehicleLabel: String,
    val tripId: String,
    val lat: Double,
    val lon: Double,
    val bearing: Float,
    val currentStopSequence: Int,
    val timestamp: Long,
    val delaySeconds: Int?, // додатнє = запізнення, від'ємне = випередження; null якщо невідомо
)

/**
 * Тримає в пам'яті останні відомі позиції автобусів, ключ — tripId
 * (той самий формат, що й у нашому статичному GTFS — напряму мапиться
 * на stop_departures/trip_stops без додаткової конвертації).
 */
object LiveVehiclesCache {
    private val positionsByTrip = ConcurrentHashMap<String, VehiclePosition>()
    private val logger = LoggerFactory.getLogger("LiveVehicles")
    private val client = HttpClient(CIO)
    private val LUBLIN_ZONE_LOCAL: ZoneId = ZoneId.of("Europe/Warsaw")

    fun byTripId(tripId: String): VehiclePosition? = positionsByTrip[tripId]

    fun all(): List<VehiclePosition> = positionsByTrip.values.toList()

    fun startPolling(scope: CoroutineScope) {
        scope.launch {
            while (isActive) {
                try {
                    refresh()
                } catch (e: CancellationException) {
                    throw e // Пропускаємо системне скасування далі
                } catch (e: Exception) {
    // Передаємо сам об'єкт винятку 'e' другим параметром. 
    // Це змусить логер роздрукувати ВЕСЬ стек викликів (stack trace).
    logger.error("Критична помилка при оновленні live-позицій", e)
}
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    /**
     * Фактичний час (unix) прибуття/відправлення для (tripId, stopSequence),
     * зібраний з entity типу tripUpdate. Пріоритет — departure.time, якщо є,
     * інакше arrival.time.
     */
    private fun collectActualTimes(feed: GtfsRealtime.FeedMessage): Map<Pair<String, Int>, Long> {
        val result = HashMap<Pair<String, Int>, Long>()
        for (entity in feed.entityList) {
            if (!entity.hasTripUpdate()) continue
            val tu = entity.tripUpdate
            if (!tu.trip.hasTripId()) continue
            for (stu in tu.stopTimeUpdateList) {
                val time = when {
                    stu.hasDeparture() && stu.departure.hasTime() -> stu.departure.time
                    stu.hasArrival() && stu.arrival.hasTime() -> stu.arrival.time
                    else -> continue
                }
                result[tu.trip.tripId to stu.stopSequence] = time
            }
        }
        return result
    }

    /**
     * Різниця (сек) між фактичним unix-часом і плановим часом за розкладом.
     * Планові хвилини не прив'язані до конкретної календарної дати (можуть бути
     * >=1440 для нічних рейсів), тому перебираємо сусідні доби і беремо найближчий
     * кандидат до фактичного часу — надійніше, ніж вгадувати службову дату.
     */
    private fun computeDelaySeconds(scheduledMinutes: Int, actualUnix: Long): Int {
        val refDate = Instant.ofEpochSecond(actualUnix).atZone(LUBLIN_ZONE_LOCAL).toLocalDate()
        val candidates = listOf(refDate.minusDays(1), refDate, refDate.plusDays(1)).map { date ->
            date.atStartOfDay(LUBLIN_ZONE_LOCAL).plusMinutes(scheduledMinutes.toLong()).toEpochSecond()
        }
        val closest = candidates.minByOrNull { abs(it - actualUnix) }!!
        return (actualUnix - closest).toInt()
    }

    private suspend fun refresh() {
        // Якщо сервер мовчить 10 секунд - корутина викине TimeoutCancellationException, 
        // яку спіймає наш catch у startPolling і перезапустить цикл.
       // Якщо сервер мовчить 10 секунд - поверне null, і ми кинемо звичайний Exception
	val bytes: ByteArray = withTimeoutOrNull(10_000L) {
  	  client.get(ZBIORKOM_LUBLIN_PB_URL).readBytes()
	} ?: throw Exception("Таймаут 10с при запиті до GTFS-RT")
        val feed = GtfsRealtime.FeedMessage.parseFrom(bytes)

        // --- НОВИЙ БЛОК: Захист від застарілого фіда ---
        if (feed.header.hasTimestamp()) {
            val feedTimestamp = feed.header.timestamp
            val currentTimestamp = java.time.Instant.now().epochSecond

            val diff = currentTimestamp - feedTimestamp
            if (diff > 300) { // Якщо дані старіші за 5 хвилин (300 секунд)
                logger.warn("⚠️ УВАГА! GTFS-RT фід застарів. Затримка: $diff секунд!")
            }
        }
        // -----------------------------------------------
        val actualTimes = collectActualTimes(feed)

	     val fresh = ConcurrentHashMap<String, VehiclePosition>()
		
		// 1. Спочатку пробігаємось і збираємо всі (tripId, seq), які зараз є на лінії
		val targetStops = mutableListOf<Pair<String, Int>>()
		for (entity in feed.entityList) {
		    if (!entity.hasVehicle()) continue
		    val v = entity.vehicle
		    if (!v.hasPosition() || !v.trip.hasTripId()) continue
		    
		    targetStops.add(v.trip.tripId to v.currentStopSequence)
		}

		// 2. Робимо ОДИН запит до бази даних!
		val scheduledMap = transaction {
		    scheduledDepartureMinutesBulk(targetStops)
		}

		// 3. Збираємо свіжі дані для кешу, використовуючи словник у пам'яті
		for (entity in feed.entityList) {
		    if (!entity.hasVehicle()) continue
		    val v = entity.vehicle
		    if (!v.hasPosition() || !v.trip.hasTripId()) continue

		    val tripId = v.trip.tripId
		    val seq = v.currentStopSequence

		    // Беремо плановий час не з бази, а зі словника
		    val delaySeconds = actualTimes[tripId to seq]?.let { actualUnix ->
		        scheduledMap[tripId to seq]?.let { scheduledMin ->
		            computeDelaySeconds(scheduledMin, actualUnix)
		        }
		    }

		    fresh[tripId] = VehiclePosition(
		        vehicleLabel = if (v.vehicle.hasLabel()) v.vehicle.label else v.vehicle.id,
		        tripId = tripId,
		        lat = v.position.latitude.toDouble(),
		        lon = v.position.longitude.toDouble(),
		        bearing = v.position.bearing,
		        currentStopSequence = seq,
		        timestamp = v.timestamp,
		        delaySeconds = delaySeconds,
		    )
		}

        positionsByTrip.clear()
        positionsByTrip.putAll(fresh)
        logger.info("Live-позиції оновлено: ${fresh.size} автобусів")
    }
}
