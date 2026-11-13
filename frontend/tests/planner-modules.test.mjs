import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

class Element {
  constructor() {
    this.value = ''; this.style = {}; this.dataset = {}; this.children = [];
    this.listeners = {}; this.parts = new Map(); this.classes = new Set();
    this.classList = { contains: c => this.classes.has(c), add: c => this.classes.add(c),
      remove: c => this.classes.delete(c), toggle: (c,on) => on ? this.classes.add(c) : this.classes.delete(c) };
    this.parentNode = { insertBefore() {} };
  }
  set innerHTML(value) { this.html = value; this.children = []; this.recentCards = null; }
  get innerHTML() { return this.html || ''; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async emit(type, extra = {}) {
    for (const listener of this.listeners[type] || []) {
      await listener({ target: this, preventDefault() {}, stopPropagation() {}, ...extra });
    }
  }
  click() { return this.emit('click'); }
  focus() { this.focused = true; } blur() { this.focused = false; } contains(target) { return this === target; } closest() { return null; }
  appendChild(child) { this.children.push(child); }
  getBoundingClientRect() { return { bottom: 100 }; }
  querySelector(selector) {
    if (!this.parts.has(selector)) this.parts.set(selector, new Element());
    return this.parts.get(selector);
  }
  querySelectorAll(selector) {
    if (selector === '.stop-card') return this.recentCards ||= Array.from({ length: (this.innerHTML.match(/class="stop-card"/g) || []).length }, () => new Element());
    if (selector === '.dep-expand-map-btn') return [this.querySelector(selector)];
    return [];
  }
}

async function setup(initialHistory = []) {
  const elements = new Map(), calls = [], maps = [], history = new Map(initialHistory), toasts = [], documents = [], timers = new Map();
  let timelines = [], clockNow = null, holdShortTimers = false;
  class PlannerTestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockNow ?? Date.now()])); }
    static now() { return clockNow ?? Date.now(); }
  }
  let nextTimer = 0; const intervals = new Map(), created = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let responder = () => [], position = { lat: 51.24, lon: 22.57 };
  const context = {
    console, Date: PlannerTestDate, AbortController, URLSearchParams,
    setTimeout: (fn, delay) => { if (delay < 5000 && !holdShortTimers) { fn(); return 0; } const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), setInterval: fn => { const id=++nextTimer; intervals.set(id,fn); return id; }, clearInterval: id => intervals.delete(id),
    localStorage: { getItem: k => history.get(k), setItem: (k, v) => history.set(k, v) },
    document: { getElementById: get, createElement: () => { const element = new Element(); created.push(element); return element; }, addEventListener: (type, fn) => documents.push({type,fn}),
      querySelector: () => null, querySelectorAll: selector => selector === '.trasa-timeline' ? timelines : [] },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const data = await responder(url, options);
      if (data instanceof Error) throw data;
      const status = data?.httpStatus || 200;
      return { ok: status >= 200 && status < 300, status, json: async () => data };
    },
  };
  const { createPlanner } = await loadBrowserModule(new URL('../js/planner.js', import.meta.url), context);
  const planner = createPlanner({ apiBaseUrl: '/api', getMapTilerKey: () => 'test-key',
    locationService: { getPosition: () => position }, getNearbyStops: () => [], showToast: text => toasts.push(text),
    showVehicleOnMap: (...args) => maps.push(args), addMinutesToTime: s => s,
    onAccordionOpen() {}, onBack() {} });
  planner.initPlanner(); planner.enterPlanner();
  return { planner, get, calls, maps, history, toasts, documents, timers, intervals, created, setNow: value => { clockNow = value; }, setTimelines: value => { timelines = value; }, respond: fn => { responder = fn; },
    holdShortTimers: value => { holdShortTimers = value; },
    move: p => { position = p; } };
}

