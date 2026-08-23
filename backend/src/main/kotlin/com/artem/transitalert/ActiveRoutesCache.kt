package com.artem.transitalert

import org.jetbrains.exposed.sql.SqlExpressionBuilder.inList
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object ActiveRoutesCache {
    private var cachedDate: LocalDate? = null
    private var routesList: List<String> = emptyList()

    fun getTodayRoutes(): List<String> {
        val today = LocalDate.now(ZoneId.of("Europe/Warsaw"))

        if (cachedDate != today) {
            routesList = fetchActiveRoutesFromDb(today)
            cachedDate = today
        }

        return routesList
    }

    private fun fetchActiveRoutesFromDb(date: LocalDate): List<String> {
        val dateString = date.format(DateTimeFormatter.ofPattern("yyyyMMdd"))

        return transaction {
            // 1. Отримуємо активні serviceId на сьогодні з ServiceCalendar
            val activeServiceIds = ServiceCalendar
                .select(ServiceCalendar.serviceId)
                .where { ServiceCalendar.date eq dateString }
                .map { it[ServiceCalendar.serviceId] }

            if (activeServiceIds.isEmpty()) return@transaction emptyList()

            // 2. Шукаємо унікальні лінії, які їздять сьогодні (SELECT DISTINCT route)[cite: 4]
            StopDepartures
                .select(StopDepartures.route)
                .where { StopDepartures.serviceId inList activeServiceIds }
                .withDistinct()
                .map { it[StopDepartures.route] }
                .sortedBy {
                    // Просте сортування, щоб "150" було після "14", а не "14", "150", "2"
                    it.padStart(4, '0') 
                }
        }
    }

    fun invalidate() {
        cachedDate = null
    }
}
