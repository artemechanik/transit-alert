package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import java.time.Instant
import org.jetbrains.exposed.sql.JoinType
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.greaterEq
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.SortOrder
import org.jetbrains.exposed.sql.transactions.transaction


internal fun loadTripTimelineStops(tripId: String): List<UpcomingStop> = transaction {
    TripStops.join(Stops, JoinType.INNER) { TripStops.stopId eq Stops.stopId }
        .selectAll().where { TripStops.tripId eq tripId }
        .orderBy(TripStops.stopSequence, SortOrder.ASC).map {
            val minutes = it[TripStops.departureMinutes] % (24 * 60)
            UpcomingStop(stopId = it[TripStops.stopId], stopSequence = it[TripStops.stopSequence],
                name = it[TripStops.stopName], platformCode = it[Stops.code],
                eta = "%02d:%02d".format(minutes / 60, minutes % 60),
                lat = it[Stops.lat], lon = it[Stops.lon])
        }
}

fun Application.upcomingStopsRoutes(
    loadStops: (String) -> List<UpcomingStop> = ::loadTripTimelineStops,
) {
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
                
                val currentSeq = LiveVehiclesCache.byTripId(tripId)?.currentStopSequence

                val upcoming = TripStops
                    .join(Stops, JoinType.INNER) { TripStops.stopId eq Stops.stopId }
                    .selectAll()
                    .where { (TripStops.tripId eq tripId) and (TripStops.stopSequence greaterEq currentSequence) }
                    .orderBy(TripStops.stopSequence, SortOrder.ASC)
                    .map {
                        val minutes = it[TripStops.departureMinutes] % (24 * 60)
                        UpcomingStop(
                            isPassed = currentSeq != null && it[TripStops.stopSequence] < currentSeq,
                            stopId = it[TripStops.stopId],
                            stopSequence = it[TripStops.stopSequence],
                            name = it[TripStops.stopName],
                            platformCode = it[Stops.code],
                            eta = "%02d:%02d".format(minutes / 60, minutes % 60),
                            lat = it[Stops.lat],
    			    lon = it[Stops.lon],
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

            val includeLive = call.request.queryParameters["includeLive"] == "true"
            val sequenceParam = call.request.queryParameters["fromStopSequence"]
            val requestedSequence = sequenceParam?.toIntOrNull()
            if (sequenceParam != null && (requestedSequence == null || requestedSequence < 0)) {
                call.respond(HttpStatusCode.BadRequest, "Invalid fromStopSequence")
                return@get
            }
            // One immutable cache entry supplies both isPassed and live metadata.
            val position = LiveVehiclesCache.byTripId(tripId)
            val live = tripLiveState(tripId, position, Instant.now().epochSecond)
            val stops = loadStops(tripId).sortedBy { it.stopSequence }
            val matches = stops.filter { it.stopId == fromStopId }
            if (includeLive && requestedSequence == null && matches.size > 1) {
                call.respond(HttpStatusCode.Conflict,
                    StopOccurrenceConflict(stopSequences = matches.mapNotNull { it.stopSequence }))
                return@get
            }
            val start = matches.firstOrNull { requestedSequence == null || it.stopSequence == requestedSequence }
            if (start == null) {
                call.respond(HttpStatusCode.NotFound)
                return@get
            }
            // Opt-in full sequence supplies approach stops without moving the boarding boundary.
            val includePrevious = includeLive && call.request.queryParameters["includePrevious"] == "true"
            val selected = (if (includePrevious) stops else stops.dropWhile { it !== start }).map { stop ->
                // Preserve legacy semantics: freshness does not change isPassed.
                stop.copy(isPassed = position?.currentStopSequence?.let { current ->
                    stop.stopSequence?.let { it < current }
                } ?: false)
            }
            if (includeLive) call.respond(TripStopsLiveResponse(selected, live, start.stopSequence))
            else call.respond(selected)
        }
    }
}
