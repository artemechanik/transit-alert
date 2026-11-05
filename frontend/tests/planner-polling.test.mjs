import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/planner.js', import.meta.url), 'utf8')
  .replace('export function createPlanner', 'function createPlanner');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
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
  vm.createContext(context); vm.runInContext(source, context);
  const planner = context.createPlanner({ apiBaseUrl: '' });
  return { planner, timers, calls, row, setResponder: fn => { responder = fn; }, tick: () => [...timers.values()][0]?.() };
}

test('enter updates immediately; leave stops polling; return resumes with one timer', async () => {
  const h = setup(); h.planner.enterPlanner(); await flush();
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
  const h = setup(); let resolve;
  h.setResponder(() => new Promise(r => { resolve = r; }));
  h.planner.enterPlanner(); await h.tick(); // concurrent polling is suppressed
  assert.equal(h.calls.length, 1);
  h.planner.leavePlanner(); assert.equal(h.calls[0].signal.aborted, true);
  h.setResponder(async () => ({ ok: true, json: async () => ({ trip: { isRealTime: true, delayMinutes: 4 } }) }));
  h.planner.enterPlanner(); await flush();
  resolve({ ok: true, json: async () => ({ trip: { isRealTime: true, delayMinutes: 99 } }) });
  await flush(); assert.equal(h.row.dataset.delay, 4);
});

test('navigation stops Trasa on map, stop, reports and history return', () => {
  const navSource = fs.readFileSync(new URL('../js/navigation.js', import.meta.url), 'utf8')
    .replace('export function createNavigation', 'function createNavigation');
  const element = { style: {}, classList: { remove() {}, add() {} } };
  let leaves = 0, enters = 0, closes = 0;
  const context = { document: { querySelectorAll: () => [], getElementById: () => element },
    window: { history: { state: null, pushState() {} } } };
  vm.createContext(context); vm.runInContext(navSource, context);
  const nav = context.createNavigation({ leavePlanner: () => leaves++, enterPlanner: () => enters++,
    closeVehicleMapModal: () => closes++, stopVehicleTracking() {}, enterStops() {}, openReports() {} });
  nav.switchScreen('route', null, true);
  assert.equal(leaves, 0); assert.equal(enters, 1);
  for (const screen of ['map', 'stop', 'reports']) nav.switchScreen(screen, null, true);
  assert.equal(leaves, 3); assert.equal(closes, 4);
});