async function chooseStop(h, field, name, ids) {
  h.respond(url => url.includes('/stops/search')
    ? ids.map(stopId => ({ name, stopId })) : { results: [] });
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
  h.respond(() => [{ legs: [{ ...leg, tripId: 'later-trip', departureMin: 630, arrivalMin: 650 }] }]);
  await results.emit('touchstart', { touches: [{ clientY: 100, clientX: 0 }] });
  await results.emit('touchmove', { touches: [{ clientY: 50, clientX: 0 }] });
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

test('address autocomplete retains PRG coordinates and stop results precede addresses', async () => {
  const h = await setup();
  await chooseStop(h, 'to', 'Felin', ['b1']);
  h.respond(url => url.includes('/stops/search') ? [{ name: 'Lipowa - cmentarz', stopId: 'lipowa' }]
    : { results: [{ type: 'address', street: 'Lipowa', house_number: '1', locality: 'Lublin', lat: 51.24, lon: 22.55 }] });
  const input = h.get('route-input-from'); input.value = 'Lipowa';
  await input.emit('input');
  const suggestions = h.get('route-suggestions-from').children;
  assert.equal(suggestions.length, 2);
  assert.match(suggestions[0].innerHTML, /Lipowa - cmentarz/);
  assert.equal(h.calls.at(-1).url, '/api/addresses/search?q=Lipowa&limit=4');
  await suggestions[1].querySelector('.address-main-click').click();
  h.respond(() => []);
  await h.get('route-search-btn').click();
  assert.equal(h.calls.at(-1).url, '/api/route/complex?fromLat=51.24&fromLon=22.55&to=b1&limit=8');
});

const street = { type: 'street', street: 'Lipowa', house_number: '', locality: 'Lublin', lat: 51.24, lon: 22.55 };
const address = { ...street, type: 'address', house_number: '12', lat: 51.244582, lon: 22.552772 };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function enter(h, field, query) {
  const input = h.get('route-input-' + field); input.value = query;
  await input.emit('input');
  return h.get('route-suggestions-' + field);
}

for (const field of ['from', 'to']) {
  test(field + ': progressive streets, separate main/arrow actions, building refinement and street-less address', async () => {
    const h = await setup();
    const other = field === 'from' ? 'to' : 'from';
    await chooseStop(h, other, 'Felin', ['b1']);
    h.respond(url => url.includes('/stops/search') ? [] : { results: [street] });
    for (const q of ['li', 'lip', 'lipo', 'lipowa']) {
      const box = await enter(h, field, q);
      assert.equal(box.children.length, 1);
      assert.match(box.children[0].innerHTML, /Lipowa/);
      assert.doesNotMatch(box.children[0].innerHTML, /Lipowa 12/);
    }
    let card = h.get('route-suggestions-' + field).children[0];
    await card.querySelector('.address-main-click').click();
    h.respond(() => []);
    await h.get('route-search-btn').click();
    assert.ok(h.calls.at(-1).url.includes(field + 'Lat=51.24&' + field + 'Lon=22.55'));
    assert.ok(!h.calls.at(-1).url.includes(field + '='));
    h.respond(url => url.includes('/stops/search') ? [] : { results: [street] });
    card = (await enter(h, field, 'Lipowa')).children[0];
    const before = h.calls.length;
    await card.querySelector('.address-copy-btn').click();
    assert.equal(h.get('route-input-' + field).value, 'Lipowa ');
    assert.equal(h.get('route-input-' + field).focused, true);
    assert.equal(h.calls.length, before, 'arrow must not geocode or select a route');
    await h.get('route-search-btn').click();
    assert.equal(h.calls.length, before, 'old coordinates must not survive arrow/refinement');
    h.respond(url => url.includes('/stops/search') ? [] : { results: [address] });
    card = (await enter(h, field, 'Lipowa 12')).children[0];
    assert.match(card.innerHTML, /Lipowa 12/);
    await card.querySelector('.address-main-click').click();
    h.respond(() => []);
    await h.get('route-search-btn').click();
    assert.ok(h.calls.at(-1).url.includes(field + 'Lat=51.244582&' + field + 'Lon=22.552772'));
    const motycz = { ...address, street: '', locality: 'Motycz', house_number: '69B' };
    h.respond(url => url.includes('/stops/search') ? [] : { results: [motycz] });
    card = (await enter(h, field, 'Motycz 69B')).children[0];
    assert.match(card.innerHTML, /Motycz 69B/);
    await card.querySelector('.address-main-click').click();
    const recents = JSON.parse(h.history.get('ta_recent_route_stops'));
    assert.equal(recents[0].name, 'Motycz 69B');
    assert.equal(recents[0].ids, undefined);
    assert.ok(!h.calls.some(c => c.url.includes('maptiler')));
  });

  test(field + ': late responses, clearing, editing a selection and PRG failure', async () => {
    const h = await setup();
    await chooseStop(h, field === 'from' ? 'to' : 'from', 'Felin', ['b1']);
    const old = deferred();
    h.respond(url => url.includes('/stops/search') ? [] :
      url.includes('q=li&') ? old.promise : { results: [address] });
    const oldInput = enter(h, field, 'li');
    await enter(h, field, 'Lipowa 12');
    old.resolve({ results: [{ ...street, street: 'Old street' }] });
    await oldInput;
    let box = h.get('route-suggestions-' + field);
    assert.match(box.children[0].innerHTML, /Lipowa 12/);
    assert.doesNotMatch(box.children[0].innerHTML, /Old street/);
    await box.children[0].querySelector('.address-main-click').click();
    const late = deferred();
    h.respond(url => url.includes('/stops/search') ? [] : late.promise);
    const typing = enter(h, field, 'New address');
    const before = h.calls.length;
    await h.get('route-search-btn').click();
    assert.equal(h.calls.length, before, 'editing invalidates selected coordinates immediately');
    await enter(h, field, '');
    late.resolve({ results: [street] }); await typing;
    box = h.get('route-suggestions-' + field);
    assert.ok(!box.children.some(c => (c.innerHTML || '').includes('address-main-click')));
    for (const failure of [{ httpStatus: 503 }, new Error('network down'), { wrong: 'shape' }]) {
      h.respond(url => url.includes('/stops/search') ? [{ name: 'Working stop', stopId: 'live-id' }] : failure);
      box = await enter(h, field, 'Lipowa');
      assert.match(box.children[0].innerHTML, /Working stop/);
      assert.match(box.children.at(-1).textContent, /adresów.*niedostępne/);
      await box.children[0].click();
    }
  });
}

test('address-to-address search preserves lat/lon; PRG order and four-card limit are retained', async () => {
  const h = await setup();
  h.respond(url => url.includes('/stops/search') ? [] : { results: [address,
    { ...address, locality: 'Świdnik' }, { ...address, locality: 'Turka' },
    { ...address, locality: 'Dys' }, { ...address, locality: 'Fifth' }] });
  const box = await enter(h, 'from', 'Lipowa 12');
  assert.equal(box.children.length, 4);
  assert.match(box.children[1].innerHTML, /Świdnik/);
  await box.children[0].querySelector('.address-main-click').click();
  h.respond(url => url.includes('/stops/search') ? [] : { results: [{ ...address, lat: 51.3, lon: 22.6 }] });
  await (await enter(h, 'to', 'Lipowa 12')).children[0].querySelector('.address-main-click').click();
  h.respond(() => []);
  await h.get('route-search-btn').click();
  assert.equal(h.calls.at(-1).url, '/api/route/complex?fromLat=51.244582&fromLon=22.552772&toLat=51.3&toLon=22.6&limit=8');
});

for (const field of ['from', 'to']) {
  test(field + ': PRG timeout keeps stops usable; clear button cancels pending suggestions', async () => {
    const h = await setup();
    h.respond((url, options) => url.includes('/stops/search')
      ? [{ name: 'Usable stop', stopId: 's1' }]
      : new Promise(resolve => options.signal.addEventListener('abort', () => resolve(new Error('aborted')), { once: true })));
    const pending = enter(h, field, 'Lipowa');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0]();
    await pending;
    let box = h.get('route-suggestions-' + field);
    assert.match(box.children[0].innerHTML, /Usable stop/);
    assert.match(box.children.at(-1).textContent, /niedostępne/);
    const late = deferred();
    h.respond(url => url.includes('/stops/search') ? [] : late.promise);
    const old = enter(h, field, 'Lipowa');
    const button = h.get('route-clear-' + field);
    button.classList.add('icon-clear');
    await button.click();
    assert.equal(h.get('route-input-' + field).value, '');
    late.resolve({ results: [street] }); await old;
    box = h.get('route-suggestions-' + field);
    assert.ok(!box.children.some(c => (c.innerHTML || '').includes('address-main-click')));
  });

  test(field + ': outside click cannot reopen a list when pending data arrives', async () => {
    const h = await setup(), late = deferred();
    h.respond(url => url.includes('/stops/search') ? [] : late.promise);
    const pending = enter(h, field, 'Lipowa');
    for (const listener of h.documents.filter(d => d.type === 'click')) listener.fn({ target: new Element() });
    late.resolve({ results: [street] }); await pending;
    assert.equal(h.get('route-suggestions-' + field).style.display, 'none');
  });
}

const prgFixtures = JSON.parse(fs.readFileSync(new URL('../../backend/src/test/resources/prg-query-fixtures.json', import.meta.url), 'utf8'));
for (const field of ['from', 'to']) {
  test(field + ': consumes the full PRG contract verified against real Kotlin HTTP', async () => {
    const h = await setup();
    for (const q of ['li', 'lip', 'lipo', 'lipowa', 'Lipowa 12', 'Motycz 69B', 'Raclawickie']) {
      const fixture = prgFixtures.find(f => f.q === q);
      assert.ok(fixture, q);
      h.respond(url => url.includes('/stops/search') ? [] : fixture.expected);
      const box = await enter(h, field, q);
      const expected = fixture.expected.results.slice(0, 4);
      assert.equal(box.children.length, expected.length);
      for (let i = 0; i < expected.length; i++) {
        assert.match(box.children[i].innerHTML, new RegExp(expected[i].locality));
      }
      await box.children[0].querySelector('.address-main-click').click();
      const selected = JSON.parse(h.history.get('ta_recent_route_stops'))[0];
      assert.equal(selected.lat, expected[0].lat);
      assert.equal(selected.lon, expected[0].lon);
      assert.equal(selected.ids, undefined);
    }
  });
}

for (const field of ['from','to']) {
  test(field + ': POI selection, stop priority, no refinement arrow and stale POI rejection', async () => {
    const h = await setup();
    const poi = { type: 'poi', id: 'poi:test', display_name: 'Galeria Orkana', subtitle: 'Orkana 6, Lublin', category: 'shopping', lat: 51.24, lon: 22.55 };
    h.respond(url => url.includes('/stops/search') ? [{ name: 'Orkana', stopId: 's1' }] : { results: [poi] });
    const box = await enter(h, field, 'ork');
    assert.equal(box.children.length, 2);
    assert.match(box.children[0].innerHTML, /Orkana/);
    assert.ok(!box.children[0].innerHTML.includes('Galeria Orkana'));
    const card = box.children[1];
    assert.match(card.innerHTML, /Galeria Orkana/);
    assert.match(card.innerHTML, /Orkana 6, Lublin/);
    assert.ok(!card.innerHTML.includes('51.24'));
    assert.ok(!card.innerHTML.includes('address-copy-btn'));
    await card.querySelector('.address-main-click').click();
    assert.equal(h.get('route-input-' + field).value, 'Galeria Orkana');
    const recents = JSON.parse(h.history.get('ta_recent_route_stops'));
    assert.deepEqual(recents[0], { name: 'Galeria Orkana', lat: 51.24, lon: 22.55 });
    const late = deferred();
    h.respond(url => url.includes('/stops/search') ? [] : late.promise);
    const old = enter(h, field, 'olimp');
    h.respond(url => url.includes('/stops/search') ? [] : { results: [] });
    await enter(h, field, 'new');
    late.resolve({ results: [poi] }); await old;
    assert.ok(!box.children.some(c => (c.innerHTML || '').includes('Galeria Orkana')));
  });
}

