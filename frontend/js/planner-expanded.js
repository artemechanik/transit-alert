import { legCountdown, journeyCountdown, departureClock } from './planner-countdown.js';
import { assessTransfer, transferPlatformChange, transferWalkMinutes } from './planner-transfer.js';
import { hasFreshLive, boardingDeadline, initialWalkRisk, initialWalkMinutes } from './planner-results.js';
import { passengerLiveState } from './planner-live-state.js';
import { captureListAnchor, restoreListAnchor } from './list-motion.js';
import { pinButtonMarkup } from './planner-pin.js';

// Presentation only: forecasts and LIVE eligibility come from planner-results.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const transitLegs = journey => journey.legs.filter(leg => leg.route && leg.route !== 'Пішки');

const quantity = (value, one, few, many) => `${value} ${value === 1 ? one
    : value % 10 >= 2 && value % 10 <= 4 && (value % 100 < 12 || value % 100 > 14) ? few : many}`;

function tripDirection(segment, leg) {
    // tripStops is the full API sequence, unlike the itinerary truncated at alighting.
    if (!leg.tripId || segment?.leg?.tripId !== leg.tripId) return '';
    const terminal = segment.stops?.tripStops?.at(-1);
    if (!terminal?.name) return '';
    let name = terminal.name.trim();
    const code = String(terminal.platformCode ?? '').trim();
    if (code) {
        for (const suffix of [` (${code})`, ` ${code}`]) {
            if (name.endsWith(suffix)) { name = name.slice(0, -suffix.length).trim(); break; }
        }
    }
    return name;
}

function boardingMetrics(journey, index, state, now) {
    const { live: fresh, minutes: remaining, color } = journeyCountdown(journey, now, index);
    const count = state.state !== 'in_progress' && Number.isInteger(state.stopsToBoarding)
        ? `<div><dt>Do wejścia</dt><dd>${quantity(state.stopsToBoarding, 'przystanek', 'przystanki', 'przystanków')}</dd></div>` : '';
    const eta = remaining === null ? '' : `<div><dt>${fresh ? 'Za około' : 'Według rozkładu'}</dt><dd style="color:${color}">${remaining < 0
        ? 'Termin odjazdu minął' : remaining === 0 ? 'Teraz' : quantity(remaining, 'minutę', 'minuty', 'minut')}</dd></div>`;
    return count || eta ? `<dl class="lubus-boarding-metrics">${count}${eta}</dl>` : '';
}

function initialWalkHint(journey, index, now) {
    if (index !== 0 || !initialWalkRisk(journey, now)) return '';
    const minutes = Math.max(0, legCountdown(transitLegs(journey)[0], now).minutes);
    return `<div class="lubus-walk-risk" role="status"><strong>⚠ Możesz nie zdążyć na przystanek</strong><p>Odjazd ${minutes ? `za ${minutes} min` : 'teraz'} · dojście około ${initialWalkMinutes(journey)} min</p></div>`;
}

function transferHint(journey, transit, index, now) {
    const current = transit[index], next = transit[index + 1];
    if (!next) return '';
    const platformChange = transferPlatformChange(current, next);
    const transfer = assessTransfer({ arrivalMin: current.arrivalMin, departureMin: next.departureMin,
        walkMin: transferWalkMinutes(journey.legs, current, next), platformChange });
    const duration = value => quantity(value, 'minuta', 'minuty', 'minut');
    const instruction = platformChange === 'same' ? 'Zostań na tym samym przystanku.'
        : platformChange === 'different' && next.fromStopName
            ? `Przejdź na przystanek <strong>${escapeHtml(next.fromStopName)}</strong>.`
            : 'Sprawdź przystanek wejścia na kolejny odcinek.';
    const walking = platformChange === 'different' && transfer.walkMin !== null
        ? ` Przejście: około ${duration(Math.ceil(transfer.walkMin))}.` : '';
    const wait = transfer.waitingMin === null ? '' : transfer.waitingMin < 0
        ? `Czasu na przesiadkę jest o około ${quantity(Math.ceil(-transfer.waitingMin), 'minutę', 'minuty', 'minut')} za mało.`
        : transfer.waitingMin < 1 ? 'Brak zapasu czasu na przesiadkę.'
            : `${duration(Math.floor(transfer.waitingMin))} oczekiwania${platformChange === 'different' ? ' po przejściu' : ''}.`;
    return `<section class="lubus-transfer-hint" data-risk="${transfer.risky}" aria-label="Przesiadka">
        ${transfer.risky ? '<p class="lubus-transfer-risk" role="status">⚠ Ryzykowna przesiadka</p>' : ''}
        <dl><div><dt>Wsiądź do ${escapeHtml(next.route)}${hasFreshLive(next, now) ? '' : ' · według rozkładu'}</dt><dd><time>${departureClock(legCountdown(next, now).departure)}</time></dd></div></dl>
        <p class="lubus-change-note">${wait ? `<strong>${wait}</strong> ` : ''}${instruction}${walking}</p>
    </section>`;
}

