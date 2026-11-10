package com.artem.transitalert

import kotlinx.serialization.json.*
import java.sql.Connection

/** Only addresses attached to this canonical place's source features; never nearest PRG. */
internal object PoiAddress {
    data class Label(val line: String?, val locality: String, val status: String) {
        val subtitle: String get() = listOfNotNull(line,locality.takeIf { it.isNotBlank() })
            .distinctBy { PrgQuery.normalize(it) }.joinToString(", ")
    }
    fun read(c: Connection, id: String, fallback: String): Label {
        // Old dictionaries remain readable; curated values live separately from source raw_json.
        val hasOverrides=c.createStatement().use { s -> s.executeQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='address_overrides'").use { it.next() } }
        if (hasOverrides) c.prepareStatement("SELECT address_line,locality FROM address_overrides WHERE poi_id=? AND confidence='confirmed'").use { s ->
            s.setString(1,id)
            s.executeQuery().use { rs -> if(rs.next()) return format(listOf(rs.getString(1) to rs.getString(2)),fallback) }
        }
        val addresses=mutableListOf<Pair<String,String>>()
        c.prepareStatement("SELECT raw_json FROM features WHERE poi_id=? AND source='overture' ORDER BY source_id").use { s ->
            s.setString(1,id)
            s.executeQuery().use { rs -> while(rs.next()) {
                val raw=Json.parseToJsonElement(rs.getString(1)).jsonObject
                for (a in (raw["addresses"] as? JsonArray).orEmpty()) {
                    val obj=a.jsonObject
                    fun text(key: String)=(obj[key] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
                    if(text("country").isNotEmpty() && text("country")!="PL") continue
                    addresses.add(text("freeform") to text("locality"))
                }
            } }
        }
        return format(addresses,fallback)
    }
    internal fun format(addresses: List<Pair<String,String>>, fallback: String): Label {
        val cities=addresses.map { it.second }.filter { it.isNotBlank() }.distinctBy { PrgQuery.normalize(it) }
        val city=cities.singleOrNull() ?: fallback
        val lines=addresses.map { it.first }.filter { it.isNotBlank() && PrgQuery.normalize(it)!=PrgQuery.normalize(city) }
            .distinctBy { PrgQuery.normalize(it) }
        // Conflicting source addresses must not silently choose a different building/site.
        if(lines.size!=1 || cities.size>1) return Label(null,city,"none")
        val line=lines.single()
        val numberAtEnd=Regex(""".*\p{L}.*\s\d+[\p{L}]?(?:\s*[/\-–—]\s*\d+[\p{L}]?)?$""").matches(line)
        return Label(line,city,if(numberAtEnd && cities.size==1) "full" else "partial")
    }
}
