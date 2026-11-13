import { createEmbeddedTripMap } from './planner-inline-map.js';
import { LIVE_MAX_AGE } from './planner-results.js';
import { legCountdown, departureClock } from './planner-countdown.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const statuses = new Set(['STOPPED_AT', 'IN_TRANSIT_TO', 'INCOMING_AT']);

export function timelinePosition(leg, stops, live, now = Date.now() / 1000) {
    if (!live || live.tripId !== leg.tripId || !live.isFresh || !Number.isFinite(live.gpsTimestamp)
        || live.gpsTimestamp <= 0 || now - live.gpsTimestamp < 0 || now - live.gpsTimestamp > LIVE_MAX_AGE
        || !Number.isInteger(live.currentStopSequence) || !statuses.has(live.currentStatus)) return { kind: 'unknown' };
    if (!stops.length || stops.some((s, i) => !Number.isInteger(s.stopSequence)
        || (i && s.stopSequence <= stops[i - 1].stopSequence))) return { kind: 'unknown' };
    const sequence = live.currentStopSequence;
    if (sequence < stops[0].stopSequence) return { kind: 'before', sequence };
    if (sequence > stops.at(-1).stopSequence) return { kind: 'after', sequence };
    if (!stops.some(s => s.stopSequence === sequence)) return { kind: 'unknown' };
    return { kind: live.currentStatus === 'STOPPED_AT' ? 'at' : 'between',
        sequence, incoming: live.currentStatus === 'INCOMING_AT' };
}

export function timelineRows(segment, now = Date.now() / 1000) {
    const { leg, stops } = segment;
    const all = stops.timelineStops || stops;
    const boarding = stops.boardingSequence ?? stops[0]?.stopSequence;
    const position = timelinePosition(leg, all, stops.live, now);
    let from = boarding;
    if (position.kind !== 'unknown' && position.sequence < boarding) {
        const index = all.findIndex(s => s.stopSequence === position.sequence);
        if (index >= 0) from = all[Math.max(0, index - 1)].stopSequence;
    }
    if (segment.approachStartSequence != null) from = Math.min(from, segment.approachStartSequence);
    return { rows: all.filter(s => s.stopSequence >= from), boarding, position, from };
}

export function renderJourneyTimeline(segments, active, now, addMinutesToTime) {
    return segments.map((segment, index) => {
        const { leg } = segment;
        const { rows: stops, boarding, position } = timelineRows(segment, now);
        const marker = `<span class="lubus-bus" data-timeline-current><b>${esc(leg.route)} · Teraz</b>${position.incoming ? '<small>Zbliża się</small>' : ''}<button type="button" data-timeline-map="${index}">Mapa</button></span>`;
        const rows = stops.map((stop, i) => {
            const passed = position.kind !== 'unknown' && stop.stopSequence < position.sequence;
            const current = index === active && stop.stopSequence === position.sequence;
            const event = stop.stopSequence === boarding ? 'Wsiądź' : i === stops.length - 1 ? 'Wysiądź' : '';
            const eta = stop.stopSequence === boarding ? departureClock(legCountdown(leg, now).departure)
                : leg.delayMinutes && addMinutesToTime ? addMinutesToTime(stop.eta, leg.delayMinutes) : stop.eta;
            return `${current && position.kind === 'between' ? `<li class="lubus-vehicle-row">${marker}</li>` : ''}
                <li class="lubus-timeline-stop${passed ? ' passed' : ''}${event ? ' key-stop' : ''}" data-sequence="${stop.stopSequence}">
                  <span>${current && position.kind === 'at' ? marker : ''}${esc(stop.name)} ${esc(stop.platformCode)}${event ? `<small>${event} · ${esc(leg.route)}</small>` : ''}</span><time>${esc(eta)}</time>
                </li>`;
        }).join('');
        const note = position.kind === 'before' ? 'Pojazd przed odcinkiem podróży.' : position.kind === 'after'
            ? 'Pojazd minął ten odcinek.' : position.kind === 'unknown' ? 'Brak aktualnego położenia względem przystanków.' : '';
        return `<section class="lubus-timeline-leg" data-segment="${index}"><header>
            <button type="button" data-timeline-select="${index}" aria-pressed="${index === active}">Linia ${esc(leg.route)}</button>
            <span>Wsiądź · ${esc(leg.fromStopName)}</span></header>
            ${note ? `<p class="lubus-note">${note}</p>` : ''}
            ${stops.length ? `<ol class="lubus-timeline-stops">${rows}</ol>` : '<p class="lubus-note">Brak jednoznacznych danych przystanków tego odcinka.</p>'}</section>`;
    }).join('');
}

