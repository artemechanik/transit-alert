package com.artem.transitalert

import io.ktor.server.application.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.testing.*
import kotlin.test.*

class StatusRoutesTest {
    @Test fun `status works without database or external feed`() = testApplication {
        application {
            install(ContentNegotiation) { json() }
            statusRoutes()
        }
        val response = client.get("/status")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals("no-store", response.headers[HttpHeaders.CacheControl])
        assertEquals("{\"status\":\"ok\"}", response.bodyAsText())
    }
}