for (const field of ['from', 'to']) {
  test(field + ': typed autocomplete uses one compact icon per card and structured POI mapping', async () => {
    const h = await setup();
    const cases = [
      ['Orkana', { type:'street', street:'Władysława Orkana', locality:'Lublin', house_number:'', lat:51.23, lon:22.51 }, 'map-pin'],
      ['Orkana', { type:'poi', id:'mall', display_name:'Galeria Orkana', subtitle:'Orkana 6, Lublin', category:'shopping', lat:51.23, lon:22.49 }, 'shopping-bag'],
      ['Ball', { type:'poi', id:'factory', display_name:'Ball Packing Europe Lublin Sp. z o.o.', subtitle:'Vetterów 14, Lublin', category:'industry', lat:51.22, lon:22.64 }, 'factory'],
      ['Cinema', { type:'poi', id:'poi:0e028b4b83d9237738cc', display_name:'Cinema', subtitle:'Lublin', category:'culture', lat:51.2, lon:22.5 }, 'clapperboard'],
      ['Lipowa 13', { type:'address', street:'Lipowa', house_number:'13', locality:'Lublin', lat:51.2, lon:22.5 }, 'map-pin'],
      ['Cinema', { type:'poi', id:'unknown', display_name:'Cinema in a name is not a category', subtitle:'Lublin', category:'unknown', lat:51.2, lon:22.5 }, 'map-pin'],
    ];
    for (const [query,item,icon] of cases) {
      h.respond(url => url.includes('/stops/search') ? [] : { results:[item] });
      const box = await enter(h,field,query), card=box.children[0];
      assert.ok(card.className.includes('planner-autocomplete-card'));
      assert.match(card.innerHTML,new RegExp('planner-icon-'+icon));
      assert.equal((card.innerHTML.match(/aria-hidden="true"/g)||[]).length,1);
      assert.ok(!card.innerHTML.includes('text-overflow'));
      assert.equal(card.innerHTML.includes('address-copy-btn'),item.type!=='poi');
      await card.querySelector('.address-main-click').click();
      const recent=JSON.parse(h.history.get('ta_recent_route_stops'))[0];
      assert.equal(recent.lat,item.lat);assert.equal(recent.lon,item.lon);
    }
    h.respond(url => url.includes('/stops/search') ? [{name:'Hubalczyków',stopId:'h1'},{name:'Hubalczyków',stopId:'h2'}] : { results:[] });
    const box=await enter(h,field,'Hubalczyków');
    assert.equal(box.children.length,1);
    assert.match(box.children[0].innerHTML,/planner-icon-bus-front/);
    assert.ok(!box.children[0].innerHTML.includes('stop.svg'));
    assert.ok(!box.children[0].innerHTML.includes('planner-autocomplete-subtitle'));
    await box.children[0].click();
    assert.deepEqual(JSON.parse(h.history.get('ta_recent_route_stops'))[0].ids,['h1','h2']);
  });
}

test('autocomplete SVG assets and wrapping rules remain local and scoped', () => {
  const css=fs.readFileSync(new URL('../css/planner.css',import.meta.url),'utf8');
  const scoped=css.slice(css.indexOf('/* Typed autocomplete results only;'));
  assert.match(scoped,/min-width: 0/);assert.match(scoped,/overflow-wrap: anywhere/);
  assert.match(scoped,/white-space: normal/);
  assert.match(scoped,/height: 60px/);
  assert.match(scoped,/padding: 8px 16px/);
  assert.match(scoped,/-webkit-line-clamp: 2/);
  assert.match(scoped,/-webkit-line-clamp: 1/);
  assert.match(scoped,/text-overflow: ellipsis/);
  assert.match(scoped,/pointer-events: none/);
  for(const icon of ['bus-front','map-pin','factory','shopping-bag','clapperboard','hospital','graduation-cap','trees','train-front','landmark']) {
    assert.ok(fs.readFileSync(new URL('../icons/lucide/'+icon+'.svg',import.meta.url),'utf8').includes('<svg'));
    assert.ok(scoped.includes('../icons/lucide/'+icon+'.svg'));
  }
});

for (const field of ['from','to']) {
  test(field + ': input icon appears only on selection and follows category, edit, refinement and clear', async () => {
    const h=await setup(), icon=h.get('route-selected-icon-'+field);
    assert.equal(icon.hidden,true);
    await chooseStop(h,field,'Hubalczyków',['h1','h2']);
    assert.equal(icon.hidden,false);assert.match(icon.className,/planner-icon-bus-front/);
    for(const [category,wanted] of [['industry','factory'],['shopping','shopping-bag'],['health','hospital'],['education','graduation-cap'],['park','trees'],['transport','train-front'],['government','landmark'],['unknown','map-pin']]) {
      h.respond(url=>url.includes('/stops/search') ? [] : {results:[{type:'poi',id:category,category,display_name:'Selected '+category,subtitle:'Lublin',lat:51.24,lon:22.55}]});
      const box=await enter(h,field,category);
      assert.equal(icon.hidden,true);
      await box.children[0].querySelector('.address-main-click').click();
      assert.equal(icon.hidden,false);assert.match(icon.className,new RegExp('planner-icon-'+wanted));
    }
    h.respond(url=>url.includes('/stops/search') ? [] : {results:[{type:'street',street:'Lipowa',locality:'Lublin',house_number:'',lat:51.2,lon:22.5}]});
    let box=await enter(h,field,'Lipowa');
    const streetCard=box.children[0];
    await streetCard.querySelector('.address-main-click').click();
    assert.match(icon.className,/planner-icon-map-pin/);
    await streetCard.querySelector('.address-copy-btn').click();
    assert.equal(icon.hidden,true);
    box=await enter(h,field,'Lipowa');
    await box.children[0].querySelector('.address-main-click').click();
    const clear=h.get('route-clear-'+field);clear.classList.add('icon-clear');
    await clear.click();assert.equal(icon.hidden,true);
    assert.equal(h.get('route-input-'+field).value,'');
    h.respond(url=>url.includes('/stops/search') ? [] : {results:[{type:'address',street:'Lipowa',house_number:'13',locality:'Lublin',lat:51.25,lon:22.56}]});
    box=await enter(h,field,'Lipowa 13');
    await box.children[0].querySelector('.address-main-click').click();
    assert.match(icon.className,/planner-icon-map-pin/);
    const gpsState=await setup();
    const gps=gpsState.get('route-clear-'+field);gps.classList.add('icon-location');
    await gps.click();
    assert.equal(gpsState.get('route-selected-icon-'+field).hidden,false);
    assert.match(gpsState.get('route-selected-icon-'+field).className,/icon-location/);
    await enter(gpsState,field,'editing GPS');
    assert.equal(gpsState.get('route-selected-icon-'+field).hidden,true);
  });
}

test('selected icons swap with points, GPS remains dynamic, and route history restores category metadata', async () => {
  const h=await setup();
  h.respond(url=>url.includes('/stops/search') ? [] : {results:[{type:'poi',id:'poi:0e028b4b83d9237738cc',category:'culture',display_name:'Cinema',subtitle:'Lublin',lat:51.24,lon:22.55}]});
  await (await enter(h,'from','Cinema')).children[0].querySelector('.address-main-click').click();
  await chooseStop(h,'to','Felin',['f1']);
  h.respond(()=>[]);await h.get('route-search-btn').click();
  assert.match(h.get('route-selected-icon-from').className,/clapperboard/);
  const swap=h.get('route-clear-to');swap.classList.add('icon-swap');await swap.click();
  assert.match(h.get('route-selected-icon-to').className,/clapperboard/);
  assert.match(h.get('route-selected-icon-from').className,/bus-front/);
  // A new page restores the saved icon even when the bounded recent-point cache is gone.
  const history=[...h.history.entries()].filter(([key])=>key!=='ta_route_point_icons');
  const restored=await setup(history);
  restored.planner.renderRecentRoutes();
  const cards=restored.get('recent-routes-list').querySelectorAll('.stop-card');assert.ok(cards.length>0);
  await cards[0].click();
  assert.match(restored.get('route-selected-icon-to').className,/clapperboard/);
  assert.match(restored.get('route-selected-icon-from').className,/bus-front/);
  await enter(restored,'from','');
  const gps=restored.get('route-clear-from');gps.classList.add('icon-location');
  restored.respond(()=>[]);await gps.click();
  assert.match(restored.get('route-selected-icon-from').className,/icon-location/);
  assert.equal(restored.get('route-selected-icon-from').hidden,false);
  restored.move({lat:51.3,lon:22.6});await restored.get('route-search-btn').click();
  assert.ok(restored.calls.at(-1).url.includes('fromLat=51.3&fromLon=22.6'));
  const reverse=restored.get('route-clear-to');reverse.classList.add('icon-swap');await reverse.click();
  assert.match(restored.get('route-selected-icon-to').className,/icon-location/);
});

