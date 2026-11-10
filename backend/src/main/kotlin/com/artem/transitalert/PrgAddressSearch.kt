package com.artem.transitalert

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import org.sqlite.Function
import org.sqlite.ProgressHandler
import java.nio.file.Files
import java.nio.file.Path
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException
import java.text.Normalizer
import java.util.Locale
import java.util.regex.Pattern

@Serializable
data class PrgAddressResult(
    val type: String, val id: String, val source_id: String,
    val display_name: String, val locality: String, val simc: String, val terc: String,
    val street: String, val house_number: String, val lat: Double, val lon: Double,
    val match_rank: Int, val ulic: String, val coordinate_kind: String,
    val origin: String, val representative_method: String?,
    val category: String? = null, val subtitle: String? = null, val site_id: String? = null,
    val address_line: String? = null, val address_status: String? = null
)
@Serializable
data class PrgSearchResponse(val query: String, val results: List<PrgAddressResult>, val warning: String?)

internal object PrgQuery {
    private val ignored = setOf("ul", "ulica", "al", "aleja", "aleje", "pl", "plac")
    private fun unicodeRegex(pattern: String) = Pattern.compile(pattern, Pattern.UNICODE_CHARACTER_CLASS or Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE)
    private val unit = unicodeRegex("""\s+(?:m\.?|mieszkanie|lok\.?|lokal)\s*\d+\w*\s*$""")
    private val house = unicodeRegex("""(?:^|\s)(\d[\w/-]*)\s*$""")
    fun normalize(s: String): String {
        val folded = Normalizer.normalize(s.lowercase(Locale.ROOT).replace('ł', 'l'), Normalizer.Form.NFKD)
            .filterNot { Character.getType(it) == Character.NON_SPACING_MARK.toInt() }
        return Regex("[a-z0-9]+").findAll(folded).joinToString(" ") { it.value }
    }
    fun text(s: String) = normalize(s).split(" ").filter { it !in ignored }.joinToString(" ")
    private fun houseText(s: String) = s.split(Regex("(?=[/-])|(?<=[/-])"))
        .joinToString("") { if (it == "/" || it == "-") it else normalize(it) }.replace(" ", "")
    data class Parsed(val text: String, val house: String, val warning: String?)
    fun parse(input: String): Parsed {
        require(input.codePointCount(0, input.length) <= 200 && input.none { it.code < 32 }) {
            "Запит має бути текстом до 200 символів без керівних знаків."
        }
        var q = input
        var warning: String? = null
        val apartment = unit.matcher(q)
        if (apartment.find()) {
            q = q.substring(0, apartment.start())
            warning = "Номер квартири пропущено: результат указує на адресну точку будинку."
        }
        q = q.trim { it.isWhitespace() || Character.isSpaceChar(it) }
        val match = house.matcher(q)
        val hasHouse = match.find()
        val number = if (hasHouse) houseText(match.group(1)) else ""
        val name = text(if (hasHouse) q.substring(0, match.start()) else q)
        if ("/" in number) warning = "Шукаємо точний номер із «/» у PRG, не квартиру. Квартиру позначайте «m.»."
        if (name.isEmpty() && number.isEmpty()) return Parsed("", "", warning)
        require(name.split(" ").size <= 12) { "Запит має містити не більше 12 слів." }
        require(name.isNotEmpty() && name.any { it in 'a'..'z' }) { "Додайте назву вулиці або населеного пункту." }
        require(name.replace(" ", "").length >= 2) { "Введіть щонайменше дві літери." }
        return Parsed(name, number, warning)
    }
    fun rank(street: String, city: String, house: String, text: String, wantedHouse: String): Int {
        val words = (street + " " + city).split(" ").filter { it.isNotEmpty() }
        val tier = when {
            text in setOf(street, city, "$street $city", "$city $street") -> 0
            street.isNotEmpty() && street.endsWith(" $text") -> 1
            street.startsWith(text) || city.startsWith(text) -> 2
            text.split(" ").all { t -> words.any { it.startsWith(t) } } -> 3
            else -> 4
        }
        return tier * 10 + if (wantedHouse.isNotEmpty() && house != wantedHouse) 1 else 0
    }
}

/** Lazy read-only SQLite, never PostgreSQL or schema/import code. */
class PrgAddressSearch(private val path: Path = configuredPath()) {
    private val permits = Semaphore(4)

