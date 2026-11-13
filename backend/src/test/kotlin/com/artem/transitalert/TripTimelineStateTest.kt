package com.artem.transitalert

import com.google.transit.realtime.GtfsRealtime as G
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.*
import java.time.Instant
import kotlin.test.*

class TripTimelineStateTest {
    private val trip = "timeline"
    private fun feed(seq: Int? = null, status: G.VehiclePosition.VehicleStopStatus? = null,
                     timestamp: Long? = null, gps: Boolean = true, present: Boolean = true): G.FeedMessage {
        val v = G.VehiclePosition.newBuilder().setTrip(G.TripDescriptor.newBuilder().setTripId(trip))
        if (seq != null) v.currentStopSequence = seq
        if (status != null) v.currentStatus = status
        if (timestamp != null) v.timestamp = timestamp
        if (gps) v.setPosition(G.Position.newBuilder().setLatitude(51f).setLongitude(22f).setBearing(123f))
        val f = G.FeedMessage.newBuilder().setHeader(G.FeedHeader.newBuilder().setGtfsRealtimeVersion("2.0"))
        if (present) f.addEntity(G.FeedEntity.newBuilder().setId("v").setVehicle(v))
        return G.FeedMessage.parseFrom(f.build().toByteArray())
    }
    private fun update(seq: Int? = null, status: G.VehiclePosition.VehicleStopStatus? = null, timestamp: Long? = null) {
        LiveVehiclesCache.updatePositions(feed(seq, status, timestamp), emptyMap())
    }
    @AfterTest fun clear() { LiveVehiclesCache.updatePositions(feed(present = false), emptyMap()) }

