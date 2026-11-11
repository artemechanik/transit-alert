import { passengerLiveState } from './planner-live-state.js';
import { captureListAnchor, restoreListAnchor } from './list-motion.js';

// Presentation only: forecasts and LIVE eligibility come from planner-results.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const transitLegs = journey => journey.legs.filter(leg => leg.route && leg.route !== 'Пішки');
const time = minutes => Number.isFinite(minutes)
    ? `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : '—';

export function renderExpandedLive(journey, segments = [], selectedIndex = 0, now = Date.now() / 1000) {
    const transit = transitLegs(journey);
    const index = Number.isInteger(selectedIndex) && transit[selectedIndex] ? selectedIndex : 0;
    const leg = transit[index];
    if (!leg) return '<p class="lubus-note">Brak danych kursu.</p>';
    const state = passengerLiveState(segments[index], now);
    const selector = transit.length > 1 ? `<nav class="lubus-live-segments" aria-label="Wybierz odcinek połączenia">${transit.map((l,i) => `<button type="button" data-live-segment="${i}" aria-pressed="${i === index}">Linia ${escapeHtml(l.route)}</button>`).join('')}</nav>` : '';
    const delay = leg.delayMinutes || 0;
    const status = !leg.isRealTime ? 'Rozkład' : delay > 0 ? `LIVE · +${delay} min`
        : delay < 0 ? `LIVE · ${delay} min` : 'LIVE · zgodnie z rozkładem';
    const tone = !leg.isRealTime ? 'schedule' : delay > 0 ? 'late' : delay < 0 ? 'early' : 'on-time';
    return selector + `<section class="lubus-leg-summary" aria-label="Odcinek ${index + 1}">
        <header><span class="dep-route-box${parseInt(leg.route, 10) >= 150 ? ' trolleybus' : ''}">${escapeHtml(leg.route)}</span>
        <span class="lubus-status lubus-status-${tone}">${status}</span></header>
        <div class="lubus-passenger-state" data-state="${state.state}" data-tone="${state.tone}" role="status">
          <strong>${escapeHtml(state.label)}</strong>
          ${state.nextStop ? `<p class="lubus-live-next">Następny przystanek:<strong>${escapeHtml(state.nextStop.name)} ${escapeHtml(state.nextStop.platformCode)}</strong></p>` : ''}
          <p class="lubus-passenger-hint">${escapeHtml(state.hint)}</p>
        </div>
        <dl class="lubus-boarding">
          <div><dt>Wsiądź</dt><dd>${escapeHtml(leg.fromStopName)}</dd><dd>${time(leg.departureMin)}</dd></div>
          <div><dt>Wysiądź</dt><dd>${escapeHtml(leg.toStopName)}</dd><dd>${time(leg.arrivalMin)}</dd></div>
        </dl>
        ${index ? '<p class="lubus-note">Przesiadka · kolejny odcinek połączenia</p>' : ''}
    </section>`;
}

export function expandedMarkup(itineraryHtml, journey) {
    const maps = transitLegs(journey).map((leg, index) => `<button type="button" data-map-segment="${index}" aria-pressed="${index === 0}">Linia ${escapeHtml(leg.route)}</button>`).join('');
    return `<nav class="lubus-tabs" aria-label="Szczegóły połączenia">
        <button type="button" data-lubus-tab="live" aria-pressed="true">LIVE</button>
        <button type="button" data-lubus-tab="journey" aria-pressed="false">Podróż</button>
        <button type="button" data-lubus-tab="map" aria-pressed="false">Mapa</button>
      </nav>
      <section class="lubus-panel lubus-live" aria-label="Czasy przejazdu" tabindex="0">${renderExpandedLive(journey)}</section>
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

export function updateExpandedLive(wrapper, journey, addMinutesToTime) {
    const timeline = wrapper.querySelector('.trasa-middle-scroll')?.lubusTimeline;
    timeline?.predictions(journey);
    wrapper.querySelectorAll('.lubus-stop-time').forEach(node => {
        const tripId = node.closest('.trasa-leg-stops').dataset.tripId;
        const leg = transitLegs(journey).find(leg => leg.tripId === tripId);
        if (!leg) return;
        node.textContent = leg.delayMinutes && addMinutesToTime
            ? addMinutesToTime(node.dataset.scheduledEta, leg.delayMinutes) : node.dataset.scheduledEta;
    });
    const panel = wrapper.querySelector('.lubus-live');
    if (!panel) return;
    const html = renderExpandedLive(journey, timeline?.observations(), timeline?.selectedIndex());
    if (panel.innerHTML !== html) {
        const restoreAnchor = preserveInlineAnchor(wrapper);
        panel.innerHTML = html;
        restoreAnchor();
    }
}

// Restore by identity after a height change; numeric scrollTop alone is insufficient.
export function preserveInlineAnchor(element) {
    const root = element.closest?.('#route-results-list');
    if (root?.dataset.presentation !== 'new') return () => {};
    const anchor = captureListAnchor(root);
    return () => restoreListAnchor(root, anchor);
}

function refreshSelectedLive(panel) {
    const journey = panel.closest?.('.trasa-wrapper')?.journey;
    const live = panel.querySelector?.('.lubus-live');
    if (!journey || !live) return;
    const timeline = panel.lubusTimeline;
    const html = renderExpandedLive(journey, timeline?.observations(), timeline?.selectedIndex());
    if (live.innerHTML !== html) live.innerHTML = html;
}
