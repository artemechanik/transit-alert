package com.artem.transitalert

import java.time.LocalDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RoutingAlternativesTest {
    private val time = LocalDateTime.of(2026, 10, 29, 13, 30)
    private val starts = listOf("2231" to 0)
    private val targets = mapOf("2231" to 9, "3113" to 4)

    private fun bus(trip: String, departure: Int, arrival: Int) =
        RouteEdge("2231", "3113", trip, trip, "test", departure, arrival, 1)

    private fun withGraph(edges: List<RouteEdge>, check: () -> Unit) {
        val savedEdges = TransitGraph.edgesByDate
        val savedLoaded = TransitGraph.isLoaded
        try {
            TransitGraph.edgesByDate = mapOf(time.toLocalDate() to edges.groupBy { it.fromStopId })
            TransitGraph.isLoaded = true
            check()
        } finally {
            TransitGraph.edgesByDate = savedEdges
            TransitGraph.isLoaded = savedLoaded
        }
    }

    @Test
    fun `walking winner does not hide two distinct transit alternatives`() {
        withGraph(listOf(bus("7", 811, 817), bus("156", 817, 823))) {
            val fastest = TransitGraph.findBestRoute(starts, targets, time)!!
            assertTrue(fastest.all { it.tripId == "WALK" })
            assertEquals(819, fastest.last().arrivalMin)

            val alternatives = TransitGraph.findRouteAlternatives(starts, targets, time)
            assertEquals(listOf("7", "156"), alternatives.map { path -> path.first().tripId })
            assertEquals(listOf(821, 827), alternatives.map { it.last().arrivalMin })
            assertTrue(alternatives.all { path -> path.any { it.tripId != "WALK" } })
        }
    }

    @Test
    fun `transit requirement and trip exclusions work for stop targets`() {
        withGraph(listOf(bus("7", 811, 817), bus("156", 817, 823))) {
            val stopTargets = mapOf("2231" to 0, "3113" to 0)
            val path = TransitGraph.findBestRoute(
                starts, stopTargets, time, excludedTripIds = setOf("7"), requireTransit = true
            )!!
            assertEquals("156", path.first().tripId)
            assertEquals("3113", path.last().toStopId)
        }
    }

    @Test
    fun `walking state does not suppress transit state at same stop`() {
        val edges = listOf(
            RouteEdge("2231", "hub", "Пішки", "WALK", "WALK", 0, 1, 0),
            RouteEdge("2231", "bus-stop", "7", "trip", "test", 810, 811, 1),
            RouteEdge("bus-stop", "hub", "Пішки", "WALK", "WALK", 0, 1, 0)
        )
        withGraph(edges) {
            val path = TransitGraph.findBestRoute(starts, mapOf("hub" to 3), time, requireTransit = true)!!
            assertEquals(815, path.last().arrivalMin)
            assertTrue(path.any { it.tripId == "trip" })
        }
    }

    @Test
    fun `walking-only journey is not returned as a transit alternative`() {
        withGraph(emptyList()) {
            assertNull(TransitGraph.findBestRoute(starts, targets, time, requireTransit = true))
            assertTrue(TransitGraph.findRouteAlternatives(starts, targets, time).isEmpty())
        }
    }

    @Test
    fun `fifteen minute allowance is measured from walking winner`() {
        withGraph(listOf(bus("within", 811, 830), bus("outside", 812, 831))) {
            val alternatives = TransitGraph.findRouteAlternatives(starts, targets, time)
            assertEquals(1, alternatives.size)
            assertEquals("within", alternatives.single().first().tripId)
            assertEquals(834, alternatives.single().last().arrivalMin)
        }
        withGraph(listOf(bus("outside", 812, 831))) {
            assertTrue(TransitGraph.findRouteAlternatives(starts, targets, time).isEmpty())
        }
    }

    @Test
    fun `transit winner still returns another direct trip`() {
        withGraph(listOf(bus("7", 811, 813), bus("156", 814, 817))) {
            val alternatives = TransitGraph.findRouteAlternatives(starts, targets, time)
            assertEquals(listOf("7", "156"), alternatives.map { it.first().tripId })
        }
    }

    @Test
    fun `subsequent search advances by transit departure rather than walking minute`() {
        val edges = (0..9).map { bus("trip-$it", 811 + it * 3, 817 + it * 3) }
        withGraph(edges) {
            val trips = linkedSetOf<String>()
            var minute = 810
            var searches = 0
            while (trips.size < 8 && searches < 150) {
                searches++
                val alternatives = TransitGraph.findRouteAlternatives(starts, targets, time.withMinute(minute % 60))
                assertTrue(alternatives.isNotEmpty())
                val signatures = alternatives.map { path -> path.filter { it.tripId != "WALK" }.map { it.tripId }.distinct() }
                assertEquals(signatures.size, signatures.distinct().size)
                signatures.forEach { trips.addAll(it) }
                minute = alternatives.first().first { it.tripId != "WALK" }.departureMin + 1
            }
            assertEquals(8, trips.size)
            assertTrue(searches < 8)
        }
    }
}
