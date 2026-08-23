package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greater
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.transactions.transaction

@Serializable
data class UpcomingStop(
    val name: String,
    val eta: String, // "HH:MM", локальний час Любліна
)

@Serializable
data class UpcomingStopsResponse(
    val reportId: Int,
    val route: String,
    val direction: String?,
    val upcomingStops: List<UpcomingStop>,
)

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

                val upcoming = TripStops.selectAll()
                    .where { (TripStops.tripId eq tripId) and (TripStops.stopSequence greater currentSequence) }
                    .orderBy(TripStops.stopSequence, SortOrder.ASC)
                    .map {
                        val minutes = it[TripStops.departureMinutes] % (24 * 60) // нормалізуємо 24:xx -> 00:xx для показу
                        UpcomingStop(
                            name = it[TripStops.stopName],
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
    }
}
