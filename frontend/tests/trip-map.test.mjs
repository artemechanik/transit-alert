import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../js/trip-map.js', import.meta.url), 'utf8')
  .replace('export function createTripMap', 'function createTripMap');
const vehicle = { route: '153', lat: 51.24, lon: 22.54, bearing: 90 };
const ok = (data = vehicle) => ({ ok: true, status: 200, json: async () => data });
const missing = { ok: false, status: 404 };

function setup(responses) {
  const timers = [], intervals = [], maps = [], animations = [], cancelled = [];
  const modal = { style: {} }, title = {};
  let requests = 0;
  class Marker {
    constructor({ element }) { this.element = element; }
    setLngLat(position) { this.position = position; return this; }
    getLngLat() { return this.position; }
    getElement() { return this.element; }
    addTo(map) { this.map = map; map.markers.add(this); return this; }
    remove() { this.map.markers.delete(this); }
  }
  class TrackingMap {
    constructor() {
      this.markers = new Set(); this.handlers = {}; this.cameraMoves = 0;
      this.staticElements = { route: {}, stops: {} };
      maps.push(this);
    }
    on(event, callback) { this.handlers[event] = callback; }
    addControl() {}
    getBearing() { return 0; }
    jumpTo() { this.cameraMoves++; }
    cameraForBounds() { return {}; }
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
    themeService: { getEffectiveTheme: () => 'light', mapStyleFor: () => ({}) },
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
    async open(trip = 'trip') { await api.showVehicleOnMap(trip); timers.shift()(); },
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
