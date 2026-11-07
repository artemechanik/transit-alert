package com.artem.transitalert

import java.text.Collator
import java.util.Locale

internal fun searchStops(stops: List<StopSuggestion>, query: String): List<StopSuggestion> {
    val q = query.trim().normalizePL()
    if (q.length < 2) return emptyList()
    // Collator is mutable: keep it local to each search request.
    val polish = Collator.getInstance(Locale.forLanguageTag("pl"))
    polish.strength = Collator.SECONDARY
    fun rank(stop: StopSuggestion): Int {
        val name = stop.name.normalizePL()
        return when {
            name == q -> 0
            name.startsWith(q) -> 1
            name.contains(" $q") || name.contains("-$q") -> 2
            stop.code.normalizePL().startsWith(q) -> 3
            else -> 4
        }
    }
    return stops.filter { it.name.normalizePL().contains(q) || it.code.normalizePL().contains(q) }
        .sortedWith(compareBy<StopSuggestion> { rank(it) }
            .thenComparator { a, b -> polish.compare(a.name, b.name) }
            .thenBy { it.name }
            .thenBy { it.code.toIntOrNull() ?: Int.MAX_VALUE }
            .thenBy { it.code }
            .thenBy { it.stopId })
        .take(20)
}
