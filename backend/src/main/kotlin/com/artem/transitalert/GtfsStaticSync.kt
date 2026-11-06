package com.artem.transitalert

import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import kotlinx.coroutines.*
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import org.postgresql.copy.CopyManager
import org.postgresql.core.BaseConnection
import org.slf4j.LoggerFactory
import java.io.BufferedReader
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.io.StringReader
import java.sql.Connection
import java.time.Instant
import java.util.zip.ZipInputStream

private const val GTFS_STATIC_ZIP_URL = "https://api.zbiorkom.live/api6-open/lublin/gtfs/default"

// zbiorkom.live перегенеровує статичний фід (і trip_id разом з ним) раз на 1-2 тижні,
// тому перевірки раз на 6 год більш ніж достатньо, щоб підхопити зміну без ручного втручання.
private const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L

private const val META_ROW_ID = 1

private val PLATFORM_SUFFIX = Regex("""^(.+)\s+(\d{2})$""")

/** Приводить новий фід до наявних полів name/code, не змінюючи зовнішній stop_id. */
internal fun normalizeGtfsStop(stop: Map<String, String>, onDemand: Boolean = false): Map<String, String> {
    val rawName = stop.getValue("stop_name").trim()
    // Старий формат уже має окремий stop_code, включно з порожнім кодом депо.
    val suffix = if (stop.containsKey("stop_code")) null else PLATFORM_SUFFIX.matchEntire(rawName)
    val code = stop["stop_code"] ?: stop["platform_code"]?.takeIf { it.isNotBlank() }
        ?: suffix?.groupValues?.get(2).orEmpty()
    val name = if (suffix != null && suffix.groupValues[2] == code) {
        suffix.groupValues[1].trimEnd()
    } else {
        rawName
    }
    val displayName = if (onDemand && !name.endsWith(" NŻ")) "$name NŻ" else name
    return stop + mapOf("stop_name" to displayName, "stop_code" to code)
}

internal fun isGtfsOnDemandStop(pickupType: String?, dropOffType: String?): Boolean =
    pickupType == "3" || dropOffType == "3"

/** Пасажирський індекс: лише рейси, що не складаються повністю із заборонених 1/1. */
internal class GtfsPassengerTrips {
    private val passengerTripIds = HashSet<String>()

    fun recordStop(tripId: String, pickupType: String?, dropOffType: String?) {
        if (pickupType != "1" || dropOffType != "1") passengerTripIds.add(tripId)
    }

    fun headsigns(lastStopIds: Map<String, String>, stopNames: Map<String, String>): Map<String, String> =
        lastStopIds.mapNotNull { (tripId, stopId) ->
            if (tripId !in passengerTripIds) return@mapNotNull null
            stopNames[stopId]?.let { tripId to it.trim() }
        }.toMap()
}

/**
 * Фоновий синхронізатор статичного GTFS (аналог LiveVehiclesCache, тільки для
 * рідкісних, але "ламких" оновлень: коли zbiorkom.live перегенеровує trip_id,
 * і всі live-дані (delaySeconds, upcoming-stops) відв'язуються від старої бази).
 *
 * Кроки:
 * 1. Умовний GET (If-None-Match / If-Modified-Since) — у 9 з 10 перевірок фід
 *    не змінився, отримуємо 304 і нічого не качаємо.
 * 2. Якщо 200 — дивимось feed_version з feed_info.txt всередині zip. Сервер
 *    іноді може віддати 200 з новим ETag, але тим самим вмістом — тоді просто
 *    оновлюємо збережені ETag/Last-Modified і не чіпаємо БД.
 * 3. Якщо feed_version реально новий — парсимо весь zip і одним JDBC-транзакційним
 *    блоком підміняємо дані. Все або нічого: при будь-якій помилці rollback,
 *    стара (робоча) версія лишається недоторканою.
 *
 * Важливо: stops оновлюються через UPSERT, а не DELETE+INSERT — на stops.stop_id
 * висить FK з reports.stop_id, і видалення зупинки, на яку посилається активний
 * (ще не протухлий по TTL) допис, впало б з помилкою foreign key violation.
 * Решта таблиць (trip_headsigns/stop_departures/trip_stops/service_calendar)
 * без вхідних FK — там DELETE + COPY, це на порядок швидше за ~сотні тисяч
 * рядків з stop_times.txt, ніж by-row insert.
 */
object GtfsStaticSync {
    private val logger = LoggerFactory.getLogger("GtfsStaticSync")
    private val client = HttpClient(CIO)

