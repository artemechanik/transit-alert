package com.artem.transitalert

import com.google.transit.realtime.GtfsRealtime
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.*
import java.time.LocalDate
import kotlin.test.*

class LiveVehiclesDelayTest {
    private val tripId = "stale"
    private val date = LocalDate.of(2026, 11, 5)
    private val scheduledMinute = 600

    @AfterTest
    fun clearCache() {
        LiveVehiclesCache.updatePositions(feed(null, includeVehicle = false), emptyMap())
    }

    @Test fun `119 хвилин допустимо`() = assertAccepted(119 * 60)
    @Test fun `рівно 7200 секунд допустимо`() = assertAccepted(7200)
    @Test fun `121 хвилина відхиляється`() = assertRejected(121 * 60)
    @Test fun `7201 секунда відхиляється без округлення`() = assertRejected(7201)

    @Test
    fun `без прогнозу позиція залишається`() {
        update(null)
        assertNull(assertNotNull(LiveVehiclesCache.byTripId(tripId)).delaySeconds)
    }

    @Test
    fun `без планового часу позиція залишається`() {
        LiveVehiclesCache.updatePositions(feed(121 * 60), emptyMap())
        assertNull(assertNotNull(LiveVehiclesCache.byTripId(tripId)).delaySeconds)
    }

    @Test
    fun `оновлення видаляє весь live запис і наступне допустиме повертає його`() {
        update(7200)
        assertEquals(17, assertNotNull(LiveVehiclesCache.byTripId(tripId)).currentStopSequence)
        update(7201)
        assertNull(LiveVehiclesCache.byTripId(tripId))
        assertTrue(LiveVehiclesCache.all().isEmpty())
        update(60)
        assertEquals(60, assertNotNull(LiveVehiclesCache.byTripId(tripId)).delaySeconds)
    }

