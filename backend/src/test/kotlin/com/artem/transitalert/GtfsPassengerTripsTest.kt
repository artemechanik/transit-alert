package com.artem.transitalert

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class GtfsPassengerTripsTest {
    private fun headsigns(vararg permissions: Pair<String?, String?>): Map<String, String> {
        val index = GtfsPassengerTrips()
        permissions.forEach { (pickup, dropOff) -> index.recordStop("trip", pickup, dropOff) }
        return index.headsigns(mapOf("trip" to "last"), mapOf("last" to " Кінцева "))
    }

    @Test
    fun `звичайний 0 0 залишається без зміни напрямку`() {
        assertEquals(mapOf("trip" to "Кінцева"), headsigns("0" to "0", "0" to "0"))
    }

    @Test
    fun `усі 1 1 виключаються незалежно від кількості зупинок`() {
        for (count in listOf(1, 2, 5)) {
            assertTrue(headsigns(*Array(count) { "1" to "1" }).isEmpty())
        }
        assertTrue(headsigns().isEmpty())
    }

    @Test
    fun `3 3 залишається з наявною позначкою NŻ`() {
        val stop = normalizeGtfsStop(mapOf("stop_name" to "Vetterów 02"), isGtfsOnDemandStop("3", "3"))
        val index = GtfsPassengerTrips()
        index.recordStop("trip", "3", "3")
        assertEquals(mapOf("trip" to "Vetterów NŻ"), index.headsigns(
            mapOf("trip" to "last"), mapOf("last" to stop.getValue("stop_name")),
        ))
    }

    @Test
    fun `порожні та відсутні необовязкові поля не видаляють старі рейси`() {
        assertEquals(mapOf("trip" to "Кінцева"), headsigns(null to null, "" to ""))
    }

    @Test
    fun `одна заборонена дія не перетворює рейс на технічний`() {
        for (permission in listOf("1" to "0", "0" to "1", "1" to "3", "3" to "1", "2" to "2")) {
            assertEquals(mapOf("trip" to "Кінцева"), headsigns(permission))
        }
    }

    @Test
    fun `змішаний рейс зберігає всі зупинки й останній напрямок незалежно від порядку записів`() {
        for (permissions in listOf(
            arrayOf("1" to "1", "0" to "0", "1" to "1"),
            arrayOf("0" to "0", "1" to "1", "1" to "1"),
            arrayOf("1" to "1", "1" to "1", "3" to "3"),
            arrayOf("0" to "1", "1" to "0"),
        )) assertEquals(mapOf("trip" to "Кінцева"), headsigns(*permissions))
    }

    @Test
    fun `пасажирський індекс не змішує рейси та не змінює сирі дані для live`() {
        val index = GtfsPassengerTrips()
        val rawStops = mapOf("technical" to "garage", "ordinary" to "garage", "on-demand" to "request")
        val rawNames = mapOf("garage" to "Зупинка без спеціальної назви", "request" to "Vetterów NŻ")
        val originalStops = rawStops.toMap()
        val originalNames = rawNames.toMap()
        index.recordStop("technical", "1", "1")
        index.recordStop("ordinary", "0", "0")
        index.recordStop("on-demand", "3", "3")
        index.recordStop("technical", "1", "1")

        assertEquals(mapOf(
            "ordinary" to "Зупинка без спеціальної назви", "on-demand" to "Vetterów NŻ",
        ), index.headsigns(rawStops, rawNames))
        assertEquals(originalStops, rawStops)
        assertEquals(originalNames, rawNames)
    }
}
