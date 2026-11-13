// State belongs to one search; absolute scheduled times distinguish service days.
export const LIVE_MAX_AGE = 300;
export function journeyKey(journey) {
    return journey.legs.filter(l => l.route !== 'Пішки' && l.route)
        .map(l => [l.tripId, l.fromStopId, l.toStopId, l.scheduledDepartureEpoch].join(':')).join('|');
}
export function mergePrediction(previous, incoming, now) {
    if (!previous) return incoming;
    return { ...incoming, legs: incoming.legs.map((leg, i) => {
        const old = previous.legs[i];
        if (!hasFreshLive(leg, now) && hasFreshLive(old, now)) return { ...leg,
            departureEpoch: old.departureEpoch, arrivalEpoch: old.arrivalEpoch,
            departureMin: old.departureMin, arrivalMin: old.arrivalMin,
            delayMinutes: old.delayMinutes, isRealTime: true, liveObservedEpoch: old.liveObservedEpoch };
        return leg;
    }) };
}
export function hasFreshLive(leg, now) {
    return !!leg?.isRealTime && Number.isFinite(leg.liveObservedEpoch)
        && now - leg.liveObservedEpoch >= 0 && now - leg.liveObservedEpoch <= LIVE_MAX_AGE
        && Number.isFinite(leg.departureEpoch);
}
export function boardingDeadline(journey, now) {
    const first = journey.legs.find(l => l.route !== 'Пішки' && l.route);
    const departure = hasFreshLive(first, now) ? first.departureEpoch : first?.scheduledDepartureEpoch;
    return Number.isFinite(departure) ? departure : Infinity;
}
// Display correction for straight-line walking estimates; never a routing constraint.
export function displayWalkMinutes(rawMinutes) {
    return Number.isFinite(rawMinutes) ? Math.round(Math.max(0, rawMinutes) * 1.8) : 0;
}
export function initialWalkMinutes(journey) {
    const first = journey.legs[0];
    return first && (!first.route || first.route === 'Пішки')
        ? displayWalkMinutes(first.arrivalMin - first.departureMin) : 0;
}
export function initialWalkRisk(journey, now) {
    const walk = initialWalkMinutes(journey);
    return walk > 0 && now + walk * 60 > boardingDeadline(journey, now);
}

export function createResultsState() {
    const entries = new Map();
    return { entries,
        setPinned(key, pinned) {
            const entry = entries.get(key);
            if (!entry || entry.expired) return false;
            entry.pinned = !!pinned;
            return true;
        },
        clearPins() { for (const entry of entries.values()) entry.pinned = false; },
        update(journeys, now) {
        for (const journey of journeys) {
            const key = journeyKey(journey), old = entries.get(key);
            if (old?.expired) continue;
            entries.set(key, { ...old, journey: mergePrediction(old?.journey, journey, now), departedAt: old?.departedAt ?? null });
        }
        for (const entry of entries.values()) {
            if (!entry.expired) {
                entry.journey = { ...entry.journey, legs: entry.journey.legs.map(leg => {
                    if (!leg.isRealTime || leg.liveObservedEpoch == null || now - leg.liveObservedEpoch <= LIVE_MAX_AGE) return leg;
                    return { ...leg, isRealTime: false, departureMin: leg.departureMin - (leg.delayMinutes || 0),
                        arrivalMin: leg.arrivalMin - (leg.delayMinutes || 0), delayMinutes: 0,
                        departureEpoch: leg.scheduledDepartureEpoch, arrivalEpoch: leg.scheduledArrivalEpoch };
                }) };
                const deadline = boardingDeadline(entry.journey, now);
                const first = entry.journey.legs.find(l => l.route !== 'Пішки' && l.route);
                if (deadline > now && hasFreshLive(first, now)) entry.departedAt = null;
                else if (deadline <= now && entry.departedAt == null) entry.departedAt = now;
            }
            entry.expired = !entry.pinned && entry.departedAt != null && now >= entry.departedAt + 60;
        }
        // Keep tombstones only through their service day, bounded by this search.
        for (const [key, entry] of entries) {
            const last = Math.max(...entry.journey.legs.map(l => l.scheduledArrivalEpoch || 0));
            if (entry.expired && now > last + 86400) entries.delete(key);
        }
        return entries;
    } };
}