export function setupJourneyTimeline(panel, legs, results, mapActions, addMinutesToTime, mapServices) {
    const view = panel.querySelector('.lubus-timeline');
    const scroller = panel.querySelector('.lubus-journey');
    if (!view || !scroller) return;
    const segments = legs.map((leg, i) => ({ leg, stops: results[i] || [] }));
    let active = 0, manual = false, positioned = false, suspended = false;
    const embeddedMap = createEmbeddedTripMap({ panel, services: mapServices,
        getSegment: () => segments[active] });
    function locate() {
        if (panel.dataset.lubusTab !== 'journey' || manual || positioned
            || panel.closest('#route-results-list')?.dataset.presentation !== 'new') return;
        const marker = view.querySelector('[data-timeline-current]');
        if (!marker) return;
        const top = marker.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 48;
        scroller.scrollTop = Math.max(0, top);
        positioned = true;
    }
    function render(now = Date.now() / 1000) {
        for (const segment of segments) {
            const { from, boarding } = timelineRows(segment, now);
            if (from < boarding) segment.approachStartSequence = from;
        }
        // Preserve the reader's stop when a marker is inserted/removed above it.
        const anchor = [...view.querySelectorAll('.lubus-timeline-stop')].find(node =>
            node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
        const key = anchor ? [anchor.closest('[data-segment]').dataset.segment, anchor.dataset.sequence] : null;
        const offset = anchor?.getBoundingClientRect().top;
        const html = renderJourneyTimeline(segments, active, now, addMinutesToTime);
        if (view.innerHTML !== html) {
            view.innerHTML = html;
            if (key) {
                const replacement = [...view.querySelectorAll('.lubus-timeline-stop')].find(node =>
                    node.closest('[data-segment]').dataset.segment === key[0] && node.dataset.sequence === key[1]);
                if (replacement) scroller.scrollTop += replacement.getBoundingClientRect().top - offset;
            }
        }
        locate();
        if (!suspended) embeddedMap.sync();
        (panel.querySelectorAll?.('[data-map-segment]') || []).forEach(button => {
            button.ariaPressed = String(Number(button.dataset.mapSegment) === active);
        });
        const fullscreen = panel.querySelector('.lubus-map-action');
        if (fullscreen) fullscreen.dataset.legIndex = String(active);
    }
    const stopFollowing = () => { manual = true; };
    scroller.addEventListener('wheel', stopFollowing, { passive: true });
    scroller.addEventListener('touchstart', stopFollowing, { passive: true });
    scroller.addEventListener('pointerdown', event => { if (!event.target.closest('button')) stopFollowing(); });
    scroller.addEventListener('keydown', event => {
        if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key) && !event.target.closest('button')) stopFollowing();
    });
    view.addEventListener('click', event => {
        const select = event.target.closest('[data-timeline-select]');
        const map = event.target.closest('[data-timeline-map]');
        if (select) choose(Number(select.dataset.timelineSelect));
        if (map) panel.querySelector('[data-lubus-tab="map"]')?.click();
        event.stopPropagation();
    });
    function choose(index) {
        if (!segments[index]) return;
        active = index; manual = false; positioned = false; render();
    }
    (panel.querySelectorAll?.('[data-map-segment]') || []).forEach(button => {
        button.addEventListener('click', event => { event.stopPropagation(); choose(Number(button.dataset.mapSegment)); });
    });
    panel.lubusTimeline = {
        opened() { locate(); if (!suspended) embeddedMap.sync(); },
        visibilityChanged() { if (!suspended) embeddedMap.sync(); },
        suspend() { suspended = true; embeddedMap.destroy(); },
        resume() { suspended = false; embeddedMap.sync(); },
        destroy() { suspended = true; embeddedMap.destroy(); },
        observations: () => segments,
        selectedIndex: () => active,
        select: choose,
        update(index, stops) {
            if (!segments[index]) return;
            // Keep the static itinerary on a failed refresh, but discard its live claim.
            if (stops.length) segments[index].stops = stops;
            else {
                const previous = segments[index].stops;
                segments[index].stops = Object.assign([...previous], {
                    timelineStops: previous.timelineStops, tripStops: previous.tripStops, boardingSequence: previous.boardingSequence
                });
            }
            render();
        },
        predictions(journey, now) {
            const transit = journey.legs.filter(l => l.route && l.route !== 'Пішки');
            segments.forEach((segment, i) => { if (transit[i]) segment.leg = transit[i]; });
            render(now);
        }
    };
    render();
}

export function renderLivePosition(segment, now = Date.now() / 1000) {
    if (!segment) return '';
    const { leg } = segment;
    const { rows: stops, position } = timelineRows(segment, now);
    const index = stops.findIndex(stop => stop.stopSequence === position.sequence);
    const next = position.kind === 'at' ? stops[index + 1] : position.kind === 'between' ? stops[index] : null;
    const current = position.kind === 'at' ? `<p class="lubus-note">Na przystanku: <strong>${esc(stops[index].name)} ${esc(stops[index].platformCode)}</strong></p>` : '';
    return current + (next ? `<p class="lubus-note">Następny przystanek: <strong>${esc(next.name)} ${esc(next.platformCode)}</strong></p>` : '');
}
