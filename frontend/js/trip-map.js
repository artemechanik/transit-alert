import { apiFetch } from './backend-connection.js';
// Один контролер володіє сеансом мінікарти; спільні сервіси передає main.js.
export function createTripMap({
    maplibregl, locationService, themeService, animation,
    apiBaseUrl, getMapTilerKey, showToast, refreshMapVehicleArrows, onOpen
}) {
    let modalVehicleMarker = null;
    let modalTrackInterval = null;
    let modalMap = null;
    let modalUserMarker = null;
    let modalInitTimeout = null;
    let modalUserInteracted = false;
    let modalTrackingSession = null;
    const { MOVE_SMOOTHING, MOVE_MIN_MS, MOVE_MAX_MS, animateMarkerTo, cancelMarkerAnimation } = animation;
    const { getEffectiveTheme, mapStyleFor } = themeService;

    async function showVehicleOnMap(tripId, routeContext = { mode: 'przystanek' }) {
      // Нове відкриття одразу скасовує попередній сеанс, навіть під час першого запиту.
      closeVehicleMapModal();
      const session = { controller: new AbortController(), inFlight: false };
      modalTrackingSession = session;
      const isCurrentSession = () => modalTrackingSession === session;

      try {
        const vehicle = await fetchVehiclePosition(tripId, session.controller.signal);
        if (!isCurrentSession()) return;
        if (!vehicle) {
          closeVehicleMapModal();
          showToast('Brak danych GPS dla tego kursu');
          return;
        }

        const modal = document.getElementById('vehicle-modal');
        modal.style.display = 'flex';
        onOpen();
        document.getElementById('modal-route-title').innerText = `Linia ${vehicle.route}`;

        // Чекаємо на розміри контейнера перед створенням карти.
        modalInitTimeout = setTimeout(() => {
          modalInitTimeout = null;
          if (!isCurrentSession() || modal.style.display === 'none') return;

          const lngLat = [vehicle.lon, vehicle.lat];
          let appliedTheme = getEffectiveTheme();
          let routeNeedsRender = false;
          let routeGeometry = null;
          const trackingMap = new maplibregl.Map({
            container: 'modal-map',
            style: mapStyleFor(appliedTheme),
            center: lngLat,
            zoom: 16,
            attributionControl: false,
            transformRequest: (url) => {
              if (url.includes('api.maptiler.com') && url.includes('{key}')) {
                return { url: url.replace('{key}', getMapTilerKey()) };
              }
              return { url };
            }
          });
          modalMap = trackingMap;
          const isCurrentMap = () => isCurrentSession() && modalMap === trackingMap;
          trackingMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

          // Програмні рухи не містять originalEvent і не вимикають стеження.
          const stopFollowing = (e) => {
            if (isCurrentMap() && e.originalEvent) modalUserInteracted = true;
          };
          ['movestart', 'dragstart', 'zoomstart', 'rotatestart', 'pitchstart'].forEach(event => {
            trackingMap.on(event, stopFollowing);
          });
          trackingMap.on('rotate', () => {
            if (isCurrentMap()) refreshMapVehicleArrows(trackingMap);
          });
          const restoreRoute = () => {
            if (!isCurrentMap() || !routeNeedsRender || !routeGeometry || !trackingMap.isStyleLoaded()) return;
            // Скидаємо до додавання джерел: їхні події не повинні запускати повторне малювання.
            routeNeedsRender = false;
            renderRouteShape(trackingMap, routeGeometry);
          };
          trackingMap.on('style.load', restoreRoute);
          trackingMap.on('idle', restoreRoute);
          session.applyTheme = () => {
            if (!isCurrentMap()) return;
            const theme = getEffectiveTheme();
            if (theme === appliedTheme) return;
            appliedTheme = theme;
            routeNeedsRender = true;
            trackingMap.setStyle(mapStyleFor(theme));
          };
          trackingMap.on('load', () => {
            if (!isCurrentMap()) return;
            drawRouteShape(tripId, routeContext, isCurrentMap, geometry => {
              routeGeometry = geometry;
              routeNeedsRender = true;
              restoreRoute();
            });
          });

          const userPosition = locationService.getPosition();
          if (userPosition) {
            const userEl = document.createElement('div');
            userEl.className = 'user-marker-dom';
            modalUserMarker = new maplibregl.Marker({ element: userEl })
              .setLngLat([userPosition.lon, userPosition.lat])
              .addTo(trackingMap);
          }

          function createVehicleMarker(currentVehicle) {
            const el = document.createElement('div');
            el.className = 'vehicle-marker-icon';
            const bearing = currentVehicle.bearing || 0;
            el.innerHTML = `
        <div style="position: relative; width: 100%; height: 100%; z-index: 1;">
          <svg class="vehicle-arrow" data-bearing="${bearing}" style="transform: rotate(${bearing - trackingMap.getBearing()}deg);" viewBox="0 0 100 100">
            <polygon points="50,10 90,90 10,90" />
          </svg>
          <div class="vehicle-marker-dot">${currentVehicle.route || '🚌'}</div>
        </div>
      `;
            const marker = new maplibregl.Marker({ element: el })
              .setLngLat([currentVehicle.lon, currentVehicle.lat])
              .addTo(trackingMap);
            return marker;
          }
          let marker = createVehicleMarker(vehicle);
          modalVehicleMarker = marker;
          let lastUpdateTs = performance.now();
          const followMarker = (position) => {
            if (isCurrentMap() && !modalUserInteracted) {
              if (modalUserMarker) {
                // Кадруємо обидва маркери за поточною позицією анімації автобуса.
                const bounds = new maplibregl.LngLatBounds()
                  .extend(position)
                  .extend(modalUserMarker.getLngLat());
                const camera = trackingMap.cameraForBounds(bounds, {
                  padding: { top: 100, bottom: 80, left: 50, right: 50 },
                  maxZoom: 16
                });
                if (camera) trackingMap.jumpTo(camera);
              } else {
                trackingMap.jumpTo({ center: position });
              }
            }
          };
          followMarker(marker.getLngLat());

          modalTrackInterval = setInterval(async () => {
            if (!isCurrentMap() || session.inFlight) return;
            session.inFlight = true;
            try {
              const updated = await fetchVehiclePosition(tripId, session.controller.signal);
              if (!isCurrentMap() || modalVehicleMarker !== marker) return;
              const userPosition = locationService.getPosition();
              if (userPosition && modalUserMarker) {
                modalUserMarker.setLngLat([userPosition.lon, userPosition.lat]);
              }
              if (!updated) {
                if (marker) {
                  cancelMarkerAnimation(marker);
                  marker._anim = null;
                  marker.remove();
                  marker = null;
                  modalVehicleMarker = null;
                }
                return;
              }
              if (updated) {
                const nowTs = performance.now();
                const interval = Math.max(MOVE_MIN_MS, Math.min(MOVE_MAX_MS, nowTs - lastUpdateTs));
                lastUpdateTs = nowTs;
                if (!marker) {
                  marker = createVehicleMarker(updated);
                  modalVehicleMarker = marker;
                  followMarker(marker.getLngLat());
                } else {
                  animateMarkerTo(marker, [updated.lon, updated.lat], interval * MOVE_SMOOTHING, followMarker);
                }
                const arrowEl = marker.getElement().querySelector('.vehicle-arrow');
                if (arrowEl) arrowEl.dataset.bearing = updated.bearing || 0;
                refreshMapVehicleArrows(trackingMap);
              }
            } catch (e) {
              if (isCurrentMap() && e.name !== 'AbortError') {
                console.warn('Не вдалося оновити позицію автобуса:', e);
              }
            } finally {
              session.inFlight = false;
            }
          }, 5000);
        }, 200);
      } catch (e) {
        if (!isCurrentSession()) return;
        closeVehicleMapModal();
        if (e.name !== 'AbortError') {
          console.error('Помилка міні-карти:', e);
          showToast('Brak połączenia z serwerem');
        }
      }
    }

    function closeVehicleMapModal() {
      if (modalTrackingSession) {
        modalTrackingSession.controller.abort();
        modalTrackingSession = null;
      }
      if (modalInitTimeout) {
        clearTimeout(modalInitTimeout);
        modalInitTimeout = null;
      }
      if (modalTrackInterval) {
        clearInterval(modalTrackInterval);
        modalTrackInterval = null;
      }

      const modal = document.getElementById('vehicle-modal');
      if (modal) modal.style.display = 'none';
      modalUserInteracted = false;

      if (modalVehicleMarker) {
        cancelMarkerAnimation(modalVehicleMarker);
        modalVehicleMarker._anim = null;
        modalVehicleMarker.remove();
        modalVehicleMarker = null;
      }
      if (modalUserMarker) {
        modalUserMarker.remove();
        modalUserMarker = null;
      }
      if (modalMap) {
        modalMap.remove();
        modalMap = null;
      }
    }

    function findNearestVertexIndex(point, coords) {
      let minDist = Infinity;
      let bestIdx = 0;
      for (let i = 0; i < coords.length; i++) {
        const dx = coords[i][0] - point[0];
        const dy = coords[i][1] - point[1];
        const d = dx * dx + dy * dy;
        if (d < minDist) {
          minDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    }

    function sliceLineString(coords, startPoint, endPoint) {
      const startIdx = findNearestVertexIndex(startPoint, coords);
      const endIdx = findNearestVertexIndex(endPoint, coords);

      const from = Math.min(startIdx, endIdx);
      const to = Math.max(startIdx, endIdx);

      const sliced = coords.slice(from, to + 1);
      if (sliced.length < 2) return coords;
      return sliced;
    }

    function projectPointToLineString(point, coords) {
      const [px, py] = point;
      let minDistance = Infinity;
      let nearestPoint = point;

      for (let i = 0; i < coords.length - 1; i++) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[i + 1];

        const dx = x2 - x1;
        const dy = y2 - y1;

        if (dx === 0 && dy === 0) continue;

        // Параметр проекції t від 0 до 1
        let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
        t = Math.max(0, Math.min(1, t));

        const projX = x1 + t * dx;
        const projY = y1 + t * dy;

        // Квадрат відстані до проекції
        const distSq = (px - projX) * (px - projX) + (py - projY) * (py - projY);
        if (distSq < minDistance) {
          minDistance = distSq;
          nearestPoint = [projX, projY];
        }
      }

      return nearestPoint;
    }

    async function drawRouteShape(tripId, context, isCurrent, onGeometry) {
      try {
        const res = await apiFetch(`${apiBaseUrl}/api/trip-stops/${tripId}`);
        if (!res.ok) return;
        const stops = await res.json();
        if (!isCurrent()) return;

        if (!stops || stops.length < 2) return;

        // 1. Готуємо зупинки для OSRM
        let filteredStops = stops;
        if (stops.length > 90) {
          filteredStops = stops.filter((_, i) => i % 2 === 0 || i === stops.length - 1);
        }
        const coordsString = filteredStops.map(s => `${s[0]},${s[1]}`).join(';');

        // 2. Геометрія від OSRM
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsString}?geometries=geojson&overview=full`;
        const osrmRes = await fetch(osrmUrl);
        const osrmData = await osrmRes.json();
        if (!isCurrent()) return;

        let routeGeoJSON;
        if (osrmData.routes && osrmData.routes.length > 0) {
          routeGeoJSON = osrmData.routes[0].geometry;
        } else {
          routeGeoJSON = { type: 'LineString', coordinates: stops };
        }

        onGeometry({ routeGeoJSON, stops, context });
      } catch (e) {
        console.error('Помилка побудови маршруту:', e);
      }
    }

    function renderRouteShape(mapInstance, { routeGeoJSON, stops, context }) {
        const lineCoords = routeGeoJSON.coordinates;
        const snappedStops = stops.map(stop => projectPointToLineString(stop, lineCoords));

        const isTrasa = context && context.mode === 'trasa' && context.fromCoords && context.toCoords;

        // 3. Формуємо точки зупинок
        const stopsGeoJSON = {
          type: 'FeatureCollection',
          features: snappedStops.map((coord, index) => {
            let role = 'intermediate';
            if (index === 0 || index === snappedStops.length - 1) role = 'terminal';
            return {
              type: 'Feature',
              properties: { role },
              geometry: { type: 'Point', coordinates: coord }
            };
          })
        };

        // 4. Базова / Фонова лінія маршруту
        const baseColor = isTrasa ? '#c0c0c0' : '#22c55e'; // У режимі Trasa фоновий маршрут приглушений
        const baseOpacity = isTrasa ? 0.75 : 0.75;
        const baseWidth = isTrasa ? 4 : 4;

        if (mapInstance.getSource('route-shape')) {
          mapInstance.getSource('route-shape').setData({
            type: 'Feature',
            properties: {},
            geometry: routeGeoJSON
          });
          mapInstance.setPaintProperty('route-shape-layer', 'line-color', baseColor);
          mapInstance.setPaintProperty('route-shape-layer', 'line-opacity', baseOpacity);
          mapInstance.setPaintProperty('route-shape-layer', 'line-width', baseWidth);
        } else {
          mapInstance.addSource('route-shape', {
            type: 'geojson',
            data: { type: 'Feature', properties: {}, geometry: routeGeoJSON }
          });

          mapInstance.addLayer({
            id: 'route-shape-layer',
            type: 'line',
            source: 'route-shape',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': baseColor,
              'line-width': baseWidth,
              'line-opacity': baseOpacity
            }
          });
        }

        // 5. Якщо це режим 'Trasa': малюємо активний сегмент поїздки (насичений)
        if (isTrasa) {
          const activeCoords = sliceLineString(lineCoords, context.fromCoords, context.toCoords);
          const activeGeoJSON = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: activeCoords }
          };

          if (mapInstance.getSource('route-active-segment')) {
            mapInstance.getSource('route-active-segment').setData(activeGeoJSON);
          } else {
            mapInstance.addSource('route-active-segment', {
              type: 'geojson',
              data: activeGeoJSON
            });

            mapInstance.addLayer({
              id: 'route-active-segment-layer',
              type: 'line',
              source: 'route-active-segment',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': '#16a34a',
                'line-width': 5.5,
                'line-opacity': 0.95
              }
            });
          }
        }

        // 6. Вузлові цятки зупинок
        if (mapInstance.getSource('route-stops')) {
          mapInstance.getSource('route-stops').setData(stopsGeoJSON);
        } else {
          mapInstance.addSource('route-stops', {
            type: 'geojson',
            data: stopsGeoJSON
          });

          mapInstance.addLayer({
            id: 'route-stops-layer',
            type: 'circle',
            source: 'route-stops',
            paint: {
              'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                11, 2,
                15, 4,
                18, 5.5
              ],
              'circle-color': '#ffffff',
              'circle-stroke-color': '#16a34a',
              'circle-stroke-width': 2
            }
          });
        }
    }

    async function fetchVehiclePosition(tripId, signal) {
      const res = await apiFetch(`${apiBaseUrl}/live-vehicles/${tripId}`, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Live GPS: HTTP ${res.status}`);
      return res.json();
    }

    function handleThemeChange() {
        modalTrackingSession?.applyTheme?.();
    }

    // Сумісність зі старим stopVehicleTracking: лише polling, без закриття сеансу.
    function stopPolling() {
        if (typeof modalTrackInterval !== 'undefined' && modalTrackInterval) {
            clearInterval(modalTrackInterval);
            modalTrackInterval = null;
        }
    }

    return {
        showVehicleOnMap,
        closeVehicleMapModal,
        fetchVehiclePosition,
        handleThemeChange,
        stopPolling
    };
}