function journeyAdvice(journey, leg, index, state, now) {
    const fresh = hasFreshLive(leg, now);
    const delay = leg.delayMinutes === undefined ? 0 : leg.delayMinutes;
    const known = fresh && Number.isFinite(delay);
    const tone = !known ? 'neutral' : delay > 0 ? 'late' : delay < 0 ? 'early' : 'on-time';
    const punctuality = !known ? 'Brak aktualnych danych o punktualności.'
        : delay > 0 ? `Pojazd ma ${delay} min opóźnienia.`
            : delay < 0 ? `Pojazd jedzie ${Math.abs(delay)} min przed rozkładem.`
                : 'Pojazd jedzie zgodnie z rozkładem.';
    const walk = initialWalkMinutes(journey);
    const remaining = boardingDeadline(journey, now) - now - walk * 60;
    let leave = '';
    if (index === 0 && state.state !== 'in_progress' && walk > 0 && Number.isFinite(remaining) && remaining >= 0) {
        const minutes = Math.floor(remaining / 60);
        leave = remaining === 0 ? 'Wyrusz teraz.' : minutes < 1 ? 'Wyrusz najpóźniej za mniej niż minutę — najlepiej wcześniej.'
            : `Wyrusz najpóźniej za ${minutes} min — najlepiej wcześniej.`;
        if (!fresh) leave += ' Według rozkładu.';
    }
    return `<section class="lubus-journey-advice" data-tone="${tone}" aria-label="Wskazówka podróży"><p class="lubus-punctuality">${punctuality}</p>${leave ? `<p class="lubus-leave-hint">${leave}</p>` : ''}</section>`;
}

export function renderExpandedLive(journey, segments = [], selectedIndex = 0, now = Date.now() / 1000, pinned = false) {
    const transit = transitLegs(journey);
    const index = Number.isInteger(selectedIndex) && transit[selectedIndex] ? selectedIndex : 0;
    const leg = transit[index];
    if (!leg) return '<p class="lubus-note">Brak danych kursu.</p>';
    const state = passengerLiveState(segments[index], now);
    const direction = tripDirection(segments[index], leg);
    const badge = route => `<span class="dep-route-box${parseInt(route, 10) >= 150 ? ' trolleybus' : ''}">${escapeHtml(route)}</span>`;
    const selector = transit.length > 1
        ? `<nav class="lubus-live-segments" aria-label="Wybierz odcinek połączenia">${transit.map((l,i) => `<button type="button" data-live-segment="${i}" aria-pressed="${i === index}" aria-label="Linia ${escapeHtml(l.route)}">${badge(l.route)}</button>`).join('')}</nav>`
        : `<span class="lubus-single-line">${badge(leg.route)}</span>`;
    return `<section class="lubus-leg-summary" aria-label="Odcinek ${index + 1}">
        <div class="lubus-position lubus-position-linked">
          ${selector}
          <div class="lubus-passenger-state" data-state="${state.state}" data-tone="${state.tone}" role="status">
            ${direction ? `<p class="lubus-direction">Kierunek:<strong>${escapeHtml(direction)}</strong></p>` : ''}
            <p class="lubus-state-label">${escapeHtml(state.label)}</p>
            ${state.nextStop ? `<p class="lubus-live-next">Następny przystanek:<strong>${escapeHtml(state.nextStop.name)} ${escapeHtml(state.nextStop.platformCode)}</strong></p>` : ''}
          </div>
          ${pinButtonMarkup(pinned)}
        </div>
        ${boardingMetrics(journey, index, state, now)}
        <div class="lubus-message-slot">${initialWalkHint(journey, index, now)
            || transferHint(journey, transit, index, now)
            || journeyAdvice(journey, leg, index, state, now)}</div>
    </section>`;
}