    fun startPolling(scope: CoroutineScope) {
        scope.launch {
            while (isActive) {
                try {
                    checkAndSync()
                } catch (e: Exception) {
                    logger.warn("Не вдалось перевірити/оновити статичний GTFS: ${e.message}", e)
                }
                delay(CHECK_INTERVAL_MS)
            }
        }
    }

    // ---------- метадані (версія фіда, ETag/Last-Modified) ----------

    private data class FeedMeta(val feedVersion: String?, val etag: String?, val lastModified: String?)

    private fun loadMeta(): FeedMeta = transaction {
        GtfsFeedMeta.selectAll()
            .where { GtfsFeedMeta.id eq META_ROW_ID }
            .limit(1)
            .firstOrNull()
            ?.let { FeedMeta(it[GtfsFeedMeta.feedVersion], it[GtfsFeedMeta.etag], it[GtfsFeedMeta.lastModified]) }
            ?: FeedMeta(null, null, null)
    }

    private fun saveMeta(feedVersion: String?, etag: String?, lastModified: String?) = transaction {
        val exists = GtfsFeedMeta.selectAll().where { GtfsFeedMeta.id eq META_ROW_ID }.limit(1).any()
        if (exists) {
            GtfsFeedMeta.update({ GtfsFeedMeta.id eq META_ROW_ID }) {
                it[GtfsFeedMeta.feedVersion] = feedVersion
                it[GtfsFeedMeta.etag] = etag
                it[GtfsFeedMeta.lastModified] = lastModified
                it[updatedAt] = Instant.now()
            }
        } else {
            GtfsFeedMeta.insert {
                it[id] = META_ROW_ID
                it[GtfsFeedMeta.feedVersion] = feedVersion
                it[GtfsFeedMeta.etag] = etag
                it[GtfsFeedMeta.lastModified] = lastModified
                it[updatedAt] = Instant.now()
            }
        }
    }

    // ---------- головний цикл перевірки ----------

    private suspend fun checkAndSync() {
        val meta = loadMeta()

        val response = client.get(GTFS_STATIC_ZIP_URL) {
            meta.etag?.let { header(HttpHeaders.IfNoneMatch, it) }
            meta.lastModified?.let { header(HttpHeaders.IfModifiedSince, it) }
        }

        if (response.status == HttpStatusCode.NotModified) {
            logger.info("GTFS static: 304 Not Modified — фід не змінився")
            return
        }

        check(response.status == HttpStatusCode.OK) {
            "GTFS static: HTTP ${response.status} замість GTFS ZIP"
        }

        val zipBytes = response.readBytes()
        val newEtag = response.headers[HttpHeaders.ETag]
        val newLastModified = response.headers[HttpHeaders.LastModified]

        val feedVersion = readFeedVersion(zipBytes)
        if (feedVersion != null && feedVersion == meta.feedVersion) {
            logger.info("GTFS static: 200, але feed_version не змінився ($feedVersion) — БД не чіпаємо")
            saveMeta(feedVersion, newEtag, newLastModified)
            return
        }

       logger.info("GTFS static: нова версія фіда (${meta.feedVersion} -> $feedVersion), імпортуємо...")
        importFeed(zipBytes)
        
        // Скидаємо кеш, бо таблиці в БД щойно оновилися
        ActiveRoutesCache.invalidate() 
        invalidateStopsCache()
        // ДОДАЄМО ЦЕ:
        com.artem.transitalert.TransitGraph.buildGraph()
        saveMeta(feedVersion, newEtag, newLastModified)
        logger.info("GTFS static: імпорт завершено, версія $feedVersion")
    }

    // ---------- CSV / zip парсинг ----------

    private fun readFeedVersion(zipBytes: ByteArray): String? =
        readCsvEntry(zipBytes, "feed_info.txt")?.firstOrNull()?.get("feed_version")