    @Test
    fun `відфільтрований запис недоступний через GPS та delays ендпоінти`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            liveVehiclesRoutes()
        }
        update(7200)
        val before = client.get("/live-vehicles/delays?tripIds=$tripId")
        val beforeInfo = Json.parseToJsonElement(before.bodyAsText()).jsonObject.getValue(tripId).jsonObject
        assertEquals(120, beforeInfo.getValue("delayMinutes").jsonPrimitive.int)
        assertTrue(beforeInfo.getValue("isRealTime").jsonPrimitive.boolean)

        update(7201)
        val positions = client.get("/live-vehicles")
        assertEquals(HttpStatusCode.OK, positions.status)
        assertTrue(Json.parseToJsonElement(positions.bodyAsText()).jsonArray.isEmpty())
        assertEquals(HttpStatusCode.NotFound, client.get("/live-vehicles/$tripId").status)
        val delays = client.get("/live-vehicles/delays?tripIds=$tripId")
        assertEquals(HttpStatusCode.OK, delays.status)
        val info = Json.parseToJsonElement(delays.bodyAsText()).jsonObject.getValue(tripId).jsonObject
        assertEquals(0, info.getValue("delayMinutes").jsonPrimitive.int)
        assertFalse(info.getValue("isRealTime").jsonPrimitive.boolean)
    }

    @Test
    fun `недостовірна затримка не повертає минулий рейс як перший транспорт`() {
        withGraph(listOf(edge("A", "B", tripId, 500, 501), edge("A", "B", "normal", 610, 630))) {
            update(7200)
            assertEquals(tripId, route("B").first().tripId)
            update(7201)
            assertEquals("normal", route("B").first().tripId)
        }
    }

    @Test
    fun `недостовірна затримка не створює пересадку на минулий рейс`() {
        withGraph(listOf(
            edge("A", "B", "first", 610, 619),
            edge("B", "C", tripId, 500, 510),
            edge("B", "C", "normal", 625, 640),
        )) {
            update(7200)
            assertEquals(listOf("first", tripId), route("C").map { it.tripId })
            update(7201)
            val path = route("C")
            assertEquals(listOf("first", "normal"), path.map { it.tripId })
            assertEquals(625, path.last().departureMin)
            assertEquals(640, path.last().arrivalMin)
        }
    }

    // Той самий спосіб побудови матриці затримок, що використовується у FormRoutes.
    private fun route(target: String): List<RouteEdge> {
        val delays = LiveVehiclesCache.all().mapNotNull {
            val minutes = (it.delaySeconds ?: 0) / 60
            if (minutes != 0) it.tripId to minutes else null
        }.toMap()
        return assertNotNull(TransitGraph.findBestRoute(
            listOf("A" to 0), mapOf(target to 0), date.atTime(10, 0),
            liveDelays = delays, requireTransit = true,
        ))
    }

    private fun edge(from: String, to: String, trip: String, departure: Int, arrival: Int) =
        RouteEdge(from, to, trip, trip, "test", departure, arrival, 1)

    private fun withGraph(edges: List<RouteEdge>, check: () -> Unit) {
        val savedEdges = TransitGraph.edgesByDate
        val savedLoaded = TransitGraph.isLoaded
        val testGraph = mapOf(date to edges.groupBy { it.fromStopId })
        try {
            TransitGraph.edgesByDate = testGraph
            TransitGraph.isLoaded = true
            check()
            assertEquals(testGraph, TransitGraph.edgesByDate)
        } finally {
            TransitGraph.edgesByDate = savedEdges
            TransitGraph.isLoaded = savedLoaded
        }
    }

    private fun assertAccepted(seconds: Int) {
        update(seconds)
        assertEquals(seconds, assertNotNull(LiveVehiclesCache.byTripId(tripId)).delaySeconds)
        assertEquals(1, LiveVehiclesCache.all().size)
    }

    private fun assertRejected(seconds: Int) {
        update(seconds)
        assertNull(LiveVehiclesCache.byTripId(tripId))
        assertTrue(LiveVehiclesCache.all().isEmpty())
    }

    private fun update(seconds: Int?) = LiveVehiclesCache.updatePositions(
        feed(seconds), mapOf((tripId to 17) to scheduledMinute),
    )

    private fun feed(seconds: Int?, includeVehicle: Boolean = true): GtfsRealtime.FeedMessage {
        val trip = GtfsRealtime.TripDescriptor.newBuilder().setTripId(tripId).build()
        val builder = GtfsRealtime.FeedMessage.newBuilder()
            .setHeader(GtfsRealtime.FeedHeader.newBuilder().setGtfsRealtimeVersion("2.0"))
        if (includeVehicle) {
            // Bearing навмисно відсутній: він не є критерієм довіри до live-запису.
            builder.addEntity(GtfsRealtime.FeedEntity.newBuilder().setId("vehicle")
                .setVehicle(GtfsRealtime.VehiclePosition.newBuilder().setTrip(trip)
                    .setVehicle(GtfsRealtime.VehicleDescriptor.newBuilder().setId("11:3944").setLabel("3944"))
                    .setPosition(GtfsRealtime.Position.newBuilder().setLatitude(51.24f).setLongitude(22.54f))
                    .setCurrentStopSequence(17).setTimestamp(gtfsInstant(date, scheduledMinute).epochSecond)))
        }
        if (seconds != null) {
            builder.addEntity(GtfsRealtime.FeedEntity.newBuilder().setId("update")
                .setTripUpdate(GtfsRealtime.TripUpdate.newBuilder().setTrip(trip)
                    .addStopTimeUpdate(GtfsRealtime.TripUpdate.StopTimeUpdate.newBuilder().setStopSequence(17)
                        .setDeparture(GtfsRealtime.TripUpdate.StopTimeEvent.newBuilder()
                            .setTime(gtfsInstant(date, scheduledMinute).epochSecond + seconds)))))
        }
        return GtfsRealtime.FeedMessage.parseFrom(builder.build().toByteArray())
    }
}
