package com.artem.transitalert

import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.testing.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assume.assumeTrue
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.URLEncoder
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import kotlin.test.*

@Serializable
private data class PrgFixture(val q: String, val limit: Int, val expected: PrgSearchResponse)

class PrgAddressSearchTest {
    private val database = PrgAddressSearch.configuredPath()
    private fun fixtures(): List<PrgFixture> =
        Json.decodeFromString(javaClass.getResource("/prg-query-fixtures.json")!!.readText())
    private fun checksum(): String = MessageDigest.getInstance("SHA-256")
        .digest(Files.readAllBytes(database)).joinToString("") { "%02x".format(it) }

    @Test fun normalizationAndValidation() {
        assertEquals("raclawickie zolc", PrgQuery.text("al. Racławickie ŻÓŁĆ"))
        assertEquals("69b", PrgQuery.parse("Motycz 69B").house)
        assertEquals("1/3", PrgQuery.parse("Lipowa 1/3").house)
        assertEquals("12", PrgQuery.parse("Lipowa 12 m. 3").house)
        for (q in listOf("24", "a", "x".repeat(201), "Lipowa\n12")) {
            assertFailsWith<IllegalArgumentException>(q) { PrgQuery.parse(q) }
        }
    }

    @Test fun missingAndCorruptDictionaryDoesNotBreakOtherRoutes() = testApplication {
        val directory = Files.createTempDirectory("prg-failure")
        val absent = directory.resolve("missing.sqlite")
        val corrupt = directory.resolve("corrupt.sqlite")
        Files.writeString(corrupt, "not a SQLite database")
        application {
            install(ContentNegotiation) { json() }
            statusRoutes()
            addressRoutes(PrgAddressSearch(absent), null)
        }
        assertEquals(HttpStatusCode.OK, client.get("/status").status)
        assertEquals(HttpStatusCode.ServiceUnavailable, client.get("/addresses/search?q=Lipowa").status)
        assertFalse(Files.exists(absent), "Read-only service must not create a missing file")
        Files.writeString(absent, "corrupt dictionary")
        assertEquals(HttpStatusCode.ServiceUnavailable, client.get("/addresses/search?q=Lipowa").status)
        assertEquals(HttpStatusCode.OK, client.get("/status").status)
        Files.delete(absent)
        runBlocking {
            assertFailsWith<java.sql.SQLException> { PrgAddressSearch(corrupt).search("Lipowa") }
        }
        // The same lazy service can recover when a dictionary becomes available.
        assumeTrue("Local PRG database not provided", Files.isRegularFile(database))
        Files.createSymbolicLink(absent, database.toAbsolutePath())
        assertEquals(HttpStatusCode.OK, client.get("/addresses/search?q=Lipowa").status)
        Files.delete(absent)
        Files.delete(corrupt)
        Files.delete(directory)
    }

    @Test fun httpValidationAndConcurrentSearches() = testApplication {
        assumeTrue("Local PRG database not provided", Files.isRegularFile(database))
        application {
            install(ContentNegotiation) { json() }
            addressRoutes(PrgAddressSearch(database), null)
        }
        for (q in listOf("", "   ")) {
            val response = client.get("/addresses/search") { parameter("q", q) }
            assertEquals(HttpStatusCode.OK, response.status)
            assertTrue(Json.decodeFromString<PrgSearchResponse>(response.bodyAsText()).results.isEmpty())
        }
        for (url in listOf("?q=a", "?q=24", "?q=Lipowa&limit=0", "?q=Lipowa&limit=-1",
            "?q=Lipowa&limit=bad", "?q=Lipowa&q=Motycz", "?q=Lipowa&unknown=1")) {
            assertEquals(HttpStatusCode.BadRequest, client.get("/addresses/search$url").status, url)
        }
        val limited = client.get("/addresses/search?q=li&limit=999999999999999999999")
        assertEquals(fixtures().first { it.q == "li" }.expected,
            Json.decodeFromString<PrgSearchResponse>(limited.bodyAsText()))
        val expected = fixtures().first { it.q == "Lipowa 12" }
        coroutineScope {
            (1..32).map {
                async {
                    val response = client.get("/addresses/search") { parameter("q", expected.q); parameter("limit", expected.limit) }
                    assertEquals(HttpStatusCode.OK, response.status)
                    assertEquals(expected.expected, Json.decodeFromString<PrgSearchResponse>(response.bodyAsText()))
                }
            }.awaitAll()
        }
    }

    /** Real loopback Netty HTTP, without Application.module, PostgreSQL or feed pollers. */
    @Test fun all58ScenariosOverRealHttpMatchPythonAndLeaveDatabaseUntouched() = runBlocking {
        assumeTrue("Local PRG database not provided", Files.isRegularFile(database))
        val before = checksum()
        val server = embeddedServer(Netty, host = "127.0.0.1", port = 0) {
            install(ContentNegotiation) { json() }
            statusRoutes()
            addressRoutes(PrgAddressSearch(database), null)
        }.start(wait = false)
        try {
            val port = server.resolvedConnectors().first().port
            val http = HttpClient.newHttpClient()
            val timings = mutableListOf<Double>()
            val cases = fixtures()
            assertEquals(58, cases.size)
            for (fixture in cases) {
                val q = URLEncoder.encode(fixture.q, Charsets.UTF_8)
                val url = "http://127.0.0.1:$port/addresses/search?q=$q&limit=${fixture.limit}"
                val started = System.nanoTime()
                val response = http.send(HttpRequest.newBuilder(URI(url)).GET().build(), HttpResponse.BodyHandlers.ofString())
                timings.add((System.nanoTime() - started) / 1e6)
                assertEquals(200, response.statusCode(), fixture.q)
                assertEquals(fixture.expected, Json.decodeFromString<PrgSearchResponse>(response.body()), fixture.q)
            }
            val concurrent = cases.first { it.q == "Lipowa 12" }
            val q = URLEncoder.encode(concurrent.q, Charsets.UTF_8)
            val uri = URI("http://127.0.0.1:$port/addresses/search?q=$q&limit=${concurrent.limit}")
            val parallelStarted = System.nanoTime()
            val requests = (1..32).map {
                http.sendAsync(HttpRequest.newBuilder(uri).GET().build(), HttpResponse.BodyHandlers.ofString())
            }
            requests.forEach {
                val response = it.get()
                assertEquals(200, response.statusCode())
                assertEquals(concurrent.expected, Json.decodeFromString<PrgSearchResponse>(response.body()))
            }
            println("PRG_CONCURRENT_HTTP requests=32 elapsed_ms=${(System.nanoTime()-parallelStarted)/1e6}")
            timings.sort()
            println("PRG_REAL_HTTP port=$port cases=${cases.size} p50_ms=${timings[timings.size/2]} p95_ms=${timings[(timings.size*.95).toInt()]} DB_SHA256=$before")
            assertEquals(before, checksum(), "SQLite content must stay unchanged")
        } finally {
            server.stop(100, 2000)
        }
    }
}
