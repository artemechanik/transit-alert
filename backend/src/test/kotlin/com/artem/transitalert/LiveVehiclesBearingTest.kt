package com.artem.transitalert

import com.google.transit.realtime.GtfsRealtime
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class LiveVehiclesBearingTest {
    private val tripId = "68c20db69b60d37f"

    @AfterTest
    fun clearCache() {
        LiveVehiclesCache.updatePositions(feed(), emptyMap())
    }

    @Test
    fun `позиція без protobuf поля bearing зберігається в кеші`() {
        LiveVehiclesCache.updatePositions(feed(vehicle(null)), emptyMap())

        val position = assertNotNull(LiveVehiclesCache.byTripId(tripId))
        assertEquals(0f, position.bearing)
        assertEquals(listOf(position), LiveVehiclesCache.all())
    }

    @Test
    fun `явний нульовий bearing зберігається`() {
        assertBearingPreserved(0f)
    }

    @Test
    fun `звичайний bearing зберігається без корекції`() {
        assertBearingPreserved(241.5f)
    }

    @Test
    fun `оновлення без bearing зберігає нову GPS позицію`() {
        LiveVehiclesCache.updatePositions(feed(vehicle(90f)), emptyMap())
        val updated = vehicle(null).toBuilder()
        updated.vehicle = updated.vehicle.toBuilder()
            .setPosition(updated.vehicle.position.toBuilder().setLongitude(22.53486f))
            .setTimestamp(1793897525L)
            .build()
        LiveVehiclesCache.updatePositions(feed(updated.build()), emptyMap())

        val position = assertNotNull(LiveVehiclesCache.byTripId(tripId))
        assertEquals(22.53486f.toDouble(), position.lon)
        assertEquals(1793897525L, position.timestamp)
        assertEquals(0f, position.bearing)
        assertEquals(listOf(position), LiveVehiclesCache.all())
    }

    private fun assertBearingPreserved(bearing: Float) {
        LiveVehiclesCache.updatePositions(feed(vehicle(bearing)), emptyMap())

        val position = assertNotNull(LiveVehiclesCache.byTripId(tripId))
        assertEquals(bearing, position.bearing)
        assertEquals("3892", position.vehicleLabel)
        assertEquals(listOf(position), LiveVehiclesCache.all())
    }

    private fun vehicle(bearing: Float?): GtfsRealtime.FeedEntity {
        val position = GtfsRealtime.Position.newBuilder()
            .setLatitude(51.24131f)
            .setLongitude(22.54498f)
        if (bearing != null) position.setBearing(bearing)

        return GtfsRealtime.FeedEntity.newBuilder()
            .setId("vehiclePosition/default/11:3892")
            .setVehicle(GtfsRealtime.VehiclePosition.newBuilder()
                .setVehicle(GtfsRealtime.VehicleDescriptor.newBuilder().setId("11:3892").setLabel("3892"))
                .setTrip(GtfsRealtime.TripDescriptor.newBuilder().setTripId(tripId).setRouteId("153"))
                .setPosition(position)
                .setCurrentStopSequence(17)
                .setTimestamp(1793897505L))
            .build()
    }

    private fun feed(vararg entities: GtfsRealtime.FeedEntity): GtfsRealtime.FeedMessage {
        val feed = GtfsRealtime.FeedMessage.newBuilder()
            .setHeader(GtfsRealtime.FeedHeader.newBuilder().setGtfsRealtimeVersion("2.0"))
            .addAllEntity(entities.toList())
            .build()
        return GtfsRealtime.FeedMessage.parseFrom(feed.toByteArray())
    }
}
