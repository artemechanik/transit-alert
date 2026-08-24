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

        // 1б. Жива позиція ОДНОГО конкретного рейсу — для "показати на мапі"
        // з розгорнутої картки табло (без потреби тягнути й фільтрувати всіх автобусів).
        get("/live-vehicles/{tripId}") {
            val tripId = call.parameters["tripId"]
            if (tripId == null) {
                call.respond(HttpStatusCode.BadRequest)
                return@get
            }

            val pos = LiveVehiclesCache.byTripId(tripId)
            if (pos == null) {
                call.respond(HttpStatusCode.NotFound, "Немає живих GPS-даних для цього рейсу")
                return@get
            }

            val route = transaction {
                StopDepartures.selectAll()
                    .where { StopDepartures.tripId eq tripId }
                    .limit(1)
                    .firstOrNull()
                    ?.get(StopDepartures.route)
            } ?: ""

            call.respond(
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
            )
        }

        // 2. Розклад (відправлення) для конкретної платформи з урахуванням Real-Time
        get("/stops/{stopId}/departures") {
            val stopId = call.parameters["stopId"]
            if (stopId == null) {
                call.respond(HttpStatusCode.BadRequest, "Missing stopId")
                return@get
            }
            val timeOffset = call.request.queryParameters["offset"]?.toIntOrNull() ?: 0
            
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

                                        // Зміщуємо вікно пошуку на timeOffset хвилин
                    val windowStart = minuteBase + timeOffset - 60 
                    val windowEnd = minuteBase + timeOffset + 1440
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
                                (StopDepartures.departureMinutes greaterEq windowStart) and
                                (StopDepartures.departureMinutes lessEq windowEnd)
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
                                                        // РОЗУМНИЙ БУФЕР ОЧІКУВАННЯ (Grace Period)
                            val hideThresholdSeconds = if (isRealTime) -120 else -300

                            // ВАЖЛИВО: Ховаємо старі рейси ТІЛЬКИ якщо ми не просимо історію (timeOffset >= 0)
                            if (timeOffset >= 0 && secondsLeft < hideThresholdSeconds) return@forEach


                            val minutesLeft = secondsLeft / 60

                            val h = (scheduledMin / 60) % 24
                            val m = scheduledMin % 60

                            collected += StopDepartureDto(
                                route = row[StopDepartures.route],
                                direction = row[TripHeadsigns.headsign],
                                scheduledTime = "%02d:%02d".format(h, m),
                                minutesLeft = minutesLeft,
                                isRealTime = isRealTime,
                                delayMinutes = delaySec / 60,
                                vehicleId = liveData?.vehicleLabel,
                                tripId = tripId
                            )

                        }
                }

                collected
            }

            // Сортуємо фінальний список за реальним часом прибуття, дедуп на випадок
            // (теоретично малоймовірного) перетину двох timeCandidate-вікон.
                        val sortedDepartures = departures
                // Спочатку піднімаємо рейси з GPS наверх (щоб вони вижили при склеюванні)
                .sortedByDescending { it.isRealTime } 
                // Склеюємо ТІЛЬКИ якщо збігається маршрут, напрямок і час за розкладом
                .distinctBy { "${it.route}|${it.direction.trim()}|${it.scheduledTime}" }
                // Сортуємо фінальний список за часом, що залишився
                .sortedBy { it.minutesLeft }
                .take(40)

            call.respond(sortedDepartures)
        }
    }
}
