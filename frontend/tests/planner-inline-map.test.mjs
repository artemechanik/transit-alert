import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
async function setup() {
    const now = Math.floor(Date.now()/1000);
    let clock = 0;
    let animations = [], cancelled = [];
    let theme = 'light', maps = [], markers = [], observers = [], requests = [], renders = [];
    const canvas = { clientWidth: 400, clientHeight: 240 }, message = {}, root = { dataset: { presentation: 'new' } };
    const panel = { dataset: { lubusTab: 'live' }, closest: () => root,
        querySelector: s => s === '.lubus-map-canvas' ? canvas : message };
    let segment = { leg: { tripId: 'trip', route: '7' }, stops: [] };
    segment.stops.live = { tripId: 'trip', lat: 51.2, lon: 22.5, gpsTimestamp: now, isFresh: true };
    class Map {
        constructor(options) { this.options = options; this.resizes = 0; this.handlers = {}; this.sources = new globalThis.Map(); this.layers = new globalThis.Map(); this.ready = true; this.bearing = 0; maps.push(this); }
        on(event, callback) { this.handlers[event] = callback; }
        getBearing() { return this.bearing; }
        isStyleLoaded() { return this.ready; }
        getLayer(id) { return this.layers.get(id); }
        removeLayer(id) { this.layers.delete(id); }
        getSource(id) { return this.sources.get(id); }
        removeSource(id) { this.sources.delete(id); }
        addControl() {} resize() { this.resizes++; } remove() { this.removed = true; }
        jumpTo(options) { this.center = options.center; this.cameraMoves = (this.cameraMoves || 0) + 1; } setStyle(style) { this.style = style; this.ready = false; this.layers.clear(); this.sources.clear(); }
    }
    class Marker {
        constructor(options) { this.options = options; markers.push(this); }
        getElement() { return this.options.element; }
        getLngLat() { return this.coords; }
        setLngLat(coords) { this.coords = coords; return this; }
        addTo(map) { this.map = map; return this; } remove() { this.removed = true; }
    }
    class Observer {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe() {} disconnect() { this.disconnected = true; }
    }
    const m = await loadBrowserModule(new URL('../js/planner-inline-map.js', import.meta.url), {
        Date, performance: {now:()=>clock}, AbortController, ResizeObserver: Observer, MutationObserver: Observer,
        document: { documentElement: {}, createElement: () => ({}) }
    });
    const services = {
        animation: {
            MOVE_MIN_MS:1000, MOVE_MAX_MS:20000, MOVE_SMOOTHING:0.4,
            cancelMarkerAnimation(marker) { cancelled.push(marker); },
            animateMarkerTo(marker, target, duration, onUpdate) {
                animations.push({marker,target,duration,onUpdate});
                marker.setLngLat(target); onUpdate(marker.getLngLat());
            }
        },
        createVehicleElement(vehicle, bearing) {
            const arrow = { dataset: {}, style: {} };
            return { className: 'vehicle-marker-icon', vehicle, bearing, querySelector: () => arrow };
        },
        drawRouteShape(tripId, context, current, deliver, signal) { requests.push({tripId,context,current,deliver,signal}); },
        renderRouteShape(map, geometry) {
            renders.push({map,geometry});
            map.sources.set('route-shape',geometry);
            map.layers.set('route-shape-layer',{});
        },
        maplibregl: { Map, Marker }, getMapTilerKey: () => 'key',
        themeService: { getEffectiveTheme: () => theme, mapStyleFor: value => `style-${value}.json` } };
    const controller = m.createEmbeddedTripMap({ panel, services, getSegment: () => segment });
    return { m, controller, panel, root, canvas, message, maps, markers, observers, requests, renders, segment, animations, cancelled, advance:ms=>{clock+=ms;},
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
    map.handlers.dragstart({originalEvent:{}});
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

test('route loads once per selection, survives style changes and never reclaims the camera', async () => {
    const h=await setup(); h.panel.dataset.lubusTab='map';
    h.segment.stops.push({lon:22.4,lat:51.1},{lon:22.6,lat:51.3});
    h.controller.sync(); const map=h.maps[0], moves=map.cameraMoves;
    assert.equal(map.options.attributionControl,false);
    assert.equal(h.requests.length,1);
    assert.equal(h.requests[0].context.mode,'trasa');
    assert.deepEqual(Array.from(h.requests[0].context.fromCoords),[22.4,51.1]);
    const geometry={id:'trip'};
    h.requests[0].deliver(geometry);
    for(let i=0;i<15;i++) h.controller.sync();
    assert.equal(h.requests.length,1); assert.equal(h.renders.length,1);
    h.setTheme('dark'); h.observers[1].callback();
    map.ready=true; map.handlers['style.load'](); map.handlers.idle();
    assert.equal(h.renders.length,2); assert.equal(h.renders[1].geometry,geometry);
    assert.equal(h.requests.length,1); assert.equal(map.cameraMoves,moves);
});

test('shared vehicle icon rotates with GPS and map bearing, hides unknown direction', async () => {
    const h=await setup(); h.panel.dataset.lubusTab='map';
    h.segment.stops.live.bearing=120; h.controller.sync();
    const marker=h.markers[0], arrow=marker.getElement().querySelector('.vehicle-arrow'), map=h.maps[0];
    assert.equal(marker.getElement().className,'vehicle-marker-icon');
    assert.equal(arrow.style.transform,'rotate(120deg)');
    map.bearing=30; map.handlers.rotate(); assert.equal(arrow.style.transform,'rotate(90deg)');
    h.segment.stops.live.bearing=0; h.controller.sync();
    assert.equal(arrow.hidden,false); assert.equal(arrow.style.transform,'rotate(-30deg)');
    delete h.segment.stops.live.bearing; h.controller.sync(); assert.equal(arrow.hidden,true);
});

test('switching selection and closing abort geometry and ignore late replies, including an offline selection', async () => {
    const h=await setup(); h.panel.dataset.lubusTab='map'; h.controller.sync();
    const first=h.requests[0]; first.deliver({id:'first'});
    h.segment.leg.tripId='second'; h.segment.stops.live.tripId='second'; h.controller.sync();
    assert.equal(first.signal.aborted,true); assert.equal(first.current(),false);
    assert.equal(h.maps[0].sources.size,0);
    first.deliver({id:'obsolete'}); assert.equal(h.renders.length,1);
    const second=h.requests[1];
    h.segment.leg.tripId='offline'; h.segment.stops.live=null; h.controller.sync();
    assert.equal(second.signal.aborted,true); assert.equal(h.maps[0].removed,true);
    second.deliver({id:'obsolete-second'}); assert.equal(h.renders.length,1);
    h.segment.leg.tripId='third';
    h.segment.stops.live={tripId:'third',lat:51,lon:22,gpsTimestamp:Date.now()/1000,isFresh:true};
    h.controller.sync(); const third=h.requests[2]; h.controller.destroy();
    assert.equal(third.signal.aborted,true); third.deliver({id:'closed'});
    assert.equal(h.renders.length,1);
});

test('fresh positions animate with modal timing and camera follows animation frames without restarting on ticks', async () => {
    const h=await setup(); h.panel.dataset.lubusTab='map'; h.controller.sync();
    const map=h.maps[0], moves=map.cameraMoves;
    h.advance(15000); h.segment.stops.live.lon+=0.001; h.controller.sync();
    assert.equal(h.animations.length,1); assert.equal(h.animations[0].duration,6000);
    assert.equal(map.cameraMoves,moves+1);
    const frame=[22.5005,51.2]; h.animations[0].onUpdate(frame);
    assert.equal(map.center,frame,'camera follows interpolated position');
    for(let i=0;i<20;i++) h.controller.sync();
    assert.equal(h.animations.length,1,'same GPS target never restarts an animation');
    assert.equal(map.cameraMoves,moves+2);
});

test('manual pan or zoom stops following while animation continues; selecting another trip restores following', async () => {
    for(const event of ['dragstart','zoomstart']) {
        const h=await setup(); h.panel.dataset.lubusTab='map'; h.controller.sync(); const map=h.maps[0];
        map.handlers.movestart({}); // programmatic camera changes preserve following
        h.segment.stops.live.lon+=0.001; h.controller.sync();
        const animation=h.animations[0], moves=map.cameraMoves;
        map.handlers[event]({originalEvent:{}});
        animation.onUpdate([22.55,51.2]); assert.equal(map.cameraMoves,moves);
        h.segment.stops.live.lon+=0.001; h.controller.sync();
        assert.equal(h.animations.length,2); assert.equal(map.cameraMoves,moves);
        h.setTheme('dark'); h.observers[1].callback();
        h.segment.stops.live.lon+=0.001; h.controller.sync(); assert.equal(map.cameraMoves,moves);
        h.segment.leg.tripId='next'; h.segment.stops.live.tripId='next'; h.controller.sync();
        assert.equal(map.cameraMoves,moves+1);
        animation.onUpdate([1,2]); assert.equal(map.cameraMoves,moves+1,'old marker cannot move camera');
        h.segment.stops.live.lon+=0.001; h.controller.sync(); assert.equal(map.cameraMoves,moves+2);
    }
});

test('GPS loss and map disposal cancel animation; queued frames cannot move a closed or replacement map', async () => {
    const h=await setup(); h.panel.dataset.lubusTab='map'; h.controller.sync();
    h.segment.stops.live.lon+=0.001; h.controller.sync();
    const first=h.animations[0], map=h.maps[0], moves=map.cameraMoves;
    h.segment.stops.live.isFresh=false; h.controller.sync();
    assert.ok(h.cancelled.includes(first.marker)); first.onUpdate([1,2]); assert.equal(map.cameraMoves,moves);
    h.segment.stops.live.isFresh=true; h.controller.sync();
    h.segment.stops.live.lon+=0.001; h.controller.sync(); const second=h.animations[1];
    h.controller.destroy(); assert.ok(h.cancelled.includes(second.marker));
    second.onUpdate([1,2]); assert.equal(map.cameraMoves,moves+2);
    h.controller.sync(); const replacement=h.maps[1], nextMoves=replacement.cameraMoves;
    second.onUpdate([1,2]); assert.equal(replacement.cameraMoves,nextMoves);
});
