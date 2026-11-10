package com.artem.transitalert

import kotlin.test.*

class RoutingLiveSnapshotTest {
    private fun vehicle(id: String, timestamp: Long, delay: Int = 120) =
        VehiclePosition(id, id, 0.0, 0.0, 0f, 1, timestamp, delay)

    @Test fun `snapshot rejects stale missing and future observations`() {
        val snapshot = routingLiveSnapshot(listOf(vehicle("fresh", 1000), vehicle("edge", 700),
            vehicle("stale", 699), vehicle("missing", 0), vehicle("future", 1001)), 1000)
        assertEquals(setOf("fresh", "edge"), snapshot.keys)
    }

    @Test fun `response snapshot remains stable when source list changes`() {
        val source = mutableListOf(vehicle("trip", 1000))
        val snapshot = routingLiveSnapshot(source, 1000)
        source[0] = vehicle("trip", 1001, 600)
        assertEquals(120, snapshot.getValue("trip").delaySeconds)
    }
}
