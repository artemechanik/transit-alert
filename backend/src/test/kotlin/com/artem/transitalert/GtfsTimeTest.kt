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

class GtfsSearchStartTest {
    // Стартова хвилина пошуку маршрутів має збігатися з тим, що дає gtfsInstant
    private fun roundTrip(date: LocalDate, minutes: Int): Int {
        val searchTime = gtfsInstant(date, minutes).atZone(LUBLIN_ZONE).toLocalDateTime()
        return gtfsMinutesOfDay(searchTime)
    }

    @Test
    fun `старт пошуку в доба переходу на зимовий час`() {
        val date = LocalDate.of(2026, 10, 25)
        assertEquals(Instant.parse("2026-10-25T04:22:00Z"), gtfsInstant(date, 322))
        assertEquals(322, roundTrip(date, 322))
        assertEquals(900, roundTrip(date, 900))
    }

    @Test
    fun `старт пошуку в доба переходу на літній час`() {
        val date = LocalDate.of(2027, 3, 28)
        assertEquals(Instant.parse("2027-03-28T03:22:00Z"), gtfsInstant(date, 322))
        assertEquals(322, roundTrip(date, 322))
        assertEquals(900, roundTrip(date, 900))
    }
}
