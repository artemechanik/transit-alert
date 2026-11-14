import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const url = name => new URL(`../js/${name}.js`, import.meta.url);
const timing = await loadBrowserModule(url('planner-countdown'), {});
const expanded = await loadBrowserModule(url('planner-expanded'), {});
const leg = { route:'45', departureEpoch:1120, scheduledDepartureEpoch:1300,
    isRealTime:true, delayMinutes:0, liveObservedEpoch:1000, departureMin:20, arrivalMin:40, toStopId:'a' };

test('header, expanded countdown and walking warning agree on partial minutes and ticks', () => {
    const journey = { legs:[{route:'Пішки', departureMin:0, arrivalMin:2},leg] };
    for (const [now, minutes] of [[1001,2],[1060,1],[1061,1],[1120,0]]) {
        const value = timing.journeyCountdown(journey,now);
        assert.equal(value.minutes,minutes);
        assert.equal(value.color,'var(--live-green)');
        const header = timing.countdownMarkup(value);
        const details = expanded.renderExpandedLive(journey,[],0,now);
        assert.match(header,new RegExp(`>${minutes || '&lt;1'}<`));
        assert.match(details,new RegExp(minutes ? `>${minutes} minut` : '>Termin odjazdu minął<'));
        if (minutes) assert.match(details,new RegExp(`Odjazd za ${minutes} min`));
        else assert.doesNotMatch(details,/Możesz nie zdążyć|Odjazd teraz/);
    }
});

test('schedule, stale and future observations remain neutral despite walking risk', () => {
    assert.equal(timing.journeyCountdown({legs:[leg]},1001).color,'var(--live-green)');
    for (const patch of [{isRealTime:false},{liveObservedEpoch:699},{liveObservedEpoch:1002}]) {
        const value = timing.journeyCountdown({legs:[{...leg,...patch}]},1001);
        assert.equal(value.minutes,5);
        assert.equal(value.color,'var(--text-muted)');
    }
    const journey={legs:[{route:'Пішки',departureMin:0,arrivalMin:4},{...leg,isRealTime:false}]};
    assert.equal(timing.journeyCountdown(journey,1001).color,'var(--text-muted)');
});

test('transfer risk leaves countdown colors unchanged and each selected vehicle uses its own delay', () => {
    const next={...leg,route:'57',delayMinutes:-2,fromStopId:'a',departureMin:42,arrivalMin:60};
    const journey={legs:[leg,next]};
    assert.equal(timing.journeyCountdown(journey,1000).color,'var(--live-green)');
    assert.match(expanded.renderExpandedLive(journey,[],0,1000),/Ryzykowna przesiadka/);
    assert.equal(timing.journeyCountdown(journey,1000,1).color,'var(--early)');
    next.departureMin=43;
    assert.equal(timing.journeyCountdown(journey,1000).color,'var(--live-green)');
});

test('absolute service dates, hour boundary and missing departure stay consistent', () => {
    assert.equal(timing.legCountdown({...leg,departureEpoch:86460,liveObservedEpoch:86340},86341).minutes,2);
    const value=timing.journeyCountdown({legs:[{...leg,departureEpoch:4600}]},1001);
    assert.equal(value.minutes,60);
    assert.match(timing.countdownMarkup(value),/1h 00m/);
    assert.equal(timing.legCountdown({route:'7'},1000).minutes,null);
    assert.match(timing.countdownMarkup({minutes:null,color:'var(--text-muted)'}),/—/);
});

test('countdown colors follow punctuality in both header and expanded details', () => {
    for (const [delayMinutes,color] of [[4,'var(--danger)'],[-2,'var(--early)'],[0,'var(--live-green)'],[undefined,'var(--live-green)'],[null,'var(--text-muted)']]) {
        const journey={legs:[{route:'Пішки',departureMin:0,arrivalMin:2},{...leg,delayMinutes}]};
        const value=timing.journeyCountdown(journey,1001);
        assert.equal(value.color,color);
        assert.ok(timing.countdownMarkup(value).includes(`color:${color}`));
        const details=expanded.renderExpandedLive(journey,[],0,1001);
        assert.ok(details.includes(`<dd style="color:${color}">2 minuty`));
        assert.match(details,/Możesz nie zdążyć/);
    }
});

