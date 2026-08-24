package com.artem.transitalert

import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.cors.routing.*
import io.ktor.server.plugins.callloging.*
import kotlinx.coroutines.DelicateCoroutinesApi
import kotlinx.coroutines.GlobalScope
import kotlinx.serialization.json.Json

fun main() {
    embeddedServer(Netty, port = 8080, host = "0.0.0.0", module = Application::module)
        .start(wait = true)
}

@OptIn(DelicateCoroutinesApi::class)
fun Application.module() {
    DatabaseFactory.init()

    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true; prettyPrint = true })
    }

    install(CallLogging)

    install(CORS) {
        anyHost() // MVP-режим; звузити до конкретного домену PWA перед продом
        allowHeader(io.ktor.http.HttpHeaders.ContentType)
    }

    reportRoutes()
    riskRoutes()
    upcomingStopsRoutes()
    liveVehiclesRoutes()
    formRoutes()
    stopRoutes()// Наші нові роути

    LiveVehiclesCache.startPolling(GlobalScope)
    GtfsStaticSync.startPolling(GlobalScope)
}
