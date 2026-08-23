package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.Instant
import kotlin.math.max

// Цей DTO можна поки залишити тут, бо він специфічний саме для карти, 
// або за бажанням теж перенести в Dtos.kt
@Serializable
data class LiveVehicleResponse(
    val vehicleLabel: String,
    val route: String,
    val tripId: String,
    val lat: Double,
    val lon: Double,
    val bearing: Float,
    val currentStopSequence: Int,
    val delaySeconds: Int?,
)

fun Application.liveVehiclesRoutes() {
    routing {
        
        // 1. Маршрут для всіх машин на карті
        get("/live-vehicles") {
            val routeFilter = call.request.queryParameters["route"]

            val positions = LiveVehiclesCache.all()
            if (positions.isEmpty()) {
                call.respond(emptyList<LiveVehicleResponse>())
                return@get
            }

            val result = transaction {
                positions.mapNotNull { pos ->
                    val route = StopDepartures.selectAll()
                        .where { StopDepartures.tripId eq pos.tripId }
                        .limit(1)
                        .firstOrNull()
                        ?.get(StopDepartures.route)
                        ?: return@mapNotNull null

                    if (routeFilter != null && route != routeFilter) return@mapNotNull null

                    LiveVehicleResponse(
                        vehicleLabel = pos.vehicleLabel,
                        route = route,
                        tripId = pos.tripId,
                        lat = pos.lat,
                        lon = pos.lon,
                        bearing = pos.bearing,
                        currentStopSequence = pos.currentStopSequence,
                        delaySeconds = pos.delaySeconds,
                    )
                }
            }

            call.respond(result)
        }

        // 2. Розклад (відправлення) для конкретної платформи з урахуванням Real-Time
        get("/stops/{stopId}/departures") {
            val stopId = call.parameters["stopId"]
            if (stopId == null) {
                call.respond(HttpStatusCode.BadRequest, "Missing stopId")
                return@get
            }

            val now = Instant.now()
            val nowSecondOfMinute = now.atZone(LUBLIN_ZONE).second

            val departures = transaction {
                val collected = mutableListOf<StopDepartureDto>()

                // Два "кандидати" на дату/базову хвилину — як і в risk-routes/directions:
                // покриває нічний хвіст GTFS (рейси 24:xx-27:xx, що належать service_id
                // ВЧОРАШНЬОЇ дати, хоча за годинником це вже сьогодні після півночі).
                for ((date, minuteBase) in timeCandidates(now)) {
                    val serviceIds = activeServiceIds(date)
                    if (serviceIds.isEmpty()) continue

                    val limitMinutes = minuteBase + 120 // рейси на 2 години вперед
                    val nowRefSeconds = minuteBase * 60 + nowSecondOfMinute

                    StopDepartures.join(TripHeadsigns, JoinType.INNER, onColumn = StopDepartures.tripId, otherColumn = TripHeadsigns.tripId)
                        .select(
                            StopDepartures.route,
                            TripHeadsigns.headsign,
                            StopDepartures.departureMinutes,
                            StopDepartures.tripId
                        )
                       .where {
                            (StopDepartures.stopId eq stopId) and
                                (StopDepartures.serviceId inList serviceIds) and
                                // БЕРЕМО РЕЙСИ З ЗАПАСОМ У 60 ХВИЛИН НАЗАД
                                // щоб покрити будь-які запізнення та "привидів"
                                (StopDepartures.departureMinutes greaterEq (minuteBase - 60)) and
                                (StopDepartures.departureMinutes lessEq limitMinutes)
                        }
                        .orderBy(StopDepartures.departureMinutes to SortOrder.ASC)
                        .limit(30)
                        .forEach { row ->
                            val scheduledMin = row[StopDepartures.departureMinutes]
                            val tripId = row[StopDepartures.tripId]

                            val liveData = LiveVehiclesCache.byTripId(tripId)
                            val delaySec = liveData?.delaySeconds ?: 0
                            val isRealTime = liveData?.delaySeconds != null

                            val scheduledSeconds = scheduledMin * 60
                            val expectedSeconds = scheduledSeconds + delaySec
                            val secondsLeft = expectedSeconds - nowRefSeconds

                            // РОЗУМНИЙ БУФЕР ОЧІКУВАННЯ (Grace Period)
                            // Якщо є GPS: ховаємо через 2 хв після проїзду зупинки
                            // Якщо немає GPS: тримаємо рейс у списку ще 10 хвилин на випадок запізнення
                            val hideThresholdSeconds = if (isRealTime) -120 else -300

                            if (secondsLeft < hideThresholdSeconds) return@forEach

                            // max(0, ...) гарантує, що поки автобус "висить" у буфері, він показуватиме 0 min
                            val minutesLeft = max(0, secondsLeft / 60)

                            val h = (scheduledMin / 60) % 24
                            val m = scheduledMin % 60

                            collected += StopDepartureDto(
                                route = row[StopDepartures.route],
                                direction = row[TripHeadsigns.headsign],
                                scheduledTime = "%02d:%02d".format(h, m),
                                minutesLeft = minutesLeft,
                                isRealTime = isRealTime,
                                delayMinutes = delaySec / 60
                            )
                        }
                }

                collected
            }

            // Сортуємо фінальний список за реальним часом прибуття, дедуп на випадок
            // (теоретично малоймовірного) перетину двох timeCandidate-вікон.
            val sortedDepartures = departures
                .distinctBy { it.route to it.direction to it.scheduledTime }
                .sortedBy { it.minutesLeft }
                .take(20)

            call.respond(sortedDepartures)
        }
    }
}
