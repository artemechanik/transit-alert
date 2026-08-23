package com.artem.transitalert

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.timestamp

object Stops : Table("stops") {
    val stopId = varchar("stop_id", 16)
    val name = varchar("name", 128)
    val code = varchar("code", 8)
    val lat = double("lat")
    val lon = double("lon")
    override val primaryKey = PrimaryKey(stopId)
}

object Reports : Table("reports") {
    val id = integer("id").autoIncrement()
    val stopId = varchar("stop_id", 16).references(Stops.stopId)
    val comment = varchar("comment", 200).nullable()
    val route = varchar("route", 16).nullable()
    val direction = varchar("direction", 128).nullable()
    val tripId = varchar("trip_id", 32).nullable()
    val fingerprint = varchar("fingerprint", 64)
    val createdAt = timestamp("created_at")
    val confirms = integer("confirms").default(0)
    val denies = integer("denies").default(0)
    val hidden = bool("hidden").default(false)
    val previousReportId = integer("previous_report_id").nullable()
    override val primaryKey = PrimaryKey(id)
}

object ReportVotes : Table("report_votes") {
    val id = integer("id").autoIncrement()
    val reportId = integer("report_id").references(Reports.id)
    val fingerprint = varchar("fingerprint", 64)
    val voteType = varchar("vote_type", 8) 
    val createdAt = timestamp("created_at")
    override val primaryKey = PrimaryKey(id)
    init {
        uniqueIndex(reportId, fingerprint)
    }
}

object StopDepartures : Table("stop_departures") {
    val id = integer("id").autoIncrement()
    val stopId = varchar("stop_id", 16)
    val route = varchar("route", 16)
    val departureMinutes = integer("departure_minutes")
    val serviceId = varchar("service_id", 32)
    val tripId = varchar("trip_id", 32)
    override val primaryKey = PrimaryKey(id)
    init {
        index(isUnique = false, stopId, serviceId, departureMinutes)
        index(isUnique = false, route, serviceId, departureMinutes)
    }
}

object TripHeadsigns : Table("trip_headsigns") {
    val tripId = varchar("trip_id", 32)
    val headsign = varchar("headsign", 128)
    override val primaryKey = PrimaryKey(tripId)
}

object ServiceCalendar : Table("service_calendar") {
    val id = integer("id").autoIncrement()
    val date = varchar("date", 8)
    val serviceId = varchar("service_id", 32)
    override val primaryKey = PrimaryKey(id)
    init {
        index(isUnique = false, date)
    }
}

object TripStops : Table("trip_stops") {
    val id = integer("id").autoIncrement()
    val tripId = varchar("trip_id", 32)
    val stopSequence = integer("stop_sequence")
    val stopId = varchar("stop_id", 16)
    val stopName = varchar("stop_name", 128)
    val departureMinutes = integer("departure_minutes")
    override val primaryKey = PrimaryKey(id)
    init {
        index(isUnique = false, tripId, stopSequence)
    }
}

object GtfsFeedMeta : Table("gtfs_feed_meta") {
    val id = integer("id")
    val feedVersion = varchar("feed_version", 128).nullable()
    val etag = varchar("etag", 128).nullable()
    val lastModified = varchar("last_modified", 64).nullable()
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(id)
}