test('input icon slots reserve stable left padding and do not intercept field actions',()=>{
  const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
  for(const field of ['from','to']) {
    assert.match(html,new RegExp('id="route-selected-icon-'+field+'"[^>]*aria-hidden="true" hidden'));
    assert.match(html,new RegExp('id="route-input-'+field+'"\\s+style="[^"]*padding: 9px 36px 9px 40px'));
  }
  const css=fs.readFileSync(new URL('../css/planner.css',import.meta.url),'utf8');
  assert.match(css,/#route-selected-icon-from, #route-selected-icon-to \{[^}]*pointer-events: none/s);
});

test('Trasa pull refresh preserves wrapper and scroll; error recovers; inactive gestures do not fetch', async () => {
  const h = await setup();
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  const now = Math.floor(Date.now()/1000);
  const j = {legs:[{...leg,scheduledDepartureEpoch:now+600,scheduledArrivalEpoch:now+1200,departureEpoch:now+600,arrivalEpoch:now+1200}]};
  h.respond(() => [j]); await h.get('route-search-btn').click();
  const results=h.get('route-results-list'), wrapper=results.children[0];
  results.scrollTop=0; results.clientHeight=100; results.scrollHeight=500;
  const pull=async () => {
    await results.emit('touchstart',{touches:[{clientY:0,clientX:0}]});
    await results.emit('touchmove',{touches:[{clientY:45,clientX:0}]});
    await results.emit('touchend',{changedTouches:[{clientY:90,clientX:0}]});
  };
  const count=h.calls.length;
  await pull(); assert.equal(h.calls.length,count+1);
  assert.equal(results.children[0],wrapper); assert.equal(results.scrollTop,0);
  h.respond(() => new Error('offline')); await pull(); assert.equal(results.children[0],wrapper);
  h.respond(() => [j]); await pull(); assert.equal(results.children[0],wrapper);
  results.scrollTop=80; const before=h.calls.length; await pull(); assert.equal(h.calls.length,before);
  h.planner.leavePlanner(); results.scrollTop=0; await pull(); assert.equal(h.calls.length,before);
});

test('automatic request is quiet; manual pull joins it; leave aborts and return resumes', async () => {
  const h=await setup();
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  const now=Math.floor(Date.now()/1000);
  const j={legs:[{...leg,isRealTime:false,scheduledDepartureEpoch:now+600,scheduledArrivalEpoch:now+1200,departureEpoch:now+600,arrivalEpoch:now+1200}]};
  h.respond(()=>[j]); await h.get('route-search-btn').click();
  const results=h.get('route-results-list'), wrapper=results.children[0], card=wrapper.children[0];
  const indicator=h.created.find(e=>e.className==='trasa-refresh-indicator');
  card.classList.add('fullscreen-expanded'); results.scrollTop=40;
  const flush=()=>new Promise(r=>setImmediate(r));
  const poll=()=>{for(let i=0;i<15;i++) [...h.intervals.values()][0]?.();};
  let resolve;
  h.respond(()=>new Promise(r=>{resolve=r;}));
  const before=h.calls.length; poll(); await flush();
  assert.equal(h.calls.length,before+1);
  assert.notEqual(indicator.style.height,'24px');
  assert.equal(results.scrollTop,40); assert.equal(results.children[0],wrapper);
  assert.equal(card.classList.contains('fullscreen-expanded'),true);
  results.scrollTop=0; results.clientHeight=100; results.scrollHeight=500;
  await results.emit('touchstart',{touches:[{clientY:0,clientX:0}]});
  await results.emit('touchmove',{touches:[{clientY:45,clientX:0}]});
  const pulling=results.emit('touchend',{changedTouches:[{clientY:90,clientX:0}]});
  await flush(); assert.equal(indicator.style.height,'24px');
  assert.equal(h.calls.length,before+1);
  resolve([j]); await pulling; await flush();
  assert.equal(indicator.style.height,'0');
  const toastCount=h.toasts.length;
  h.respond(()=>new Error('offline')); poll(); await flush();
  assert.equal(h.toasts.length,toastCount); assert.equal(indicator.style.height,'0');
  h.respond(()=>new Promise(r=>{resolve=r;})); poll(); await flush();
  const pending=h.calls.at(-1); h.planner.leavePlanner();
  assert.equal(pending.options.signal.aborted,true); assert.equal(h.intervals.size,0);
  const count=h.calls.length; poll(); assert.equal(h.calls.length,count);
  h.respond(()=>[j]); h.planner.enterPlanner(); await flush();
  assert.equal(h.calls.length,count+1); assert.equal(h.intervals.size,1);
  resolve([]); await flush(); assert.equal(results.children[0],wrapper);
});

test('only initial walker gets new warning; transfer warning stays in its timeline location', async () => {
  const h=await setup();
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  const now=Math.floor(Date.now()/1000);
  const first={...leg,scheduledDepartureEpoch:now+180,departureEpoch:now+180,scheduledArrivalEpoch:now+600,arrivalEpoch:now+600,liveObservedEpoch:now};
  const next={...first,tripId:'next',fromStopId:'b1',toStopId:'c1',departureMin:620,arrivalMin:630,scheduledDepartureEpoch:now+620,departureEpoch:now+620};
  const j={legs:[{route:'Пішки',departureMin:0,arrivalMin:7},first,next,{route:'Пішки',departureMin:630,arrivalMin:660}]};
  h.respond(()=>[j]); await h.get('route-search-btn').click();
  const wrapper=h.get('route-results-list').children[0], html=wrapper.children[0].innerHTML;
  assert.equal((html.match(/trasa-initial-walk-warn/g)||[]).length,1);
  assert.match(html,/class="trasa-initial-walk"[^]*?icon-walk[^]*?class="trasa-initial-walk-warn"  style/);
  assert.match(html,/class="trasa-row"[^]*?class="stop-name"[^]*?<span class="trasa-transfer-warn"  style="color: var\(--danger\); font-weight: 700;">⚠ <\/span>➔/);
  assert.doesNotMatch(html,/Zagrożona przesiadka/);
  assert.equal((html.match(/icon-walk/g)||[]).length,2);
  assert.equal(wrapper.classList.contains('trasa-departed'),false);
  assert.equal(wrapper.querySelector('.trasa-initial-walk-warn').hidden,false);
  const transferWarning=wrapper.children[0].querySelector('.trasa-transfer-warn');
  const row=(tripId,min,extra={})=>({dataset:{tripId,min:String(min),delay:'0',delayInitial:'0',...extra},querySelector:selector=>selector==='.trasa-transfer-warn'?transferWarning:null});
  const rows=[row('trip-7',600),row('trip-7',620,{nextDep:'620',transferWalk:'0'}),row('next',630)];
  h.setTimelines([{querySelectorAll:()=>rows,querySelector:()=>null,closest:()=>null}]);
  for(let i=0;i<15;i++) [...h.intervals.values()][0]();
  await new Promise(r=>setImmediate(r));
  assert.equal(transferWarning.hidden,false);
  assert.equal(wrapper.querySelector('.trasa-initial-walk-warn').hidden,false);
  const corrected={legs:j.legs.map(l=>l===first?{...l,departureEpoch:now+900,departureMin:615}:l)};
  h.respond(()=>[corrected]);
  const results=h.get('route-results-list'); results.scrollTop=0; results.clientHeight=100; results.scrollHeight=500;
  await results.emit('touchstart',{touches:[{clientY:0,clientX:0}]});
  await results.emit('touchmove',{touches:[{clientY:45,clientX:0}]});
  await results.emit('touchend',{changedTouches:[{clientY:90,clientX:0}]});
  assert.equal(results.children[0],wrapper);
  assert.equal(wrapper.querySelector('.trasa-initial-walk-warn').hidden,true);
});

test('gray card stays in its slot while new results arrive and fresh LIVE restores its existing node', async () => {
  const h=await setup(); const now=2000000000; h.setNow(now*1000);
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  const first={legs:[{...leg,scheduledDepartureEpoch:now+1,scheduledArrivalEpoch:now+600,departureEpoch:now+1,arrivalEpoch:now+600,liveObservedEpoch:now}]};
  h.respond(()=>[first]); await h.get('route-search-btn').click();
  const results=h.get('route-results-list'), wrapper=results.children[0];
  const second={legs:[{...first.legs[0],tripId:'later',scheduledDepartureEpoch:now+500,departureEpoch:now+500}]};
  h.setNow((now+2)*1000); h.respond(()=>[second]);
  for(let i=0;i<15;i++) [...h.intervals.values()][0]();
  await new Promise(r=>setImmediate(r));
  assert.equal(results.children.length,2); assert.equal(results.children[0],wrapper);
  assert.equal(wrapper.classList.contains('trasa-departed'),true);
  const corrected={legs:[{...first.legs[0],departureEpoch:now+200,liveObservedEpoch:now+10}]};
  h.setNow((now+10)*1000); h.respond(()=>[corrected,second]);
  for(let i=0;i<15;i++) [...h.intervals.values()][0]();
  await new Promise(r=>setImmediate(r));
  assert.equal(results.children[0],wrapper); assert.equal(wrapper.classList.contains('trasa-departed'),false);
  assert.equal(wrapper.classList.contains('trasa-result-exit'),false);
});

test('upward bottom swipe loads later journeys; ordinary scrolling and cancelled gestures do not fetch', async () => {
  const h=await setup();
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  h.respond(()=>[{legs:[leg]}]); await h.get('route-search-btn').click();
  const results=h.get('route-results-list');
  results.clientHeight=100; results.scrollHeight=500;
  const swipe=async (scrollTop, endY, endX=0, cancel=false) => {
    results.scrollTop=scrollTop;
    let prevented=false;
    await results.emit('touchstart',{touches:[{clientY:100,clientX:0}]});
    await results.emit('touchmove',{touches:[{clientY:endY,clientX:endX}],preventDefault(){prevented=true;}});
    if (cancel) await results.emit('touchcancel');
    await results.emit('touchend',{changedTouches:[{clientY:endY,clientX:endX}]});
    return prevented;
  };
  const before=h.calls.length;
  assert.equal(await swipe(200,20),false); // Scroll upwards in the middle.
  assert.equal(await swipe(0,20),false); // Scroll from the top towards later content.
  assert.equal(await swipe(400,180),false); // Scroll back from the bottom.
  assert.equal(await swipe(400,20,80),false); // Horizontal gesture.
  await swipe(400,20,0,true);
  assert.equal(h.calls.length,before);
  h.respond(()=>[{legs:[{...leg,tripId:'later',departureMin:630}]}]);
  assert.equal(await swipe(400,20),true);
  assert.equal(h.calls.length,before+1);
  assert.match(h.calls.at(-1).url,/&time=601$/);
  assert.equal(results.children.length,2);
  assert.equal(results.scrollTop,400);
  assert.equal(await swipe(0,180),true);
  assert.equal(h.calls.length,before+2);
  assert.doesNotMatch(h.calls.at(-1).url,/&time=/);
});

test('claimed bottom swipe survives indicator resizing the results viewport', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Start', ['a1']);
  await chooseStop(h, 'to', 'End', ['b1']);
  h.respond(() => [{ legs: [leg] }]);
  await h.get('route-search-btn').click();
  const results = h.get('route-results-list');
  Object.assign(results, { scrollTop: 400, clientHeight: 100, scrollHeight: 500 });
  await results.emit('touchstart', { touches: [{ clientY: 100, clientX: 0 }] });
  await results.emit('touchmove', { touches: [{ clientY: 80, clientX: 0 }] });
  const indicator = h.created.find(element => element.className === 'trasa-refresh-indicator trasa-later-indicator');
  assert.equal(indicator.style.height, '10px');
  // The indicator takes space from the flex child; it is temporarily no longer at the bottom.
  results.clientHeight = 80;
  let prevented = false;
  await results.emit('touchmove', {
    touches: [{ clientY: 20, clientX: 0 }], preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true);
  const before = h.calls.length;
  h.respond(() => [{ legs: [{ ...leg, tripId: 'later', departureMin: 630 }] }]);
  await results.emit('touchend', { changedTouches: [{ clientY: 20, clientX: 0 }] });
  assert.equal(h.calls.length, before + 1);
  assert.match(h.calls.at(-1).url, /&time=601$/);
  assert.equal(results.children.length, 2);
  assert.equal(results.scrollTop, 400);
  assert.equal(indicator.style.height, '0');
});

for (const leaveWhileQueued of [false, true]) {
  test(`bottom swipe queues later results behind LIVE; leave=${leaveWhileQueued}`, async () => {
    const h = await setup();
    await chooseStop(h, 'from', 'Start', ['a1']);
    await chooseStop(h, 'to', 'End', ['b1']);
    const now = Math.floor(Date.now() / 1000);
    const j = { legs: [{ ...leg, scheduledDepartureEpoch: now + 600,
      scheduledArrivalEpoch: now + 1200, departureEpoch: now + 600, arrivalEpoch: now + 1200 }] };
    h.respond(() => [j]);
    await h.get('route-search-btn').click();
    const results = h.get('route-results-list'), wrapper = results.children[0];
    Object.assign(results, { scrollTop: 400, clientHeight: 100, scrollHeight: 500 });
    const indicator = h.created.find(e => e.className === 'trasa-refresh-indicator trasa-later-indicator');
    assert.equal(indicator.textContent, 'Ładowanie…');
    let resolveLive;
    h.respond(() => new Promise(resolve => { resolveLive = resolve; }));
    for (let i = 0; i < 15; i++) [...h.intervals.values()][0]();
    await new Promise(resolve => setImmediate(resolve));
    const before = h.calls.length;
    assert.doesNotMatch(h.calls.at(-1).url, /&time=/);
    const swipe = async () => {
      await results.emit('touchstart', { touches: [{ clientY: 100, clientX: 0 }] });
      await results.emit('touchmove', { touches: [{ clientY: 20, clientX: 0 }] });
      return results.emit('touchend', { changedTouches: [{ clientY: 20, clientX: 0 }] });
    };
    const firstSwipe = swipe();
    await new Promise(resolve => setImmediate(resolve));
    const secondSwipe = swipe();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, before);
    if (leaveWhileQueued) h.planner.leavePlanner();
    h.respond(() => [{ legs: [{ ...j.legs[0], tripId: 'later', departureMin: 630,
      scheduledDepartureEpoch: now + 1800, departureEpoch: now + 1800 }] }]);
    resolveLive([j]);
    await Promise.all([firstSwipe, secondSwipe]);
    assert.equal(h.calls.length, before + (leaveWhileQueued ? 0 : 1));
    if (!leaveWhileQueued) {
      assert.match(h.calls.at(-1).url, /&time=601$/);
      assert.equal(results.children.length, 2);
      assert.equal(results.children[0], wrapper);
      assert.equal(results.scrollTop, 400);
    }
  });
}

