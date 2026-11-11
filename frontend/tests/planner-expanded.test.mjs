import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const load = () => loadBrowserModule(new URL('../js/planner-expanded.js', import.meta.url), {});
const leg = { route: '153', tripId: 'real-trip', fromStopName: 'Start 01', toStopName: 'End 51', departureMin: 1450, arrivalMin: 1470, isRealTime: false };

test('expanded summary uses route predictions without inventing GPS, direction or pinning', async () => {
    const m = await load();
    const html = m.expandedMarkup('<div>real stops</div>', { legs: [leg] });
    assert.match(html, /LIVE<\/button>/);
    assert.match(html, /Podróż/); assert.match(html, /Mapa/);
    assert.match(html, /real stops/); assert.match(html, /Start 01/);
    assert.match(html, /00:10/); assert.match(html, /Rozkład/);
    assert.doesNotMatch(html, /DEMO|STOPPED_AT|Przypnij|Następny przystanek|Kierunek:/);
    const live = m.renderExpandedLive({ legs: [{ ...leg, isRealTime: true, delayMinutes: 3 }] });
    assert.match(live, /LIVE · \+3 min/); assert.match(live, /lubus-status-late/);
    const stale = m.renderExpandedLive({ legs: [leg] });
    assert.doesNotMatch(stale, /LIVE ·/);
});

test('all legs and transfers are represented; walk legs do not become map vehicles; names are escaped', async () => {
    const m = await load();
    const html = m.expandedMarkup('', { legs: [leg, { route: 'Пішки' }, { ...leg, route: '7', fromStopName: '<script>bad</script>' }] });
    assert.equal((html.match(/data-map-segment=/g) || []).length, 2);
    assert.equal((html.match(/class="lubus-map-action"/g) || []).length, 1);
    assert.match(html, /data-map-segment="1"/); assert.match(html, /data-live-segment="1"/);
    assert.doesNotMatch(html, /<script>/);
    const selected = m.renderExpandedLive({ legs: [leg, { ...leg, route: '7', fromStopName: '<script>bad</script>' }] }, [], 1);
    assert.match(selected, /&lt;script&gt;/); assert.match(selected, /Przesiadka/);
});

test('tabs retain their panels and map opens the selected existing action without bubbling', async () => {
    const m = await load();
    const button = dataset => ({ dataset, addEventListener(type, fn) { this.click = fn; } });
    const tabs = ['live', 'journey', 'map'].map(name => button({ lubusTab: name }));
    const maps = [0, 1].map(index => button({ legIndex: String(index) }));
    const panel = { dataset: {}, querySelectorAll: selector => selector === '[data-lubus-tab]' ? tabs : maps };
    let opened = null, stopped = 0;
    m.bindExpandedPanels(panel, [() => { opened = 0; }, () => { opened = 1; }]);
    const event = { stopPropagation() { stopped++; } };
    tabs[1].click(event); assert.equal(panel.dataset.lubusTab, 'journey');
    assert.equal(tabs[1].ariaPressed, 'true'); assert.equal(tabs[0].ariaPressed, 'false');
    tabs[2].click(event); maps[1].click(event);
    assert.equal(opened, 1); assert.equal(stopped, 3);
});

test('existing refresh updates live summary and stop times without resetting tab or scroll', async () => {
    const m = await load();
    const live = { innerHTML: '' };
    const time = { dataset: { scheduledEta: '10:00' }, closest: () => ({ dataset: { tripId: 'real-trip' } }) };
    const wrapper = { dataset: { lubusTab: 'journey' }, scrollTop: 60, querySelector: () => live, querySelectorAll: () => [time] };
    m.updateExpandedLive(wrapper, { legs: [{ ...leg, isRealTime: true, delayMinutes: 4 }] }, (eta, delay) => `${eta}+${delay}`);
    assert.equal(time.textContent, '10:00+4'); assert.match(live.innerHTML, /LIVE · \+4 min/);
    m.updateExpandedLive(wrapper, { legs: [leg] });
    assert.equal(time.textContent, '10:00'); assert.match(live.innerHTML, /Rozkład/);
    assert.equal(wrapper.dataset.lubusTab, 'journey'); assert.equal(wrapper.scrollTop, 60);
});

test('inline height changes restore the visible journey by key after reordering', async () => {
    const m = await load();
    const a = { dataset: { motionKey: 'a' }, offsetTop: 0, offsetHeight: 200 };
    const b = { dataset: { motionKey: 'b' }, offsetTop: 200, offsetHeight: 200 };
    const root = { dataset: { presentation: 'new' }, children: [a, b], scrollTop: 230, offsetTop: 0 };
    const restore = m.preserveInlineAnchor({ closest: () => root });
    root.children = [b, a]; b.offsetTop = 0; a.offsetTop = 320;
    restore(); assert.equal(root.scrollTop, 30);
    root.dataset.presentation = 'classic';
    const classicRestore = m.preserveInlineAnchor({ closest: () => root });
    b.offsetTop = 100; classicRestore(); assert.equal(root.scrollTop, 30);
});

test('LIVE renders only the manually selected segment with state above independently known next stop', async () => {
    const m = await load();
    const base = { ...leg, fromStopId: 'board' };
    function observation(tripId, currentStopSequence, currentStatus) {
        const all = [1,4,9].map((stopSequence,i) => ({ stopSequence, stopId: i===1?'board':'s'+i, name:'Stop '+stopSequence, eta:'10:00' }));
        const stops = all.slice(1);stops.timelineStops=all;stops.boardingSequence=4;
        stops.live={tripId,currentStopSequence,currentStatus,gpsTimestamp:1000,isFresh:true};
        return {leg:{...base,tripId},stops};
    }
    const segments=[observation('first',9,'IN_TRANSIT_TO'),observation('second',4,'STOPPED_AT')];
    const journey={legs:[{...base,tripId:'first'},{...base,tripId:'second',route:'7'}]};
    const html=m.renderExpandedLive(journey,segments,1,1000);
    assert.match(html,/data-live-segment="1" aria-pressed="true"/);
    assert.equal((html.match(/class="lubus-leg-summary"/g)||[]).length,1);
    assert.match(html,/Na przystanku/);assert.doesNotMatch(html,/Kurs w toku/);
    assert.ok(html.indexOf('Na przystanku')<html.indexOf('Następny przystanek'));
    assert.ok(html.indexOf('Następny przystanek')<html.indexOf('Sprawdź numer linii'));
    segments[1].stops.boardingSequence=99;
    const neutral=m.renderExpandedLive(journey,segments,1,1000);
    assert.match(neutral,/Brak aktualnej lokalizacji/);assert.match(neutral,/Następny przystanek/);
});
