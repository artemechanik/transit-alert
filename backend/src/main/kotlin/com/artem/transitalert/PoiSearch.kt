package com.artem.transitalert

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.sqlite.Function
import org.sqlite.ProgressHandler
import java.nio.file.Files
import java.nio.file.Path
import java.sql.DriverManager
import java.sql.SQLException

/** Independent, lazy, bounded read-only dictionary; no import or background process. */
class PoiSearch(private val path: Path = configuredPath()) {
    private val permits = Semaphore(4)
    suspend fun search(query: String, limit: Int = 10): List<PrgAddressResult> {
        require(query.codePointCount(0, query.length) <= 200 && query.none { it.code < 32 })
        require(limit in 1..50)
        val q = PrgQuery.normalize(query)
        require(q.split(" ").size <= 12)
        if (q.replace(" ", "").length < 2) return emptyList()
        val match = q.split(" ").joinToString(" AND ") { "\"$it\"*" }
        return permits.withPermit { withContext(Dispatchers.IO) {
            if (!Files.isRegularFile(path)) throw SQLException("POI SQLite unavailable")
            DriverManager.getConnection("jdbc:sqlite:" + path.toAbsolutePath().toUri() + "?mode=ro").use { c ->
                c.createStatement().use { it.execute("PRAGMA query_only=ON"); it.execute("PRAGMA cache_size=-2048") }
                val deadline = System.nanoTime() + 2_000_000_000L
                ProgressHandler.setHandler(c, 10000, object : ProgressHandler() {
                    override fun progress() = if (System.nanoTime() > deadline) 1 else 0
                })
                Function.create(c, "text_rank", object : Function() {
                    override fun xFunc() { result(rank(value_text(0), value_text(1))) }
                }, 2, Function.FLAG_DETERMINISTIC)
                c.prepareStatement("""
                    WITH matches AS (
                      SELECT a.poi_id,a.name matched_name,a.kind,text_rank(a.normalized,?) tier,
                        row_number() OVER (PARTITION BY a.poi_id ORDER BY text_rank(a.normalized,?),
                          CASE a.kind WHEN 'canonical' THEN 0 ELSE 1 END,length(a.name),a.name) rn
                      FROM names_fts JOIN names a ON a.rowid=names_fts.rowid WHERE names_fts MATCH ?)
                    SELECT p.*,m.matched_name,m.kind,m.tier FROM matches m JOIN pois p ON p.id=m.poi_id
                    JOIN search_presentations sp ON sp.poi_id=p.id WHERE m.rn=1 AND sp.visible=1
                    ORDER BY m.tier,CASE m.kind WHEN 'canonical' THEN 0 ELSE 1 END,p.relevance DESC,
                      CASE WHEN p.nearest_stop_m IS NULL THEN 1 ELSE 0 END,p.nearest_stop_m,p.name,p.id LIMIT ?
                """.trimIndent()).use { s ->
                    s.setString(1,q); s.setString(2,q); s.setString(3,match); s.setInt(4,limit)
                    s.executeQuery().use { rs -> buildList {
                        while (rs.next()) {
                            val lat=rs.getDouble("lat"); val lon=rs.getDouble("lon")
                            val address = PoiAddress.read(c,rs.getString("id"),rs.getString("gmina"))
                            add(PrgAddressResult("poi",rs.getString("id"),rs.getString("id"),rs.getString("name"),
                                address.locality,"",rs.getString("terc"),"","",lat,lon,rs.getInt("tier"),"",
                                rs.getString("geometry_kind"),"local-poi",null,
                                category=rs.getString("category"),subtitle=address.subtitle,site_id=rs.getString("id"),
                                address_line=address.line,address_status=address.status))
                        }
                    } }
                }
            }
        } }
    }
    companion object {
        internal fun rank(name: String, query: String): Int = when {
            name == query -> 0
            name.startsWith(query) -> 1
            query.split(" ").all { t -> name.split(" ").any { it.startsWith(t) } } -> 2
            else -> 3
        }
        fun configuredPath(): Path {
            System.getenv("POI_SQLITE_PATH")?.takeIf { it.isNotBlank() }?.let { return Path.of(it) }
            val candidates=listOf(Path.of("../experiments/local-poi/data/poi.sqlite"),Path.of("experiments/local-poi/data/poi.sqlite"))
            return candidates.firstOrNull { Files.isRegularFile(it) } ?: candidates.first()
        }
    }
}
