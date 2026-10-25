package com.artem.transitalert

import java.time.Instant
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals

class GtfsTimeTest {
    @Test
    fun `доба переходу на зимовий час`() {
        assertEquals(Instant.parse("2026-10-25T04:22:00Z"), gtfsInstant(LocalDate.of(2026, 10, 25), 322))
    }

    @Test
    fun `доба переходу на літній час`() {
        assertEquals(Instant.parse("2027-03-28T03:22:00Z"), gtfsInstant(LocalDate.of(2027, 3, 28), 322))
    }

    @Test
    fun `звичайна доба`() {
        assertEquals(Instant.parse("2026-08-14T03:22:00Z"), gtfsInstant(LocalDate.of(2026, 8, 14), 322))
    }
}