test('top refresh and bottom pagination have separate indicators and request parameters', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Start', ['a1']);
  await chooseStop(h, 'to', 'End', ['b1']);
  const now = Math.floor(Date.now() / 1000);
  const j = { legs: [{ ...leg, scheduledDepartureEpoch: now + 600,
    scheduledArrivalEpoch: now + 1200, departureEpoch: now + 600, arrivalEpoch: now + 1200 }] };
  h.respond(() => [j]);
  await h.get('route-search-btn').click();
  const results = h.get('route-results-list'), wrapper = results.children[0];
  const top = h.created.find(e => e.className === 'trasa-refresh-indicator');
  const bottom = h.created.find(e => e.className === 'trasa-refresh-indicator trasa-later-indicator');
  assert.equal(top.textContent, 'Odświeżanie…');
  assert.equal(bottom.textContent, 'Ładowanie…');
  Object.assign(results, { scrollTop: 400, clientHeight: 100, scrollHeight: 500 });
  let resolve;
  h.respond(() => new Promise(done => { resolve = done; }));
  await results.emit('touchstart', { touches: [{ clientY: 100, clientX: 0 }] });
  let prevented = false;
  await results.emit('touchmove', { touches: [{ clientY: 99, clientX: 0 }],
    preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'claim the edge gesture before native overscroll starts');
  await results.emit('touchmove', { touches: [{ clientY: 20, clientX: 0 }] });
  assert.equal(bottom.style.height, '32px');
  assert.equal(top.style.height, '0');
  const later = results.emit('touchend', { changedTouches: [{ clientY: 20, clientX: 0 }] });
  assert.match(h.calls.at(-1).url, /&time=601$/);
  assert.equal(bottom.style.height, '24px');
  resolve([{ legs: [{ ...j.legs[0], tripId: 'later', departureMin: 630,
    scheduledDepartureEpoch: now + 1800, departureEpoch: now + 1800 }] }]);
  await later;
  assert.equal(results.children.length, 2);
  assert.equal(results.children[0], wrapper);
  assert.equal(results.scrollTop, 400);
  assert.equal(bottom.style.height, '0');
  results.scrollTop = 0;
  await results.emit('touchstart', { touches: [{ clientY: 0, clientX: 0 }] });
  await results.emit('touchmove', { touches: [{ clientY: 90, clientX: 0 }] });
  assert.equal(top.style.height, '32px');
  assert.equal(bottom.style.height, '0');
  const refresh = results.emit('touchend', { changedTouches: [{ clientY: 90, clientX: 0 }] });
  assert.doesNotMatch(h.calls.at(-1).url, /&time=/);
  assert.equal(top.style.height, '24px');
  assert.equal(bottom.style.height, '0');
  resolve([j]);
  await refresh;
  assert.equal(results.children.length, 2);
  assert.equal(results.children[0], wrapper);
});