test('omitted default zero delay is green only with fresh LIVE and agrees with punctuality advice', () => {
    const {delayMinutes, ...wireLeg}=leg;
    const journey=JSON.parse(JSON.stringify({legs:[wireLeg]}));
    assert.equal(timing.journeyCountdown(journey,1001).color,'var(--live-green)');
    assert.match(expanded.renderExpandedLive(journey,[],0,1001),/Pojazd jedzie zgodnie z rozkładem/);
    for (const patch of [{isRealTime:false},{liveObservedEpoch:699},{liveObservedEpoch:1002}]) {
        const offline={legs:[{...wireLeg,...patch}]};
        assert.equal(timing.journeyCountdown(offline,1001).color,'var(--text-muted)');
        assert.match(expanded.renderExpandedLive(offline,[],0,1001),/Brak aktualnych danych o punktualności/);
    }
});

test('header retains less-than-one-minute label at zero and after departure', () => {
    for (const minutes of [0,-1]) {
        const html=timing.countdownMarkup({minutes,color:'var(--live-green)'});
        assert.match(html,/>&lt;1<\/span>/);
        assert.match(html,/>minuta<\/span>/);
        assert.doesNotMatch(html,/Teraz/);
    }
});

test('Nowa changes exactly at departure from the existing countdown to the boarding departure time', () => {
    const scheduled=Date.parse('2026-11-13T09:00:00Z')/1000;
    const predicted=scheduled+120;
    const journey={legs:[{...leg,scheduledDepartureEpoch:scheduled,departureEpoch:predicted,liveObservedEpoch:predicted-120}]};
    for(const now of [predicted-61,predicted-1]) {
        const value=timing.journeyCountdown(journey,now);
        assert.equal(timing.countdownMarkup(value,'new'),timing.countdownMarkup(value),'pre-departure markup stays identical');
    }
    for(const now of [predicted,predicted+1,predicted+60]) {
        const html=timing.countdownMarkup(timing.journeyCountdown(journey,now),'new');
        assert.match(html,/>odjazd o:</);assert.match(html,/>10:02</);
        assert.doesNotMatch(html,/&lt;1|minuta|TERAZ|ODJECHAŁ/);
    }
});

test('Nowa uses scheduled boarding time without a trustworthy LIVE forecast', () => {
    const scheduled=Date.parse('2026-11-13T09:00:00Z')/1000, now=scheduled+200;
    for(const patch of [{isRealTime:false},{liveObservedEpoch:undefined},{liveObservedEpoch:now-301},{liveObservedEpoch:now+1},{departureEpoch:null}]) {
        const value=timing.journeyCountdown({legs:[{...leg,scheduledDepartureEpoch:scheduled,departureEpoch:scheduled+120,liveObservedEpoch:now,...patch}]},now);
        assert.equal(value.live,false);
        const html=timing.countdownMarkup(value,'new');
        assert.match(html,/>odjazd o:</);assert.match(html,/>10:00</);
        assert.match(html,/color:var\(--text-muted\)/);assert.doesNotMatch(html,/&lt;1|minuta/);
    }
});

test('Nowa keeps the first boarding time on transfers; explicit segment timing and summer midnight stay correct', () => {
    const firstEpoch=Date.parse('2026-07-13T21:58:00Z')/1000;
    const first={...leg,isRealTime:false,scheduledDepartureEpoch:firstEpoch};
    const next={...first,tripId:'second',scheduledDepartureEpoch:firstEpoch+600};
    const journey={legs:[{route:'Пішки'},first,{route:'Пішки'},next]};
    const now=firstEpoch+180;
    const html=timing.countdownMarkup(timing.journeyCountdown(journey,now),'new');
    assert.match(html,/>odjazd o:</);assert.match(html,/>23:58</);
    assert.equal(timing.journeyCountdown(journey,now,1).minutes,7);
    const nextHtml=timing.countdownMarkup(timing.journeyCountdown(journey,firstEpoch+601,1),'new');
    assert.match(nextHtml,/>00:08</);
    assert.match(timing.countdownMarkup(timing.journeyCountdown({legs:[{route:'7'}]},now),'new'),/—/);
});

