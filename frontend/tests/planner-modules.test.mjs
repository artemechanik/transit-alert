import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

class Element {
  constructor() {
    this.value = ''; this.style = {}; this.dataset = {}; this.children = [];
    this.listeners = {}; this.parts = new Map(); this.classes = new Set();
    this.classList = { contains: c => this.classes.has(c), add: c => this.classes.add(c),
      remove: c => this.classes.delete(c) };
    this.parentNode = { insertBefore() {} };
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async emit(type, extra = {}) {
    for (const listener of this.listeners[type] || []) {
      await listener({ target: this, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  }
  click() { return this.emit('click'); }
  focus() {} blur() {} contains() { return false; } closest() { return null; }
  appendChild(child) { this.children.push(child); }
  getBoundingClientRect() { return { bottom: 100 }; }
  querySelector(selector) {
    if (!this.parts.has(selector)) this.parts.set(selector, new Element());
    return this.parts.get(selector);
  }
  querySelectorAll(selector) {
    if (selector === '.dep-expand-map-btn') return [this.querySelector(selector)];
    return [];
  }
}

async function setup() {
  const elements = new Map(), calls = [], maps = [], history = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let responder = () => [], position = { lat: 51.24, lon: 22.57 };
  const context = {
    console, Date, AbortController, setTimeout: fn => fn(), setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: k => history.get(k), setItem: (k, v) => history.set(k, v) },
    document: { getElementById: get, createElement: () => new Element(), addEventListener() {},
      querySelector: () => null, querySelectorAll: () => [] },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const data = responder(url);
      return { ok: true, json: async () => data };
    },
  };
  const { createPlanner } = await loadBrowserModule(new URL('../js/planner.js', import.meta.url), context);
  const planner = createPlanner({ apiBaseUrl: '/api', getMapTilerKey: () => 'test-key',
    locationService: { getPosition: () => position }, getNearbyStops: () => [], showToast() {},
    showVehicleOnMap: (...args) => maps.push(args), addMinutesToTime: s => s,
    onAccordionOpen() {}, onBack() {} });
  planner.initPlanner();
  return { planner, get, calls, maps, history, respond: fn => { responder = fn; },
    move: p => { position = p; } };
}

async function chooseStop(h, field, name, ids) {
  h.respond(url => url.includes('/stops/search')
    ? ids.map(stopId => ({ name, stopId })) : { features: [] });
  const input = h.get(`route-input-${field}`); input.value = name;
  await input.emit('input');
  const suggestions = h.get(`route-suggestions-${field}`);
  assert.equal(suggestions.children.length, 1, 'platforms are grouped into one suggestion');
  await suggestions.children[0].click();
}

const leg = { route: '7', tripId: 'trip-7', fromStopId: 'a1', toStopId: 'b1',
  fromStopName: 'Park Akademicki 01', toStopName: 'Felin 01', departureMin: 600, arrivalMin: 620,
  isRealTime: true, delayMinutes: 3 };

test('grouped stop selection reaches search, card and map with exact stop IDs', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Park Akademicki', ['a1', 'a2']);
  await chooseStop(h, 'to', 'Felin', ['b1', 'b2']);
  h.respond(url => url.includes('/route/complex') ? [{ legs: [leg] }] : [
    { stopId: 'a1', name: 'Start', platformCode: '01', eta: '10:00', lat: 51.2, lon: 22.5 },
    { stopId: 'b1', name: 'Finish', platformCode: '01', eta: '10:20', lat: 51.3, lon: 22.6 },
    { stopId: 'b2', name: 'Beyond destination', eta: '10:30' },
  ]);
  await h.get('route-search-btn').click();
  assert.equal(h.calls.at(-1).url, '/api/route/complex?from=a1,a2&to=b1,b2&limit=8');
  const card = h.get('route-results-list').children[0].children[0];
  assert.match(card.innerHTML, /data-trip-id="trip-7" data-min="600" data-delay="3" data-delay-initial="3"/);
  await card.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.at(-1).url, '/api/trips/trip-7/upcoming-stops?fromStopId=a1');
  const panel = card.querySelector('.trasa-middle-scroll');
  assert.match(panel.innerHTML, /Finish/);
  assert.doesNotMatch(panel.innerHTML, /Beyond destination/);
  await panel.querySelector('.dep-expand-map-btn').click();
  assert.equal(h.maps[0][0], 'trip-7');
  assert.equal(h.maps[0][1].mode, 'trasa');
  assert.equal(JSON.stringify(h.maps[0][1].fromCoords), '[22.5,51.2]');
  assert.equal(JSON.stringify(h.maps[0][1].toCoords), '[22.6,51.3]');

  const results = h.get('route-results-list');
  results.scrollTop = 0; results.clientHeight = 100; results.scrollHeight = 100;
  h.respond(() => [{ legs: [{ ...leg, departureMin: 630, arrivalMin: 650 }] }]);
  await results.emit('touchstart', { touches: [{ clientY: 100 }] });
  await results.emit('touchend', { changedTouches: [{ clientY: 20 }] });
  assert.equal(h.calls.at(-1).url, '/api/route/complex?from=a1,a2&to=b1,b2&limit=8&time=601');
  assert.equal(results.children.length, 2);
});

test('dynamic GPS stays fresh at search time and swap keeps the same selected points', async () => {
  const h = await setup();
  await chooseStop(h, 'to', 'Felin', ['b1', 'b2']);
  const gps = h.get('route-clear-from'); gps.classList.add('icon-location');
  h.respond(() => []);
  await gps.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.calls.some(c => c.url === '/api/route/complex?fromLat=51.24&fromLon=22.57&to=b1,b2&limit=8'));
  h.move({ lat: 51.25, lon: 22.58 });
  await h.get('route-search-btn').click();
  assert.equal(h.calls.at(-1).url, '/api/route/complex?fromLat=51.25&fromLon=22.58&to=b1,b2&limit=8');
  const swap = h.get('route-clear-to'); swap.classList.add('icon-swap');
  await swap.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.at(-1).url, '/api/route/complex?from=b1,b2&toLat=51.25&toLon=22.58&limit=8');
});

test('address autocomplete retains MapTiler coordinates and stop results precede addresses', async () => {
  const h = await setup();
  await chooseStop(h, 'to', 'Felin', ['b1']);
  h.respond(url => url.includes('/stops/search') ? [{ name: 'Lipowa - cmentarz', stopId: 'lipowa' }]
    : { features: [{ text: 'Lipowa', address: '1', place_name: 'Lipowa 1, Lublin', center: [22.55, 51.24] }] });
  const input = h.get('route-input-from'); input.value = 'Lipowa';
  await input.emit('input');
  const suggestions = h.get('route-suggestions-from').children;
  assert.equal(suggestions.length, 2);
  assert.match(suggestions[0].innerHTML, /Lipowa - cmentarz/);
  assert.match(h.calls.at(-1).url, /language=pl&autocomplete=true&bbox=22.35,51.11,22.75,51.36/);
  await suggestions[1].querySelector('.address-main-click').click();
  h.respond(() => []);
  await h.get('route-search-btn').click();
  assert.equal(h.calls.at(-1).url, '/api/route/complex?fromLat=51.24&fromLon=22.55&to=b1&limit=8');
});