    /** Читає одне ціле CSV-entry в пам'ять як список Map(колонка -> значення). Для малих файлів. */
    private fun readCsvEntry(zipBytes: ByteArray, entryName: String): List<Map<String, String>>? {
        ZipInputStream(ByteArrayInputStream(zipBytes)).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                if (entry.name == entryName) {
                    val reader = BufferedReader(InputStreamReader(zis, Charsets.UTF_8))
                    val header = parseCsvLine(reader.readLine() ?: return emptyList())
                    return reader.lineSequence().filter { it.isNotBlank() }.map { line ->
                        val values = parseCsvLine(line)
                        header.indices.associate { i -> header[i] to values.getOrElse(i) { "" } }
                    }.toList()
                }
                entry = zis.nextEntry
            }
        }
        return null
    }

    /**
     * Потокове читання entry (для великих файлів типу stop_times.txt, ~сотні тисяч рядків) —
     * щоб не тримати весь розпарсений файл у пам'яті, а обробляти рядок за рядком.
     */
    private fun <T> withCsvEntry(
        zipBytes: ByteArray,
        entryName: String,
        block: (header: List<String>, lines: Sequence<List<String>>) -> T,
    ): T {
        ZipInputStream(ByteArrayInputStream(zipBytes)).use { zis ->
            var entry = zis.nextEntry
            while (entry != null) {
                if (entry.name == entryName) {
                    val reader = BufferedReader(InputStreamReader(zis, Charsets.UTF_8))
                    val header = parseCsvLine(reader.readLine() ?: error("$entryName порожній"))
                    val lines = generateSequence { reader.readLine() }
                        .filter { it.isNotBlank() }
                        .map { parseCsvLine(it) }
                    return block(header, lines)
                }
                entry = zis.nextEntry
            }
        }
        error("Entry $entryName не знайдено в zip")
    }

    /** Мінімальний RFC4180-парсер: лапки, коми всередині лапок, подвоєні лапки як екранування. */
    private fun parseCsvLine(line: String): List<String> {
        val result = mutableListOf<String>()
        val sb = StringBuilder()
        var inQuotes = false
        var i = 0
        while (i < line.length) {
            val c = line[i]
            when {
                inQuotes && c == '"' && i + 1 < line.length && line[i + 1] == '"' -> { sb.append('"'); i++ }
                c == '"' -> inQuotes = !inQuotes
                c == ',' && !inQuotes -> { result.add(sb.toString()); sb.clear() }
                else -> sb.append(c)
            }
            i++
        }
        result.add(sb.toString())
        return result
    }

    /** "04:53:00" -> 293, "25:54:00" -> 1554 (нічні рейси навмисно НЕ нормалізуємо по модулю). */
    private fun gtfsTimeToMinutes(hms: String): Int? {
        if (hms.isBlank()) return null
        val parts = hms.split(":")
        if (parts.size < 2) return null
        val h = parts[0].toIntOrNull() ?: return null
        val m = parts[1].toIntOrNull() ?: return null
        return h * 60 + m
    }

    /** Екранування текстового поля для COPY ... WITH (FORMAT csv). */
    private fun csv(value: String): String = "\"" + value.replace("\"", "\"\"") + "\""

    // ---------- імпорт ----------

    private fun importFeed(zipBytes: ByteArray) {
        // Малі довідники — повністю в пам'ять (stops ~1.5к рядків, routes ~50, trips ~15-20к).
        val rawStopsById = readCsvEntry(zipBytes, "stops.txt")!!.associateBy { it["stop_id"]!! }
        val routeShortNameById = readCsvEntry(zipBytes, "routes.txt")!!
            .associate { it["route_id"]!! to it["route_short_name"]!! }
        val tripsById = readCsvEntry(zipBytes, "trips.txt")!!.associateBy { it["trip_id"]!! }
        val calendarDates = readCsvEntry(zipBytes, "calendar_dates.txt")!!
            .filter { it["exception_type"] == "1" } // тільки "додати сервіс на дату", як і в поточних seed-файлах

        // Прохід 1 по stop_times.txt: знаходимо останній stop_sequence кожного trip_id -> headsign.
        val lastStopIdByTrip = HashMap<String, String>()
        val lastSeqByTrip = HashMap<String, Int>()
        val onDemandStops = HashSet<String>()
        val passengerTrips = GtfsPassengerTrips()
        withCsvEntry(zipBytes, "stop_times.txt") { header, lines ->
            val tripIdx = header.indexOf("trip_id")
            val seqIdx = header.indexOf("stop_sequence")
            val stopIdx = header.indexOf("stop_id")
            val pickupIdx = header.indexOf("pickup_type")
            val dropOffIdx = header.indexOf("drop_off_type")
            for (row in lines) {
                val tripId = row[tripIdx]
                val seq = row[seqIdx].toIntOrNull() ?: continue
                val stopId = row[stopIdx]
                passengerTrips.recordStop(tripId, row.getOrNull(pickupIdx), row.getOrNull(dropOffIdx))
                if (isGtfsOnDemandStop(row.getOrNull(pickupIdx), row.getOrNull(dropOffIdx))) {
                    onDemandStops.add(stopId)
                }
                if (seq >= (lastSeqByTrip[tripId] ?: -1)) {
                    lastSeqByTrip[tripId] = seq
                    lastStopIdByTrip[tripId] = stopId
                }
            }
        }

        val stopsById = rawStopsById.mapValues { (stopId, stop) ->
            normalizeGtfsStop(stop, stopId in onDemandStops)
        }

        val rawConn = DatabaseFactory.dataSource.connection
        try {
            rawConn.autoCommit = false
            val copyManager = CopyManager(rawConn.unwrap(BaseConnection::class.java))

            // stops: UPSERT (детальніше — в доккоменті класу вище).
            upsertStops(rawConn, stopsById.values)

            deleteAll(rawConn, "trip_headsigns")
            deleteAll(rawConn, "stop_departures")
            deleteAll(rawConn, "trip_stops")
            deleteAll(rawConn, "service_calendar")

            // service_calendar
            val calSb = StringBuilder()
            for (row in calendarDates) {
                calSb.append(row["date"]).append(',').append(csv(row["service_id"]!!)).append('\n')
            }
            copyManager.copyIn(
                "COPY service_calendar (date, service_id) FROM STDIN WITH (FORMAT csv)",
                StringReader(calSb.toString()),
            )

            // Пасажирський індекс; сирі trip_stops і stop_departures нижче зберігають
            // також технічні рейси для розкладу live-позицій та їхнього route join.
            val headSb = StringBuilder()
            val passengerHeadsigns = passengerTrips.headsigns(
                lastStopIdByTrip, stopsById.mapValues { it.value.getValue("stop_name") },
            )
            for ((tripId, name) in passengerHeadsigns) {
                headSb.append(csv(tripId)).append(',').append(csv(name)).append('\n')
            }
            copyManager.copyIn(
                "COPY trip_headsigns (trip_id, headsign) FROM STDIN WITH (FORMAT csv)",
                StringReader(headSb.toString()),
            )

            // Прохід 2 по stop_times.txt: одночасно наповнюємо trip_stops і stop_departures.
            val tripStopsSb = StringBuilder()
            val stopDeparturesSb = StringBuilder()
            withCsvEntry(zipBytes, "stop_times.txt") { header, lines ->
                val tripIdx = header.indexOf("trip_id")
                val seqIdx = header.indexOf("stop_sequence")
                val stopIdx = header.indexOf("stop_id")
                val arrIdx = header.indexOf("arrival_time")
                val depIdx = header.indexOf("departure_time")

                for (row in lines) {
                    val tripId = row[tripIdx]
                    val seq = row[seqIdx].toIntOrNull() ?: continue
                    val stopId = row[stopIdx]
                    val stop = stopsById[stopId] ?: continue
                    val minutes = gtfsTimeToMinutes(row.getOrElse(depIdx) { "" })
                        ?: gtfsTimeToMinutes(row.getOrElse(arrIdx) { "" })
                        ?: continue

                    tripStopsSb.append(csv(tripId)).append(',').append(seq).append(',')
                        .append(csv(stopId)).append(',').append(csv(stop["stop_name"]!!.trim())).append(',')
                        .append(minutes).append('\n')

                    val trip = tripsById[tripId] ?: continue
                    val route = routeShortNameById[trip["route_id"]] ?: continue
                    stopDeparturesSb.append(csv(stopId)).append(',').append(csv(route)).append(',')
                        .append(minutes).append(',').append(csv(trip["service_id"]!!)).append(',')
                        .append(csv(tripId)).append('\n')
                }
            }
            copyManager.copyIn(
                "COPY trip_stops (trip_id, stop_sequence, stop_id, stop_name, departure_minutes) FROM STDIN WITH (FORMAT csv)",
                StringReader(tripStopsSb.toString()),
            )
            copyManager.copyIn(
                "COPY stop_departures (stop_id, route, departure_minutes, service_id, trip_id) FROM STDIN WITH (FORMAT csv)",
                StringReader(stopDeparturesSb.toString()),
            )

            rawConn.commit()
        } catch (e: Exception) {
            rawConn.rollback()
            throw e
        } finally {
            rawConn.autoCommit = true
            rawConn.close()
        }
    }

    private fun deleteAll(conn: Connection, table: String) {
        conn.createStatement().use { it.execute("DELETE FROM $table") }
    }

    private fun upsertStops(conn: Connection, stops: Collection<Map<String, String>>) {
        val sql = """
            INSERT INTO stops (stop_id, name, code, lat, lon) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (stop_id) DO UPDATE SET
                name = EXCLUDED.name, code = EXCLUDED.code, lat = EXCLUDED.lat, lon = EXCLUDED.lon
        """.trimIndent()
        conn.prepareStatement(sql).use { ps ->
            for (s in stops) {
                ps.setString(1, s["stop_id"])
                ps.setString(2, s["stop_name"]?.trim())
                ps.setString(3, s["stop_code"] ?: "")
                ps.setDouble(4, s["stop_lat"]!!.toDouble())
                ps.setDouble(5, s["stop_lon"]!!.toDouble())
                ps.addBatch()
            }
            ps.executeBatch()
        }
    }
}
