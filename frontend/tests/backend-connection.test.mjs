import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const ok = () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });
async function setup() {
  const timers = new Map(), events = {}, calls = [], states = [];
  let id = 0, responder = async () => ok();
  const document = { hidden: false, addEventListener: (name, fn) => { events[name] = fn; } };
  const { createBackendConnection } = await loadBrowserModule(new URL('../js/backend-connection.js', import.meta.url), {
    AbortController, setTimeout, clearTimeout, fetch: () => { throw new Error('unexpected native fetch'); }
  });
  const monitor = createBackendConnection({ apiBaseUrl: 'http://api', document,
    fetchImpl: (url, options) => { calls.push(url); return responder(url, options); },
    onUnavailable: value => states.push(value),
    setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id)
  });
  const tick = async ms => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `timer ${ms}`);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  };
  return { monitor, timers, states, calls, document, events, tick, respond: fn => { responder = fn; } };
}

test('startup outage recovers with one 10s timer, no normal status polling or POST replay', async () => {
  const s = await setup();
  s.respond(async () => { throw new TypeError('offline'); });
  s.monitor.start(); s.monitor.start(); await flush();
  assert.deepEqual(s.states, [true]);
  assert.equal(s.timers.size, 1);
  await assert.rejects(s.monitor.request('http://api/reports', { method: 'POST' }));
  s.respond(async () => ok());
  await s.tick(10000);
  assert.deepEqual(s.states, [true, false]);
  assert.equal(s.timers.size, 0);
  assert.equal(s.calls.filter(url => url.endsWith('/reports')).length, 1);
});

test('endpoint 500 confirms via status; healthy backend never shows banner; 404 and abort do not probe', async () => {
  const s = await setup();
  s.respond(async url => url.endsWith('/status') ? ok() : { ok: false, status: 500 });
  await s.monitor.request('http://api/live-vehicles'); await flush();
  assert.deepEqual(s.states, [false]);
  s.respond(async () => ({ ok: false, status: 404 }));
  await s.monitor.request('http://api/live-vehicles/trip');
  s.respond(async () => { const error = new Error(); error.name = 'AbortError'; throw error; });
  await assert.rejects(s.monitor.request('http://api/trip'));
  assert.equal(s.calls.filter(url => url.endsWith('/status')).length, 1);
});

test('runtime disconnect, background pause, immediate foreground probe and single in-flight check', async () => {
  const s = await setup();
  s.monitor.start(); await flush();
  s.respond(async () => { throw new TypeError('offline'); });
  await assert.rejects(s.monitor.request('http://api/live-vehicles')); await flush();
  assert.equal(s.states.at(-1), true);
  s.document.hidden = true; s.events.visibilitychange();
  assert.equal(s.timers.size, 0);
  let resolve;
  s.respond(() => new Promise(r => { resolve = r; }));
  s.document.hidden = false; s.events.visibilitychange(); s.events.visibilitychange(); await flush();
  assert.equal(s.calls.filter(url => url.endsWith('/status')).length, 3);
  resolve(ok()); await flush();
  assert.equal(s.states.at(-1), false);
  assert.equal(s.timers.size, 0);
});

test('probe timeout is bounded and retries; malformed status is not considered recovery', async () => {
  const s = await setup();
  s.respond((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timeout')));
  }));
  s.monitor.start(); await flush();
  await s.tick(5000);
  assert.deepEqual(s.states, [true]);
  s.respond(async () => ({ ok: true, json: async () => ({}) }));
  await s.tick(10000);
  assert.equal(s.states.at(-1), true);
  assert.equal(s.timers.size, 1);
});

test('application response and caller cancellation signal are preserved', async () => {
  const s = await setup();
  const controller = new AbortController();
  const response = ok();
  s.respond(async (url, options) => {
    assert.equal(options.signal, controller.signal);
    return response;
  });
  assert.equal(await s.monitor.request('http://api/trip', { signal: controller.signal }), response);
  assert.deepEqual(s.states, []);
});

test('integration changes only banner; external failures and empty LIVE do not trigger recovery', async () => {
  const banner = { hidden: true }, events = {}, calls = [], timers = new Map();
  let offline = false, id = 0;
  const fetchImpl = async url => {
    calls.push(url);
    if (url.startsWith('https://external') || offline) throw new TypeError('network');
    return url.endsWith('/status') ? ok() : { ok: true, status: 200, json: async () => [] };
  };
  const { initBackendConnection, apiFetch } = await loadBrowserModule(new URL('../js/backend-connection.js', import.meta.url), {
    AbortController, fetch: fetchImpl,
    setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    document: {
      hidden: false,
      // Access to any screen, map, form or panel would fail this test.
      getElementById: id => { assert.equal(id, 'backend-connection-status'); return banner; },
      addEventListener: (name, fn) => { events[name] = fn; }
    }
  });
  initBackendConnection('http://api'); await flush();
  await assert.rejects(fetchImpl('https://external/geocoding'));
  await apiFetch('http://api/live-vehicles'); await flush();
  assert.equal(banner.hidden, true);
  assert.equal(calls.filter(url => url.endsWith('/status')).length, 1);
  offline = true;
  await assert.rejects(apiFetch('http://api/live-vehicles')); await flush();
  assert.equal(banner.hidden, false);
  offline = false;
  events.visibilitychange(); await flush();
  assert.equal(banner.hidden, true);
  assert.equal(timers.size, 0);
});