export function expandedMarkup(itineraryHtml, journey, pinned = false) {
    const maps = transitLegs(journey).map((leg, index) => `<button type="button" data-map-segment="${index}" aria-pressed="${index === 0}">Linia ${escapeHtml(leg.route)}</button>`).join('');
    return `<nav class="lubus-tabs" aria-label="Szczegóły połączenia">
        <button type="button" data-lubus-tab="live" aria-pressed="true">LIVE</button>
        <button type="button" data-lubus-tab="journey" aria-pressed="false">Podróż</button>
        <button type="button" data-lubus-tab="map" aria-pressed="false">Mapa</button>
      </nav>
      <section class="lubus-panel lubus-live" aria-label="Czasy przejazdu" tabindex="0">${renderExpandedLive(journey, [], 0, Date.now() / 1000, pinned)}</section>
      <section class="lubus-panel lubus-journey" aria-label="Przebieg podróży" tabindex="0"><div class="lubus-classic-itinerary">${itineraryHtml}</div><div class="lubus-timeline"></div></section>
      <section class="lubus-panel lubus-map" aria-label="Mapa połączenia" tabindex="0">
        <div class="lubus-map-toolbar" aria-label="Wybierz kurs na mapie">${maps}<button type="button" class="lubus-map-action" data-leg-index="0">Pełny ekran</button></div>
        <div class="lubus-map-viewport"><div class="lubus-map-canvas"></div><p class="lubus-map-neutral" role="status">Brak aktualnych współrzędnych GPS tego kursu.</p></div>
      </section>`;
}

export function bindExpandedPanels(panel, mapActions) {
    panel.dataset.lubusTab = 'live';
    panel.querySelector?.('.lubus-live')?.addEventListener('click', event => {
        const button = event.target.closest('[data-live-segment]');
        if (!button) return;
        event.stopPropagation();
        panel.lubusTimeline?.select(Number(button.dataset.liveSegment));
        refreshSelectedLive(panel);
    });
    panel.querySelectorAll('[data-lubus-tab]').forEach(button => {
        button.addEventListener('click', event => {
            event.stopPropagation();
            const restoreAnchor = preserveInlineAnchor(panel);
            panel.dataset.lubusTab = button.dataset.lubusTab;
            panel.querySelectorAll('[data-lubus-tab]').forEach(option => {
                option.ariaPressed = String(option === button);
            });
            restoreAnchor();
            panel.lubusTimeline?.opened();
            refreshSelectedLive(panel);
        });
    });
    panel.querySelectorAll('.lubus-map-action').forEach(button => {
        button.addEventListener('click', event => {
            event.stopPropagation();
            mapActions[Number(button.dataset.legIndex)]?.();
        });
    });
}

export function updateExpandedLive(wrapper, journey, addMinutesToTime, now = Date.now() / 1000) {
    const timeline = wrapper.querySelector('.trasa-middle-scroll')?.lubusTimeline;
    timeline?.predictions(journey, now);
    wrapper.querySelectorAll('.lubus-stop-time').forEach(node => {
        const tripId = node.closest('.trasa-leg-stops').dataset.tripId;
        const leg = transitLegs(journey).find(leg => leg.tripId === tripId);
        if (!leg) return;
        node.textContent = leg.delayMinutes && addMinutesToTime
            ? addMinutesToTime(node.dataset.scheduledEta, leg.delayMinutes) : node.dataset.scheduledEta;
    });
    const panel = wrapper.querySelector('.lubus-live');
    if (!panel) return;
    const html = renderExpandedLive(journey, timeline?.observations(), timeline?.selectedIndex(), now, wrapper.classList?.contains('trasa-pinned'));
    if (panel.innerHTML !== html) {
        const restoreAnchor = preserveInlineAnchor(wrapper);
        panel.innerHTML = html;
        restoreAnchor();
    }
}

// Restore by identity after a height change; numeric scrollTop alone is insufficient.
export function preserveInlineAnchor(element) {
    const root = element.closest?.('#route-results-list');
    if (root?.dataset.presentation !== 'new' || root.dataset.cardAligning === 'true') return () => {};
    const anchor = captureListAnchor(root);
    return () => restoreListAnchor(root, anchor);
}

function refreshSelectedLive(panel) {
    const wrapper = panel.closest?.('.trasa-wrapper');
    const journey = wrapper?.journey;
    const live = panel.querySelector?.('.lubus-live');
    if (!journey || !live) return;
    const timeline = panel.lubusTimeline;
    const html = renderExpandedLive(journey, timeline?.observations(), timeline?.selectedIndex(), Date.now() / 1000, wrapper.classList?.contains('trasa-pinned'));
    if (live.innerHTML !== html) live.innerHTML = html;
}
