package com.artem.transitalert

import kotlinx.serialization.Serializable

@Serializable
data class CreateReportRequest(
    val stopId: String? = null,
    val route: String? = null,
    val direction: String? = null,
    val stopName: String? = null,
    val comment: String? = null,
    val fingerprint: String,
    val previousReportId: Int? = null
)

@Serializable
data class ReportResponse(
    val id: Int,
    val stopId: String,
    val stopName: String,
    val stopCode: String,
    val lat: Double,
    val lon: Double,
    val comment: String?,
    val route: String?,
    val direction: String?,
    val createdAt: String,
    val confirms: Int,
    val denies: Int,
    val previousReportId: Int? = null
)

@Serializable
data class VoteRequest(
    val fingerprint: String,
)

// Змінили назву, щоб не було конфлікту з RiskRoutes.kt
@Serializable
data class StopRouteDto(
    val route: String,
    val direction: String
)

@Serializable
data class StopSuggestion(
    val stopId: String,
    val name: String,
    val code: String,
    val lat: Double,
    val lon: Double,
    val routes: List<StopRouteDto> = emptyList() // Використовуємо нову назву тут
)

@Serializable
data class StopDepartureDto(
    val route: String,
    val direction: String,
    val scheduledTime: String, 
    val minutesLeft: Int,      
    val isRealTime: Boolean,   
    val delayMinutes: Int      
)
