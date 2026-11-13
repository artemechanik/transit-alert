import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const load = () => loadBrowserModule(new URL('../js/planner-timeline.js', import.meta.url), { Date });
const leg = { tripId: 'trip', route: '153', fromStopName: 'Start 01', toStopName: 'End 51', delayMinutes: 0 };
function stops(status = 'STOPPED_AT', sequence = 4) {
    const rows = [1,4,9].map((stopSequence, i) => ({ stopId: i === 1 ? 'b' : 'a', stopSequence, name: `Stop ${stopSequence}`, platformCode: '01', eta: '10:00' }));
    rows.live = { tripId: 'trip', currentStopSequence: sequence, currentStatus: status, gpsTimestamp: 1000, isFresh: true };
    return rows;
}

test('explicit stop statuses place marker at or before the exact sequence without inferring from ETA', async () => {
    const m = await load();
    for (const status of ['STOPPED_AT','IN_TRANSIT_TO','INCOMING_AT']) {
        const rows = stops(status);
        const position = m.timelinePosition(leg, rows, rows.live, 1000);
        assert.equal(position.kind, status === 'STOPPED_AT' ? 'at' : 'between');
        const html = m.renderJourneyTimeline([{ leg, stops: rows }], 0, 1000);
        assert.equal((html.match(/data-timeline-map=/g) || []).length, 1);
        assert.match(html, /153 · Teraz/);
        assert.match(html, /class="lubus-timeline-stop passed key-stop" data-sequence="1"/);
        assert.doesNotMatch(html, /passed[^>]*data-sequence="4"/);
        if (status !== 'STOPPED_AT') assert.ok(html.indexOf('data-timeline-current') < html.indexOf('data-sequence="4"'));
    }
});

test('stale future missing mismatched and incomplete observations never show Teraz or passed stops', async () => {
    const m = await load();
    const variants = [null, { isFresh: false }, { gpsTimestamp: 699 }, { gpsTimestamp: 1001 },
        { currentStatus: null }, { currentStopSequence: null }, { tripId: 'other' }];
    for (const changes of variants) {
        const rows = stops(); rows.live = changes === null ? null : { ...rows.live, ...changes };
        const html = m.renderJourneyTimeline([{ leg, stops: rows }], 0, 1000);
        assert.doesNotMatch(html, /Teraz|data-timeline-map=|class="lubus-timeline-stop passed/);
    }
    const rows = stops(); rows.live.gpsTimestamp = 700;
    assert.equal(m.timelinePosition(leg, rows, rows.live, 1000).kind, 'at');
});

test('sparse sequences and repeat stop IDs retain distinct occurrences without invented intermediate movement', async () => {
    const m = await load();
    const rows = stops('STOPPED_AT', 9);
    assert.equal(m.timelinePosition(leg, rows, rows.live, 1000).sequence, 9);
    rows.live.currentStopSequence = 7;
    assert.equal(m.timelinePosition(leg, rows, rows.live, 1000).kind, 'unknown');
    rows.live.currentStopSequence = 0;
    assert.equal(m.timelinePosition(leg, rows, rows.live, 1000).kind, 'before');
    rows.live.currentStopSequence = 10;
    assert.equal(m.timelinePosition(leg, rows, rows.live, 1000).kind, 'after');
    rows[2].stopSequence = 4;
    assert.equal(m.timelinePosition(leg, rows, rows.live, 1000).kind, 'unknown');
});

test('transfer segments stay separate with one map marker only for manually selected segment', async () => {
    const m = await load();
    const first = { leg, stops: stops() }, second = { leg: { ...leg, tripId: 'second', route: '7' }, stops: stops() };
    second.stops.live.tripId = 'second';
    const html = m.renderJourneyTimeline([first, second], 1, 1000);
    assert.equal((html.match(/data-segment=/g) || []).length, 2);
    assert.equal((html.match(/data-timeline-current/g) || []).length, 1);
    assert.match(html, /7 · Teraz/); assert.doesNotMatch(html, /153 · Teraz/);
    assert.match(html, /data-timeline-select="1" aria-pressed="true"/);
});

test('autoscroll runs on opening only and stops after manual input until explicit segment selection', async () => {
    const m = await load(), now = Math.floor(Date.now()/1000);
    const rows = stops(); rows.live.gpsTimestamp = now;
    const listeners = {}, events = {};
    const root = { dataset: { presentation: 'new' } };
    const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }), addEventListener: (type, fn) => { listeners[type] = fn; } };
    const view = { innerHTML: '', addEventListener: (type, fn) => { events[type] = fn; },
        querySelectorAll: () => [], querySelector: () => view.innerHTML.includes('data-timeline-current')
            ? { getBoundingClientRect: () => ({ top: 600-scroller.scrollTop }) } : null };
    const panel = { dataset: { lubusTab: 'live' }, closest: () => root, querySelector: s => s === '.lubus-timeline' ? view : s === '.lubus-journey' ? scroller : null };
    m.setupJourneyTimeline(panel, [leg], [rows], [() => {}]);
    assert.equal(scroller.scrollTop, 0);
    panel.dataset.lubusTab = 'journey'; panel.lubusTimeline.opened();
    assert.equal(scroller.scrollTop, 552);
    scroller.scrollTop = 20; listeners.wheel(); panel.lubusTimeline.opened();
    panel.lubusTimeline.update(0, rows); assert.equal(scroller.scrollTop, 20);
    events.click({ target: { closest: selector => selector === '[data-timeline-select]' ? { dataset: { timelineSelect: '0' } } : null }, stopPropagation() {} });
    assert.equal(scroller.scrollTop, 552);
    panel.lubusTimeline.update(0, []);
    assert.doesNotMatch(view.innerHTML, /Teraz/); assert.match(view.innerHTML, /Stop 4/);
});

