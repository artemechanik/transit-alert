package com.artem.transitalert

import kotlin.test.Test
import kotlin.test.assertEquals

class NearbyPlatformOrderTest {
    @Test
    fun `платформи Park Bronowice повертаються за зростанням номера`() {
        val stops = listOf("04", "03", "02", "01").map { TempStop(it, "Park Bronowice", it, 20.0) }
        assertEquals(listOf("01", "02", "03", "04"), stops.sortedWith(nearbyPlatformOrder).map { it.code })
    }

    @Test
    fun `номер порівнюється чисельно а всі окремі платформи зберігаються`() {
        val stops = listOf("55", "2", "51", "10", "1", "52").map { TempStop(it, "Stop", it, 20.0) }
        assertEquals(listOf("1", "2", "10", "51", "52", "55"), stops.sortedWith(nearbyPlatformOrder).map { it.code })
        val sameCode = listOf(TempStop("a", "Depot", "", 1.0), TempStop("b", "Depot", "", 2.0))
        assertEquals(sameCode, sameCode.sortedWith(nearbyPlatformOrder))
    }
}
