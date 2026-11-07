package com.artem.transitalert

import kotlin.test.Test
import kotlin.test.assertEquals

class StopSearchTest {
    private fun stop(name: String, code: String = "01") = StopSuggestion("$name-$code", name, code, 0.0, 0.0)

    @Test
    fun `park sorts names and platforms independently of input order`() {
        val input = listOf(stop("Park Bronowice", "04"), stop("Park Akademicki", "03"),
            stop("Felin Europark"), stop("Park Bronowice", "02"), stop("Park Akademicki"))
        assertEquals(listOf("Park Akademicki-01", "Park Akademicki-03", "Park Bronowice-02",
            "Park Bronowice-04", "Felin Europark-01"), searchStops(input, "park").map { it.stopId })
        assertEquals(searchStops(input, "park"), searchStops(input.reversed(), "park"))
    }

    @Test
    fun `felin exact match comes first`() {
        val input = listOf(stop("Felin Kalinówka"), stop("Felin Uniwersytet"), stop("Felin"), stop("Felin Europark"))
        assertEquals(listOf("Felin", "Felin Europark", "Felin Kalinówka", "Felin Uniwersytet"),
            searchStops(input, "felin").map { it.name })
    }

    @Test
    fun `sw and św have identical priority and Polish alphabetical order`() {
        val input = listOf(stop("Kolonia Świdnik Mały NŻ"), stop("Świdnik stadion"),
            stop("Świętochowskiego"), stop("Świdniczek NŻ"))
        assertEquals(listOf("Świdniczek NŻ", "Świdnik stadion", "Świętochowskiego", "Kolonia Świdnik Mały NŻ"),
            searchStops(input, "sw").map { it.name })
        assertEquals(searchStops(input, "sw"), searchStops(input, "św"))
        assertEquals(listOf("Zana", "Źródło", "Żeglarska"),
            searchStops(listOf(stop("Żeglarska"), stop("Źródło"), stop("Zana")), "01").map { it.name })
    }

    @Test
    fun `five priority tiers override alphabet`() {
        val input = listOf(stop("Axxab"), stop("A-code", "ab"), stop("A-ab"), stop("Abc"), stop("Ab"))
        assertEquals(listOf("Ab", "Abc", "A-ab", "A-code", "Axxab"), searchStops(input, "ab").map { it.name })
    }

    @Test
    fun `Polish collation handles hyphens consistently`() {
        val input = listOf(stop("Świdnik - Helikopter"), stop("Świdnik Mały - szkoła", "02"),
            stop("Świdnik Mały NŻ"), stop("Świdnik Duży Pierwszy NŻ"), stop("Świdnik Duży - Leśniczówka"))
        assertEquals(listOf("Świdnik Duży - Leśniczówka", "Świdnik Duży Pierwszy NŻ",
            "Świdnik - Helikopter", "Świdnik Mały NŻ", "Świdnik Mały - szkoła"),
            searchStops(input, "sw").map { it.name })
    }

    @Test
    fun `limit is twenty platforms after ranking rather than twenty names`() {
        val input = (1..25).map { stop("Park Akademicki", it.toString()) } + stop("Park") + stop("Park Bronowice")
        val result = searchStops(input.reversed(), "park")
        assertEquals(20, result.size)
        assertEquals("Park", result.first().name)
        assertEquals((1..19).map { it.toString() }, result.drop(1).map { it.code })
        assertEquals(2, result.map { it.name }.distinct().size)
        assertEquals(result, searchStops(input, "park"))
    }
}