test('LIVE current and next names come from fresh sequence and status only', async () => {
    const m = await load(); const rows = stops();
    const at = m.renderLivePosition({ leg, stops: rows }, 1000);
    assert.match(at, /Na przystanku:.*Stop 4/); assert.match(at, /Następny przystanek:.*Stop 9/);
    rows.live.currentStatus = 'IN_TRANSIT_TO';
    assert.match(m.renderLivePosition({ leg, stops: rows }, 1000), /Następny przystanek:.*Stop 4/);
    assert.equal(m.renderLivePosition({ leg, stops: rows }, 1301), '');
});

test('approach stops extend backwards without moving boarding or alighting labels', async () => {
    const m = await load();
    const all = [1,4,9,12,20].map(stopSequence => ({ stopId: 's'+stopSequence, stopSequence, name: 'Stop '+stopSequence, eta: '10:00' }));
    const selected = all.slice(3);
    selected.boardingSequence = 12; selected.timelineStops = all;
    selected.live = { tripId: 'trip', currentStatus: 'IN_TRANSIT_TO', currentStopSequence: 4, gpsTimestamp:1000,isFresh:true };
    const segment = { leg, stops: selected };
    const rows = m.timelineRows(segment,1000);
    assert.deepEqual(Array.from(rows.rows, s=>s.stopSequence), [1,4,9,12,20]);
    const html = m.renderJourneyTimeline([segment],0,1000);
    assert.match(html, /Teraz/);
    assert.match(html, /data-sequence="12"[\s\S]*?Wsiądź/);
    assert.doesNotMatch(html.split('data-sequence="12"')[0], /<small>Wsiądź/);
    assert.equal(selected[0].stopSequence, 12);
    selected.live.gpsTimestamp = 699;
    assert.equal(m.timelineRows(segment,1000).rows[0].stopSequence, 12);
    segment.approachStartSequence = 1;
    assert.equal(m.timelineRows(segment,1000).rows[0].stopSequence, 1);
    assert.doesNotMatch(m.renderJourneyTimeline([segment],0,1000), /Teraz|class="lubus-timeline-stop passed/);
});

test('each Wsiądź occurrence uses its own precise boarding timestamp, leaving other stop times unchanged', async () => {
 const m=await load(),scheduled=Date.parse('2026-11-13T09:05:00Z')/1000,now=scheduled-60;
 const all=[10,20,30,40].map(stopSequence=>({stopSequence,stopId:stopSequence===10||stopSequence===30?'repeat':'other',name:'Stop '+stopSequence,eta:'12:30'}));
 const selected=all.slice(2);selected.boardingSequence=30;selected.timelineStops=all;
 const first={...leg,tripId:'one',route:'1',departureMin:605,departureEpoch:scheduled-30,scheduledDepartureEpoch:scheduled,isRealTime:true,liveObservedEpoch:now};
 const second={...first,tripId:'two',route:'2',departureEpoch:scheduled+3990,scheduledDepartureEpoch:scheduled+4020};
 const segments=[{leg:first,stops:selected},{leg:second,stops:selected}];
 const html=m.renderJourneyTimeline(segments,1,now);
 assert.match(html,/data-segment="0"[\s\S]*?data-sequence="30"[\s\S]*?Wsiądź[\s\S]*?<time>10:04<\/time>/);
 assert.match(html,/data-segment="1"[\s\S]*?data-sequence="30"[\s\S]*?Wsiądź[\s\S]*?<time>11:11<\/time>/);
 assert.equal((html.match(/<time>12:30<\/time>/g)||[]).length,2);
 first.liveObservedEpoch=now-301;
 assert.match(m.renderJourneyTimeline(segments,1,now),/data-segment="0"[\s\S]*?<time>10:05<\/time>/);
});

test('timeline prediction refresh uses the same freshness instant as the outer countdown', async () => {
 const scheduled=Date.parse('2026-11-13T09:05:00Z')/1000,now=scheduled-60;
 class Clock extends Date { static now(){return (now+1)*1000;} }
 const m=await loadBrowserModule(new URL('../js/planner-timeline.js',import.meta.url),{Date:Clock});
 const first={...leg,departureEpoch:scheduled-30,scheduledDepartureEpoch:scheduled,isRealTime:true,liveObservedEpoch:now-300};
 const rows=[{stopSequence:10,name:'Boarding',eta:'10:05'},{stopSequence:20,name:'End',eta:'10:20'}];rows.boardingSequence=10;
 const view={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null,addEventListener(){}};
 const scroller={scrollTop:0,getBoundingClientRect:()=>({top:0}),addEventListener(){}};
 const panel={dataset:{lubusTab:'live'},closest:()=>({dataset:{presentation:'new'}}),querySelector:s=>s==='.lubus-timeline'?view:s==='.lubus-journey'?scroller:null};
 m.setupJourneyTimeline(panel,[first],[rows],[]);
 assert.match(view.innerHTML,/<time>10:05<\/time>/,'the later default clock sees stale LIVE');
 panel.lubusTimeline.predictions({legs:[first]},now);
 assert.match(view.innerHTML,/<time>10:04<\/time>/,'the shared tick keeps both displays on the same freshness boundary');
 assert.equal(panel.lubusTimeline.selectedIndex(),0);
});
