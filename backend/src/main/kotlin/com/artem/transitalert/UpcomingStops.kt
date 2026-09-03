package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.JoinType
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.transactions.transaction


fun Application.upcomingStopsRoutes() {
    routing {
        get("/reports/{id}/upcoming-stops") {
            val id = call.parameters["id"]?.toIntOrNull()
            if (id == null) {
                call.respond(HttpStatusCode.BadRequest)
                return@get
            }

            val result = transaction {
                val report = Reports.selectAll().where { Reports.id eq id }.limit(1).firstOrNull()
                    ?: return@transaction "not_found"

                val tripId = report[Reports.tripId]
                    ?: return@transaction "no_route" // допис без вказаної лінії — тут немає що показувати

                // Знаходимо на якій позиції в рейсі була та зупинка, де написали допис
                val currentStopRow = TripStops.selectAll()
                    .where { (TripStops.tripId eq tripId) and (TripStops.stopId eq report[Reports.stopId]) }
                    .limit(1)
                    .firstOrNull()
                    ?: return@transaction "no_route"

                val currentSequence = currentStopRow[TripStops.stopSequence]

                val upcoming = TripStops
                    .join(Stops, JoinType.INNER) { TripStops.stopId eq Stops.stopId }
                    .selectAll()
                    .where { (TripStops.tripId eq tripId) and (TripStops.stopSequence greaterEq currentSequence) }
                    .orderBy(TripStops.stopSequence, SortOrder.ASC)
                    .map {
                        val minutes = it[TripStops.departureMinutes] % (24 * 60)
                        UpcomingStop(
                            stopId = it[TripStops.stopId],
                            name = it[TripStops.stopName],
                            platformCode = it[Stops.code],
                            eta = "%02d:%02d".format(minutes / 60, minutes % 60),
                        )
                    }

                UpcomingStopsResponse(
                    reportId = id,
                    route = report[Reports.route] ?: "",
                    direction = report[Reports.direction],
                    upcomingStops = upcoming,
                )
            }

            when (result) {
                is UpcomingStopsResponse -> call.respond(result)
                "not_found" -> call.respond(HttpStatusCode.NotFound)
                else -> call.respond(HttpStatusCode.OK, mapOf("upcomingStops" to emptyList<UpcomingStop>()))
            }
        }

        // Той самий принцип, що й вище, але без прив'язки до конкретного допису —
        // потрібно для розгортання картки в табло Przystanek, де tripId+stopId
        // вже відомі напряму з розкладу, без створення проміжного допису.
        get("/trips/{tripId}/upcoming-stops") {
            val tripId = call.parameters["tripId"]
            val fromStopId = call.request.queryParameters["fromStopId"]
            if (tripId == null || fromStopId == null) {
                call.respond(HttpStatusCode.BadRequest, "Потрібні tripId і fromStopId")
                return@get
            }

            val result = transaction {
                val currentStopRow = TripStops.selectAll()
                    .where { (TripStops.tripId eq tripId) and (TripStops.stopId eq fromStopId) }
                    .limit(1)
                    .firstOrNull() ?: return@transaction null

                val currentSequence = currentStopRow[TripStops.stopSequence]

                TripStops
                    .join(Stops, JoinType.INNER) { TripStops.stopId eq Stops.stopId }
                    .selectAll()
                    .where { (TripStops.tripId eq tripId) and (TripStops.stopSequence greaterEq currentSequence) }
                    .orderBy(TripStops.stopSequence, SortOrder.ASC)
                    .map {
                        val minutes = it[TripStops.departureMinutes] % (24 * 60)
                        UpcomingStop(
                            stopId = it[TripStops.stopId],
                            name = it[TripStops.stopName],
                            platformCode = it[Stops.code],
                            eta = "%02d:%02d".format(minutes / 60, minutes % 60),
                        )
                    }
            }

            if (result == null) call.respond(HttpStatusCode.NotFound) else call.respond(result)
        }
    }
}