    suspend fun search(query: String, limit: Int = 10): PrgSearchResponse {
        require(limit > 0) { "limit має бути додатним цілим числом." }
        val parsed = PrgQuery.parse(query)
        if (parsed.text.isEmpty()) return PrgSearchResponse(query, emptyList(), parsed.warning)
        return permits.withPermit {
            withContext(Dispatchers.IO) {
                if (!Files.isRegularFile(path)) throw SQLException("PRG SQLite is unavailable")
                DriverManager.getConnection("jdbc:sqlite:" + path.toAbsolutePath().toUri() + "?mode=ro").use { c ->
                    c.createStatement().use { it.execute("PRAGMA query_only=ON") }
                    val deadline = System.nanoTime() + 2_000_000_000L
                    ProgressHandler.setHandler(c, 10000, object : ProgressHandler() {
                        override fun progress(): Int = if (System.nanoTime() > deadline) 1 else 0
                    })
                    Function.create(c, "text_rank", object : Function() {
                        override fun xFunc() {
                            result(PrgQuery.rank(value_text(0), value_text(1), value_text(2), value_text(3), value_text(4)))
                        }
                    }, 5, Function.FLAG_DETERMINISTIC)
                    var text = parsed.text
                    var house = parsed.house
                    if (house.isNotEmpty() && "/" !in house) {
                        c.prepareStatement("SELECT 1 FROM streets WHERE street_norm=? LIMIT 1").use {
                            it.setString(1, PrgQuery.text(query))
                            it.executeQuery().use { rs -> if (rs.next()) { text = PrgQuery.text(query); house = "" } }
                        }
                    }
                    val capped = limit.coerceAtMost(50)
                    val results = if (house.isNotEmpty()) rows(c, text, house, capped, "address") else {
                        val streets = rows(c, text, "", capped, "street")
                        if (streets.size == capped) streets else streets +
                            rows(c, text, "", 50, "address").filter { it.street.isEmpty() }.take(capped - streets.size)
                    }
                    PrgSearchResponse(query, results, parsed.warning)
                }
            }
        }
    }

    private fun rows(c: Connection, text: String, house: String, limit: Int, kind: String): List<PrgAddressResult> {
        val isStreet = kind == "street"
        val table = if (isStreet) "streets" else "addresses"
        val words = if (isStreet) "street_words" else "words"
        val fragments = if (isStreet) "street_fragments" else "fragments"
        val tokens = text.split(" ")
        val params = mutableListOf<Any>(tokens.joinToString(" AND ") { "\"$it\"*" })
        var candidates = "SELECT rowid FROM $words WHERE $words MATCH ?"
        val longTokens = tokens.filter { it.length >= 3 }
        if (longTokens.isNotEmpty()) {
            candidates += " UNION SELECT rowid FROM $fragments WHERE $fragments MATCH ?"
            params.add(longTokens.joinToString(" AND ") { "\"$it\"" })
        }
        val filters = tokens.map { "instr(a.text_norm, ?) > 0" }.toMutableList()
        params.addAll(listOf(text, house))
        params.addAll(tokens)
        if (house.isNotEmpty()) {
            if ("/" in house) { filters.add("a.house_norm = ?"); params.add(house) }
            else {
                filters.add("(a.house_norm = ? OR a.house_norm GLOB ?)")
                params.addAll(listOf(house, house + "[a-z]*"))
            }
        }
        params.add(limit)
        val sql = """
            WITH candidates AS ($candidates)
            SELECT a.*, text_rank(a.street_norm,a.city_norm,a.house_norm,?,?) AS rank
            FROM candidates JOIN $table a ON a.rowid=candidates.rowid
            WHERE ${filters.joinToString(" AND ")}
            ORDER BY rank, (a.city_norm = 'lublin') DESC, length(a.street_norm), a.city_norm, a.street_norm,
                cast(a.house_norm AS INTEGER), a.house_norm, a.id LIMIT ?
        """.trimIndent()
        return c.prepareStatement(sql).use { stmt ->
            params.forEachIndexed { i, value -> stmt.setObject(i + 1, value) }
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(PrgAddressResult(
                        type = kind, id = rs.getString("id"), source_id = rs.getString("source_id"),
                        display_name = rs.getString("display_name"), locality = rs.getString("locality"),
                        simc = rs.getString("simc"), terc = rs.getString("terc"), street = rs.getString("street"),
                        house_number = rs.getString("house_number"), lat = rs.getDouble("lat"), lon = rs.getDouble("lon"),
                        match_rank = rs.getInt("rank"), ulic = if (isStreet) rs.getString("ulic") else "",
                        coordinate_kind = if (isStreet) "street_representative" else "address_point",
                        origin = if (isStreet) rs.getString("origin") else "PRG_PunktyAdresowe",
                        representative_method = if (isStreet) rs.getString("representative_method") else null
                    ))
                }
            }
        }
    }

    companion object {
        fun configuredPath(): Path {
            System.getenv("PRG_SQLITE_PATH")?.takeIf { it.isNotBlank() }?.let { return Path.of(it) }
            val candidates = listOf(
                Path.of("../experiments/local-geocoder/data/addresses.sqlite"),
                Path.of("experiments/local-geocoder/data/addresses.sqlite")
            )
            return candidates.firstOrNull { Files.isRegularFile(it) } ?: candidates.first()
        }
    }
}
