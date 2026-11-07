package com.artem.transitalert

import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun Application.statusRoutes() {
    routing {
        get("/status") {
            call.response.headers.append("Cache-Control", "no-store")
            call.respond(mapOf("status" to "ok"))
        }
    }
}