    @Test fun `explicit statuses survive and absent fields remain unknown`() {
        for (status in listOf(G.VehiclePosition.VehicleStopStatus.STOPPED_AT,
            G.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO, G.VehiclePosition.VehicleStopStatus.INCOMING_AT)) {
            update(7, status, 1000)
            val live = tripLiveState(trip, LiveVehiclesCache.byTripId(trip), 1000)
            assertEquals(status.name, live.currentStatus)
            assertEquals(7, live.currentStopSequence)
            assertEquals(1000L, live.gpsTimestamp)
            assertTrue(live.isFresh)
            assertEquals(123f, live.bearing)
        }
        update()
        val pos = assertNotNull(LiveVehiclesCache.byTripId(trip))
        assertNull(pos.currentStatus); assertNull(pos.currentStopSequence)
        assertNull(tripLiveState(trip, pos, 1000).gpsTimestamp)
        assertFalse(tripLiveState(trip, pos, 1000).isFresh)
        update(0); assertEquals(0, LiveVehiclesCache.byTripId(trip)?.currentStopSequence)
    }
    @Test fun `freshness matches routing at stale future missing and inclusive boundaries`() {
        for (timestamp in listOf(0L, 699L, 700L, 1000L, 1001L)) {
            update(3, timestamp = timestamp)
            val pos = assertNotNull(LiveVehiclesCache.byTripId(trip))
            val state = tripLiveState(trip, pos, 1000)
            assertEquals(trip in routingLiveSnapshot(listOf(pos), 1000), state.isFresh)
            assertEquals(timestamp in 700L..1000L, state.isFresh)
        }
    }
    @Test fun `sequence jumps never mutate prior snapshot or interpolate observations`() {
        update(2, G.VehiclePosition.VehicleStopStatus.STOPPED_AT, 1000)
        val before = tripLiveState(trip, LiveVehiclesCache.byTripId(trip), 1000)
        update(12, G.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO, 1010)
        assertEquals(12, LiveVehiclesCache.byTripId(trip)?.currentStopSequence)
        assertEquals(2, before.currentStopSequence); assertEquals("STOPPED_AT", before.currentStatus)
        update(1, timestamp = 1020); assertEquals(1, LiveVehiclesCache.byTripId(trip)?.currentStopSequence)
    }
    @Test fun `GPS disappearance removes all prior state`() {
        update(7, G.VehiclePosition.VehicleStopStatus.STOPPED_AT, 1000)
        LiveVehiclesCache.updatePositions(feed(gps = false), emptyMap())
        assertNull(LiveVehiclesCache.byTripId(trip))
        val state = tripLiveState(trip, null, 1000)
        assertEquals(trip, state.tripId); assertFalse(state.isFresh)
        assertNull(state.gpsTimestamp); assertNull(state.currentStatus); assertNull(state.currentStopSequence)
        assertNull(state.bearing)
        update(9, timestamp = 1000); clear(); assertNull(LiveVehiclesCache.byTripId(trip))
    }
    private fun stop(id: String, sequence: Int) = UpcomingStop(stopId = id, stopSequence = sequence, name = id, eta = "10:00")
    @Test fun `HTTP legacy array and opt-in snapshot distinguish repeated stops without changing isPassed`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            upcomingStopsRoutes { listOf(stop("a", 1), stop("b", 4), stop("a", 9), stop("c", 15)) }
        }
        update(9, G.VehiclePosition.VehicleStopStatus.STOPPED_AT, Instant.now().epochSecond - 301)
        val url = "/trips/$trip/upcoming-stops?fromStopId=a"
        val legacy = client.get(url)
        assertEquals(HttpStatusCode.OK, legacy.status)
        val array = Json.parseToJsonElement(legacy.bodyAsText()).jsonArray
        assertEquals(listOf(1,4,9,15), array.map { it.jsonObject.getValue("stopSequence").jsonPrimitive.int })
        assertTrue(array[0].jsonObject.getValue("isPassed").jsonPrimitive.boolean)
        assertFalse(array[2].jsonObject.getValue("isPassed").jsonPrimitive.boolean)
        assertEquals(HttpStatusCode.Conflict, client.get("$url&includeLive=true").status)
        val selected = client.get("$url&includeLive=true&fromStopSequence=9")
        assertEquals(HttpStatusCode.OK, selected.status)
        val obj = Json.parseToJsonElement(selected.bodyAsText()).jsonObject
        assertEquals(listOf(9,15), obj.getValue("stops").jsonArray.map { it.jsonObject.getValue("stopSequence").jsonPrimitive.int })
        val live = obj.getValue("live").jsonObject
        assertEquals("STOPPED_AT", live.getValue("currentStatus").jsonPrimitive.content)
        assertEquals(9, live.getValue("currentStopSequence").jsonPrimitive.int)
        assertFalse(live.getValue("isFresh").jsonPrimitive.boolean)
        assertEquals(HttpStatusCode.NotFound, client.get("$url&fromStopSequence=4").status)
        assertEquals(HttpStatusCode.BadRequest, client.get("$url&fromStopSequence=no").status)
        clear()
        val absent = Json.parseToJsonElement(client.get("$url&includeLive=true&fromStopSequence=9").bodyAsText()).jsonObject.getValue("live").jsonObject
        assertFalse(absent.getValue("isFresh").jsonPrimitive.boolean)
        assertEquals(JsonNull, absent.getValue("currentStopSequence"))
    }

    @Test fun `HTTP response uses a single observation when cache changes while loading stops`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            upcomingStopsRoutes {
                update(20, G.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO, 2000)
                listOf(stop("a", 1), stop("b", 10))
            }
        }
        update(5, G.VehiclePosition.VehicleStopStatus.STOPPED_AT, 1000)
        val obj = Json.parseToJsonElement(client.get(
            "/trips/$trip/upcoming-stops?fromStopId=a&includeLive=true").bodyAsText()).jsonObject
        assertEquals(5, obj.getValue("live").jsonObject.getValue("currentStopSequence").jsonPrimitive.int)
        assertFalse(obj.getValue("stops").jsonArray[1].jsonObject.getValue("isPassed").jsonPrimitive.boolean)
        assertEquals(20, LiveVehiclesCache.byTripId(trip)?.currentStopSequence)
    }
    @Test fun `approach mode returns full sequence with unchanged boarding and coherent coordinates`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            upcomingStopsRoutes { listOf(stop("a", 1), stop("b", 4), stop("a", 9), stop("c", 15)) }
        }
        update(4, G.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO, Instant.now().epochSecond)
        val url = "/trips/$trip/upcoming-stops?fromStopId=a&fromStopSequence=9"
        val obj = Json.parseToJsonElement(client.get("$url&includeLive=true&includePrevious=true").bodyAsText()).jsonObject
        assertEquals(9, obj.getValue("boardingStopSequence").jsonPrimitive.int)
        assertEquals(listOf(1,4,9,15), obj.getValue("stops").jsonArray.map { it.jsonObject.getValue("stopSequence").jsonPrimitive.int })
        val live = obj.getValue("live").jsonObject
        assertEquals(51.0, live.getValue("lat").jsonPrimitive.double)
        assertEquals(22.0, live.getValue("lon").jsonPrimitive.double)
        assertTrue(live.getValue("isFresh").jsonPrimitive.boolean)
        val legacy = Json.parseToJsonElement(client.get("$url&includePrevious=true").bodyAsText()).jsonArray
        assertEquals(listOf(9,15), legacy.map { it.jsonObject.getValue("stopSequence").jsonPrimitive.int })
        clear()
        val absent = Json.parseToJsonElement(client.get("$url&includeLive=true").bodyAsText()).jsonObject.getValue("live").jsonObject
        assertTrue(absent["lat"] == null || absent["lat"] == JsonNull)
        assertTrue(absent["lon"] == null || absent["lon"] == JsonNull)
    }

}
