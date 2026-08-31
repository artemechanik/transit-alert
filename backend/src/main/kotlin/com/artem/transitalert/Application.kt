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
import io.ktor.http.*

fun main() {
    embeddedServer(Netty, port = 8080, host = "0.0.0.0", module = Application::module)
        .start(wait = true)
}

@OptIn(DelicateCoroutinesApi::class)
fun Application.module() {
    // 1. База даних
    DatabaseFactory.init()
	// БУДУЄМО ГРАФ МАРШРУТІВ ДЛЯ ПОШУКУ З ПЕРЕСАДКАМИ
  	  TransitGraph.buildGraphForToday()
    // 2. Встановлюємо наш новий потужний CORS (один раз!)
    install(CORS) {
        anyHost()
        allowHeader(HttpHeaders.ContentType)
        allowHeader(HttpHeaders.AccessControlAllowOrigin)
        allowMethod(HttpMethod.Options)
        allowMethod(HttpMethod.Get)
        allowMethod(HttpMethod.Post)
    }

    // 3. Інші плагіни
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true; prettyPrint = true })
    }
    install(CallLogging)

    // 4. Роути
    reportRoutes()
    riskRoutes()
    upcomingStopsRoutes()
    liveVehiclesRoutes()
    formRoutes()
    stopRoutes()// Наші нові роути

    // 5. Фонові задачі
    LiveVehiclesCache.startPolling(GlobalScope)
    GtfsStaticSync.startPolling(GlobalScope)
}
