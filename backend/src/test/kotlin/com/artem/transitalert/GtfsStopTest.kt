package com.artem.transitalert

import kotlin.test.Test
import kotlin.test.assertEquals

class GtfsStopTest {
    @Test
    fun `NŻ додається лише за явною ознакою посадки або висадки на вимогу`() {
        for ((pickup, dropOff) in listOf("3" to "0", "0" to "3", "3" to "3")) {
            val stop = normalizeGtfsStop(
                mapOf("stop_id" to "vetterow02-n2t46", "stop_name" to "Vetterów 02"),
                isGtfsOnDemandStop(pickup, dropOff),
            )
            assertEquals("Vetterów NŻ", stop["stop_name"])
            assertEquals("02", stop["stop_code"])
            assertEquals("vetterow02-n2t46", stop["stop_id"])
        }
        for ((pickup, dropOff) in listOf(null to null, "" to "", "0" to "0", "1" to "1", "2" to "2")) {
            val stop = normalizeGtfsStop(
                mapOf("stop_name" to "Brama Krakowska 01"), isGtfsOnDemandStop(pickup, dropOff),
            )
            assertEquals("Brama Krakowska", stop["stop_name"])
            assertEquals("01", stop["stop_code"])
        }
    }

    @Test
    fun `наявне NŻ не дублюється а звичайна назва не отримує його без ознаки`() {
        val old = mapOf("stop_name" to " Vetterów NŻ ", "stop_code" to "04")
        assertEquals("Vetterów NŻ", normalizeGtfsStop(old, true)["stop_name"])
        assertEquals("Vetterów NŻ", normalizeGtfsStop(old)["stop_name"])
        assertEquals("Vetterów", normalizeGtfsStop(mapOf("stop_name" to "Vetterów 04"))["stop_name"])
    }

    @Test
    fun `новий формат зберігає базову назву та номер платформи`() {
        val examples = listOf(
            Triple("zbozowa01-i3jty", "Zbożowa 01", "Zbożowa" to "01"),
            Triple("skladowa02-ks911", "Składowa 02", "Składowa" to "02"),
            Triple("dworzec-lublin51-k8twf", "Dworzec Lublin 51", "Dworzec Lublin" to "51"),
            Triple("dolna-3-maja01-k0zni", "Dolna 3 Maja 01", "Dolna 3 Maja" to "01"),
        )
        for ((id, name, expected) in examples) {
            val stop = normalizeGtfsStop(mapOf(
                "stop_id" to id, "stop_name" to " $name ", "platform_code" to "",
                "stop_lat" to "51.0", "stop_lon" to "22.0",
            ))
            assertEquals(expected.first, stop["stop_name"])
            assertEquals(expected.second, stop["stop_code"])
            assertEquals(id, stop["stop_id"])
            assertEquals("51.0", stop["stop_lat"])
            assertEquals("22.0", stop["stop_lon"])
        }
    }

    @Test
    fun `старий формат з окремим кодом не переосмислюється`() {
        val old = mapOf("stop_id" to "7451", "stop_name" to " Dys - Zbożowa NŻ ", "stop_code" to "01")
        assertEquals(old + ("stop_name" to "Dys - Zbożowa NŻ"), normalizeGtfsStop(old))
        val withoutCode = mapOf("stop_name" to "Nazwa 51", "stop_code" to "")
        assertEquals(withoutCode, normalizeGtfsStop(withoutCode))
    }

    @Test
    fun `різні платформи мають спільну назву та окремі ID`() {
        val first = normalizeGtfsStop(mapOf("stop_id" to "zbozowa01-i3jty", "stop_name" to "Zbożowa 01"))
        val second = normalizeGtfsStop(mapOf("stop_id" to "zbozowa02-i0z8g", "stop_name" to "Zbożowa 02"))
        assertEquals(first["stop_name"], second["stop_name"])
        assertEquals(listOf("01", "02"), listOf(first["stop_code"], second["stop_code"]))
        assertEquals(listOf("zbozowa01-i3jty", "zbozowa02-i0z8g"), listOf(first["stop_id"], second["stop_id"]))
    }

    @Test
    fun `депо без номерів не отримують вигаданих платформ або спільного ID`() {
        val ids = listOf("zajezdnia-stefczyka-k4lg8", "zajezdnia-stefczyka-k4gtn")
        for (id in ids) {
            val stop = normalizeGtfsStop(mapOf("stop_id" to id, "stop_name" to "Zajezdnia Stefczyka"))
            assertEquals(id, stop["stop_id"])
            assertEquals("Zajezdnia Stefczyka", stop["stop_name"])
            assertEquals("", stop["stop_code"])
        }
    }

    @Test
    fun `окремий platform_code має пріоритет над суфіксом назви`() {
        val stop = normalizeGtfsStop(mapOf("stop_name" to "Nazwa 51", "platform_code" to "02"))
        assertEquals("Nazwa 51", stop["stop_name"])
        assertEquals("02", stop["stop_code"])
        val matching = normalizeGtfsStop(mapOf("stop_name" to "Dworzec Lublin 51", "platform_code" to "51"))
        assertEquals("Dworzec Lublin", matching["stop_name"])
        assertEquals("51", matching["stop_code"])
    }
}
