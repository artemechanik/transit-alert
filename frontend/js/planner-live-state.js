import { LIVE_MAX_AGE, hasFreshLive } from './planner-results.js';

export const PASSENGER_LIVE_STATES = {
    not_started: { label: 'Kurs jeszcze się nie rozpoczął', tone: 'neutral', hint: 'Poczekaj na rozpoczęcie kursu.' },
    approaching: { label: 'Jedzie do Ciebie', tone: 'info', hint: 'Sprawdź miejsce wejścia.' },
    near: { label: 'Zbliża się', tone: 'info', hint: 'Przygotuj się do wejścia.' },
    boarding: { label: 'Na przystanku', tone: 'boarding', hint: 'Pojazd stoi na przystanku wejścia. Sprawdź numer linii przed wejściem.' },
    in_progress: { label: 'Kurs w toku', tone: 'info', hint: 'Pojazd minął przystanek wejścia. Sprawdź dalszy przebieg kursu.' },
    unknown: { label: 'Brak aktualnej lokalizacji', tone: 'neutral', hint: 'Nie można potwierdzić położenia względem miejsca wejścia. Sprawdź rozkład.' }
};

// Pure presentation logic. A timetable is never evidence that a course has not started.
// not_started is reserved for an explicit operational signal absent from today's API.
export function passengerLiveState(segment, now = Date.now() / 1000) {
    const result = (state, extra = {}) => ({ state, ...PASSENGER_LIVE_STATES[state], nextStop: null, stopsToBoarding: null, ...extra });
    const stops = segment?.stops;
    const live = stops?.live;
    const all = stops?.tripStops || stops?.timelineStops || stops || [];
    const valid = live?.tripId === segment?.leg?.tripId && live?.isFresh
        && Number.isFinite(live.gpsTimestamp) && live.gpsTimestamp > 0
        && now - live.gpsTimestamp >= 0 && now - live.gpsTimestamp <= LIVE_MAX_AGE
        && Number.isInteger(live.currentStopSequence)
        && ['STOPPED_AT','IN_TRANSIT_TO','INCOMING_AT'].includes(live.currentStatus)
        && all.length > 0 && all.every((s,i) => Number.isInteger(s.stopSequence)
            && (!i || s.stopSequence > all[i-1].stopSequence));
    if (!valid) return result('unknown');
    const current = all.findIndex(s => s.stopSequence === live.currentStopSequence);
    const nextStop = current < 0 ? null : live.currentStatus === 'STOPPED_AT' ? all[current+1] || null : all[current];
    // Determine the next stop independently of whether boarding is unambiguous.
    const neutral = () => result('unknown', { nextStop });
    let boarding = stops.boardingSequence;
    if (!Number.isInteger(boarding)) {
        const matches = all.filter(s => s.stopId === segment.leg.fromStopId);
        if (!segment.leg.fromStopId || matches.length !== 1) return neutral();
        boarding = matches[0].stopSequence;
    }
    const boardingIndex = all.findIndex(s => s.stopSequence === boarding);
    if (boardingIndex < 0 || (segment.leg.fromStopId && all[boardingIndex].stopId !== segment.leg.fromStopId)) return neutral();
    // The response may end at alighting; a sequence beyond it still proves boarding was passed.
    if (live.currentStopSequence > boarding && (current >= 0 || live.currentStopSequence > all.at(-1).stopSequence)) {
        return result('in_progress', { nextStop, stopsToBoarding: 0 });
    }
    if (current < 0) return neutral();
    if (current === boardingIndex && live.currentStatus === 'STOPPED_AT') {
        return result('boarding', { nextStop, stopsToBoarding: 0 });
    }
    const remaining = boardingIndex - current + (live.currentStatus === 'STOPPED_AT' ? 0 : 1);
    if (remaining < 1) return neutral();
    if (remaining === 1) {
        const hint = live.currentStatus === 'STOPPED_AT' ? 'Pojazd stoi na poprzednim przystanku. Przygotuj się do wejścia.'
            : live.currentStatus === 'INCOMING_AT' ? 'Pojazd zbliża się do przystanku wejścia. Przygotuj się do wejścia.'
                : 'Pojazd jedzie do przystanku wejścia. Przygotuj się do wejścia.';
        return result('near', { nextStop, stopsToBoarding: remaining, hint });
    }
    const motion = live.currentStatus === 'STOPPED_AT' ? 'Pojazd stoi na wcześniejszym przystanku.'
        : live.currentStatus === 'INCOMING_AT' ? 'Pojazd zbliża się do wcześniejszego przystanku.' : 'Sprawdź miejsce wejścia.';
    const noun = remaining % 10 >= 2 && remaining % 10 <= 4 && (remaining % 100 < 12 || remaining % 100 > 14) ? 'przystanki' : 'przystanków';
    return result('approaching', { nextStop, stopsToBoarding: remaining, hint: `${motion} Do wejścia: ${remaining} ${noun}.` });
}

// Arrival belongs to the chosen transport leg, never the final destination of a transfer journey.
export function alightingProgress(segment, now = Date.now() / 1000) {
    if (passengerLiveState(segment, now).state !== 'in_progress') return null;
    const { leg, stops } = segment;
    const all = stops.tripStops || stops.timelineStops || stops;
    const boarding = stops.boardingSequence ?? all.find(s => s.stopId === leg.fromStopId)?.stopSequence;
    const destinations = leg.toStopId ? all.filter(s => s.stopId === leg.toStopId && s.stopSequence >= boarding) : [];
    const destination = destinations.length === 1 ? all.indexOf(destinations[0]) : -1;
    const current = all.findIndex(s => s.stopSequence === stops.live.currentStopSequence);
    const passed = destination >= 0 && stops.live.currentStopSequence > all[destination].stopSequence;
    const atDestination = destination >= 0 && current === destination && stops.live.currentStatus === 'STOPPED_AT';
    const stopsRemaining = passed || destination < 0 || current < 0 ? null
        : destination - current + (stops.live.currentStatus === 'STOPPED_AT' ? 0 : 1);
    const live = hasFreshLive(leg, now) && Number.isFinite(leg.arrivalEpoch);
    const arrival = live ? leg.arrivalEpoch : leg.scheduledArrivalEpoch;
    const minutes = !passed && !atDestination && Number.isFinite(arrival) && arrival > now
        ? Math.ceil((arrival - now) / 60) : null;
    return { stopsRemaining, minutes, live, atDestination, passed };
}
