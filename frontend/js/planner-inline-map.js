import { LIVE_MAX_AGE } from './planner-results.js';

export function validMapPosition(segment, now = Date.now() / 1000) {
    const live = segment?.stops.live;
    return !!live && live.tripId === segment.leg.tripId && live.isFresh
        && Number.isFinite(live.gpsTimestamp) && live.gpsTimestamp > 0
        && now - live.gpsTimestamp >= 0 && now - live.gpsTimestamp <= LIVE_MAX_AGE
        && Number.isFinite(live.lat) && Math.abs(live.lat) <= 90
        && Number.isFinite(live.lon) && Math.abs(live.lon) <= 180;
}

// Receives existing timeline observations. Owns WebGL/DOM resources, never GPS requests.
export function createEmbeddedTripMap({ panel, services, getSegment }) {
    let map = null, marker = null, resizeObserver = null, themeObserver = null;
    let routeRequest = null, routeGeometry = null, routeNeedsRender = false;
    let appliedTheme = null, selectedTrip = null, failed = false;
    let following = true, lastTarget = null, lastMoveTime = 0;
    let lastWidth = 0, lastHeight = 0, lastPixelRatio = 0;
    const canvas = panel.querySelector('.lubus-map-canvas');
    const message = panel.querySelector('.lubus-map-neutral');
    function notify(text) { if (message) { message.textContent = text; message.hidden = !text; } }
    function removeMarker() {
        if (marker) {
            services.animation.cancelMarkerAnimation(marker);
            marker._anim = null;
            marker.remove(); marker = null;
        }
        lastTarget = null;
    }
    function followMarker(position, targetMap, targetMarker) {
        if (map === targetMap && marker === targetMarker && following && validMapPosition(getSegment())) {
            map.jumpTo({ center: position });
        }
    }
    function destroy() {
        routeRequest?.abort(); routeRequest = null; routeGeometry = null; routeNeedsRender = false;
        resizeObserver?.disconnect(); themeObserver?.disconnect();
        resizeObserver = themeObserver = null;
        removeMarker();
        map?.remove(); map = null; selectedTrip = null; failed = false;
        lastWidth = lastHeight = lastPixelRatio = 0;
        following = true; lastMoveTime = 0;
    }
    function resizeIfChanged() {
        if (!map || !canvas) return;
        const width = canvas.clientWidth, height = canvas.clientHeight;
        const pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
        if (!(width > 0 && height > 0)
            || (width === lastWidth && height === lastHeight && pixelRatio === lastPixelRatio)) return;
        lastWidth = width; lastHeight = height; lastPixelRatio = pixelRatio;
        map.resize();
    }
    function applyTheme() {
        if (!map) return;
        const theme = services.themeService.getEffectiveTheme();
        if (appliedTheme !== theme) {
            appliedTheme = theme;
            routeNeedsRender = true;
            map.setStyle(services.themeService.mapStyleFor(theme));
        }
    }
    function restoreRoute() {
        if (!map || !routeGeometry || !routeNeedsRender || !map.isStyleLoaded()) return;
        routeNeedsRender = false;
        services.renderRouteShape(map, routeGeometry);
    }
    function updateArrow(live) {
        const arrow = marker?.getElement().querySelector('.vehicle-arrow');
        if (!arrow) return;
        const known = Number.isFinite(live.bearing);
        arrow.hidden = !known;
        arrow.style.display = known ? '' : 'none';
        if (known) {
            arrow.dataset.bearing = live.bearing;
            arrow.style.transform = `rotate(${live.bearing - map.getBearing()}deg)`;
        }
    }
    function selectRoute(segment) {
        routeRequest?.abort();
        routeGeometry = null; routeNeedsRender = false;
        // Clear the previous trip immediately while the selected geometry loads.
        for (const id of ['route-active-segment-layer', 'route-stops-layer', 'route-shape-layer']) {
            if (map.getLayer(id)) map.removeLayer(id);
        }
        for (const id of ['route-active-segment', 'route-stops', 'route-shape']) {
            if (map.getSource(id)) map.removeSource(id);
        }
        if (!services.drawRouteShape) return;
        const controller = new AbortController(), targetMap = map, tripId = segment.leg.tripId;
        routeRequest = controller;
        const current = () => map === targetMap && selectedTrip === tripId && !controller.signal.aborted;
        const first = segment.stops[0], last = segment.stops.at(-1);
        const context = first && last && [first.lon,first.lat,last.lon,last.lat].every(Number.isFinite)
            ? { mode:'trasa', fromCoords:[first.lon,first.lat], toCoords:[last.lon,last.lat] } : { mode:'przystanek' };
        services.drawRouteShape(tripId, context, current, geometry => {
            if (!current()) return;
            routeGeometry = geometry; routeNeedsRender = true; restoreRoute();
        }, controller.signal);
    }
    function sync() {
        const visible = panel.dataset.lubusTab === 'map'
            && panel.closest('#route-results-list')?.dataset.presentation === 'new';
        if (!visible) { destroy(); return; }
        const segment = getSegment();
        const valid = validMapPosition(segment);
        if (!valid) {
            if (map && selectedTrip !== segment?.leg.tripId) destroy();
            removeMarker();
            notify('Brak aktualnych współrzędnych GPS tego kursu.');
            resizeIfChanged();
            return;
        }
        if (!canvas || !services?.maplibregl || !services?.themeService) {
            notify('Mapa jest niedostępna. Możesz otworzyć widok pełnoekranowy.'); return;
        }
        const { lat, lon } = segment.stops.live;
        if (!map && !failed) {
            try {
                appliedTheme = services.themeService.getEffectiveTheme();
                map = new services.maplibregl.Map({ container: canvas,
                    style: services.themeService.mapStyleFor(appliedTheme), center: [lon, lat], zoom: 15,
                    attributionControl: false,
                    transformRequest: url => ({ url: url.includes('api.maptiler.com')
                        ? url.replace('{key}', services.getMapTilerKey()) : url }) });
                const ownedMap = map;
                for (const event of ['movestart', 'dragstart', 'zoomstart', 'rotatestart', 'pitchstart']) {
                    map.on(event, event => { if (map === ownedMap && event.originalEvent) following = false; });
                }
                for (const event of ['load', 'style.load', 'idle']) map.on(event, restoreRoute);
                map.on('rotate', () => {
                    const selected = getSegment();
                    if (validMapPosition(selected)) updateArrow(selected.stops.live);
                });
                if (services.maplibregl.NavigationControl) map.addControl(new services.maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
                if (typeof ResizeObserver === 'function') {
                    resizeObserver = new ResizeObserver(resizeIfChanged); resizeObserver.observe(canvas);
                }
                if (typeof MutationObserver === 'function') {
                    themeObserver = new MutationObserver(applyTheme);
                    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
                }
            } catch {
                destroy(); failed = true;
            }
        }
        if (!map) { notify('Nie udało się uruchomić mapy. Dostępny jest widok pełnoekranowy.'); return; }
        notify(''); applyTheme(); resizeIfChanged();
        if (selectedTrip !== segment.leg.tripId) {
            removeMarker();
            following = true;
            selectedTrip = segment.leg.tripId;
            selectRoute(segment);
        }
        if (!marker) {
            const element = services.createVehicleElement({ ...segment.stops.live, route: segment.leg.route }, map.getBearing());
            marker = new services.maplibregl.Marker({ element }).setLngLat([lon, lat]).addTo(map);
            lastTarget = [lon, lat]; lastMoveTime = performance.now();
            followMarker(marker.getLngLat(), map, marker);
        } else if (lastTarget[0] !== lon || lastTarget[1] !== lat) {
            const now = performance.now(), targetMap = map, targetMarker = marker;
            const { animateMarkerTo, MOVE_MIN_MS, MOVE_MAX_MS, MOVE_SMOOTHING } = services.animation;
            const interval = Math.max(MOVE_MIN_MS, Math.min(MOVE_MAX_MS, now - lastMoveTime));
            lastMoveTime = now; lastTarget = [lon, lat];
            animateMarkerTo(marker, lastTarget, interval * MOVE_SMOOTHING,
                position => followMarker(position, targetMap, targetMarker));
        }
        updateArrow(segment.stops.live);
    }
    return { sync, destroy };
}
