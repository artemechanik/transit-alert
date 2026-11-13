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
        assert.match(details,new RegExp(minutes ? `>${minutes} minut` : '>Teraz<'));
        assert.match(details,new RegExp(minutes ? `Odjazd za ${minutes} min` : 'Odjazd teraz'));
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