test('bottom swipe tolerates initial finger jitter and sideways drift after claiming', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Park Bronowice', ['park-bronowice03-kn8g8']);
  await chooseStop(h, 'to', 'Lotnicza', ['lotnicza01-kyogp']);
  const now = Math.floor(Date.now() / 1000);
  const j = { legs: [{ ...leg, scheduledDepartureEpoch: now + 600,
    scheduledArrivalEpoch: now + 1200, departureEpoch: now + 600, arrivalEpoch: now + 1200 }] };
  h.respond(() => [j]);
  await h.get('route-search-btn').click();
  const results = h.get('route-results-list');
  Object.assign(results, { scrollTop: 400, clientHeight: 100, scrollHeight: 500 });
  const before = h.calls.length;
  await results.emit('touchstart', { touches: [{ clientY: 200, clientX: 100 }] });
  // A tiny initial movement down must not discard an otherwise upward swipe.
  await results.emit('touchmove', { touches: [{ clientY: 202, clientX: 103 }] });
  await results.emit('touchmove', { touches: [{ clientY: 175, clientX: 105 }] });
  // The finger then drifts sideways while continuing mostly upwards.
  await results.emit('touchmove', { touches: [{ clientY: 110, clientX: 132 }] });
  h.respond(() => [{ legs: [{ ...j.legs[0], tripId: 'later', departureMin: 630,
    scheduledDepartureEpoch: now + 1800, departureEpoch: now + 1800 }] }]);
  await results.emit('touchend', { changedTouches: [{ clientY: 110, clientX: 132 }] });
  assert.equal(h.calls.length, before + 1);
  assert.match(h.calls.at(-1).url, /&time=601$/);
  assert.equal(results.children.length, 2);
});

test('Trasa second tick updates the existing card without writing scrollTop and cancelling native smooth scroll', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Start', ['a1']);
  await chooseStop(h, 'to', 'End', ['b1']);
  const now = Math.floor(Date.now() / 1000);
  h.setNow(now * 1000);
  h.respond(() => [{ legs: [{ ...leg, scheduledDepartureEpoch: now + 600,
    scheduledArrivalEpoch: now + 1200, departureEpoch: now + 600, arrivalEpoch: now + 1200 }] }]);
  await h.get('route-search-btn').click();
  const results = h.get('route-results-list'), wrapper = results.children[0];
  let scroll = 80, writes = 0;
  Object.defineProperty(results, 'scrollTop', {
    get: () => scroll,
    set: value => { scroll = value; writes++; }, configurable: true
  });
  for (let i = 0; i < 3; i++) {
    // Native smooth scrolling changes position between successive UI updates.
    scroll += 20;
    h.setNow((now + (i + 1) * 60) * 1000);
    [...h.intervals.values()][0]();
    assert.match(wrapper.querySelector('.trasa-timer-content').innerHTML, new RegExp(`>${9 - i}<`));
    assert.match(wrapper.querySelector('.lubus-live').innerHTML, new RegExp(`>${9 - i} minut`));
  }
  assert.equal(writes, 0);
  assert.equal(results.children[0], wrapper);
});

test('presentation switch retains the result DOM and shares the existing request and polling session', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Park Akademicki', ['a1']);
  await chooseStop(h, 'to', 'Felin', ['b1']);
  h.respond(() => [{ legs: [leg] }]);
  await h.get('route-search-btn').click();
  const list = h.get('route-results-list');
  const wrapper = list.children[0], card = wrapper.children[0];
  const journeyKey = wrapper.dataset.journeyKey;
  const calls = h.calls.length;
  const intervals = [...h.intervals.keys()];
  const html = card.innerHTML;
  await h.get('trasa-presentation-new').click();
  assert.equal(list.dataset.presentation, 'new');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], wrapper);
  assert.equal(wrapper.dataset.journeyKey, journeyKey);
  assert.equal(wrapper.children[0], card);
  assert.equal(card.innerHTML, html, 'the LIVE nodes are shared verbatim');
  assert.equal(h.calls.length, calls, 'switching performs no network requests');
  assert.deepEqual([...h.intervals.keys()], intervals, 'switching creates no polling timers');
  await h.get('trasa-presentation-classic').click();
  assert.equal(list.dataset.presentation, 'classic');
  assert.equal(list.children[0], wrapper);
  assert.equal(h.calls.length, calls);
  assert.deepEqual([...h.intervals.keys()], intervals);
});

test('accordion touch scrolling never claims list refresh or pagination in either presentation', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Start', ['a1']);
  await chooseStop(h, 'to', 'End', ['b1']);
  h.respond(() => [{ legs: [leg] }]);
  await h.get('route-search-btn').click();
  const results = h.get('route-results-list');
  results.clientHeight = 100; results.scrollHeight = 500;
  const nested = { closest: selector => ['.trasa-card.fullscreen-expanded', '.trasa-middle-scroll'].includes(selector) ? {} : null };
  const calls = h.calls.length;
  for (const mode of ['classic', 'new']) {
    await h.get(`trasa-presentation-${mode}`).click();
    for (const [top, end] of [[0, 180], [400, 20]]) {
      results.scrollTop = top;
      await results.emit('touchstart', { target: nested, touches: [{ clientY: 100, clientX: 0 }] });
      let prevented = false;
      await results.emit('touchmove', { target: nested, touches: [{ clientY: end, clientX: 0 }], preventDefault() { prevented = true; } });
      await results.emit('touchend', { target: nested, changedTouches: [{ clientY: end, clientX: 0 }] });
      assert.equal(prevented, false, 'native scrolling inside the accordion must remain available');
      assert.equal(h.calls.length, calls, 'accordion scroll must not trigger list requests');
    }
  }
});

test('Nowa summary leaves list swipes available while its expanded tabs own nested scrolling', async () => {
  const h = await setup();
  await chooseStop(h, 'from', 'Start', ['a1']);
  await chooseStop(h, 'to', 'End', ['b1']);
  h.respond(() => [{ legs: [leg] }]);
  await h.get('route-search-btn').click();
  await h.get('trasa-presentation-new').click();
  const root = h.get('route-results-list');
  root.scrollTop = 400; root.clientHeight = 100; root.scrollHeight = 500;
  const summary = { closest: selector => selector === '.trasa-card.fullscreen-expanded' ? {} : null };
  let prevented = false;
  const calls = h.calls.length;
  await root.emit('touchstart', { target: summary, touches: [{ clientX: 0, clientY: 100 }] });
  await root.emit('touchmove', { target: summary, touches: [{ clientX: 0, clientY: 20 }], preventDefault() { prevented = true; } });
  await root.emit('touchend', { target: summary, changedTouches: [{ clientX: 0, clientY: 20 }] });
  assert.equal(prevented, true);
  assert.ok(h.calls.length > calls, 'bottom swipe on inline summary still loads later journeys');
});

