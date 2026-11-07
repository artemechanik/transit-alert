import { apiFetch } from './backend-connection.js';
// Контролер володіє головною картою; залежності передає main.js та legacy-оболонка.
export function createCityMap({
    maplibregl, themeService, locationService, animation,
    apiBaseUrl, getMapTilerKey, showToast, refreshMapVehicleArrows
}) {
    let map;
    let liveMapInterval = null;
    let activeVehicleMarkers = {};
    const CLUSTER_RADIUS_PX = 34;
    const CLUSTER_MAX_ZOOM = 14;
    const clusterByKey = new Map();
    const { MOVE_SMOOTHING, MOVE_MIN_MS, MOVE_MAX_MS, animateMarkerTo, cancelMarkerAnimation } = animation;
    let lastLiveUpdateTs = 0;
    let lastLiveInterval = 15000;
    const LUBLIN_CENTER_MAPLIBRE = [22.5684, 51.2465];
    let mapIs3D = false;
    let appliedMapTheme = null;
    const { getEffectiveTheme, mapStyleFor } = themeService;
    let searchMarker;
    let searchDebounce;
    let userLocationMarker = null;
    let userLocationAccuracyCircle = { type: 'FeatureCollection', features: [] };

    animation.setAnimationTickHandler(applyVehicleClustering);

    function applyVehicleClustering() {
        if (!map) return;
        const entries = Object.entries(activeVehicleMarkers).map(([id, marker]) => {
            const lngLat = marker.getLngLat();
            return { id, marker, lngLat, pt: map.project(lngLat) };
        });

        const groups = [];
        if (map.getZoom() >= CLUSTER_MAX_ZOOM) {
            entries.forEach(e => groups.push([e]));
        } else {
            const used = new Set();
            entries.forEach((e, i) => {
                if (used.has(i)) return;
                used.add(i);
                const group = [e];
                entries.forEach((o, j) => {
                    if (used.has(j)) return;
                    if (Math.hypot(e.pt.x - o.pt.x, e.pt.y - o.pt.y) < CLUSTER_RADIUS_PX) {
                        used.add(j);
                        group.push(o);
                    }
                });
                groups.push(group);
            });
        }

        const aliveKeys = new Set();
        groups.forEach(group => {
            if (group.length === 1) {
                group[0].marker.getElement().style.display = '';
                return;
            }
            group.forEach(g => { g.marker.getElement().style.display = 'none'; });

            const key = group.map(g => g.id).sort().join('|');
            aliveKeys.add(key);
            const lng = group.reduce((s, g) => s + g.lngLat.lng, 0) / group.length;
            const lat = group.reduce((s, g) => s + g.lngLat.lat, 0) / group.length;

            const existing = clusterByKey.get(key);
            if (existing) {
                existing.setLngLat([lng, lat]);
            } else {
                const el = document.createElement('div');
                el.className = 'vehicle-cluster';
                el.textContent = group.length;
                const cm = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
                el.addEventListener('click', () => {
                    const p = cm.getLngLat();
                    map.easeTo({ center: [p.lng, p.lat], zoom: Math.min(map.getZoom() + 2, 17) });
                });
                clusterByKey.set(key, cm);
            }
        });

        for (const [key, cm] of clusterByKey) {
            if (!aliveKeys.has(key)) { cm.remove(); clusterByKey.delete(key); }
        }
    }

    async function updateLiveCityMap() {
        try {
            const res = await apiFetch(`${apiBaseUrl}/live-vehicles`);
            if (!res.ok) return;
          const vehicles = await res.json();
          const nowTs = performance.now();
          if (lastLiveUpdateTs) {
              lastLiveInterval = Math.max(MOVE_MIN_MS, Math.min(MOVE_MAX_MS, nowTs - lastLiveUpdateTs));
          }
          lastLiveUpdateTs = nowTs;

            // Сюди зберемо всі tripId, які зараз онлайн
            const currentTripIds = new Set();

            vehicles.forEach(vehicle => {
                if (!vehicle.lat || !vehicle.lon) return;
                const lngLat = [vehicle.lon, vehicle.lat];
                const bearing = vehicle.bearing || 0;
                currentTripIds.add(vehicle.tripId);

                if (activeVehicleMarkers[vehicle.tripId]) {
                    const marker = activeVehicleMarkers[vehicle.tripId];
                    animateMarkerTo(marker, lngLat, lastLiveInterval * MOVE_SMOOTHING);
                    const arrowEl = marker.getElement().querySelector('.vehicle-arrow');
                    if (arrowEl) {
                        arrowEl.dataset.bearing = bearing;
                        arrowEl.style.transform = `rotate(${bearing - map.getBearing()}deg)`;
                    }
                } else {
                    const el = document.createElement('div');
                    el.className = 'vehicle-marker-icon';

                    // ТОЧНА копія твоєї HTML-структури з Leaflet
                    el.innerHTML = `
                    <div style="position: relative; width: 100%; height: 100%; z-index: 1;">
                        <svg class="vehicle-arrow" data-bearing="${bearing}" style="transform: rotate(${bearing - map.getBearing()}deg);" viewBox="0 0 100 100">
                            <polygon points="50,10 90,90 10,90" />
                        </svg>
                        <div class="vehicle-marker-dot">${vehicle.route || '🚌'}</div>
                    </div>
                `;

                    // MapLibre сам відцентрує цей блок 34x34 по координатах
                    const marker = new maplibregl.Marker({ element: el })
                        .setLngLat(lngLat)
                        .addTo(map);

                    activeVehicleMarkers[vehicle.tripId] = marker;
                }
            });
            for (const tripId in activeVehicleMarkers) {
              if (!currentTripIds.has(tripId)) {
                  cancelMarkerAnimation(activeVehicleMarkers[tripId]);
                    // 1. Видаляємо маркер з карти Leaflet/MapLibre
                    activeVehicleMarkers[tripId].remove();
                    // 2. Видаляємо запис з нашого словника, щоб звільнити пам'ять
                    delete activeVehicleMarkers[tripId];
                }
            }
            applyVehicleClustering();
        } catch (e) {
            console.warn('Не вдалося оновити живу карту:', e);
        }
    }

    function refreshVehicleArrows() {
        refreshMapVehicleArrows(map);
    }

    function syncMapStyle() {
        if (!map) return;
        const eff = getEffectiveTheme();
        if (eff === appliedMapTheme) return;
        appliedMapTheme = eff;
        map.setStyle(mapStyleFor(eff));
    }

    function addMapButton(label, title, onClick, position) {
        const container = document.createElement('div');
        container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = title;
        btn.innerHTML = label;

        // Інлайн !important — перебиває будь-який глобальний стиль для button
        const force = {
            color: 'var(--map-btn-fg, #333)',
            background: 'transparent',   // фон тепер дає сама група, її перефарбує CSS
            width: '29px',
            height: '29px',
            padding: '0',
            border: '0',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'font-size': '14px',
            'font-weight': '700',
            opacity: '1',
            'text-indent': '0',
        };
        for (const [k, v] of Object.entries(force)) btn.style.setProperty(k, v, 'important');

        btn.addEventListener('click', () => onClick(btn));
        container.appendChild(btn);
        map.addControl({ onAdd: () => container, onRemove: () => container.remove() }, position);
        return btn;
    }

    function apply3D(on) {
        const exists = map.getLayer('3d-buildings');
        if (on && !exists) {
            const layers = map.getStyle().layers;
            const bld = layers.find(l => l['source-layer'] === 'building');
            if (!bld) return; // стиль без будівель — буде лише нахил камери
          const baseColor = map.getPaintProperty(bld.id, 'fill-color') || '#d9d6cf';
          const firstSymbol = layers.find(l => l.type === 'symbol')?.id;
            map.addLayer({
                id: '3d-buildings',
                type: 'fill-extrusion',
                source: bld.source,
                'source-layer': 'building',
                minzoom: 14,
                paint: {
                    'fill-extrusion-color': baseColor,
                    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
                    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                    'fill-extrusion-opacity': 0.8,
                },
            }, firstSymbol);
        } else if (!on && exists) {
            map.removeLayer('3d-buildings');
        }
    }

    function setMapMode3D(on) {
        mapIs3D = on;
        apply3D(on);
        map.easeTo({ pitch: on ? 60 : 0, bearing: 0, duration: 600 });
    }

    function initMap() {
        appliedMapTheme = getEffectiveTheme();

        map = new maplibregl.Map({
            container: 'map',
            style: mapStyleFor(appliedMapTheme),
            center: LUBLIN_CENTER_MAPLIBRE,
            zoom: 14,
            attributionControl: false,
            transformRequest: (url, resourceType) => {
                if (url.includes('api.maptiler.com') && url.includes('{key}')) {
                    return { url: url.replace('{key}', getMapTilerKey()) };
                }
                return { url };
            }
        });

        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

        // 1. Моя позиція
        map.addControl(new maplibregl.GeolocateControl({
            positionOptions: { enableHighAccuracy: true },
            trackUserLocation: true,
            showUserHeading: true,
            showUserLocation: false,
        }), 'top-right');

        // 2. Тема: Авто → День → Ніч
        const themeButton = themeService.getThemeButton();
        addMapButton(themeButton.icon, themeButton.title, (btn) => {
            showToast(themeService.cycleTheme(btn));
        }, 'top-right');

        // 3. 3D / 2D
        addMapButton('3D', '3D / 2D', (btn) => {
            setMapMode3D(!mapIs3D);
            btn.textContent = mapIs3D ? '2D' : '3D';
        }, 'top-right');

        map.on('style.load', () => {
            if (mapIs3D) apply3D(true);
            syncUserLocationAccuracyCircle(true);
        });

        map.on('rotate', refreshVehicleArrows);
        map.on('zoomend', applyVehicleClustering);
        map.on('pitchend', applyVehicleClustering);
    }

    function initSearchBar() {
      const input = document.getElementById('search-input');
      const clearBtn = document.getElementById('search-clear');
      const list = document.getElementById('search-suggestions');

      input.addEventListener('input', () => {
        clearBtn.style.display = input.value ? 'block' : 'none';
        clearTimeout(searchDebounce);
        const q = input.value.trim();
        if (q.length < 2) { list.style.display = 'none'; return; }
        searchDebounce = setTimeout(() => runStopSearch(q, list, input), 250);
      });

      clearBtn.addEventListener('click', () => {
        input.value = '';
        clearBtn.style.display = 'none';
        list.style.display = 'none';
        if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
      });
    }

    async function runStopSearch(q, listEl, inputEl) {
      try {
        const res = await apiFetch(`${apiBaseUrl}/stops/search?q=${encodeURIComponent(q)}`);
        const stops = await res.json();
        if (!stops.length) {
          listEl.innerHTML = '<div id="search-empty">Нічого не знайдено</div>';
          listEl.style.display = 'block';
          return;
        }
        listEl.innerHTML = '';
        stops.forEach(s => {
          const row = document.createElement('div');
          row.innerHTML = `${s.name}<span class="code">${s.code}</span>`;
          row.onclick = () => {
            inputEl.value = `${s.name} ${s.code}`;
            listEl.style.display = 'none';
            flyToStop(s);
          };
          listEl.appendChild(row);
        });
        listEl.style.display = 'block';
      } catch (e) {
        console.warn('Пошук зупинок не вдався', e);
      }
    }

    function flyToStop(stop) {
      if (searchMarker) map.removeLayer(searchMarker);
      searchMarker = L.marker([stop.lat, stop.lon]).addTo(map)
        .bindPopup(`<b>${stop.name}</b><br>Platforma ${stop.code}`).openPopup();
      map.flyTo([stop.lat, stop.lon], 17);
    }

    function initCityMap() {
        if (map) return;
        initMap();

        // ВАЖЛИВО: Чекаємо, поки карта повністю промалюється, перш ніж щось на неї додавати
        map.on('load', () => {
            console.log("Карта завантажена! Запускаємо GPS та маркери...");
            trackUserLocation();

            // --- Додаємо запуск автобусів ---
            updateLiveCityMap();
            clearInterval(liveMapInterval);
            liveMapInterval = setInterval(updateLiveCityMap, 5000);        // --------------------------------
        });
    }

    function updateUserLocationAccuracyCircle(lngLat, accuracy) {
        userLocationAccuracyCircle = { type: 'FeatureCollection', features: [] };
        if (Number.isFinite(accuracy) && accuracy >= 0) {
            const radians = Math.PI / 180;
            const lon = lngLat[0] * radians;
            const lat = lngLat[1] * radians;
            const distance = accuracy / 6371008.8;
            const ring = [];
            for (let i = 0; i < 64; i++) {
                const bearing = i * 2 * Math.PI / 64;
                const destLat = Math.asin(Math.max(-1, Math.min(1,
                    Math.sin(lat) * Math.cos(distance) +
                    Math.cos(lat) * Math.sin(distance) * Math.cos(bearing)
                )));
                const destLon = lon + Math.atan2(
                    Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
                    Math.cos(distance) - Math.sin(lat) * Math.sin(destLat)
                );
                ring.push([destLon / radians, destLat / radians]);
            }
            ring.push(ring[0].slice());
            userLocationAccuracyCircle.features.push({
                type: 'Feature', properties: {},
                geometry: { type: 'Polygon', coordinates: [ring] }
            });
        }
        syncUserLocationAccuracyCircle();
    }

    function syncUserLocationAccuracyCircle(styleLoaded = false) {
        if (!map) return;
        const sourceId = 'user-location-accuracy';
        const source = map.getSource(sourceId);
        // Під час завантаження нового стилю зберігаємо дані до style.load.
        if (!source && !styleLoaded && !map.isStyleLoaded()) return;
        if (source) source.setData(userLocationAccuracyCircle);
        else map.addSource(sourceId, { type: 'geojson', data: userLocationAccuracyCircle });

        const color = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim();
        if (!map.getLayer('user-location-accuracy-fill')) {
            map.addLayer({
                id: 'user-location-accuracy-fill', type: 'fill', source: sourceId,
                paint: { 'fill-color': color, 'fill-opacity': 0.1, 'fill-antialias': false }
            });
        } else map.setPaintProperty('user-location-accuracy-fill', 'fill-color', color);
        if (!map.getLayer('user-location-accuracy-outline')) {
            map.addLayer({
                id: 'user-location-accuracy-outline', type: 'line', source: sourceId,
                paint: { 'line-color': color, 'line-opacity': 0.25, 'line-width': 1 }
            });
        } else map.setPaintProperty('user-location-accuracy-outline', 'line-color', color);
    }

    function trackUserLocation() {
        console.log("[GPS] Запит геолокації...");

        if (!locationService.isSupported()) {
            showToast('Geolokalizacja nie jest wspierana');
            return;
        }

        locationService.startLocation(
            renderUserLocation,
            (error) => {
                console.warn('[GPS] Помилка:', error.message);
            }
        );
    }

    function renderUserLocation(position) {
        const lat = position.lat;
        const lon = position.lon;
        const lngLat = [lon, lat];

        if (!userLocationMarker) {
            // Створюємо елемент лише ОДИН раз
            const el = document.createElement('div');
            el.className = 'user-marker-dom';

            userLocationMarker = new maplibregl.Marker({ element: el })
                .setLngLat(lngLat)
                .addTo(map);

            map.flyTo({ center: lngLat, zoom: 16 });
            console.log("[GPS] Маркер створено!");
        } else {
            // Просто плавно рухаємо існуючий маркер
            userLocationMarker.setLngLat(lngLat);
        }
        updateUserLocationAccuracyCircle(lngLat, position.accuracy);
    }

    return {
        initCityMap,
        applyMapTheme: syncMapStyle,
        trackUserLocation,
        // Старий невикликаний пошук зберігає свої Leaflet-виклики без виправлень.
        initSearchBar,
        runStopSearch,
        flyToStop
    };
}
