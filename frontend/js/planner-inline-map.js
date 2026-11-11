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
    let appliedTheme = null, selectedTrip = null, failed = false;
    let lastWidth = 0, lastHeight = 0, lastPixelRatio = 0;
    const canvas = panel.querySelector('.lubus-map-canvas');
    const message = panel.querySelector('.lubus-map-neutral');
    function notify(text) { if (message) { message.textContent = text; message.hidden = !text; } }
    function destroy() {
        resizeObserver?.disconnect(); themeObserver?.disconnect();
        resizeObserver = themeObserver = null;
        marker?.remove(); marker = null;
        map?.remove(); map = null; selectedTrip = null; failed = false;
        lastWidth = lastHeight = lastPixelRatio = 0;
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
            map.setStyle(services.themeService.mapStyleFor(theme));
        }
    }
    function sync() {
        const visible = panel.dataset.lubusTab === 'map'
            && panel.closest('#route-results-list')?.dataset.presentation === 'new';
        if (!visible) { destroy(); return; }
        const segment = getSegment();
        const valid = validMapPosition(segment);
        if (!valid) {
            marker?.remove(); marker = null;
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
                    attributionControl: true,
                    transformRequest: url => ({ url: url.includes('api.maptiler.com')
                        ? url.replace('{key}', services.getMapTilerKey()) : url }) });
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
            marker?.remove(); marker = null;
            map.jumpTo({ center: [lon, lat] }); selectedTrip = segment.leg.tripId;
        }
        if (!marker) {
            const element = document.createElement('div');
            element.className = 'vehicle-marker-dot lubus-inline-vehicle';
            element.textContent = segment.leg.route;
            marker = new services.maplibregl.Marker({ element }).setLngLat([lon, lat]).addTo(map);
        } else marker.setLngLat([lon, lat]);
    }
    return { sync, destroy };
}