test('Nowa consumes one live stop snapshot per leg without a parallel GPS request or timer', async () => {
  const h = await setup();
  h.setNow(1800000000000);
  await chooseStop(h, 'from', 'Start', ['a1']);
  await chooseStop(h, 'to', 'End', ['b1']);
  h.respond(() => [{ legs: [leg] }]);
  await h.get('route-search-btn').click();
  await h.get('trasa-presentation-new').click();
  const root = h.get('route-results-list'), card = root.children[0].children[0];
  card.closest = selector => selector === '#route-results-list' ? root : null;
  h.respond(url => url.includes('includeLive=true') ? {
    stops: [{stopId:'a1',stopSequence:1,name:'Start',eta:'10:00'}, {stopId:'b1',stopSequence:4,name:'End',eta:'10:10'}],
    live: {tripId:'trip-7',currentStopSequence:4,currentStatus:'STOPPED_AT',gpsTimestamp:1800000000,isFresh:true}
  } : []);
  const before = h.calls.length, timers = [...h.intervals.keys()];
  await card.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, before + 1);
  assert.match(h.calls.at(-1).url, /upcoming-stops\?fromStopId=a1&includeLive=true/);
  const timeline = card.querySelector('.trasa-middle-scroll').querySelector('.lubus-timeline');
  assert.match(timeline.innerHTML, /7 · Teraz/);
  assert.deepEqual([...h.intervals.keys()], timers);
});

test('Nowa includes real approach stops but preserves the selected boarding range and map context', async () => {
  const h = await setup(); h.setNow(1800000000000);
  await chooseStop(h, 'from', 'Start', ['a1']); await chooseStop(h, 'to', 'End', ['b1']);
  h.respond(() => [{ legs: [leg] }]); await h.get('route-search-btn').click();
  await h.get('trasa-presentation-new').click();
  const root = h.get('route-results-list'), card = root.children[0].children[0];
  card.closest = selector => selector === '#route-results-list' ? root : null;
  h.respond(() => ({ boardingStopSequence: 12,
    stops: [
      {stopId:'previous',stopSequence:1,name:'Earlier',eta:'09:50',lat:51.1,lon:22.1},
      {stopId:'current',stopSequence:4,name:'Current GPS stop',eta:'09:55',lat:51.2,lon:22.2},
      {stopId:'a1',stopSequence:12,name:'Actual boarding',eta:'10:00',lat:51.3,lon:22.3},
      {stopId:'b1',stopSequence:30,name:'Actual alighting',eta:'10:20',lat:51.4,lon:22.4}],
    live:{tripId:'trip-7',currentStopSequence:4,currentStatus:'STOPPED_AT',gpsTimestamp:1800000000,isFresh:true,lat:51.2,lon:22.2}
  }));
  const before = h.calls.length;
  await card.click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, before+1);
  assert.match(h.calls.at(-1).url, /includeLive=true&includePrevious=true/);
  const panel = card.querySelector('.trasa-middle-scroll');
  const html = panel.querySelector('.lubus-timeline').innerHTML;
  assert.match(html, /Current GPS stop/); assert.match(html, /7 · Teraz/);
  assert.doesNotMatch(html.split('data-sequence="12"')[0], /<small>Wsiądź/);
  const mapButton = panel.querySelector('.dep-expand-map-btn');
  await mapButton.click();
  assert.equal(h.maps[0][0], 'trip-7');
  assert.equal(h.maps[0][1].fromCoords[0], 22.3, 'fullscreen route still starts at boarding');
});

test('LIVE sorting waits for card alignment; manual interruption preserves the visible journey and late stops never realign', async () => {
  const h=await setup();h.setNow(1800000000000);
  await chooseStop(h,'from','Start',['a1']);await chooseStop(h,'to','End',['b1']);
  const a={...leg,departureEpoch:1800000600,scheduledDepartureEpoch:1800000600,liveObservedEpoch:1800000000};
  const b={...a,tripId:'second',departureEpoch:1800000900,scheduledDepartureEpoch:1800000900};
  let journeys=[{legs:[a]},{legs:[b]}],resolveStops;
  h.respond(url=>url.includes('upcoming-stops')?new Promise(resolve=>{resolveStops=resolve;}):journeys);
  await h.get('route-search-btn').click();await h.get('trasa-presentation-new').click();
  const root=h.get('route-results-list'),[first,second]=root.children,calls=[];
  root.offsetTop=0;root.clientHeight=100;root.scrollTop=50;
  root.scrollTo=options=>{calls.push(options);if(options.behavior==='instant')root.scrollTop=options.top;};
  root.insertBefore=(node,current)=>{
    root.children=root.children.filter(child=>child!==node);
    const index=current?root.children.indexOf(current):root.children.length;
    root.children.splice(index,0,node);root.children.forEach((child,i)=>{child.offsetTop=i*110;});
  };
  [first,second].forEach((node,i)=>{node.parentNode=root;node.offsetTop=i*110;node.offsetHeight=100;});
  const card=second.children[0];card.parentNode=second;card.closest=s=>s==='#route-results-list'?root:null;
  h.holdShortTimers(true);await card.click();
  assert.equal(root.dataset.cardAligning,'true');assert.equal(calls[0].top,110);
  journeys=[{legs:[{...a,departureEpoch:1800001000}]},{legs:[{...b,departureEpoch:1800000700}]}];
  for(let i=0;i<15;i++)for(const tick of h.intervals.values())tick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(root.children[0],first,'do not move cards during smooth alignment');
  const visibleOffset=first.offsetTop-root.scrollTop;
  await root.emit('wheel');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(root.children[0],second,'apply the queued sort once the gesture owns scrolling');
  assert.equal(first.offsetTop-root.scrollTop,visibleOffset,'preserve visible journey across the deferred sort');
  const count=calls.length;
  resolveStops({stops:[{stopId:'a1',stopSequence:1,name:'Start',eta:'10:00'}, {stopId:'b1',stopSequence:2,name:'End',eta:'10:10'}],boardingStopSequence:1,live:null});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,count,'late stop loading must not resume cancelled alignment');
  assert.equal(root.dataset.cardAligning,undefined);
});

for (const [edge, direction] of [['top',1],['bottom',-1]]) {
  test(`fitting Nowa LIVE uses the existing ${edge} swipe threshold; overflowing LIVE stays native`,async()=>{
    const h=await setup();await chooseStop(h,'from','Start',['a1']);await chooseStop(h,'to','End',['b1']);
    h.respond(()=>[{legs:[leg]}]);await h.get('route-search-btn').click();await h.get('trasa-presentation-new').click();
    const root=h.get('route-results-list');root.clientHeight=100;root.scrollHeight=500;
    const live={clientHeight:280,scrollHeight:280};
    const target={closest:s=>s==='.lubus-live'?live:['.trasa-card.fullscreen-expanded','.trasa-middle-scroll'].includes(s)?{}:null};
    async function swipe(distance){
      root.scrollTop=edge==='top'?0:400;
      const before=h.calls.length;let prevented=false;
      await root.emit('touchstart',{target,touches:[{clientX:0,clientY:100}]});
      await root.emit('touchmove',{target,touches:[{clientX:0,clientY:100+direction*distance}],preventDefault(){prevented=true;}});
      await root.emit('touchend',{target,changedTouches:[{clientX:0,clientY:100+direction*distance}]});
      return {requested:h.calls.length>before,prevented};
    }
    assert.equal((await swipe(59)).requested,false);
    assert.equal((await swipe(60)).requested,false);
    const claimed=await swipe(61);assert.equal(claimed.requested,true);assert.equal(claimed.prevented,true);
    live.scrollHeight=500;const nested=await swipe(100);assert.equal(nested.requested,false);assert.equal(nested.prevented,false);
  });
}


