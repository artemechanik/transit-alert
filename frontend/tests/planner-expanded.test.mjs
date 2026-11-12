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
    assert.match(html, /real stops/);
    assert.match(html, /lubus-passenger-state/);
    assert.doesNotMatch(html, /DEMO|STOPPED_AT|Przypnij|Następny przystanek|Kierunek:/);
    const live = m.renderExpandedLive({ legs: [{ ...leg, isRealTime: true, delayMinutes: 3 }] });
    assert.doesNotMatch(live, /<header>|lubus-status|LIVE ·/);
    assert.doesNotMatch(live, /lubus-boarding"|Start 01|End 51/);
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
    const selected = m.renderExpandedLive({ legs: [leg, { ...leg, route: '7<script>bad</script>', fromStopName: '<script>bad</script>' }] }, [], 1);
    assert.match(selected, /&lt;script&gt;/); assert.doesNotMatch(selected, /lubus-transfer-hint/);
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
    assert.equal(time.textContent, '10:00+4'); assert.match(live.innerHTML, /lubus-passenger-state/);
    m.updateExpandedLive(wrapper, { legs: [leg] });
    assert.equal(time.textContent, '10:00'); assert.match(live.innerHTML, /lubus-passenger-state/);
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
    assert.doesNotMatch(html, /lubus-passenger-hint|Sprawdź numer linii/);
    segments[1].stops.boardingSequence=99;
    const neutral=m.renderExpandedLive(journey,segments,1,1000);
    assert.match(neutral,/Brak aktualnej lokalizacji/);assert.match(neutral,/Następny przystanek/);
});


test('boarding countdown uses fresh predictions and falls back to scheduled epochs across midnight', async () => {
    const m = await load();
    const predicted = { ...leg, isRealTime: true, liveObservedEpoch: 1000, departureEpoch: 1060, scheduledDepartureEpoch: 1180 };
    assert.match(m.renderExpandedLive({legs:[predicted]},[],0,1000), /Za około<\/dt><dd>1 minutę/);
    for (const patch of [{liveObservedEpoch:699},{liveObservedEpoch:1001},{isRealTime:false}]) {
        const html=m.renderExpandedLive({legs:[{...predicted,...patch}]},[],0,1000);
        assert.match(html,/Według rozkładu<\/dt><dd>3 minuty/);assert.doesNotMatch(html,/Za około/);
    }
    assert.doesNotMatch(m.renderExpandedLive({legs:[leg]},[],0,1000),/Za około|Według rozkładu/);
    assert.match(m.renderExpandedLive({legs:[{...predicted,departureEpoch:900}]},[],0,1000),/Termin odjazdu minął/);
    assert.match(m.renderExpandedLive({legs:[{...leg,scheduledDepartureEpoch:86460}]},[],0,86340),/2 minuty/);
});

test('transfer advice uses platform IDs, escapes names and never assumes missing IDs match', async () => {
    const m=await load();
    const first={...leg,toStopId:'platform-01'}, next={...leg,route:'7',fromStopId:'platform-01'};
    const render=(patch={})=>m.renderExpandedLive({legs:[first,{...next,...patch}]},[],0,1000);
    assert.match(render(),/Zostań na tym samym przystanku/);
    assert.match(render(),/Wsiądź do 7 · według rozkładu<\/dt><dd><time>00:10<\/time>/);
    const other=render({fromStopId:'platform-02',fromStopName:'Start 02 <test>'});
    assert.match(other,/Przejdź na przystanek <strong>Start 02 &lt;test&gt;/);assert.doesNotMatch(other,/Zostań/);
    assert.match(render({fromStopId:null}),/Sprawdź przystanek wejścia/);
    assert.doesNotMatch(m.renderExpandedLive({legs:[first,next]},[],1,1000),/lubus-transfer-hint/);
});

test('boarding stop count is visible only with unambiguous fresh GPS', async () => {
    const m=await load();
    const stops=[{stopSequence:1,stopId:'before'},{stopSequence:2,stopId:'board'}];
    stops.boardingSequence=2;
    stops.live={tripId:leg.tripId,isFresh:true,gpsTimestamp:1000,currentStopSequence:2,currentStatus:'IN_TRANSIT_TO'};
    const current={...leg,fromStopId:'board'}, segments=[{leg:current,stops}];
    const html=m.renderExpandedLive({legs:[current]},segments,0,1000);
    assert.match(html,/Do wejścia<\/dt><dd>1 przystanek/);
    stops.live.gpsTimestamp=699;
    assert.doesNotMatch(m.renderExpandedLive({legs:[current]},segments,0,1000),/Do wejścia/);
});