test('Nowa boarding clock matches precise departure with an early fractional-minute prediction', async () => {
 const {updateBoardingTime}=await loadBrowserModule(url('planner-cards'),{});
 const scheduled=Date.parse('2026-11-13T09:05:00Z')/1000,now=scheduled-60;
 const first={...leg,departureMin:605,scheduledDepartureEpoch:scheduled,departureEpoch:scheduled-30,liveObservedEpoch:now};
 const node={innerHTML:''},wrapper={querySelector:()=>node},journey={legs:[{route:'Пішки'},first]};
 updateBoardingTime(wrapper,journey,now,'new');assert.equal(node.innerHTML,'10:04');
 assert.equal(timing.journeyCountdown(journey,now).minutes,1);
 assert.equal(timing.departureClock(timing.journeyCountdown(journey,now).departure),'10:04');
 updateBoardingTime(wrapper,journey,now,'classic');assert.equal(node.innerHTML,'10:05');
 for(const patch of [{isRealTime:false},{liveObservedEpoch:now-301},{liveObservedEpoch:now+1}]) {
  updateBoardingTime(wrapper,{legs:[{...first,...patch}]},now,'new');assert.equal(node.innerHTML,'10:05');
 }
 updateBoardingTime(wrapper,{legs:[{route:'7'}]},now,'new');assert.equal(node.innerHTML,'—');
});

test('all Nowa cards use the clock outside the positive inclusive 60-minute window', () => {
    const departure = Date.parse('2026-11-14T09:04:30Z') / 1000;
    for (const remaining of [3600.001, 3600, 3599.999, 60, 1, 0.001, 0, -0.001, -61]) {
        const now = departure - remaining;
        const value = timing.journeyCountdown({ legs: [{ ...leg, departureEpoch: departure,
            scheduledDepartureEpoch: departure + 30, liveObservedEpoch: now }] }, now);
        const html = timing.countdownMarkup(value, 'new');
        if (remaining <= 0 || remaining > 3600) {
            assert.match(html, />odjazd o:</);
            assert.match(html, />10:04</);
            assert.doesNotMatch(html, /&lt;1|minuta|minuty|minut|odjazd za:|1h/);
        } else {
            assert.match(html, new RegExp(`>${Math.ceil(remaining / 60)}<`));
            assert.match(html, />minut[ay]?</);
            assert.doesNotMatch(html, /odjazd o:|1h/);
        }
    }
});

test('far-future Nowa clock follows trusted LIVE updates and falls back to the schedule', () => {
    const now = Date.parse('2026-11-14T08:00:00Z') / 1000;
    const first = { ...leg, scheduledDepartureEpoch: now + 5400, departureEpoch: now + 5670, liveObservedEpoch: now };
    const second = { ...first, route: '57', departureEpoch: now + 7200, scheduledDepartureEpoch: now + 7500 };
    const journey = { legs: [first, { route: 'Пішки' }, second] };
    const clock = index => timing.countdownMarkup(timing.journeyCountdown(journey, now, index), 'new');
    assert.match(clock(0), />10:34</);
    assert.match(clock(1), />11:00</);
    first.departureEpoch = now + 5790;
    assert.match(clock(0), />10:36</);
    assert.match(clock(1), />11:00</);
    for (const observed of [undefined, now - 301, now + 1]) {
        first.liveObservedEpoch = observed;
        assert.match(clock(0), />10:30</);
        assert.match(clock(0), /color:var\(--text-muted\)/);
    }
    assert.match(timing.countdownMarkup({ minutes: 60, departure: first.departureEpoch, color: 'inherit' }), /1h 00m/);
    assert.match(timing.countdownMarkup({ minutes: 61, departure: first.departureEpoch, color: 'inherit' }), /1h 01m/);
});
