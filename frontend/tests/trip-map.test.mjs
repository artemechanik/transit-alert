import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/trip-map.js', import.meta.url), 'utf8')
  .replace("import { apiFetch } from './backend-connection.js';", 'const apiFetch = (...args) => fetch(...args);')
  .replace('export function createTripMap', 'function createTripMap');
const vehicle = { route: '153', lat: 51.24, lon: 22.54, bearing: 90 };
const ok = (data = vehicle) => ({ ok: true, status: 200, json: async () => data });
const missing = { ok: false, status: 404 };

function setup(responses) {
  const timers = [], intervals = [], maps = [], animations = [], cancelled = [];
  const modal = { style: {} }, title = {};
  let requests = 0;
  let theme = 'light';
  class Marker {
    constructor({ element }) { this.element = element; }
    setLngLat(position) { this.position = position; return this; }
    getLngLat() { return this.position; }
    getElement() { return this.element; }
    addTo(map) { this.map = map; map.markers.add(this); return this; }
    remove() { this.map.markers.delete(this); }
  }
  class TrackingMap {
    constructor(options) {
      this.markers = new Set(); this.handlers = {}; this.cameraMoves = 0;
      this.staticElements = { route: {}, stops: {} };
      this.style = options.style; this.styleReady = true;
      this.sources = new Map(); this.layers = new Map(); this.styleChanges = 0;
      maps.push(this);
    }
    on(event, callback) { this.handlers[event] = callback; }
    addControl() {}
    getBearing() { return 0; }
    jumpTo() { this.cameraMoves++; }
    cameraForBounds() { return {}; }
    isStyleLoaded() { return this.styleReady; }
    setStyle(style) {
      this.style = style; this.styleReady = false; this.styleChanges++;
      this.sources.clear(); this.layers.clear();
    }
    getSource(id) { return this.sources.get(id); }
    addSource(id, source) {
      assert.equal(this.sources.has(id), false);
      this.sources.set(id, { ...source, setData(data) { this.data = data; } });
    }
    addLayer(layer) {
      assert.equal(this.layers.has(layer.id), false);
      this.layers.set(layer.id, layer);
    }
    setPaintProperty(id, key, value) { this.layers.get(id).paint[key] = value; }
    remove() { this.removed = true; }
  }
  const context = {
    AbortController, performance: { now: () => 5000 }, console: { warn() {}, error() {} },
    setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
    setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {},
    document: {
      getElementById: id => id === 'vehicle-modal' ? modal : title,
      createElement: () => {
        const arrow = { dataset: {}, style: {} };
        return { className: '', innerHTML: '', querySelector: () => arrow };
      },
    },
    fetch: async () => {
      requests++;
      const response = responses.shift();
      assert.notEqual(response, undefined, 'unexpected request');
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response() : response;
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const api = context.createTripMap({
    maplibregl: {
      Map: TrackingMap, Marker, NavigationControl: class {},
      LngLatBounds: class { extend() { return this; } },
    },
    locationService: { getPosition: () => ({ lat: 51.25, lon: 22.55 }) },
    themeService: { getEffectiveTheme: () => theme, mapStyleFor: value => `style-${value}.json` },
    animation: {
      MOVE_SMOOTHING: 0.4, MOVE_MIN_MS: 1000, MOVE_MAX_MS: 20000,
      animateMarkerTo: (marker, position, duration, follow) => {
        animations.push({ marker, position, duration }); marker.setLngLat(position); follow(position);
      },
      cancelMarkerAnimation: marker => cancelled.push(marker),
    },
    apiBaseUrl: '', getMapTilerKey: () => '', showToast() {}, onOpen() {},
    refreshMapVehicleArrows: map => {
      for (const marker of map.markers) {
        if (marker.element.className === 'vehicle-marker-icon') {
          const arrow = marker.element.querySelector();
          arrow.style.transform = `rotate(${arrow.dataset.bearing}deg)`;
        }
      }
    },
  });
  return {
    api, maps, modal, animations, cancelled,
    get requests() { return requests; },
    vehicles: () => [...maps.at(-1).markers].filter(m => m.element.className === 'vehicle-marker-icon'),
    async open(trip = 'trip', routeContext) { await api.showVehicleOnMap(trip, routeContext); timers.shift()(); },
    theme(value) { theme = value; api.handleThemeChange(); },
    styleLoaded() { const map = maps.at(-1); map.styleReady = true; map.handlers['style.load'](); },
    poll: () => intervals.at(-1)(),
  };
}

test('200 → 404 removes only the vehicle and cancels its animation', async () => {
  const h = setup([ok(), missing]); await h.open();
  const map = h.maps[0], staticElements = map.staticElements, marker = h.vehicles()[0];
  marker._anim = {};
  await h.poll();
  assert.equal(h.vehicles().length, 0);
  assert.equal(map.markers.size, 1); // user marker remains
  assert.equal(map.staticElements, staticElements);
  assert.equal(map.removed, undefined);
  assert.equal(h.modal.style.display, 'flex');
  assert.equal(marker._anim, null);
  assert.deepEqual(h.cancelled, [marker]);
});

test('200 → 404 → 200 restores one marker and resumes normal updates', async () => {
  const updated = { ...vehicle, lon: 22.56, bearing: 180 };
  const h = setup([ok(), missing, ok(updated), ok(updated)]); await h.open();
  const original = h.vehicles()[0];
  await h.poll(); await h.poll();
  assert.equal(h.vehicles().length, 1);
  assert.notEqual(h.vehicles()[0], original);
  assert.equal(h.vehicles()[0].position[0], updated.lon);
  await h.poll();
  assert.equal(h.vehicles().length, 1);
  assert.equal(h.animations.length, 1);
  assert.equal(h.vehicles()[0].element.querySelector().style.transform, 'rotate(180deg)');
});

test('200 → 200 preserves the marker, smoothing and camera following', async () => {
  const h = setup([ok(), ok({ ...vehicle, lon: 22.56, bearing: 45 })]); await h.open();
  const marker = h.vehicles()[0], moves = h.maps[0].cameraMoves;
  await h.poll();
  assert.equal(h.vehicles()[0], marker);
  assert.equal(h.animations.length, 1);
  assert.equal(h.animations[0].duration, 400);
  assert.equal(h.maps[0].cameraMoves, moves + 1);
  assert.equal(marker.element.querySelector().dataset.bearing, 45);
});

for (const [name, response] of [
  ['network error', new Error('offline')], ['HTTP 500', { ok: false, status: 500 }],
]) {
  test(`200 → ${name} retains the current marker`, async () => {
    const h = setup([ok(), response]); await h.open(); const marker = h.vehicles()[0];
    await h.poll(); assert.equal(h.vehicles()[0], marker); assert.equal(h.cancelled.length, 0);
  });
}

test('manual camera interaction remains respected after marker recovery', async () => {
  const h = setup([ok(), missing, ok()]); await h.open();
  h.maps[0].handlers.dragstart({ originalEvent: {} });
  const moves = h.maps[0].cameraMoves;
  await h.poll(); await h.poll();
  assert.equal(h.maps[0].cameraMoves, moves);
  assert.equal(h.vehicles().length, 1);
});

test('polling serializes requests so an older response cannot overtake a newer 404', async () => {
  let resolve;
  const h = setup([ok(), () => new Promise(r => { resolve = r; }), missing]); await h.open();
  const pending = h.poll(); await h.poll();
  assert.equal(h.requests, 2);
  resolve(ok()); await pending; await h.poll();
  assert.equal(h.vehicles().length, 0);
});

test('an old session response cannot resurrect a marker after the new session received 404', async () => {
  let resolve;
  const h = setup([ok(), () => new Promise(r => { resolve = r; }), ok(), missing]);
  await h.open('old'); const pending = h.poll();
  await h.open('new'); await h.poll();
  resolve(ok()); await pending;
  assert.equal(h.maps[0].removed, true);
  assert.equal(h.maps[1].removed, undefined);
  assert.equal(h.vehicles().length, 0);
});

test('closing the modal prevents even a queued polling callback from requesting positions', async () => {
  const h = setup([ok()]);
  await h.open();
  h.api.closeVehicleMapModal();
  await h.poll();
  assert.equal(h.requests, 1);
  assert.equal(h.maps[0].removed, true);
  assert.equal(h.modal.style.display, 'none');
});

const stops = [[22.54, 51.24], [22.55, 51.25], [22.56, 51.26]];
const shape = { routes: [{ geometry: { type: 'LineString', coordinates: stops } }] };
const flush = () => new Promise(resolve => setImmediate(resolve));

test('theme preserves map, markers, camera and polling; restores Trasa layers without new requests', async () => {
  const h = setup([ok(), ok(stops), ok(shape), ok({ ...vehicle, lon: 22.55 })]);
  await h.open('trip', { mode: 'trasa', fromCoords: stops[0], toCoords: stops[2] });
  const map = h.maps[0], marker = h.vehicles()[0], moves = map.cameraMoves;
  h.styleLoaded(); map.handlers.load(); await flush();
  assert.equal(map.sources.size, 3); assert.equal(map.layers.size, 3);
  const geometry = map.getSource('route-shape').data;
  const requestCount = h.requests;
  map.handlers.dragstart({ originalEvent: {} });
  h.theme('dark');
  assert.equal(map.style, 'style-dark.json'); assert.equal(map.removed, undefined);
  assert.equal(h.maps.length, 1); assert.equal(h.vehicles()[0], marker);
  assert.equal(map.markers.size, 2); assert.equal(map.cameraMoves, moves);
  assert.equal(h.modal.style.display, 'flex');
  h.styleLoaded();
  assert.equal(map.sources.size, 3); assert.equal(map.layers.size, 3);
  assert.deepEqual(map.getSource('route-shape').data, geometry);
  assert.equal(h.requests, requestCount);
  await h.poll(); assert.equal(h.animations.length, 1);
  assert.equal(map.cameraMoves, moves); // manual camera state survived
  h.theme('dark'); assert.equal(map.styleChanges, 1);
});

test('rapid theme changes restore layers once for the current style and ignore a closed map', async () => {
  const h = setup([ok(), ok(stops), ok(shape)]); await h.open();
  const map = h.maps[0]; h.styleLoaded(); map.handlers.load(); await flush();
  h.theme('dark'); h.theme('light'); h.theme('dark');
  map.handlers['style.load'](); // superseded style event while latest style is not ready
  assert.equal(map.sources.size, 0);
  h.styleLoaded(); h.styleLoaded();
  assert.equal(map.sources.size, 2); assert.equal(map.layers.size, 2);
  assert.equal(h.requests, 3);
  h.theme('light'); h.api.closeVehicleMapModal(); h.styleLoaded();
  assert.equal(map.sources.size, 0); assert.equal(h.modal.style.display, 'none');
});

test('geometry arriving during style loading is cached until the new style is ready', async () => {
  let resolve;
  const h = setup([ok(), ok(stops), () => new Promise(r => { resolve = r; })]);
  await h.open(); h.styleLoaded(); h.maps[0].handlers.load(); await flush();
  h.theme('dark'); resolve(ok(shape)); await flush();
  assert.equal(h.maps[0].sources.size, 0);
  h.styleLoaded(); assert.equal(h.maps[0].sources.size, 2);
  assert.equal(h.requests, 3);
});

test('geometry arriving after closing during theme loading cannot revive the map', async () => {
  let resolve;
  const h = setup([ok(), ok(stops), () => new Promise(r => { resolve = r; })]);
  await h.open(); h.styleLoaded(); h.maps[0].handlers.load(); await flush();
  h.theme('dark'); h.api.closeVehicleMapModal(); resolve(ok(shape)); await flush();
  h.styleLoaded(); assert.equal(h.maps[0].sources.size, 0);
  assert.equal(h.maps[0].removed, true);
});

test('initial route renders when style.load preceded source readiness', async () => {
  const h = setup([ok(), ok(stops), ok(shape)]); await h.open();
  const map = h.maps[0];
  map.styleReady = false; map.handlers['style.load']();
  map.styleReady = true; map.handlers.load(); await flush();
  assert.equal(map.sources.size, 2);
  assert.equal(map.layers.size, 2);
  assert.equal(h.requests, 3);
});

test('idle retries pending route after source readiness without repeated rendering or requests', async () => {
  const h = setup([ok(), ok(stops), ok(shape)]);
  await h.open('trip', { mode: 'trasa', fromCoords: stops[0], toCoords: stops[2] });
  const map = h.maps[0];
  map.styleReady = false; map.handlers['style.load']();
  map.handlers.load(); await flush();
  assert.equal(map.sources.size, 0);
  map.styleReady = true; map.handlers.idle();
  assert.equal(map.sources.size, 3); assert.equal(map.layers.size, 3);
  const route = map.getSource('route-shape');
  route.setData = () => assert.fail('idle must not redraw a rendered route');
  map.handlers.idle(); map.handlers['style.load']();

  h.theme('dark'); map.handlers['style.load']();
  assert.equal(map.sources.size, 0);
  map.styleReady = true; map.handlers.idle();
  assert.equal(map.sources.size, 3); assert.equal(map.layers.size, 3);
  map.getSource('route-shape').setData = () => assert.fail('route must render only once per style');
  map.handlers.idle();
  assert.equal(h.requests, 3);
  assert.equal(h.maps.length, 1);
});

test('closing cancels pending rendering even when idle arrives later', async () => {
  const h = setup([ok(), ok(stops), ok(shape)]); await h.open();
  const map = h.maps[0]; map.styleReady = false;
  map.handlers['style.load'](); map.handlers.load(); await flush();
  h.api.closeVehicleMapModal(); map.styleReady = true; map.handlers.idle();
  assert.equal(map.sources.size, 0);
  assert.equal(map.removed, true);
});
