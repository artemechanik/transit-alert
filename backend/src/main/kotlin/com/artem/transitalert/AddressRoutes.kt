package com.artem.transitalert

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import java.sql.SQLException

@Serializable
private data class AddressSearchError(val error: String)

fun Application.addressRoutes(service: PrgAddressSearch = PrgAddressSearch()) {
    routing {
        get("/addresses/search") {
            call.response.header(HttpHeaders.CacheControl, "no-store")
            try {
                val parameters = call.request.queryParameters
                require(parameters.names().all { it in setOf("q", "limit") } &&
                    parameters.names().all { parameters.getAll(it)?.size == 1 }) {
                    "Підтримуються лише по одному параметру q та limit."
                }
                val rawLimit = parameters["limit"] ?: "10"
                require(rawLimit.matches(Regex("[0-9]+")) && rawLimit.any { it != '0' }) {
                    "limit має бути додатним цілим числом."
                }
                val limit = rawLimit.toIntOrNull()?.coerceAtMost(50) ?: 50
                call.respond(service.search(parameters["q"] ?: "", limit))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, AddressSearchError(e.message ?: "Invalid query"))
            } catch (e: SQLException) {
                call.application.environment.log.warn("PRG address search unavailable", e)
                call.respond(HttpStatusCode.ServiceUnavailable, AddressSearchError("Локальний адресний довідник недоступний."))
            }
        }
    }
}
