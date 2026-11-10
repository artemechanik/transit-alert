package com.artem.transitalert

import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.testing.*
import io.ktor.client.request.*
import io.ktor.http.HttpStatusCode
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assume.assumeTrue
import java.nio.file.Files
import java.nio.file.Path
import java.net.URI
import java.net.URLEncoder
import java.net.http.*
import java.security.MessageDigest
import kotlin.test.*

@Serializable private data class ExpectedPoi(val id:String,val name:String,val lat:Double,val lon:Double,val category:String,val text_rank:Int)
@Serializable private data class PoiFixture(val q:String,val results:List<ExpectedPoi>)
class PoiSearchTest {
    private val path=PoiSearch.configuredPath()
    private fun fixtures()=Json.decodeFromString<List<PoiFixture>>(javaClass.getResource("/poi-query-fixtures.json")!!.readText())
    private fun hash(p:Path)=MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(p)).toList()
    @Test fun pythonParityAndIndependentFailures()=runBlocking {
        assumeTrue(Files.isRegularFile(path))
        val before=hash(path); val service=PoiSearch(path)
        for (f in fixtures()) assertEquals(f.results,service.search(f.q,50).map { ExpectedPoi(it.id,it.display_name,it.lat,it.lon,it.category!!,it.match_rank) },f.q)
        val absent=Files.createTempDirectory("poi-failure").resolve("absent.sqlite")
        val corrupt=absent.resolveSibling("corrupt.sqlite"); Files.writeString(corrupt,"not sqlite")
        for (bad in listOf(absent,corrupt)) {
            assertFailsWith<java.sql.SQLException> { PoiSearch(bad).search("ork") }
            assertTrue(PlaceSearch(PrgAddressSearch(bad),service).search("ork",4).results.any { it.type=="poi" })
            assertFailsWith<java.sql.SQLException> { PlaceSearch(PrgAddressSearch(bad),PoiSearch(bad)).search("ork",4) }
            if(Files.isRegularFile(PrgAddressSearch.configuredPath())) assertTrue(PlaceSearch(PrgAddressSearch(),PoiSearch(bad)).search("Lipowa 12",4).results.any { it.type=="address" })
        }
        assertFalse(Files.exists(absent));Files.delete(corrupt);Files.delete(absent.parent)
        val samples=mutableListOf<Double>()
        repeat(20) { for(q in listOf("ork","uniwersytet","raben")) {
            val started=System.nanoTime();service.search(q,4);samples.add((System.nanoTime()-started)/1e6)
        } }
        val rss=Path.of("/proc/self/status").takeIf { Files.isRegularFile(it) }?.let { Files.readAllLines(it).firstOrNull { line -> line.startsWith("VmRSS:") } }
        println("POI_TEST_JVM_RSS $rss")
        samples.sort();println("POI_DIRECT_WARM samples=${samples.size} p95_ms=${samples[(samples.size*.95).toInt()]}")
        assertEquals(before,hash(path))
    }
    @Test fun httpFailureIsolation() {
        assumeTrue(Files.isRegularFile(path) && Files.isRegularFile(PrgAddressSearch.configuredPath()))
        val directory=Files.createTempDirectory("poi-http-failure")
        try {
            for (failure in listOf("prg","poi","both")) testApplication {
                application {
                    install(ContentNegotiation) { json() };statusRoutes()
                    addressRoutes(PrgAddressSearch(if(failure!="poi") directory.resolve("missing-prg") else PrgAddressSearch.configuredPath()),
                        PoiSearch(if(failure!="prg") directory.resolve("missing-poi") else path))
                }
                assertEquals(HttpStatusCode.OK,client.get("/status").status)
                val query=if(failure=="poi") "Lipowa 12" else "ork"
                assertEquals(if(failure=="both") HttpStatusCode.ServiceUnavailable else HttpStatusCode.OK,
                    client.get("/addresses/search") { parameter("q",query) }.status)
            }
        } finally { Files.delete(directory) }
    }
    @Test fun mixingPreservesStreamsAndProtectsExactAddresses()=runBlocking {
        assumeTrue(Files.isRegularFile(path) && Files.isRegularFile(PrgAddressSearch.configuredPath()))
        val addresses=PrgAddressSearch().search("ork",50).results
        val places=PoiSearch(path).search("ork",50)
        val merged=PlaceRanking.merge(addresses,places,4)
        assertTrue(merged.any { it.type=="poi" });assertTrue(merged.any { it.type=="street" })
        assertEquals(addresses.take(merged.count { it.type!="poi" }),merged.filter { it.type!="poi" })
        val exact=PrgAddressSearch().search("Lipowa 12",4).results
        assertEquals(exact.first(),PlaceRanking.merge(exact,places,4).first())
        assertEquals(places.take(4),PlaceRanking.merge(emptyList(),places,4))
    }
    @Test fun realMixedHttpConcurrencyAndRanking()=runBlocking {
        assumeTrue(Files.isRegularFile(path) && Files.isRegularFile(PrgAddressSearch.configuredPath()))
        val before=hash(path);val prgBefore=hash(PrgAddressSearch.configuredPath())
        val server=embeddedServer(Netty,host="127.0.0.1",port=0) {
            install(ContentNegotiation) { json() };statusRoutes();addressRoutes()
        }.start(false)
        try {
            val port=server.resolvedConnectors().first().port;val http=HttpClient.newHttpClient()
            fun request(q:String)=java.net.http.HttpRequest.newBuilder(URI("http://127.0.0.1:$port/addresses/search?limit=4&q="+URLEncoder.encode(q,Charsets.UTF_8))).GET().build()
            val timings=mutableListOf<Double>()
            for(q in listOf("ork","Lipowa 12","Motycz 69B","olimp","szpital","rapa","verano","raben","uniwersytet","umcs","aliplast","ball packing","lubella","perla","pzl swidnik","art bet","stokrotka","margomed")) {
                val t=System.nanoTime();val res=http.send(request(q),HttpResponse.BodyHandlers.ofString());timings.add((System.nanoTime()-t)/1e6)
                assertEquals(200,res.statusCode(),q)
                val rows=Json.decodeFromString<PrgSearchResponse>(res.body()).results
                assertTrue(rows.size in 1..4,q)
                if(q=="ork") { assertEquals("Orkana 6, Lublin",rows.first { it.display_name=="Galeria Orkana" }.subtitle); assertTrue(rows.any { it.type=="street" && it.street.contains("Orkana") },rows.toString());assertTrue(rows.any { it.display_name=="Galeria Orkana" },rows.toString()) }
                if(q in listOf("Lipowa 12","Motycz 69B")) assertEquals("address",rows.first().type)
                val postalChecks=when(q) {
                    "art bet" -> mapOf("poi:33f4b578e10e3774dec3" to "ul. Antoniny Grygowej 5A, Lublin")
                    "stokrotka" -> mapOf("poi:7afce11771c9f378904e" to "ul. Mełgiewska 7–9, Lublin")
                    "margomed" -> mapOf("poi:9fea548e59fe7639ca7c" to "ul. Pancerniaków 27 / Al. Wincentego Witosa 38, Lublin")
                    "ball packing" -> mapOf("poi:854eb6d2b240c11d328c" to "Vetterów 14, Lublin")
                    "lubella" -> mapOf("poi:81f12419d2966e9ba933" to "Działkowa 45, Lublin","poi:c13dd5d066d11f25638f" to "Wrotkowska 1, Lublin")
                    "perla" -> mapOf("poi:e08fd9ff60f859f28174" to "Bernardyńska 15, Lublin","poi:107ffba1cc4379e3eb38" to "Władysława Kunickiego 106, Lublin")
                    "pzl swidnik" -> mapOf("poi:6a40ff74dd8d0fc3484a" to "al. Lotników Polskich 1, Świdnik")
                    else -> emptyMap()
                }
                for((id,label) in postalChecks) assertEquals(label,rows.first { it.id==id }.subtitle)
                if(q=="aliplast") assertEquals("Wacława Moritza 3, Lublin",rows.first { it.type=="poi" }.subtitle)
                if(q=="olimp") assertTrue(rows.any { it.display_name=="Galeria Olimp" })
            }
            val requests=(1..32).map { http.sendAsync(request("ork"),HttpResponse.BodyHandlers.ofString()) }
            requests.forEach { assertEquals(200,it.get().statusCode()) }
            timings.sort();println("POI_MIXED_HTTP queries=10 concurrent=32 p95_ms=${timings.last()} heap_used_mib=${(Runtime.getRuntime().totalMemory()-Runtime.getRuntime().freeMemory())/1048576}")
            assertEquals(before,hash(path));assertEquals(prgBefore,hash(PrgAddressSearch.configuredPath()))
        } finally { server.stop(0,1000) }
    }
}
