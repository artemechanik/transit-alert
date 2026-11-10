package com.artem.transitalert

import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import java.nio.file.Files
import java.sql.DriverManager
import kotlin.test.*

class PoiAddressTest {
    @Test fun partialMissingAndConflictingAddresses() {
        assertEquals("Fabryczna, Lublin",PoiAddress.format(listOf("Fabryczna" to "Lublin"),"Lublin").subtitle)
        assertEquals("full",PoiAddress.format(listOf("ul. Elektryczna 13–15" to "Świdnik"),"Świdnik").status)
        assertEquals("partial",PoiAddress.format(listOf("Fabryczna" to "Lublin"),"Lublin").status)
        assertEquals("Lublin",PoiAddress.format(emptyList(),"Lublin").subtitle)
        assertEquals("Lublin",PoiAddress.format(listOf("A 1" to "Lublin","A 2" to "Lublin"),"Lublin").subtitle)
        assertEquals("A 1, Lublin",PoiAddress.format(listOf("A 1" to "Lublin","A 1" to "Lublin"),"Lublin").subtitle)
        // Separate sites of the same brand receive only their own source address.
        assertEquals("A 2, Świdnik",PoiAddress.format(listOf("A 2" to "Świdnik"),"Świdnik").subtitle)
        assertEquals("partial",PoiAddress.format(listOf("A 1" to ""),"Lublin").status)
    }
    @Test fun ownerKnowledgeStaysScopedToExistingSites()=runBlocking {
        assumeTrue(Files.isRegularFile(PoiSearch.configuredPath()))
        val service=PoiSearch()
        val checks=mapOf(
            "art bet" to "ul. Antoniny Grygowej 5A, Lublin",
            "biomed" to "ul. Główna 34, Lublin",
            "stokrotka" to "ul. Mełgiewska 7–9, Lublin",
            "margomed" to "ul. Pancerniaków 27 / Al. Wincentego Witosa 38, Lublin",
            "winged" to "ul. Wrotkowska 2, Lublin",
            "elektryczna" to "ul. Elektryczna 13–15, Świdnik")
        for((q,label) in checks.filterKeys { it!="elektryczna" }) assertTrue(service.search(q,50).any { it.subtitle==label },q)
        val a=service.search("art bed",50).first { it.id=="poi:33f4b578e10e3774dec3" }
        assertEquals("Art-Bet Wytwórnia Betonu Sp. J.",a.display_name)
        assertEquals(51.24186,a.lat,0.00001)
        assertEquals("full",service.search("lubelska agencja ochrony",50).first().address_status)
    }
    @Test fun realSourcesAndCoverage()=runBlocking {
        assumeTrue(Files.isRegularFile(PoiSearch.configuredPath()))
        val service=PoiSearch()
        assertEquals("Orkana 6, Lublin",service.search("galeria orkana").first().subtitle)
        assertEquals("Orkana 4, Lublin",service.search("galeria mozaika").first().subtitle)
        assertEquals("Vetterów 14, Lublin",service.search("ball packing").first().subtitle)
        assertEquals("Wacława Moritza 3, Lublin",service.search("aliplast",50).first { it.id=="poi:0266c3292a806df8c573" }.subtitle)
        assertEquals("Wrotkowska 1, Lublin",service.search("lubella",50).first { it.id=="poi:c13dd5d066d11f25638f" }.subtitle)
        assertEquals("Działkowa 45, Lublin",service.search("lubella",50).first { it.id=="poi:81f12419d2966e9ba933" }.subtitle)
        assertEquals("al. Lotników Polskich 1, Świdnik",service.search("pzl swidnik",50).first().subtitle)
        val perla=service.search("perla",50).filter { it.display_name=="Perła — Browary Lubelskie" }
        assertEquals(2,perla.size)
        assertEquals("Władysława Kunickiego 106, Lublin",perla.first { it.id=="poi:107ffba1cc4379e3eb38" }.subtitle)
        assertEquals("Bernardyńska 15, Lublin",perla.first { it.id=="poi:e08fd9ff60f859f28174" }.subtitle)
        assertNotEquals(perla[0].lat,perla[1].lat)
        DriverManager.getConnection("jdbc:sqlite:"+PoiSearch.configuredPath().toAbsolutePath().toUri()+"?mode=ro").use { c ->
            val counts=mutableMapOf<String,Int>()
            c.createStatement().use { s -> s.executeQuery("SELECT p.id,p.gmina FROM pois p JOIN search_presentations sp ON sp.poi_id=p.id WHERE sp.visible=1").use { rs ->
                while(rs.next()) {
                    val address=PoiAddress.read(c,rs.getString(1),rs.getString(2))
                    counts[address.status]=counts.getOrDefault(address.status,0)+1
                    assertFalse(address.subtitle.contains(Regex("\\d{2}\\.\\d{5}")))
                }
            } }
            assertEquals(406,counts.values.sum())
            println("POI_ADDRESS_COVERAGE $counts")
        }
    }
}
