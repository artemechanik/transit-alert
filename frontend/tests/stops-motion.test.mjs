import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup(base = 0) {
  const elements = new Map(), timers = new Map(), intervals = [], scrolls = [];
  let timerId = 0, responder;
  class Element {
    constructor() {
      this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.className = '';
      this.scrollTop = 0; this.clientHeight = 300; this.offsetHeight = 100; this.value = '';
      this.classList = { contains: c => this.className.split(' ').includes(c),
        add: c => { if (!this.classList.contains(c)) this.className += ' ' + c; },
        remove: c => { this.className = this.className.split(' ').filter(x => x !== c).join(' '); } };
    }
    set innerHTML(value) { this.html = value; this.children.forEach(c => { c.parentNode = null; }); this.children = []; }
    get innerHTML() { return this.html || ''; }
    get isConnected() { return !!this.id || !!this.parentNode?.isConnected; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1]; }
    get scrollHeight() { return this.children.length * 100; }
    get offsetTop() { return this.parentNode?.children?.indexOf(this) * 100 || 0; }
    get offsetParent() { return this.parentNode?.children ? this.parentNode : null; }
    getBoundingClientRect() { return { top: this.offsetTop, bottom: this.offsetTop + 100 }; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    async emit(name, args = {}) { for (const fn of this.listeners[name] || []) await fn({ target: this, ...args }); }
    appendChild(child) { child.parentNode = this; this.children.push(child); }
    insertBefore(child) { this.appendChild(child); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      const classes = selector.split('.').filter(Boolean), matches = [];
      for (const child of this.children) {
        if (classes.every(c => child.classList.contains(c))) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
    contains() { return false; }
    scrollTo(options) { scrolls.push(options); }
    scrollIntoView(options) { scrolls.push({ panel: true, ...options }); }
  }
  const host = new Element(); host.id = 'host';
  const get = id => {
    if (!elements.has(id)) { const node = new Element(); node.id = id; host.appendChild(node); elements.set(id, node); }
    return elements.get(id);
  };
  const initial = Array.from({ length: 8 }, (_, i) => ({ route: '7', scheduledTime: `12:${String(i).padStart(2, '0')}`,
    minutesLeft: base + i + 1, tripId: `trip${i}`, direction: 'Felin', isRealTime: false }));
  responder = url => url.includes('/stops/search') ? [{ stopId: 'stop', name: 'Park Bronowice', code: '03' }] : initial;
  const { createStops } = await loadBrowserModule(new URL('../js/stops.js', import.meta.url), {
    console, localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: get, createElement: () => new Element(), addEventListener() {},
      querySelectorAll: selector => host.querySelectorAll(selector) },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: fn => { intervals.push(fn); return intervals.length; },
    fetch: async url => ({ ok: true, json: async () => responder(url) })
  });
  const stops = createStops({ apiBaseUrl: '/api', locationService: {}, getNearbyStops() {},
    showVehicleOnMap() {}, onAccordionOpen() {}, onBack() {} });
  stops.initStops();
  const input = get('stop-screen-search'); input.value = 'Park'; await input.emit('input');
  await get('stop-screen-suggestions').children[0].emit('click'); await flush();
  const root = get('departures-list'); root.scrollTop = 500;
  const more = [8, 9, 10].map(i => ({ ...initial[0], tripId: `trip${i}`, scheduledTime: `12:${i}`, minutesLeft: base + i + 1 }));
  responder = () => more;
  await root.emit('touchstart', { touches: [{ clientY: 200 }] });
  await root.emit('touchmove', { touches: [{ clientY: 100 }] });
  await root.emit('touchend', { changedTouches: [{ clientY: 100 }] });
  const run = async ms => {
    for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { root, initial, intervals, scrolls, run, respond: fn => { responder = fn; } };
}

test('Przystanek retains DOM while LIVE arrives during pagination and applies it after scrollend', async () => {
  const h = await setup();
  const wrapper = h.root.children[0];
  h.respond(() => h.initial);
  h.intervals[0](); await flush();
  assert.equal(h.root.children[0], wrapper, 'LIVE must not rebuild a moving list');
  await h.run(220);
  assert.equal(h.scrolls.at(-1).behavior, 'smooth');
  assert.equal(h.root.children[0], wrapper);
  await h.root.emit('scrollend'); await flush();
  assert.notEqual(h.root.children[0], wrapper, 'deferred LIVE is applied after movement');
});

test('accordion stops native pagination and keeps LIVE deferred through its own scroll', async () => {
  const h = await setup();
  await h.run(220);
  const wrapper = h.root.children[0], card = wrapper.children[0];
  h.respond(url => url.includes('upcoming-stops') ? [] : h.initial);
  const opening = card.emit('click'); await flush();
  assert.equal(h.scrolls.at(-1).behavior, 'instant', 'opening cancels the active native auto-scroll');
  h.intervals[0](); await flush();
  assert.equal(h.root.children[0], wrapper);
  await h.run(150); await opening;
  assert.equal(h.scrolls.at(-1).panel, true);
  assert.equal(h.root.children[0], wrapper, 'LIVE still waits for the accordion scroll');
  await h.root.emit('scrollend'); await flush();
  assert.notEqual(h.root.children[0], wrapper);
  assert.equal(h.root.querySelector('.dep-card.open')?.dataset.depKey, card.dataset.depKey);
});

for (const base of [0, 26, 60]) {
  test(`upper swipe adds older departures regardless of API offset sign: base=${base}`, async () => {
    const h = await setup(base);
    await h.run(220); await h.root.emit('scrollend');
    assert.equal(h.root.children[0].dataset.motionKey, '7-12:00');
    const before = h.scrolls.length;
    const older = [-3, -2, -1].map(i => ({ ...h.initial[0], tripId: `old${i}`,
      scheduledTime: `11:${60 + i}`, minutesLeft: base + i }));
    h.respond(() => older);
    h.root.scrollTop = 0;
    await h.root.emit('touchstart', { touches: [{ clientY: 100 }] });
    await h.root.emit('touchmove', { touches: [{ clientY: 200 }] });
    await h.root.emit('touchend', { changedTouches: [{ clientY: 200 }] });
    assert.equal(h.root.children[0].dataset.motionKey, '7-11:57');
    await h.run(220);
    assert.equal(h.scrolls.length, before + 1);
    assert.equal(h.scrolls.at(-1).behavior, 'smooth');
    await h.root.emit('scrollend');
    const after = h.scrolls.length;
    // An empty page must not pretend that it added cards or auto-scroll again.
    h.respond(() => []); h.root.scrollTop = 0;
    await h.root.emit('touchstart', { touches: [{ clientY: 100 }] });
    await h.root.emit('touchmove', { touches: [{ clientY: 200 }] });
    await h.root.emit('touchend', { changedTouches: [{ clientY: 200 }] });
    await h.run(220);
    assert.equal(h.scrolls.length, after);
  });
}

test('multiple later pages preserve the initial departures and history preserves the far end', async () => {
  const h = await setup();
  await h.run(220); await h.root.emit('scrollend');
  const key = node => node.dataset.motionKey;
  assert.equal(h.root.children.length, 11);
  assert.equal(key(h.root.children[0]), '7-12:00');
  for (const start of [11, 14]) {
    const more = Array.from({ length: 3 }, (_, i) => ({ ...h.initial[0],
      scheduledTime: `12:${start + i}`, tripId: `trip${start + i}`, minutesLeft: start + i + 1 }));
    h.respond(() => more);
    h.root.scrollTop = h.root.scrollHeight - h.root.clientHeight;
    await h.root.emit('touchstart', { touches: [{ clientY: 200 }] });
    await h.root.emit('touchmove', { touches: [{ clientY: 100 }] });
    await h.root.emit('touchend', { changedTouches: [{ clientY: 100 }] });
    await h.run(220); await h.root.emit('scrollend');
    assert.equal(key(h.root.children[0]), '7-12:00');
  }
  assert.equal(h.root.children.length, 17);
  h.root.scrollTop = 0; // Returning to the start needs no extra request.
  assert.equal(h.root.children[0].children[0].dataset.tripId, 'trip0');
  const older = [-3, -2, -1].map(i => ({ ...h.initial[0], tripId: `old${i}`,
    scheduledTime: `11:${60 + i}`, minutesLeft: i }));
  h.respond(() => older);
  await h.root.emit('touchstart', { touches: [{ clientY: 100 }] });
  await h.root.emit('touchmove', { touches: [{ clientY: 200 }] });
  await h.root.emit('touchend', { changedTouches: [{ clientY: 200 }] });
  await h.run(220); await h.root.emit('scrollend');
  assert.equal(h.root.children.length, 20);
  assert.equal(key(h.root.children.at(-1)), '7-12:16');
  h.respond(() => h.initial);
  h.intervals[0](); await flush();
  assert.equal(h.root.children.length, 20);
  assert.equal(key(h.root.children[0]), '7-11:57');
  assert.equal(key(h.root.children.at(-1)), '7-12:16');
});
