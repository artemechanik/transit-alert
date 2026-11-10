import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup() {
  const timers = new Map(), calls = [];
  let timerId = 0, responder = async () => ({ ok: true, json: async () => ({ trip: { isRealTime: true, delayMinutes: 3 } }) });
  const row = { dataset: { tripId: 'trip', min: '600', delay: '0', delayInitial: '0' }, querySelector: () => null };
  const timeline = { querySelectorAll: () => [row], querySelector: () => null, closest: () => null };
  const context = {
    AbortController, Date, console,
    document: {
      getElementById: () => null,
      querySelectorAll: selector => selector === '.trasa-timeline' ? [timeline] : [],
      querySelector: () => null,
    },
    setInterval: fn => { timers.set(++timerId, fn); return timerId; },
    clearInterval: id => timers.delete(id),
    fetch: (url, options) => { calls.push({ url, signal: options.signal }); return responder(options.signal); },
  };
  const { createPlannerLive } = await loadBrowserModule(new URL('../js/planner-live.js', import.meta.url), context);
  const live = createPlannerLive({ apiBaseUrl: '', refreshOpenTrasaPassedStops: async () => {} });
  const planner = { enterPlanner: live.enterPlannerLive, leavePlanner: live.leavePlanner };
  return { planner, timers, calls, row, setResponder: fn => { responder = fn; }, tick: async () => { for (let i=0;i<15;i++) [...timers.values()][0]?.(); await flush(); } };
}

test('enter updates immediately; leave stops polling; return resumes with one timer', async () => {
  const h = await setup(); h.planner.enterPlanner(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.row.dataset.delay, 3);
  assert.equal(h.timers.size, 1);
  await h.tick(); assert.equal(h.calls.length, 2);
  const obsoleteTick = [...h.timers.values()][0];
  h.planner.leavePlanner(); await obsoleteTick();
  assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 2);
  h.planner.enterPlanner(); await flush();
  assert.equal(h.calls.length, 3); assert.equal(h.timers.size, 1);
  h.planner.enterPlanner(); await flush(); assert.equal(h.timers.size, 1);
});

test('leave aborts the request and an old response cannot update the returned screen', async () => {
  const h = await setup(); let resolve;
  h.setResponder(() => new Promise(r => { resolve = r; }));
  h.planner.enterPlanner(); await h.tick(); // concurrent polling is suppressed
  assert.equal(h.calls.length, 1);
  h.planner.leavePlanner(); assert.equal(h.calls[0].signal.aborted, true);
  h.setResponder(async () => ({ ok: true, json: async () => ({ trip: { isRealTime: true, delayMinutes: 4 } }) }));
  h.planner.enterPlanner(); await flush();
  resolve({ ok: true, json: async () => ({ trip: { isRealTime: true, delayMinutes: 99 } }) });
  await flush(); assert.equal(h.row.dataset.delay, 4);
});

test('navigation stops Trasa on map, stop, reports and history return', async () => {
  const element = { style: {}, classList: { remove() {}, add() {} } };
  let leaves = 0, enters = 0, closes = 0;
  const context = { document: { querySelectorAll: () => [], getElementById: () => element },
    window: { history: { state: null, pushState() {} } } };
  const { createNavigation } = await loadBrowserModule(new URL('../js/navigation.js', import.meta.url), context);
  const nav = createNavigation({ leavePlanner: () => leaves++, enterPlanner: () => enters++,
    closeVehicleMapModal: () => closes++, stopVehicleTracking() {}, enterStops() {}, openReports() {} });
  nav.switchScreen('route', null, true);
  assert.equal(leaves, 0); assert.equal(enters, 1);
  for (const screen of ['map', 'stop', 'reports']) nav.switchScreen(screen, null, true);
  assert.equal(leaves, 3); assert.equal(closes, 4);
});

test('polling keeps the red blinking LIVE node and its animation instance', async () => {
  let content, badge, interval;
  const timer = {
    set innerHTML(value) { content={innerHTML:''}; badge=null; },
    querySelector: s => s === '.trasa-timer-content' ? content : badge,
    prepend: node => { badge=node; },
  };
  const row={dataset:{tripId:'trip',min:'600',delay:'0',delayInitial:'0',live:'true'},querySelector:()=>null};
  const timeline={querySelectorAll:()=>[row],querySelector:s=>s==='.trasa-dep-min'?timer:null,closest:()=>null};
  const {createPlannerLive}=await loadBrowserModule(new URL('../js/planner-live.js',import.meta.url),{
    Date,AbortController,console,
    document:{querySelectorAll:()=>[timeline],createElement:()=>({style:{}})},
    setInterval:fn=>{interval=fn;return 1;},clearInterval(){},
  });
  const live=createPlannerLive({refreshResults:async()=>{},refreshOpenTrasaPassedStops:async()=>{}});
  live.enterPlannerLive(); await flush();
  const original=badge; assert.ok(original);
  assert.match(original.style.cssText,/color:#ef4444/);
  assert.match(original.style.cssText,/animation:trasaLiveBlink 1.5s infinite/);
  for(let i=0;i<15;i++) interval(); await flush();
  assert.equal(badge,original);
  live.leavePlanner();
});

test('transfer risk remains independent of the initial walking warning', async () => {
  const walkWarning={hidden:false};
  const transferWarning={hidden:true};
  const makeRow=dataset=>({dataset,querySelector:s=>s==='.trasa-transfer-warn'?transferWarning:null});
  const rows=[makeRow({tripId:'first',min:'600',delay:'0',delayInitial:'0'}),
    makeRow({tripId:'first',min:'650',delay:'0',delayInitial:'0',nextDep:'651',transferWalk:'1'}),
    makeRow({tripId:'second',min:'700',delay:'0',delayInitial:'0'})];
  const timeline={querySelectorAll:()=>rows,querySelector:()=>null,closest:()=>null};
  const {createPlannerLive}=await loadBrowserModule(new URL('../js/planner-live.js',import.meta.url),{
    Date,AbortController,console,document:{querySelectorAll:()=>[timeline]},setInterval:()=>1,clearInterval(){}
  });
  const live=createPlannerLive({refreshResults:async()=>{},refreshOpenTrasaPassedStops:async()=>{}});
  live.enterPlannerLive(); await flush();
  assert.equal(transferWarning.hidden,false); assert.equal(walkWarning.hidden,false);
  rows[1].dataset.nextDep='660'; await live.updateTrasaCountdowns();
  assert.equal(transferWarning.hidden,true); assert.equal(walkWarning.hidden,false);
  live.leavePlanner();
});