test('LIVE omits repeated first-leg stops but retains the manually selected transfer context', async () => {
    const m = await load();
    const next = {...leg,route:'7',fromStopName:'Transfer 02',toStopName:'Destination 01'};
    const journey = {legs:[leg,next]};
    const first = m.renderExpandedLive(journey,[],0,1000);
    assert.doesNotMatch(first,/lubus-leg-context|Start 01|lubus-boarding"/);
    const selected = m.renderExpandedLive(journey,[],1,1000);
    assert.match(selected,/data-live-segment="1" aria-pressed="true" aria-label="Linia 7"/);
    assert.doesNotMatch(selected,/lubus-leg-context|Transfer 02|Destination 01/);
});

test('prototype transfer shows departure, walking-adjusted waiting and risk without mutating results', async () => {
    const m=await load();
    const first={...leg,toStopId:'a',toStopName:'Park 02',arrivalMin:1185};
    const next={...leg,tripId:'next',fromStopId:'b',fromStopName:'Park 04',route:'7',departureMin:1189};
    const journey={legs:[first,{route:'Пішки',departureMin:1185,arrivalMin:1187},next]};
    const before=JSON.stringify(journey);
    let html=m.renderExpandedLive(journey,[],0,1000);
    assert.doesNotMatch(html,/będziesz około|19:45/);
    assert.match(html,/<time>19:49<\/time>/);assert.match(html,/1 minuta oczekiwania po przejściu/);
    assert.match(html,/Przejście: około 3 minuty/);assert.doesNotMatch(html,/Ryzykowna przesiadka/);
    assert.match(html,/według rozkładu/);assert.equal(JSON.stringify(journey),before);
    next.departureMin=1187;
    html=m.renderExpandedLive(journey,[],0,1000);
    assert.match(html,/⚠ Ryzykowna przesiadka/);assert.match(html,/o około minutę|o około 1 minutę/);
    assert.doesNotMatch(html,/oczekiwania/);
    next.fromStopId='a';next.departureMin=1188;
    journey.legs=[first,next];
    html=m.renderExpandedLive(journey,[],0,1000);
    assert.match(html,/3 minuty oczekiwania/);assert.match(html,/Zostań/);assert.doesNotMatch(html,/Przejście:/);
});


test('prototype transfer label sits above time and omits LIVE while retaining schedule labels', async () => {
    const m=await load();
    const current={...leg,toStopId:'a',toStopName:'Long platform name 02',arrivalMin:600,
        isRealTime:true,departureEpoch:1000,liveObservedEpoch:1000};
    const next={...current,route:'7',fromStopId:'a',departureMin:605};
    let html=m.renderExpandedLive({legs:[current,next]},[],0,1000);
    assert.doesNotMatch(html,/będziesz około|lubus-transfer-heading/);
    assert.match(html, /Wsiądź do 7<\/dt><dd><time>10:05<\/time>/);
    assert.doesNotMatch(html,/\(LIVE\)|według rozkładu/);
    html=m.renderExpandedLive({legs:[current,{...next,isRealTime:false}]},[],0,1000);
    assert.equal((html.match(/według rozkładu/g)||[]).length,1);
});


test('direction comes from the full trip terminal without its platform, independently of GPS and chosen alighting', async () => {
    const m=await load();
    const current={...leg,toStopName:'Chosen exit 02'};
    const stops=[{name:'Chosen exit',platformCode:'02'}];
    stops.tripStops=[...stops,{name:'Rondo Lubelskiego Lipca 03',platformCode:'03'}];
    const segment={leg:current,stops};
    let html=m.renderExpandedLive({legs:[current]},[segment],0,1000);
    assert.match(html,/Kierunek:<strong>Rondo Lubelskiego Lipca<\/strong>/);
    assert.match(html,/Brak aktualnej lokalizacji/);assert.doesNotMatch(html,/Kierunek:<strong>Chosen exit/);
    stops.tripStops[1]={name:'Terminal <test> (51)',platformCode:'51'};
    html=m.renderExpandedLive({legs:[current]},[segment],0,1000);
    assert.match(html,/Kierunek:<strong>Terminal &lt;test&gt;<\/strong>/);
    stops.tripStops[1]={name:'Ulica 11',platformCode:'03'};
    assert.match(m.renderExpandedLive({legs:[current]},[segment],0,1000),/Kierunek:<strong>Ulica 11/);
    delete stops.tripStops;
    assert.doesNotMatch(m.renderExpandedLive({legs:[current]},[segment],0,1000),/Kierunek:/);
    stops.tripStops=[{name:'Other terminal 01',platformCode:'01'}];
    assert.doesNotMatch(m.renderExpandedLive({legs:[current]},[{...segment,leg:{...current,tripId:'other'}}],0,1000),/Kierunek:/);
});
