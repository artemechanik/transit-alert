import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
async function setup() {
    const now = Math.floor(Date.now()/1000);
    let theme = 'light', maps = [], markers = [], observers = [];
    const canvas = { clientWidth: 400, clientHeight: 240 }, message = {}, root = { dataset: { presentation: 'new' } };
    const panel = { dataset: { lubusTab: 'live' }, closest: () => root,
        querySelector: s => s === '.lubus-map-canvas' ? canvas : message };
    let segment = { leg: { tripId: 'trip', route: '7' }, stops: [] };
    segment.stops.live = { tripId: 'trip', lat: 51.2, lon: 22.5, gpsTimestamp: now, isFresh: true };
    class Map {
        constructor(options) { this.options = options; this.resizes = 0; maps.push(this); }
        addControl() {} resize() { this.resizes++; } remove() { this.removed = true; }
        jumpTo(options) { this.center = options.center; this.cameraMoves = (this.cameraMoves || 0) + 1; } setStyle(style) { this.style = style; }
    }
    class Marker {
        constructor(options) { this.options = options; markers.push(this); }
        setLngLat(coords) { this.coords = coords; return this; }
        addTo(map) { this.map = map; return this; } remove() { this.removed = true; }
    }
    class Observer {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {} disconnect() { this.disconnected = true; }
    }
    const m = await loadBrowserModule(new URL('../js/planner-inline-map.js', import.meta.url), {
        Date, ResizeObserver: Observer, MutationObserver: Observer,
        document: { documentElement: {}, createElement: () => ({}) }
    });
    const services = { maplibregl: { Map, Marker }, getMapTilerKey: () => 'key',
        themeService: { getEffectiveTheme: () => theme, mapStyleFor: value => `style-${value}.json` } };
    const controller = m.createEmbeddedTripMap({ panel, services, getSegment: () => segment });
    return { m, controller, panel, root, canvas, message, maps, markers, observers, segment,
        setTheme: value => { theme = value; } };
}

test('map is lazy, shares GPS observations, resizes and changes style without rebuilding', async () => {
    const h = await setup(); h.controller.sync(); assert.equal(h.maps.length, 0);
    h.panel.dataset.lubusTab = 'map'; h.controller.sync();
    assert.equal(h.maps.length, 1); assert.equal(h.maps[0].options.container, h.canvas);
    assert.equal(h.maps[0].options.style, 'style-light.json');
    assert.equal(h.maps[0].options.transformRequest('https://api.maptiler.com/{key}').url, 'https://api.maptiler.com/key');
    h.segment.stops.live.lon = 22.6; h.controller.sync();
    assert.equal(h.maps.length, 1); assert.equal(h.markers.length, 1); assert.equal(h.markers[0].coords[0], 22.6);
    h.setTheme('dark'); h.observers[1].callback(); assert.equal(h.maps[0].style, 'style-dark.json');
    const count = h.maps[0].resizes; h.canvas.clientWidth = 450; h.observers[0].callback(); assert.ok(h.maps[0].resizes > count);
});

test('missing stale future or mismatched GPS cannot create a marker; recovery uses the same map', async () => {
    const h = await setup(); h.panel.dataset.lubusTab = 'map';
    const live = h.segment.stops.live;
    for (const patch of [{ lat: null }, { gpsTimestamp: 1 }, { gpsTimestamp: Date.now()/1000+50 }, { tripId: 'wrong' }]) {
        h.segment.stops.live = { ...live, ...patch }; h.controller.sync();
        assert.equal(h.maps.length, 0); assert.equal(h.markers.length, 0); assert.equal(h.message.hidden, false);
    }
    h.segment.stops.live = live; h.controller.sync(); assert.equal(h.maps.length, 1);
    live.isFresh = false; h.controller.sync(); assert.equal(h.markers[0].removed, true);
    live.isFresh = true; h.controller.sync(); assert.equal(h.maps.length, 1); assert.equal(h.markers.length, 2);
});

test('mode change tab closure and disposal release map marker and observers', async () => {
    const h = await setup(); h.panel.dataset.lubusTab = 'map'; h.controller.sync();
    h.root.dataset.presentation = 'classic'; h.controller.sync();
    assert.equal(h.maps[0].removed, true); assert.ok(h.observers.every(o => o.disconnected));
    h.root.dataset.presentation = 'new'; h.controller.sync(); assert.equal(h.maps.length, 2);
    h.panel.dataset.lubusTab = 'journey'; h.controller.sync(); assert.equal(h.maps[1].removed, true);
    h.panel.dataset.lubusTab = 'map'; h.controller.sync(); h.controller.destroy(); h.controller.destroy();
    assert.equal(h.maps[2].removed, true); assert.equal(h.markers[2].removed, true);
});

test('routine LIVE updates and GPS loss do not resize or recenter an unchanged map', async () => {
    const h = await setup(); h.panel.dataset.lubusTab = 'map'; h.controller.sync();
    const map = h.maps[0], resizes = map.resizes, cameraMoves = map.cameraMoves;
    // A gesture owns the camera while the existing one-second tick updates LIVE.
    for (let i=0;i<20;i++) {
        h.segment.stops.live.lon += 0.001;
        h.controller.sync();
    }
    assert.equal(map.resizes, resizes, 'GPS ticks must not reset the canvas/transform');
    assert.equal(map.cameraMoves, cameraMoves, 'GPS updates must not reclaim the camera');
    h.segment.stops.live.isFresh = false; h.controller.sync();
    assert.equal(map.resizes, resizes);
    h.segment.stops.live.isFresh = true; h.controller.sync();
    assert.equal(map.resizes, resizes); assert.equal(map.cameraMoves, cameraMoves);
    h.observers[0].callback(); assert.equal(map.resizes, resizes, 'initial/duplicate observer notification is harmless');
    h.canvas.clientHeight = 260; h.observers[0].callback(); assert.equal(map.resizes, resizes+1);
    h.controller.sync(); h.observers[0].callback(); assert.equal(map.resizes, resizes+1);
    h.segment.leg.tripId = 'explicit-selection'; h.segment.stops.live.tripId = 'explicit-selection'; h.controller.sync();
    assert.equal(map.cameraMoves, cameraMoves+1, 'explicit segment selection may center its bus');
});

test('size checking remains available through the existing tick if an observer notification is delayed', async () => {
    const h = await setup(); h.panel.dataset.lubusTab = 'map'; h.controller.sync();
    const count = h.maps[0].resizes;
    h.canvas.clientWidth = 500; h.controller.sync(); assert.equal(h.maps[0].resizes, count+1);
    h.controller.sync(); assert.equal(h.maps[0].resizes, count+1);
});
