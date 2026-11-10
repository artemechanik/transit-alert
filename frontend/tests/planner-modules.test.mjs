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
  let timelines = [], clockNow = null;
  class PlannerTestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clockNow ?? Date.now()])); }
    static now() { return clockNow ?? Date.now(); }
  }
  let nextTimer = 0; const intervals = new Map(), created = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let responder = () => [], position = { lat: 51.24, lon: 22.57 };
  const context = {
    console, Date: PlannerTestDate, AbortController,
    setTimeout: (fn, delay) => { if (delay < 5000) { fn(); return 0; } const id = ++nextTimer; timers.set(id, fn); return id; },
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
  assert.match(html,/class="trasa-row"[^]*?class="stop-name"[^]*?<span class="trasa-transfer-warn" hidden style="color: var\(--danger\); font-weight: 700;">⚠ <\/span>➔/);
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
  const corrected={legs:j.legs.map(l=>l===first?{...l,departureEpoch:now+600,departureMin:610}:l)};
  h.respond(()=>[corrected]);
  const results=h.get('route-results-list'); results.scrollTop=0; results.clientHeight=100; results.scrollHeight=500;
  await results.emit('touchstart',{touches:[{clientY:0,clientX:0}]});
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
