package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction

// Вікно "ризику" навколо часу допису
private const val RISK_WINDOW_MINUTES = 10

@Serializable
data class RouteDirection(
    val route: String,
    val direction: String?, // кінцева зупинка найближчого рейсу цієї лінії
)

@Serializable
data class RiskRoutesResponse(
    val reportId: Int,
    val stopId: String,
    val routes: List<RouteDirection>,
)

fun Application.riskRoutes() {
    routing {
        get("/reports/{id}/risk-routes") {
            val id = call.parameters["id"]?.toIntOrNull()
            if (id == null) {
                call.respond(HttpStatusCode.BadRequest)
                return@get
            }

            val result = transaction {
                val report = Reports.selectAll().where { Reports.id eq id }.limit(1).firstOrNull()
                    ?: return@transaction null

                val stopId = report[Reports.stopId]
                val createdAt = report[Reports.createdAt]

                // Для кожної лінії в вікні лишаємо найближчий за часом рейс (з його напрямком)
                val bestPerRoute = mutableMapOf<String, DepartureMatch>()
                for ((date, minuteBase) in timeCandidates(createdAt)) {
                    val serviceIds = activeServiceIds(date)
                    if (serviceIds.isEmpty()) continue

                    val departures = StopDepartures.selectAll()
                        .where {
                            (StopDepartures.stopId eq stopId) and
                                (StopDepartures.serviceId inList serviceIds) and
                                (StopDepartures.departureMinutes greaterEq (minuteBase - RISK_WINDOW_MINUTES)) and
                                (StopDepartures.departureMinutes lessEq (minuteBase + RISK_WINDOW_MINUTES))
                        }

                    for (row in departures) {
                        val route = row[StopDepartures.route]
                        val diff = kotlin.math.abs(row[StopDepartures.departureMinutes] - minuteBase)
                        val existing = bestPerRoute[route]
                        if (existing == null || diff < existing.diffMinutes) {
                            bestPerRoute[route] = DepartureMatch(route, row[StopDepartures.tripId], diff)
                        }
                    }
                }

                val routes = bestPerRoute.values
                    .sortedBy { it.route }
                    .map { RouteDirection(it.route, headsignFor(it.tripId)) }

                RiskRoutesResponse(id, stopId, routes)
            }

            if (result == null) {
                call.respond(HttpStatusCode.NotFound)
            } else {
                call.respond(result)
            }
        }
    }
}
