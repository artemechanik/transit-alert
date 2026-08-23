package com.artem.transitalert

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction

object DatabaseFactory {

    // Публічний, бо GtfsStaticSync бере сирі JDBC-конекшени напряму (з autoCommit=false)
    // для org.postgresql.copy.CopyManager — Exposed не вміє в COPY, а звичайні
    // batch-insert'и на ~сотні тисяч рядків stop_times.txt були б помітно повільніші.
    lateinit var dataSource: HikariDataSource
        private set

    fun init() {
        val config = HikariConfig().apply {
            // Локально піднятий Postgres (див. docker-compose.yml)
            jdbcUrl = System.getenv("DB_URL") ?: "jdbc:postgresql://localhost:5432/transit_alert"
            driverClassName = "org.postgresql.Driver"
            username = System.getenv("DB_USER") ?: "transit"
            password = System.getenv("DB_PASSWORD") ?: "transit"
            maximumPoolSize = 5
        }
        dataSource = HikariDataSource(config)
        Database.connect(dataSource)

        // На старті MVP — просто створюємо таблиці якщо їх нема.
        // Пізніше заміниш на нормальні міграції (Flyway/Liquibase).
        transaction {
            SchemaUtils.create(
                Stops, Reports, ReportVotes, StopDepartures,
                ServiceCalendar, TripHeadsigns, TripStops, GtfsFeedMeta,
            )
        }
    }
}
