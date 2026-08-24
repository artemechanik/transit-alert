package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction
import kotlin.math.*

data class TempStop(val stopId: String, val name: String, val code: String, val distance: Double)

fun Application.stopRoutes() {
    routing {
        get("/stops/nearby") {
            val latStr = call.request.queryParameters["lat"]
            val lonStr = call.request.queryParameters["lon"]

            if (latStr == null || lonStr == null) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing lat or lon parameters"))
                return@get
            }

            val userLat = latStr.toDoubleOrNull()
            val userLon = lonStr.toDoubleOrNull()

            if (userLat == null || userLon == null) {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid coordinates"))
                return@get
            }

            val nearbyGroups = transaction {
                Stops.selectAll().map { row ->
                    TempStop(
                        stopId = row[Stops.stopId],
                        name = row[Stops.name],
                        code = row[Stops.code],
                        distance = calculateDistance(
                            userLat, userLon,
                            row[Stops.lat], row[Stops.lon]
                        )
                    )
                }
                .filter { it.distance <= 1500.0 } // Фільтр увімкнено!
                .groupBy { it.name }
                .mapNotNull { (groupName, stopsInGroup) ->
                    val minDistance = stopsInGroup.minOf { it.distance }
                    
                    NearbyGroupDto(
                        name = groupName,
                        distance = minDistance.roundToLong(),
                        stops = stopsInGroup.map { tempStop ->
                            
                            // Дістаємо унікальні маршрути та напрямки для цієї платформи
                            val platformRoutes = StopDepartures
                                .join(TripHeadsigns, JoinType.INNER, onColumn = StopDepartures.tripId, otherColumn = TripHeadsigns.tripId)
                                .select(StopDepartures.route, TripHeadsigns.headsign)
                                .where { StopDepartures.stopId eq tempStop.stopId }
                                .withDistinct()
                                .map { row ->
                                    RoutePillDto(
                                        route = row[StopDepartures.route],
                                        direction = row[TripHeadsigns.headsign]
                                    )
                                }
                                .distinctBy { it.route to it.direction.trim() }
                                .sortedBy { it.route.toIntOrNull() ?: 9999 } // Сортуємо за номером (14, 17, 150)

                            NearbyStopDto(
                                stopId = tempStop.stopId, 
                                name = tempStop.name, 
                                code = tempStop.code, 
                                routes = platformRoutes
                            ) 
                        }
                    )
                }
                .sortedBy { it.distance }
                .take(8)
            }

            call.respond(nearbyGroups)
        }
    }
}

fun calculateDistance(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
    val earthRadius = 6371000.0
    val dLat = Math.toRadians(lat2 - lat1)
    val dLon = Math.toRadians(lon2 - lon1)
    val originLat = Math.toRadians(lat1)
    val destinationLat = Math.toRadians(lat2)

    val a = sin(dLat / 2).pow(2) + cos(originLat) * cos(destinationLat) * sin(dLon / 2).pow(2)
    val c = 2 * atan2(sqrt(a), sqrt(1 - a))

    return earthRadius * c
}