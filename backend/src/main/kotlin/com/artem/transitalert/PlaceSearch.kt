package com.artem.transitalert

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import java.sql.SQLException

/** Merge two already-ranked streams: never reorder the tested PRG stream. */
internal object PlaceRanking {
    fun merge(prg: List<PrgAddressResult>, poi: List<PrgAddressResult>, limit: Int): List<PrgAddressResult> {
        val a=prg.toMutableList(); val b=poi.toMutableList()
        fun score(r: PrgAddressResult) = if (r.type=="poi") r.match_rank
            else if (r.type=="address") minOf(3, r.match_rank / 10) - 1 else minOf(3, if (r.match_rank / 10 == 3) 2 else r.match_rank / 10)
        return buildList {
            while (size<limit && (a.isNotEmpty() || b.isNotEmpty())) {
                if (b.isEmpty() || (a.isNotEmpty() && (score(a.first())<score(b.first()) || (score(a.first())==score(b.first()) && lastOrNull()?.type=="poi")))) add(a.removeAt(0))
                else add(b.removeAt(0))
            }
        }
    }
}

class PlaceSearch(private val prg: PrgAddressSearch, private val poi: PoiSearch?) {
    suspend fun search(query: String, limit: Int): PrgSearchResponse = coroutineScope {
        require(query.codePointCount(0,query.length)<=200 && query.none { it.code<32 })
        val normalized=PrgQuery.normalize(query)
        require(normalized.split(" ").size<=12)
        if (normalized.isEmpty()) return@coroutineScope PrgSearchResponse(query,emptyList(),null)
        require(normalized.replace(" ","").length>=2 && normalized.any { it in 'a'..'z' })
        val addresses=async { try { prg.search(query,limit) } catch (_: SQLException) { null } catch (_: IllegalArgumentException) { null } }
        val places=async { if (poi==null) emptyList() else try { poi.search(query,limit) } catch (_: SQLException) { null } }
        val a=addresses.await(); val b=places.await()
        val invalidPrg = try { PrgQuery.parse(query); null } catch (e: IllegalArgumentException) { e }
        if (invalidPrg != null && b.orEmpty().isEmpty()) throw invalidPrg
        if (a==null && (b==null || poi==null)) throw SQLException("Both local dictionaries unavailable")
        PrgSearchResponse(query,PlaceRanking.merge(a?.results.orEmpty(),b.orEmpty(),limit),
            a?.warning ?: if (a==null || b==null) "Część lokalnych źródeł wyszukiwania jest niedostępna." else null)
    }
}