test('search button hides only after results and returns on either field or point action', async () => {
  const h=await setup(), button=h.get('route-search-btn');
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  assert.equal(button.dataset.collapsed,'false');
  for(const [id,event] of [['route-input-from','focus'],['route-input-to','focus'],
      ['route-input-from','input'],['route-input-to','input'],['route-clear-from','click'],['route-clear-to','click']]) {
    // Focus/action restoration must work without altering the existing search contracts.
    h.respond(url=>url.includes('/route/complex')?[{legs:[leg]}]:[]);
    await button.click();assert.equal(button.dataset.collapsed,'true');
    assert.equal(button.inert,true);assert.equal(button.ariaHidden,'true');
    if(event==='input') {
      // Keep autocomplete idle; selecting the points again belongs to the normal form flow.
      h.get(id).value='';
    }
    await h.get(id).emit(event);assert.equal(button.dataset.collapsed,'false',`${id}/${event}`);
    assert.equal(button.inert,false);assert.equal(button.ariaHidden,'false');
    await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  }
  h.planner.leavePlanner();
});

test('empty or failed searches keep the search button visible', async () => {
  const h=await setup(), button=h.get('route-search-btn');
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  for(const result of [[],{httpStatus:500},new Error('offline')]) {
    h.respond(()=>result);await button.click();assert.equal(button.dataset.collapsed,'false');
  }
  h.planner.leavePlanner();
});

test('editing during a search and subsequent LIVE refreshes never hide the search button', async () => {
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const h=await setup(),button=h.get('route-search-btn');
  await chooseStop(h,'from','Start',['a1']); await chooseStop(h,'to','End',['b1']);
  let resolve;
  h.respond(url=>url.includes('/route/complex')?new Promise(r=>{resolve=r;}):[]);
  const search=button.click();await flush();
  await h.get('route-input-to').emit('focus');
  resolve([{legs:[leg]}]);await search;
  assert.equal(button.dataset.collapsed,'false');
  h.respond(url=>url.includes('/route/complex')?[{legs:[leg]}]:[]);
  for(let i=0;i<15;i++) [...h.intervals.values()][0]?.();
  await flush();await flush();assert.equal(button.dataset.collapsed,'false');
  // A fresh explicit search is allowed to collapse it again.
  await button.click();assert.equal(button.dataset.collapsed,'true');
  h.planner.leavePlanner();
});

test('Nowa pin keeps the same card slot through LIVE sorting and unpin uses the original departure deadline', async () => {
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const h=await setup(),now=2000000000;h.setNow(now*1000);
 await chooseStop(h,'from','Start',['a1']);await chooseStop(h,'to','End',['b1']);
 const first={...leg,scheduledDepartureEpoch:now+100,departureEpoch:now+100,scheduledArrivalEpoch:now+600,arrivalEpoch:now+600,liveObservedEpoch:now};
 const second={...first,tripId:'next',scheduledDepartureEpoch:now+200,departureEpoch:now+200};
 let journeys=[{legs:[first]},{legs:[second]}];h.respond(()=>journeys);
 await h.get('route-search-btn').click();
 const root=h.get('route-results-list'),wrapper=root.children[1],card=wrapper.children[0];
 root.insertBefore=(node,current)=>{root.children=root.children.filter(n=>n!==node);const at=current?root.children.indexOf(current):root.children.length;root.children.splice(at,0,node);};
 wrapper.remove=()=>{root.children=root.children.filter(n=>n!==wrapper);};
 card.closest=()=>root;card.classList.add('fullscreen-expanded');
 const pin=wrapper.querySelector('.trasa-pin-button');
 const target={closest:s=>s==='.trasa-pin-button'?pin:null};
 let backs=0; // Pin clicks must be consumed before the accordion's open/Back path.
 card.querySelector=()=>{backs++;throw Error('pin click reached accordion');};
 const requests=h.calls.length,intervals=[...h.intervals.keys()],storage=[...h.history];
 await card.emit('click',{target});assert.equal(pin.ariaPressed,'true');assert.equal(backs,0);
 assert.equal(wrapper.classList.contains('trasa-pinned'),true);
 assert.equal(wrapper.classList.contains('trasa-departed'),false);
 assert.equal(h.calls.length,requests);assert.deepEqual([...h.intervals.keys()],intervals);assert.deepEqual([...h.history],storage);
 // A forecast would now put the pinned second card first. Its DOM slot stays put.
 journeys=[{legs:[{...first,departureEpoch:now+300}]},{legs:[{...second,departureEpoch:now+50}]}];
 for(let i=0;i<15;i++) [...h.intervals.values()][0]();await flush();await flush();
 assert.equal(root.children[1],wrapper);assert.equal(pin.ariaPressed,'true');
 assert.equal(wrapper.journey.legs[0].departureEpoch,now+50,'LIVE forecast updated before departure');
 h.setNow((now+60)*1000);[...h.intervals.values()][0]();
 assert.equal(wrapper.classList.contains('trasa-departed'),true,'departure detected at +60');
 assert.equal(wrapper.classList.contains('trasa-pinned'),true,'departure retains the contrast exemption');
 assert.match(wrapper.querySelector('.trasa-timer-content').innerHTML,/>ODJAZD</);
 h.setNow((now+121)*1000);[...h.intervals.values()][0]();
 assert.equal(root.children[1],wrapper);assert.equal(wrapper.classList.contains('trasa-result-exit'),false);
 await card.emit('click',{target});assert.equal(pin.ariaPressed,'false');
 assert.equal(wrapper.classList.contains('trasa-pinned'),false,'unpin restores ordinary departed styling');
 assert.equal(wrapper.classList.contains('trasa-result-exit'),true,'unpin marks the overdue card for removal');
 assert.equal(root.children.includes(wrapper),false,'unpin after the grace period removes the card');
 assert.equal(backs,0);h.planner.leavePlanner();
});

test('pins are unavailable to classic/collapsed cards, survive screen visits and end on a new search or manual unpin', async () => {
 const h=await setup(),now=2000000000;h.setNow(now*1000);
 await chooseStop(h,'from','Start',['a1']);await chooseStop(h,'to','End',['b1']);
 const j={legs:[{...leg,scheduledDepartureEpoch:now+10,departureEpoch:now+10,scheduledArrivalEpoch:now+600,arrivalEpoch:now+600,liveObservedEpoch:now}]};
 h.respond(()=>[j]);await h.get('route-search-btn').click();
 const root=h.get('route-results-list');
 function controls(wrapper) {
  const card=wrapper.children[0],pin=wrapper.querySelector('.trasa-pin-button');card.closest=()=>root;
  wrapper.remove=()=>{root.children=root.children.filter(n=>n!==wrapper);};
  return {card,pin,toggle:()=>card.emit('click',{target:{closest:s=>s==='.trasa-pin-button'?pin:null}})};
 }
 let c=controls(root.children[0]);await c.toggle();assert.equal(c.pin.ariaPressed,'false','collapsed card cannot pin');
 c.card.classList.add('fullscreen-expanded');root.dataset.presentation='classic';
 await c.toggle();assert.equal(c.pin.ariaPressed,'false','classic cannot pin');
 root.dataset.presentation='new';await c.toggle();assert.equal(c.pin.ariaPressed,'true');
 const original=root.children[0];await h.get('route-search-btn').click();
 assert.notEqual(root.children[0],original);c=controls(root.children[0]);assert.equal(c.pin.ariaPressed,'false');
 c.card.classList.add('fullscreen-expanded');await c.toggle();assert.equal(c.pin.ariaPressed,'true');
 h.planner.leavePlanner();h.planner.enterPlanner();
 assert.equal(c.pin.ariaPressed,'true','screen visits preserve the pin before departure');
 h.setNow((now+11)*1000);[...h.intervals.values()][0]();
 h.setNow((now+100)*1000);[...h.intervals.values()][0]();assert.equal(root.children.length,1);
 h.planner.leavePlanner();assert.equal(h.intervals.size,0);
 h.planner.enterPlanner();
 assert.equal(root.children.length,1,'returning to Trasa keeps the pinned journey after departure');
 assert.equal(c.pin.ariaPressed,'true');
 await c.toggle();assert.equal(root.children.length,0,'manual unpin still restores expiration after return');
 h.planner.leavePlanner();
});
