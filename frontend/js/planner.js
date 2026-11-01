// Власник стану, DOM-обробників і LIVE-таймера планувальника Trasa.
export function createPlanner({
    apiBaseUrl, getMapTilerKey, locationService, getNearbyStops,
    showVehicleOnMap, showToast, addMinutesToTime, onAccordionOpen, onBack
}) {
    let initialized = false;
    let lastJourneyDepartureMin = null;
    let trasaCountdownInterval = null;
    let routeFromStop = null;
    let routeToStop = null;
    let trasaStartY = 0;
    let trasaIsAtBottom = false;
    let trasaIsRefreshing = false;
    let searchRouteBtn, routeResultsBox, trasaBottomIndicator;

    function getRecentRouteStops() {
        try { return JSON.parse(localStorage.getItem('ta_recent_route_stops')) || []; } catch (e) { return []; }
    }

    function saveRecentRouteStop(stop) {
        let recents = getRecentRouteStops();
        // Видаляємо дублікати по імені (бо платформи вже згруповані)
        recents = recents.filter(s => s.name !== stop.name);
        recents.unshift(stop);
        if (recents.length > 4) recents.length = 4; // Ліміт: 4 зупинки!
        localStorage.setItem('ta_recent_route_stops', JSON.stringify(recents));
    }

    function getRecentRoutes() {
        try { return JSON.parse(localStorage.getItem('ta_recent_routes')) || []; } catch (e) { return []; }
    }

    function saveRecentRoute(fromStop, toStop) {
        let routes = getRecentRoutes();
        const routeKey = `${fromStop.name}-${toStop.name}`; // Унікальний ключ маршруту

        // Видаляємо такий самий маршрут, якщо він вже є, щоб підняти його наверх
        routes = routes.filter(r => `${r.from.name}-${r.to.name}` !== routeKey);
        routes.unshift({ from: fromStop, to: toStop });

        if (routes.length > 10) routes.length = 10; // Зберігаємо 3 останні маршрути
        localStorage.setItem('ta_recent_routes', JSON.stringify(routes));
    }

    function renderRecentRoutes() {
        const container = document.getElementById('recent-routes-list');
        if (!container) return;

        const routes = getRecentRoutes();
        if (routes.length === 0) {
            container.innerHTML = '';
            return;
        }

        // Робимо заголовок липким (sticky), щоб він не зникав при гортанні списку
        let html = '<div style="padding: 10px; font-weight: bold; color: var(--text-muted); font-size: 0.9em; position: sticky; top: 0; background: var(--bg); z-index: 2;">OSTATNIE TRASY</div>';

        // calc(100vh - 320px) вираховує висоту динамічно: весь екран МІНУС верхні інпути та нижнє меню
        // Це дозволить списку ідеально вписатися на будь-якому телефоні
        html += '<div class="recent-scroll-container" style="max-height: calc(100vh - 320px); overflow-y: auto; overscroll-behavior: contain; padding-bottom: 20px;">';

        routes.forEach(route => {
            html += `
        <div class="stop-card" style="padding: 12px 16px; cursor: pointer; border-bottom: 1px solid var(--border); background: var(--bg); display: flex; align-items: center; gap: 10px;">
            <div class="svg-icon icon-clock" style="color: var(--blue);"></div>
            <div style="flex: 1;">
                <div style="font-weight: bold; color: var(--text);">${route.from.name}</div>
                <div style="font-size: 0.85em; color: var(--text-muted);">➔ ${route.to.name}</div>
            </div>
        </div>`;
        });

        html += '</div>';

        container.innerHTML = html;
        container.querySelectorAll('.stop-card').forEach((card, index) => {
            card.addEventListener('click', () => applyRecentRoute(routes[index]));
        });

        // (Опціонально) Ховаємо текст "Wybierz przystanek...", якщо є історія, щоб не засмічувати екран
        const helperText = document.querySelector('#screen-route > p, #screen-route .helper-text');
        if (helperText) helperText.style.display = 'none';
    }

    function applyRecentRoute(route) {
        document.getElementById('route-input-from').value = route.from.name;
        document.getElementById('route-input-to').value = route.to.name;

        routeFromStop = route.from;
        routeToStop = route.to;

        // Оновлюємо стани кнопок (верхня буде ✕, нижня — ⇅)
        updateRouteButtonState(true);
        updateRouteButtonState(false);

        document.getElementById('recent-routes-list').style.display = 'none';
        document.getElementById('route-search-btn').click();
    }

    function updateRouteButtonState(isFrom) {
      const input = document.getElementById(isFrom ? 'route-input-from' : 'route-input-to');
      const btn = document.getElementById(isFrom ? 'route-clear-from' : 'route-clear-to');
      if (!input || !btn) return;

      const isFocused = document.activeElement === input;
      const hasText = input.value.trim().length > 0;

      if (isFrom) {
        // Верхнє поле: або 📍 (порожнє), або ✕ (з текстом)
        btn.className = hasText ? 'route-action-btn icon-clear' : 'route-action-btn icon-location';
        btn.title = hasText ? 'Wyczyść' : 'Moja lokalizacja';
      } else {
        // Нижнє поле: 📍 (порожнє), ✕ (активний ввід), ⇅ (вибрано ціль і фокус знято)
        if (!hasText) {
          btn.className = 'route-action-btn icon-location';
          btn.title = 'Moja lokalizacja';
        } else if (isFocused) {
          btn.className = 'route-action-btn icon-clear';
          btn.title = 'Wyczyść';
        } else {
          btn.className = 'route-action-btn icon-swap';
          btn.title = 'Zamień miejscami';
        }
      }
    }

    function swapRoutePoints() {
      const inputFrom = document.getElementById('route-input-from');
      const inputTo = document.getElementById('route-input-to');

      // Міняємо тексти в інпутах
      const tmpName = inputFrom.value;
      inputFrom.value = inputTo.value;
      inputTo.value = tmpName;

      // Міняємо збережені об'єкти точок
      const tmpStop = routeFromStop;
      routeFromStop = routeToStop;
      routeToStop = tmpStop;

      // Оновлюємо вигляд обох кнопок
      updateRouteButtonState(true);
      updateRouteButtonState(false);

      // Якщо обидва заповнені — запускаємо пошук нового маршруту
      if (routeFromStop && routeToStop) {
        document.getElementById('recent-routes-list').style.display = 'none';
        document.getElementById('route-search-btn')?.click();
      }
    }

    function applyMyCurrentLocation(isFrom) {
      const inputEl = document.getElementById(isFrom ? 'route-input-from' : 'route-input-to');
      const boxEl = document.getElementById(isFrom ? 'route-suggestions-from' : 'route-suggestions-to');

      if (locationService.getPosition()) {
        if (inputEl) inputEl.value = 'Moja lokalizacja';
        if (boxEl) {
          boxEl.innerHTML = '';
          boxEl.style.display = 'none';
        }

        const locObj = { name: 'Moja lokalizacja', isDynamicGps: true };

        if (isFrom) {
          routeFromStop = locObj;
        } else {
          routeToStop = locObj;
        }

        if (inputEl) inputEl.blur();
        updateRouteButtonState(isFrom);

        // Якщо обидві точки вже є — ховаємо останні маршрути і шукаємо
        if (routeFromStop && routeToStop) {
          const recentList = document.getElementById('recent-routes-list');
          if (recentList) recentList.style.display = 'none';
          document.getElementById('route-search-btn')?.click();
        }
      } else {
        if (typeof showToast === 'function') {
          showToast('Szukam lokalizacji GPS, spróbuj za sekundę...');
        } else {
          alert('Szukam lokalizacji GPS, spróbuj za sekundę...');
        }
      }
    }

    function setupRouteAutocomplete(inputId, suggestionsId, isFrom) {
        const input = document.getElementById(inputId);
        const suggestionsBox = document.getElementById(suggestionsId);
        const actionBtn = document.getElementById(isFrom ? 'route-clear-from' : 'route-clear-to');

        if (!input || !suggestionsBox) return;

        // ОБРОБКА КЛІКУ ПО КНОПЦІ В ПОЛІ
        if (actionBtn) {
            actionBtn.addEventListener('pointerdown', (e) => {
                e.preventDefault();
            });

            actionBtn.addEventListener('click', (e) => {
                e.preventDefault();

                // 1. Стан SWAP ⇅ (тільки для нижнього поля)
                if (actionBtn.classList.contains('icon-swap')) {
                    swapRoutePoints();
                    return;
                }

                // 2. Стан CLEAR ✕
                if (actionBtn.classList.contains('icon-clear')) {
                    input.value = '';
                    suggestionsBox.style.display = 'none';
                    if (isFrom) routeFromStop = null;
                    else routeToStop = null;

                    updateRouteButtonState(isFrom);
                    loadRouteDefaultSuggestions(isFrom);
                    input.focus();
                    return;
                }

                // 3. Стан GPS 📍
                if (actionBtn.classList.contains('icon-location')) {
                  applyMyCurrentLocation(isFrom);
                  return;
                }
            });
        }

        // Відстеження фокусу для перемикання ✕ на ⇅
        input.addEventListener('focus', () => {
            updateRouteButtonState(isFrom);
        });

        input.addEventListener('blur', () => {
            // Невелика затримка, щоб клік по Swap встиг зареєструватися
            setTimeout(() => updateRouteButtonState(isFrom), 150);
        });

        input.addEventListener('input', async (e) => {
            const query = e.target.value.trim();
            updateRouteButtonState(isFrom);

            if (query.length === 0) {
                if (isFrom) routeFromStop = null; else routeToStop = null;
                loadRouteDefaultSuggestions(isFrom);
                return;
            } else if (query.length < 2) {
                suggestionsBox.innerHTML = '';
                suggestionsBox.style.display = 'none';
                if (isFrom) routeFromStop = null; else routeToStop = null;
                return;
            }

            try {
                const stopsPromise = fetch(`${apiBaseUrl}/stops/search?q=${encodeURIComponent(query)}`)
                    .then(r => r.ok ? r.json() : []);

                const mapTilerUrl = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${getMapTilerKey()}&language=pl&autocomplete=true&bbox=22.35,51.11,22.75,51.36`;
                const geocodePromise = fetch(mapTilerUrl)
                    .then(r => r.ok ? r.json() : { features: [] });

                const [stops, geocodeData] = await Promise.all([stopsPromise, geocodePromise]);

                if (stops.length === 0 && (!geocodeData.features || geocodeData.features.length === 0)) {
                    suggestionsBox.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">Brak wyników</div>';
                    suggestionsBox.style.display = 'block';
                    return;
                }

                suggestionsBox.innerHTML = '';

                // Клік по зупинці
                if (stops.length > 0) {
                    const groupedStops = {};
                    stops.forEach(stop => {
                        if (!groupedStops[stop.name]) {
                            groupedStops[stop.name] = { name: stop.name, ids: [stop.stopId], routes: stop.routes ? [...stop.routes] : [] };
                        } else {
                            if (!groupedStops[stop.name].ids.includes(stop.stopId)) {
                                groupedStops[stop.name].ids.push(stop.stopId);
                            }
                            if (stop.routes) groupedStops[stop.name].routes.push(...stop.routes);
                        }
                    });

                    Object.values(groupedStops).forEach(group => {
                        const div = document.createElement('div');
                        div.className = 'stop-card';
                        div.style = 'padding: 12px 16px; cursor: pointer; border-bottom: 1px solid var(--border); background: var(--bg); display: flex; align-items: center; gap: 12px;';
                        div.innerHTML = `
                        <div style="-webkit-mask-image: url('stop.svg'); mask-image: url('stop.svg'); -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; background-color: var(--blue); width: 20px; height: 20px; flex-shrink: 0;"></div>
                        <div style="font-weight: bold; color: var(--text);">${group.name}</div>
                    `;

                        div.addEventListener('click', () => {
                            input.value = group.name;
                            suggestionsBox.innerHTML = '';
                            suggestionsBox.style.display = 'none';

                            const routeObj = { name: group.name, ids: group.ids };
                            if (isFrom) routeFromStop = routeObj;
                            else routeToStop = routeObj;

                            saveRecentRouteStop({ name: group.name, ids: group.ids });

                            // Знімаємо фокус і оновлюємо стан кнопки
                            input.blur();
                            updateRouteButtonState(isFrom);
                        });
                        suggestionsBox.appendChild(div);
                    });
                }

                // Клік по адресі (MapTiler)
                if (geocodeData.features && geocodeData.features.length > 0) {
                    geocodeData.features.slice(0, 4).forEach(feature => {
                        const div = document.createElement('div');
                        div.className = 'stop-card';
                        div.style = 'padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg); display: flex; align-items: center; justify-content: space-between; gap: 12px;';

                        const shortName = feature.text + (feature.address ? ' ' + feature.address : '');
                        const contextParts = feature.place_name.split(',').slice(1).join(',').trim();

                        div.innerHTML = `
                        <div class="address-main-click" style="display: flex; align-items: center; gap: 12px; flex: 1; cursor: pointer;">
                            <div class="svg-icon icon-map-pin" style="color: var(--text-muted); flex-shrink: 0;"></div>
                            <div style="overflow: hidden;">
                                <div style="font-weight: bold; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${shortName}</div>
                                <div style="font-size: 0.85em; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${contextParts}</div>
                            </div>
                        </div>
                        <div class="address-copy-btn" style="padding: 4px 8px; cursor: pointer; color: var(--text-muted); font-size: 20px; font-weight: bold; flex-shrink: 0;">↖</div>
                    `;

                        div.querySelector('.address-main-click').addEventListener('click', () => {
                            input.value = shortName;
                            suggestionsBox.innerHTML = '';
                            suggestionsBox.style.display = 'none';

                            const routeObj = { name: shortName, lat: feature.center[1], lon: feature.center[0] };
                            if (isFrom) routeFromStop = routeObj; else routeToStop = routeObj;
                            saveRecentRouteStop(routeObj);

                            // Знімаємо фокус і оновлюємо стан кнопки
                            input.blur();
                            updateRouteButtonState(isFrom);
                        });

                        div.querySelector('.address-copy-btn').addEventListener('click', (e) => {
                            e.stopPropagation();
                            input.value = shortName + ' ';
                            input.focus();
                            updateRouteButtonState(isFrom);
                        });

                        suggestionsBox.appendChild(div);
                    });
                }

                suggestionsBox.style.display = 'block';
            } catch (error) {
                console.error('Помилка пошуку:', error);
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !suggestionsBox.contains(e.target)) {
                suggestionsBox.style.display = 'none';
            }
        });
    }

    function groupStopsByNameAndDistance(stopsArray) {
        const grouped = {};
        stopsArray.forEach(stop => {
            // Беремо масив ids (якщо це з історії) або робимо масив з одного stopId (якщо з GPS)
            const currentIds = stop.ids ? stop.ids : (stop.stopId ? [stop.stopId] : []);

            if (!grouped[stop.name]) {
                grouped[stop.name] = {
                    name: stop.name,
                    ids: [...currentIds],
                    routes: stop.routes ? [...stop.routes] : [],
                    distance: stop.distance,
                    // ДОДАНО: Зберігаємо координати, якщо це адреса
                    lat: stop.lat,
                    lon: stop.lon
                };
            } else {
                // Безпечно докидаємо всі нові ID, яких ще немає в групі
                currentIds.forEach(id => {
                    if (!grouped[stop.name].ids.includes(id)) {
                        grouped[stop.name].ids.push(id);
                    }
                });
                // Докидаємо маршрути
                if (stop.routes) {
                    stop.routes.forEach(newRoute => {
                        if (!grouped[stop.name].routes.find(r => r.route === newRoute.route)) {
                            grouped[stop.name].routes.push(newRoute);
                        }
                    });
                }
            }
        });
        return Object.values(grouped);
    }

    function createRouteSuggestionElement(group, inputEl, suggestionsBoxEl, isFrom) {
        const item = document.createElement('div');
        item.className = 'stop-suggestion-item';

        const title = document.createElement('div');
        title.className = 'stop-suggestion-title';
        title.innerHTML = `${group.name}`; // БЕЗ КОДУ ПЛАТФОРМИ!

        if (group.distance) {
            title.innerHTML += ` <span style="float: right; font-size: 13px; color: #888;">${group.distance}m</span>`;
        }
        item.appendChild(title);

        if (group.routes && group.routes.length > 0) {
            const carousel = document.createElement('div');
            carousel.className = 'stop-routes-carousel';
            group.routes.forEach(r => {
                const pill = document.createElement('div');
                pill.className = 'route-pill';
                pill.innerHTML = `<span class="route-pill-num">${r.route}</span><span class="route-pill-dir">${r.direction}</span>`;
                carousel.appendChild(pill);
            });
            item.appendChild(carousel);
        }

        item.addEventListener('click', () => {
            inputEl.value = group.name;
            suggestionsBoxEl.style.display = 'none';

            const clearBtn = document.getElementById(isFrom ? 'route-clear-from' : 'route-clear-to');
            if (clearBtn) clearBtn.style.display = 'flex';

            // ДОДАНО: Розділяємо логіку для адрес і зупинок
            let routeObj;
            if (group.lat && group.lon) {
                routeObj = { name: group.name, lat: group.lat, lon: group.lon }; // Це адреса
            } else {
                routeObj = { name: group.name, ids: group.ids }; // Це зупинка
            }

            if (isFrom) routeFromStop = routeObj;
            else routeToStop = routeObj;

            // Зберігаємо в історію, оновлюючи її
            if (group.lat && group.lon) {
                saveRecentRouteStop(routeObj);
            } else {
                saveRecentRouteStop({ name: group.name, stopId: group.ids[0], code: '' });
            }
        });
        return item;
    }

    function loadRouteDefaultSuggestions(isFrom) {
        const inputEl = document.getElementById(isFrom ? 'route-input-from' : 'route-input-to');
        const boxEl = document.getElementById(isFrom ? 'route-suggestions-from' : 'route-suggestions-to');
    // === АБСОЛЮТНО АДАПТИВНА ВЕРСТКА ДЛЯ БУДЬ-ЯКОГО ЕКРАНА ===
        // 1. Отримуємо точні координати інпута на поточному телефоні
        const inputRect = inputEl.getBoundingClientRect();

        if (inputEl.value.trim() !== '') return;

        boxEl.innerHTML = '';
       // 2. Відриваємо список від звичайного потоку і робимо його "плаваючим"
        boxEl.style.position = 'fixed'; // Фіксуємо відносно екрана
        boxEl.style.left = '0';
        boxEl.style.right = '0';

        // 3. Прибиваємо верх списку рівно під інпут (додаємо 8px відступу для краси)
        boxEl.style.top = `${inputRect.bottom + 8}px`;

        // 4. Прибиваємо низ списку над твоєю навігацією
        // (заміни 70px на реальну висоту твого нижнього меню, зазвичай це 60-80px)
        boxEl.style.bottom = '70px';

        // 5. Вбиваємо старі конфлікти
        boxEl.style.maxHeight = 'none';
        boxEl.style.height = 'auto';
        boxEl.style.overflowY = 'auto';
        boxEl.style.backgroundColor = 'var(--bg)';
        boxEl.style.zIndex = '100';
        // ========================================================

        // 1. ОСТАННІ ПОШУКИ (Групуємо історію, щоб прибрати платформи, якщо вони там були)
        const recents = getRecentRouteStops();
        if (recents.length > 0) {
            const groupedRecents = groupStopsByNameAndDistance(recents);

            const recentsHeader = document.createElement('div');
            recentsHeader.style = 'padding: 10px; font-weight: bold; color: var(--blue); display: flex; align-items: center; gap: 12px;';
            recentsHeader.innerHTML = '<div class="svg-icon icon-clock"></div> Ostatnio wyszukiwane';
            boxEl.appendChild(recentsHeader);

            groupedRecents.forEach(group => {
                boxEl.appendChild(createRouteSuggestionElement(group, inputEl, boxEl, isFrom));
            });
        }

        // 2. ЗУПИНКИ ПОРУЧ (GPS)
        const nearbyContainer = document.createElement('div');
        nearbyContainer.id = `nearby-route-container-${isFrom ? 'from' : 'to'}`;
        nearbyContainer.style.margin = '0';
        nearbyContainer.style.padding = '0';
        boxEl.appendChild(nearbyContainer);
        boxEl.style.display = 'block';

      const fetchAndShow = async (lat, lon) => {
            try {
                const nearbyResult = getNearbyStops(apiBaseUrl, lat, lon);
                const apiGroups = nearbyResult instanceof Promise ? await nearbyResult : nearbyResult;

                // Відмальовуємо результати
                renderNearby(apiGroups);

            } catch (error) {
                nearbyContainer.innerHTML = `<div style="padding: 10px; color: red;">Błąd lokalizacji</div>`;
            }
        };

        // Окрема міні-функція для відмальовки (щоб не дублювати код)
        const renderNearby = (apiGroups) => {
            if (apiGroups.length === 0) {
                nearbyContainer.innerHTML = `<div style="padding: 10px; color: var(--text-muted);">Brak przystanków w pobliżu 😕</div>`;
                return;
            }

            // Збираємо всі зупинки з API в один плоский масив і чіпляємо дистанцію
            let flatNearbyStops = [];
            apiGroups.forEach(g => {
                g.stops.forEach(s => {
                    s.distance = g.distance;
                    flatNearbyStops.push(s);
                });
            });

            // Групуємо їх за назвою (зливаємо 01, 02 і т.д.)
            const groupedNearby = groupStopsByNameAndDistance(flatNearbyStops);

            nearbyContainer.innerHTML = '<div style="padding: 10px; font-weight: bold; color: var(--blue); display: flex; align-items: center; gap: 12px;"><div class="svg-icon icon-walk"></div> Przystanki w pobliżu</div>';

            groupedNearby.forEach(group => {
                nearbyContainer.appendChild(createRouteSuggestionElement(group, inputEl, boxEl, isFrom));
            });
        };
        // 3. ПЕРЕВІРКА GPS ТА ЗАПУСК
        const pos = locationService.getPosition();
        if (pos) {
            fetchAndShow(pos.lat, pos.lon);
        } else {
            nearbyContainer.innerHTML = '<div style="padding: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 12px;"><div class="svg-icon icon-map-pin"></div>Szukam lokalizacji...</div>';
            if (locationService.isSupported()) {
                locationService.requestPosition(
                    (pos) => fetchAndShow(pos.coords.latitude, pos.coords.longitude),
                    () => { nearbyContainer.innerHTML = '<div style="padding: 10px; color: red;">Włącz GPS, aby zobaczyć pobliskie przystanki</div>'; },
                    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
                );
            }
        }
    }

    function formatTime(minutes) {
        // Додаємо % 24, щоб після 23:59 годинник скидався на 00:xx
        const h = (Math.floor(minutes / 60) % 24).toString().padStart(2, '0');
        const m = (minutes % 60).toString().padStart(2, '0');
        return `${h}:${m}`;
    }

    function coloredTimeHtml(min, delay) {
        const timeStr = formatTime(min);
        if (delay > 0) return `<span style="color: var(--danger); font-weight: 700;">${timeStr}</span>`;
        if (delay < 0) return `<span style="color: var(--blue); font-weight: 700;">${timeStr}</span>`;
        return timeStr;
    }

    function rowLiveMin(row) {
        return parseInt(row.dataset.min, 10)
            + parseInt(row.dataset.delay, 10) - parseInt(row.dataset.delayInitial, 10);
    }

    async function updateTrasaCountdowns() {
        const timelines = document.querySelectorAll('.trasa-timeline');
        if (timelines.length === 0) return;

        // 1. Збираємо всі tripId з рядків на екрані
        const tripIds = new Set();
        timelines.forEach(timeline => {
            timeline.querySelectorAll('.trasa-row[data-trip-id]').forEach(row => {
                if (row.dataset.tripId) tripIds.add(row.dataset.tripId);
            });
        });

        // 2. Робимо запит на сервер за новими затримками
        let liveDelays = {};
        if (tripIds.size > 0) {
            try {
                const res = await fetch(`${apiBaseUrl}/live-vehicles/delays?tripIds=${Array.from(tripIds).join(',')}`);
                if (res.ok) {
                    liveDelays = await res.json();
                }
            } catch (e) {
                console.warn('Не вдалося оновити LIVE затримки:', e);
            }
        }

        const now = new Date();

        timelines.forEach(timeline => {
            const rows = [...timeline.querySelectorAll('.trasa-row[data-trip-id]')];
            if (rows.length === 0) return;

            // 3. Кожен рядок бере затримку СВОГО рейсу. Якщо рейс зараз без GPS —
            // лишаємо останню відому затримку, а не скидаємо в 0
            rows.forEach(row => {
                const info = liveDelays[row.dataset.tripId];
                if (info && info.isRealTime) {
                    row.dataset.delay = info.delayMinutes;
                    row.dataset.live = 'true';
                }
                const timeEl = row.querySelector('.time');
                if (timeEl) timeEl.innerHTML = coloredTimeHtml(rowLiveMin(row), parseInt(row.dataset.delay, 10));
            });

            // 4. Перевірка пересадок: та сама умова, що в RoutingGraph —
            // наступний рейс має відправитись не раніше ніж прибуття + пішки + 1 хв
            rows.forEach((row, k) => {
                if (row.dataset.nextDep === undefined || !rows[k + 1]) return;
                const next = rows[k + 1];
                const nextDepLive = parseInt(row.dataset.nextDep, 10)
                    + parseInt(next.dataset.delay, 10) - parseInt(next.dataset.delayInitial, 10);
                const walk = parseInt(row.dataset.transferWalk || '0', 10);
                const missed = rowLiveMin(row) + walk + 1 > nextDepLive;

                const warn = row.querySelector('.trasa-transfer-warn');
                if (warn) warn.hidden = !missed;
                row.title = missed ? 'Możesz nie zdążyć na przesiadkę' : '';
            });

            const firstRow = rows[0];
            const lastRow = rows[rows.length - 1];
            const firstDelay = parseInt(firstRow.dataset.delay, 10);
            const isLive = firstRow.dataset.live === 'true';

            // 5. Таймер відправлення — за першим рейсом
            const timerEl = timeline.querySelector('.trasa-dep-min');
            if (timerEl) {
                const expectedDepartureMin = rowLiveMin(firstRow);

                // --- ЧИСТА МАТЕМАТИКА ТАЙМЕРА (БЕЗ 1440) ---
                // JS Date сам перемкне день вперед, якщо expectedDepartureMin >= 1440
                const depDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(expectedDepartureMin / 60), expectedDepartureMin % 60, 0);
                const diffMs = depDate - now;
                let countdown = Math.max(0, Math.floor(diffMs / 60000));

                function getMinLabel(m) {
                    if (m === 1) return 'minuta';
                    const mod10 = m % 10;
                    const mod100 = m % 100;
                    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'minuty';
                    return 'minut';
                }

                const liveBadgeHtml = isLive
                    ? `<span style="color: #ef4444; font-size: 9px; font-weight: 900; letter-spacing: 0.5px; margin-bottom: 2px; animation: trasaLiveBlink 1.5s infinite;">LIVE</span>`
                    : '';

                let timerHtml = '';
                if (countdown < 60) {
                    let numStr = countdown === 0 ? '<1' : countdown;
                    let labelStr = countdown === 0 ? 'minuta' : getMinLabel(countdown);
                    let colorStr = countdown <= 30 ? '#10b981' : 'var(--text)';

                    timerHtml = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1;">
                    ${liveBadgeHtml}
                    <span style="font-size:26px; font-weight:800; color:${colorStr}; letter-spacing:-1px;">${numStr}</span>
                    <span style="font-size:10px; font-weight:700; color:${colorStr}; text-transform:uppercase; letter-spacing:0.5px; margin-top:2px; opacity:0.8;">${labelStr}</span>
                </div>`;
                } else {
                    const h = Math.floor(countdown / 60);
                    const m = countdown % 60;
                    const hStr = String(h).padStart(1, '0');
                    const mStr = String(m).padStart(2, '0');

                    timerHtml = `
                <div style="display:flex; flex-direction:column; align-items:center; line-height:1;">
                    <span style="font-size:10px; font-weight:600; color:var(--text); opacity:0.8; margin-bottom:3px;">
                        odjazd za:
                    </span>
                    <span style="font-size:16px; font-weight:700; color:var(--text);">
                        ${hStr}h ${mStr}m
                    </span>
                </div>`;
                }

                timerEl.innerHTML = timerHtml;
            }

            // 6. Шапка: статус першого рейсу + тривалість (перший і останній рейси можуть мати різні затримки)
            const trasaCard = timeline.closest('.trasa-card');
            if (trasaCard) {
                const statusWrap = trasaCard.querySelector('.trasa-header-status-wrap');
                if (statusWrap) statusWrap.innerHTML = getLiveStatusBadge(isLive, firstDelay);

                const durationEl = trasaCard.querySelector('.trasa-duration');
                if (durationEl) durationEl.textContent = `${Math.max(0, rowLiveMin(lastRow) - rowLiveMin(firstRow))}m`;
            }
        });

        // 7. Розгорнута картка: зупинки сіріють, поки автобус їде
        await refreshOpenTrasaPassedStops();
    }

    function splitStopName(fullName) {
        if (!fullName) return { name: '', code: '' };
        const parts = fullName.split(' ');
        const lastPart = parts[parts.length - 1];

        // Перевіряємо, чи останнє слово - це рівно 2 цифри (код платформи, напр "01")
        if (/^\d{2}$/.test(lastPart)) {
            parts.pop();
            return { name: parts.join(' '), code: lastPart };
        }

        // Якщо це адреса ("Biłgorajska 24") або системна мітка - повертаємо як є
        return { name: fullName, code: '' };
    }

    function getLiveStatusBadge(isLive, delayMinutes) {
        if (!isLive) return ''; // Якщо немає GPS-даних, нічого не показуємо

        // Зменшили іконки з 20px до 18px, щоб вони пасували до компактного тексту
        const iconStyle = "width:18px; height:18px; flex-shrink:0; display:inline-block; transform: translateY(0px);";

        if (delayMinutes > 0) {
            // Запізнюється (червоний + іконка slow)
            return `<div style="display:flex; align-items:center; gap:2px; color: var(--danger);"><div class="svg-icon icon-slow" style="${iconStyle}"></div>+${delayMinutes}m</div> <span style="opacity:0.4">•</span> `;
        } else if (delayMinutes < 0) {
            // Поспішає (синій + іконка fast)
            return `<div style="display:flex; align-items:center; gap:2px; color: var(--blue);"><div class="svg-icon icon-fast" style="${iconStyle}"></div>-${Math.abs(delayMinutes)}m</div> <span style="opacity:0.4">•</span> `;
        } else {
            // Чітко за розкладом (зелений + іконка ok)
            return `<div style="display:flex; align-items:center; color: #10b981;"><div class="svg-icon icon-ok" style="${iconStyle}"></div></div> <span style="opacity:0.4">•</span> `;
        }
    }

    function buildJourneyCard(journey) {
        const legs = journey.legs;
        if (!legs || legs.length === 0) return null;

        const transitLegs = legs.filter(l => l.route !== "Пішки" && l.route);
        if (transitLegs.length === 0) return null;

        const firstLeg = legs[0];
        const lastLeg = legs[legs.length - 1];
        const firstTransitLeg = transitLegs[0];
        const lastTransitLeg = transitLegs[transitLegs.length - 1];

        const initialWalkLeg = (firstLeg.route === "Пішки" || !firstLeg.route) ? firstLeg : null;
        const walkMinRaw = initialWalkLeg ? Math.max(0, initialWalkLeg.arrivalMin - initialWalkLeg.departureMin) : 0;
        const walkMin = Math.round(walkMinRaw * 1.8); // Наш множник для реальності

        const finalWalkLeg = (lastLeg.route === "Пішки" || !lastLeg.route) ? lastLeg : null;
        const finalWalkMinRaw = finalWalkLeg ? Math.max(0, finalWalkLeg.arrivalMin - finalWalkLeg.departureMin) : 0;
        const finalWalkMin = Math.round(finalWalkMinRaw * 1.8); // Наш множник для реальності

        // Коригуємо загальний час у дорозі, щоб математика зійшлася
        const extraWalkTime = (walkMin - walkMinRaw) + (finalWalkMin - finalWalkMinRaw);

        // Прив'язка рядка таймлайну до рейсу: updateTrasaCountdowns зсуває кожен рядок
        // на затримку саме його рейсу (min — час від бекенда, уже із затримкою)
        const rowAttrs = (leg, min) => {
            const d = leg.delayMinutes || 0;
            return `data-trip-id="${leg.tripId || ''}" data-min="${min}" data-delay="${d}" data-delay-initial="${d}" data-live="${leg.isRealTime ? 'true' : 'false'}"`;
        };

        // Пішки між двома рейсами (сирі хвилини бекенда — та сама умова, що в роутингу)
        const transferWalkMin = (fromLeg, toLeg) => legs
            .slice(legs.indexOf(fromLeg) + 1, legs.indexOf(toLeg))
            .filter(l => l.route === "Пішки" || !l.route)
            .reduce((sum, l) => sum + Math.max(0, l.arrivalMin - l.departureMin), 0);

        const depTime = coloredTimeHtml(firstTransitLeg.departureMin, firstTransitLeg.delayMinutes || 0);
        const arrTime = coloredTimeHtml(lastTransitLeg.arrivalMin, lastTransitLeg.delayMinutes || 0);
        // Рахуємо суто час від посадки в перший автобус до висадки з останнього
        // departureMin/arrivalMin від бекенда вже з урахуванням затримки
        const transitStart = firstTransitLeg.departureMin;
        const transitEnd = lastTransitLeg.arrivalMin;
        const duration = Math.max(0, transitEnd - transitStart);

        const now = new Date();
        const delay = firstTransitLeg.delayMinutes || 0;
        const isLive = firstTransitLeg.isRealTime || false;
        let expectedDepartureMin = firstTransitLeg.departureMin;

        // ❌ ВСІ ХАКИ З 1440 ВИДАЛЕНО! ❌
        // Більше не треба перевіряти "нічні" чи "завтрашні" рейси.
        // Якщо бекенд прислав 1450 хвилин (00:10 ночі наступного дня),
        // JS Date сам перекине дату на завтра!

        const depDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(expectedDepartureMin / 60), expectedDepartureMin % 60, 0);
        const diffMs = depDate - now;
        let countdown = Math.max(0, Math.floor(diffMs / 60000));

        function getMinLabel(m) {
            if (m === 1) return 'minuta';
            const mod10 = m % 10;
            const mod100 = m % 100;
            if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'minuty';
            return 'minut';
        }

        let timerHtml = '';
        if (countdown < 60) {
            let numStr = countdown === 0 ? '<1' : countdown;
            let labelStr = countdown === 0 ? 'minuta' : getMinLabel(countdown);
            let colorStr = countdown <= 30 ? '#10b981' : 'var(--text)';

            timerHtml = `
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1;">
            <span style="font-size:26px; font-weight:800; color:${colorStr}; letter-spacing:-1px;">${numStr}</span>
            <span style="font-size:10px; font-weight:700; color:${colorStr}; text-transform:uppercase; letter-spacing:0.5px; margin-top:2px; opacity:0.8;">${labelStr}</span>
        </div>`;
        } else {
        const h = Math.floor(countdown / 60);
        const m = countdown % 60;
        const hStr = String(h).padStart(1, '0');
        const mStr = String(m).padStart(2, '0');

        timerHtml = `
    <div style="display:flex; flex-direction:column; align-items:center; line-height:1;">
        <span style="font-size:10px; font-weight:600; color:var(--text); opacity:0.8; margin-bottom:3px;">
            odjazd za:
        </span>
        <span style="font-size:16px; font-weight:700; color:var(--text);">
            ${hStr}h ${mStr}m
        </span>
    </div>`;
    }

        const startName = firstTransitLeg.fromStopName;
        const endName = lastTransitLeg.toStopName;
        const fromStop = splitStopName(startName);
        const toStop = splitStopName(endName);

        let timelineHtml = '<div class="trasa-timeline" style="position:relative; margin: 0px 0 2px;">';
        timelineHtml += '<div style="position:absolute; left: 55px; top: 8px; bottom: 8px; border-left: 2px dotted var(--border); z-index: 1;"></div>';

        const rowStyle = 'position:relative; padding:2px 0; display: flex; align-items: center;';
        const timeStyle = 'width: 44px; text-align: center; font-size: 15px; font-weight: 600; color: var(--text); flex-shrink: 0;';
        const dotWrapperStyle = 'width: 24px; display: flex; justify-content: center; z-index: 2; flex-shrink: 0;';

        // 1. ПЕРША ЗУПИНКА
        timelineHtml += `<div class="trasa-row" ${rowAttrs(firstTransitLeg, firstTransitLeg.departureMin)} style="${rowStyle}">
        <div class="time" style="${timeStyle}">${depTime}</div>
        <div style="${dotWrapperStyle}"><div style="width: 8px; height: 8px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 3px var(--card);"></div></div>
        <div class="stop-name" style="flex: 1; font-size: 15px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; padding-right: 65px;">${fromStop.name} ${fromStop.code ? `<span class="stop-code" style="color:var(--text); font-size:15px; font-weight:600;">(${fromStop.code})</span>` : ''}</div>
    </div>`;

        // 2. ПРОМІЖНІ ЗУПИНКИ
        for (let i = 0; i < transitLegs.length - 1; i++) {
            const tStop = splitStopName(transitLegs[i].toStopName);
            const nextLeg = transitLegs[i + 1];
            timelineHtml += `<div class="trasa-row" ${rowAttrs(transitLegs[i], transitLegs[i].arrivalMin)} data-next-dep="${nextLeg.departureMin}" data-transfer-walk="${transferWalkMin(transitLegs[i], nextLeg)}" style="${rowStyle} opacity: 0.8;">
            <div class="time" style="${timeStyle} font-size: 14px; font-weight: 500; color: var(--text-muted);">${coloredTimeHtml(transitLegs[i].arrivalMin, transitLegs[i].delayMinutes || 0)}</div>
            <div style="${dotWrapperStyle}"><div style="width: 8px; height: 8px; border-radius: 50%; background: var(--border); box-shadow: 0 0 0 3px var(--card);"></div></div>
            <div class="stop-name" style="flex: 1; font-size: 14px; font-weight: 500; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; padding-right: 65px;"><span class="trasa-transfer-warn" hidden style="color: var(--danger); font-weight: 700;">⚠ Zagrożona przesiadka · </span>➔ ${tStop.name} ${tStop.code ? `<span class="stop-code" style="font-size: 14px; font-weight: 500; color: var(--text-muted);">(${tStop.code})</span>` : ''}</div>
        </div>`;
        }

        // 3. ОСТАННЯ ЗУПИНКА
        timelineHtml += `<div class="trasa-row" ${rowAttrs(lastTransitLeg, lastTransitLeg.arrivalMin)} style="${rowStyle}">
        <div class="time" style="${timeStyle}">${arrTime}</div>
        <div style="${dotWrapperStyle}"><div style="width: 8px; height: 8px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 3px var(--card);"></div></div>
        <div class="stop-name" style="flex: 1; font-size: 15px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; padding-right: 65px;">${toStop.name} ${toStop.code ? `<span class="stop-code" style="color:var(--text); font-size:15px; font-weight:600;">(${toStop.code})</span>` : ''}</div>
    </div>`;

        // 4. ТАЙМЕР АБСОЛЮТНИЙ (відцентрований відносно всього таймлайну!)
        timelineHtml += `<div class="trasa-dep-min" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); z-index: 5;">${timerHtml}</div>`;

        timelineHtml += '</div>';

        let busesHtml = '';
        transitLegs.forEach(leg => {
            const isTrolley = parseInt(leg.route, 10) >= 150 ? ' trolleybus' : '';
            busesHtml += `<div class="dep-route-box route-size-3${isTrolley}" style="width: 28px; height: 28px; font-size: 13px; border-width: 1.5px; background: var(--bg); border-color: var(--blue); color: var(--blue); display: flex; align-items: center; justify-content: center; border-radius: 6px; position: relative;">${leg.route}</div>`;
        });

            let compactHeaderHtml = `
    <div class="trasa-compact-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;">
        <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            ${busesHtml}
        </div>
        <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
            <!-- НОВИЙ БЛОК: Динамічний статус -->
            <div class="trasa-header-status-wrap" style="display:flex; align-items:center; gap:4px;">
                ${getLiveStatusBadge(isLive, delay)}
            </div>
            <!-- Далі твій старий код пішоходів і годинника -->
            ${walkMin > 0 ? `<div style="display:flex; align-items:center; gap:2px;"><div class="svg-icon icon-walk" style="width:13px;height:13px;"></div>${walkMin}m</div> <span style="opacity:0.4">•</span>` : ''}
            <div style="display:flex; align-items:center; gap:3px; color: var(--text-muted);">
                <div class="svg-icon icon-bus-ride" style="width:20px;height:16px; color:var(--text-muted);"></div><span class="trasa-duration">${duration}m</span>
            </div>
            ${finalWalkMin > 0 ? `<span style="opacity:0.4">•</span> <div style="display:flex; align-items:center; gap:2px;"><div class="svg-icon icon-walk" style="width:13px;height:13px;"></div>${finalWalkMin}m</div>` : ''}
        </div>
    </div>`;


        const wrapper = document.createElement('div');
        wrapper.className = 'trasa-wrapper';
        const card = document.createElement('div');
        card.className = 'trasa-card expandable';
        card.style.cursor = 'pointer';

        card.innerHTML = `
        <button class="close-trasa-btn" title="Zamknij">✕</button>
        ${compactHeaderHtml}
        <div class="trasa-middle-scroll" style="display: none;"></div>
        <div class="trasa-details">
            ${timelineHtml}
        </div>
    `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('.dep-expand-map-btn')) return;
            toggleTrasaExpand(card, legs, transitLegs);
        });

        wrapper.appendChild(card);

        return wrapper;
    }

    async function refreshOpenTrasaPassedStops() {
        const containers = document.querySelectorAll('.trasa-card.fullscreen-expanded .trasa-leg-stops[data-trip-id]');
        await Promise.all([...containers].map(async container => {
            const { tripId, fromStopId, toStopId } = container.dataset;
            const stops = await fetchLegStops({ tripId, fromStopId, toStopId });
            const rows = container.querySelectorAll('.trasa-leg-stop');
            // Рядки рендерились із того самого запиту, тож порядок збігається; інакше — не чіпаємо
            if (stops.length !== rows.length) return;
            rows.forEach((row, i) => row.classList.toggle('dep-expand-stop-passed', !!stops[i].isPassed));
        }));
    }

    async function fetchLegStops(leg) {
        if (!leg.tripId || leg.tripId === 'WALK' || !leg.fromStopId) return [];
        try {
            const res = await fetch(`${apiBaseUrl}/trips/${leg.tripId}/upcoming-stops?fromStopId=${encodeURIComponent(leg.fromStopId)}`);
            if (!res.ok) return [];
            const stops = await res.json();
            // Матчимо по toStopId (реальний ID зупинки висадки), а не по назві —
            // назви можуть повторюватись раніше в маршруті й обрізати список зарано.
            const cutIdx = leg.toStopId
                ? stops.findIndex(s => s.stopId === leg.toStopId)
                : -1;
            return cutIdx >= 0 ? stops.slice(0, cutIdx + 1) : stops.slice(0, 8);
        } catch (e) {
            return [];
        }
    }

    async function toggleTrasaExpand(card, legs, transitLegs) {
        const isOpen = card.classList.contains('fullscreen-expanded');
        const scrollPanel = card.querySelector('.trasa-middle-scroll');

        document.querySelectorAll('.trasa-card.fullscreen-expanded').forEach(c => {
            if (c !== card) {
                c.classList.remove('fullscreen-expanded');
                const p = c.querySelector('.trasa-middle-scroll');
                if (p) { p.innerHTML = ''; p.style.display = 'none'; }
            }
        });

        if (isOpen) {
                // Якщо клікнули на відкритий акордеон — просто робимо крок назад
                onBack();
                return;
            }

            // ДОДАЄМО: записуємо відкриття акордеону в історію
            onAccordionOpen();

            card.classList.add('fullscreen-expanded');
            scrollPanel.style.display = 'block';
            scrollPanel.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-muted);">Ładowanie trasy...</div>';
        try {
            const legStopsResults = await Promise.all(transitLegs.map(fetchLegStops));

            let html = '';
            const mapActions = [];
            let transitIdx = 0;

            legs.forEach((leg, i) => {
                        const isWalk = leg.route === 'Пішки' || !leg.route;
                        const hasNextLeg = i < legs.length - 1; // Чи є наступний крок маршруту

                        // БЛОК 1: Пішохідний перехід
                        if (isWalk) {
                            const walkMinRaw = Math.max(0, leg.arrivalMin - leg.departureMin);
                            const walkMin = Math.round(walkMinRaw * 1.8);

                            // Якщо це найперший крок (старт з адреси)
                            if (i === 0) {
                                html += `
                            <div style="position: relative; padding: 10px 14px 10px 42px; display: flex; align-items: center;">
                                <div style="position: absolute; left: 21px; top: 50%; transform: translateY(-50%); width: 12px; height: 12px; border-radius: 50%; background: var(--danger); z-index: 2;"></div>
                                <div style="position: absolute; left: 26px; top: 50%; bottom: 0; border-left: 2px dashed var(--border); z-index: 1;"></div>                                <span style="font-weight: 700; color: var(--text); font-size: 15px;">${routeFromStop.name}</span>
                            </div>`;
                            }

                            // Сам піший перехід (використовуємо абсолютну лінію для ідеального зшивання)
                            html += `
                        <div style="position: relative; padding: 12px 14px 12px 42px; background: rgba(0,0,0,0.02); display: flex; align-items: center;">
                            <div style="position: absolute; left: 26px; top: 0; bottom: 0; border-left: 2px dashed var(--border); z-index: 1;"></div>
                            <div class="svg-icon icon-walk" style="width:16px; height:16px; margin-right:8px; color: var(--text-muted); position: relative; z-index: 2;"></div>
                            <span style="font-weight: 600; font-size: 14px; color: var(--text-muted); position: relative; z-index: 2;">Przejście pieszo: ${walkMin} min</span>
                        </div>`;

                            // Якщо це останній крок (фініш), малюємо червону крапку адреси
                            if (!hasNextLeg) {
                                html += `
                            <div style="position: relative; padding: 10px 14px 10px 42px; display: flex; align-items: center;">
                                <div style="position: absolute; left: 26px; top: 0; bottom: 50%; border-left: 2px dashed var(--border); z-index: 1;"></div>
                                <div style="position: absolute; left: 21px; top: 50%; transform: translateY(-50%); width: 12px; height: 12px; border-radius: 50%; background: var(--danger); z-index: 2;"></div>
                                <span style="font-weight: 700; color: var(--text); font-size: 15px;">${routeToStop.name}</span>
                            </div>`;
                            }
                            return;
                        }

                        // БЛОК 2: Транспорт
                        const stops = legStopsResults[transitIdx] || [];
                        const routeNum = parseInt(leg.route, 10);
                        const trolleyClass = (routeNum >= 150) ? ' trolleybus' : '';

                        let openMap = () => showVehicleOnMap(String(leg.tripId));
                        if (stops.length >= 2 && stops[0].lon && stops[stops.length - 1].lon) {
                            const fromCoord = [stops[0].lon, stops[0].lat];
                            const toCoord = [stops[stops.length - 1].lon, stops[stops.length - 1].lat];
                            openMap = () => showVehicleOnMap(String(leg.tripId), {
                                mode: 'trasa', fromCoords: fromCoord, toCoords: toCoord
                            });
                        }
                        mapActions.push(openMap);

                        // МАГІЯ ЗШИВАННЯ: Прокидаємо лінію під заголовком "Wsiądź" від попереднього кроку
                        let headerLine = '';
                        if (i > 0) {
                            const isPrevWalk = legs[i - 1].route === 'Пішки' || !legs[i - 1].route;
                            const borderStyle = isPrevWalk ? 'border-left: 2px dashed var(--border);' : 'width: 2px; background: var(--border);';
                            headerLine = `<div style="position: absolute; left: 26px; top: 0; bottom: 0; ${borderStyle} z-index: 1;"></div>`;
                        }

                        html += `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--bg); position: sticky; top: 0; z-index: 10; border-bottom: 2px solid var(--border);">
                        ${headerLine}
                        <div style="display: flex; align-items: center; gap: 10px; position: relative; z-index: 2; margin-left: 28px;">
                            <div class="dep-route-box trasa-detail-box${trolleyClass}">${leg.route}</div>
                            <span style="font-weight: 700; color: var(--text); font-size: 15px;">Wsiądź</span>
                        </div>
                        <button class="dep-expand-map-btn" style="margin: 0; width: auto; background: rgba(25, 118, 210, 0.1); color: var(--blue); border: none; border-radius: 8px; padding: 6px 12px; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px; position: relative; z-index: 2;">
                            <div class="svg-icon icon-map-pin" style="width: 14px; height: 14px;"></div> Mapa
                        </button>
                    </div>`;

                        // БЛОК 3: Список зупинок
                        const legRow = [...card.querySelectorAll('.trasa-row[data-trip-id]')].find(r => r.dataset.tripId === leg.tripId);
                        const delay = legRow ? parseInt(legRow.dataset.delay, 10) : (leg.delayMinutes || 0);

                        const stopsHtml = stops.length ? stops.map((s, index) => {
                            const stopName = s.name || '';
                            const platformCode = s.platformCode || '';

                            const isFirst = index === 0;
                            const isLast = index === stops.length - 1;
                            const isImportant = isFirst || isLast;

                            const fontWeight = isImportant ? '700' : '500';
                            const textColor = isImportant ? 'var(--text)' : 'var(--text-muted)';
                            const dotColor = isImportant ? 'var(--blue)' : 'var(--border)';
                            const dotSize = isImportant ? '12px' : '8px';
                            const dotLeft = isImportant ? '21px' : '23px';

                            let realEta = s.eta;
                            if (delay !== 0 && s.eta.includes(':')) {
                                realEta = addMinutesToTime(s.eta, delay);
                            }

                            // Малюємо суцільну лінію вниз. Якщо це остання зупинка, але є наступний етап (напр. пішки), тягнемо лінію до низу блоку
                            const drawLineDown = !isLast || hasNextLeg;
                            const lineBottom = !isLast ? '-50%' : '0';

                            return `
                        <div class="trasa-leg-stop${s.isPassed ? ' dep-expand-stop-passed' : ''}" style="position: relative; padding: 10px 14px 10px 42px; display: flex; justify-content: space-between; align-items: center;">
                            <div style="position: absolute; left: ${dotLeft}; top: 50%; transform: translateY(-50%); width: ${dotSize}; height: ${dotSize}; border-radius: 50%; background: ${dotColor}; z-index: 2;"></div>

                            ${drawLineDown ? `<div style="position: absolute; left: 26px; top: 50%; bottom: ${lineBottom}; width: 2px; background: var(--border); z-index: 1;"></div>` : ''}

                            <span style="font-weight: ${fontWeight}; color: ${textColor}; font-size: 15px;">
                                ${stopName}
                                <span class="stop-code" style="color:${textColor}; font-size:13px; font-weight: 500;">${platformCode}</span>
                            </span>
                            <span style="font-weight: ${fontWeight}; color: ${textColor}; font-size: 15px;">${realEta}</span>
                        </div>`;
                        }).join('') : '<div style="padding: 10px; text-align: center; color: var(--text-muted);">Brak danych</div>';

                        html += `<div class="trasa-leg-stops" data-trip-id="${leg.tripId || ''}" data-from-stop-id="${leg.fromStopId || ''}" data-to-stop-id="${leg.toStopId || ''}" style="padding-bottom: 0;">${stopsHtml}</div>`;
                        transitIdx++;
                    });
            scrollPanel.innerHTML = html || '<div style="text-align:center; padding: 20px;">Błąd ładowania</div>';
            scrollPanel.querySelectorAll('.dep-expand-map-btn').forEach((button, index) => {
                button.addEventListener('click', mapActions[index]);
            });

            // Блокуємо згортання при кліках всередині списку (крім мапи)
            scrollPanel.onclick = (e) => {
                if (!e.target.closest('.dep-expand-map-btn')) {
                    e.stopPropagation();
                }
            };

        } catch (e) {
            scrollPanel.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--danger);">Błąd serwera</div>';
        }
    }

    function enterPlanner() {
        updateRouteButtonState(true);
        updateRouteButtonState(false);
        renderRecentRoutes();
    }

    function closePlannerAccordion() {
        document.querySelectorAll('.trasa-card.fullscreen-expanded').forEach(card => {
            card.classList.remove('fullscreen-expanded');
            const p = card.querySelector('.trasa-middle-scroll');
            if (p) {
                p.innerHTML = '';
                p.style.display = 'none';
            }
        });
    }

    function initPlanner() {
        if (initialized) return;
        initialized = true;
        setupRouteAutocomplete('route-input-from', 'route-suggestions-from', true);
        setupRouteAutocomplete('route-input-to', 'route-suggestions-to', false);
        updateRouteButtonState(true);
        updateRouteButtonState(false);
        document.getElementById('route-input-from').addEventListener('focus', () => loadRouteDefaultSuggestions(true));
        document.getElementById('route-input-to').addEventListener('focus', () => loadRouteDefaultSuggestions(false));
        searchRouteBtn = document.getElementById('route-search-btn');
        routeResultsBox = document.getElementById('route-results-list');
        if (searchRouteBtn && routeResultsBox) {
            searchRouteBtn.addEventListener('click', async () => {

                if (routeFromStop && routeFromStop.isDynamicGps) {
                    const pos = locationService.getPosition();
                    if (pos) {
                        routeFromStop.lat = pos.lat;
                        routeFromStop.lon = pos.lon;
                    } else {
                        showToast('Błąd: Brak sygnału GPS. Poczekaj chwilę.');
                        return;
                    }
                }

                if (routeToStop && routeToStop.isDynamicGps) {
                    const pos = locationService.getPosition();
                    if (pos) {
                        routeToStop.lat = pos.lat;
                        routeToStop.lon = pos.lon;
                    } else {
                        showToast('Błąd: Brak sygnału GPS. Poczekaj chwilę.');
                        return;
                    }
                }

                if (!routeFromStop || !routeToStop) {
                    showToast('Wybierz przystanek początkowy i końcowy z listy!');
                    return;
                }

                saveRecentRoute(routeFromStop, routeToStop);
                const recentRoutesContainer = document.getElementById('recent-routes-list');
                if (recentRoutesContainer) recentRoutesContainer.style.display = 'none';

                routeResultsBox.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 40px;">Szukam połączeń... <div class="svg-icon icon-hourglass"></div></div>';

                let fromParams = '';
                if (routeFromStop.ids) {
                    fromParams = `from=${routeFromStop.ids.join(',')}`;
                } else if (routeFromStop.lat && routeFromStop.lon) {
                    fromParams = `fromLat=${routeFromStop.lat}&fromLon=${routeFromStop.lon}`;
                }

                let toParams = '';
                if (routeToStop.ids) {
                    toParams = `to=${routeToStop.ids.join(',')}`;
                } else if (routeToStop.lat && routeToStop.lon) {
                    toParams = `toLat=${routeToStop.lat}&toLon=${routeToStop.lon}`;
                }

                try {
                    const res = await fetch(`${apiBaseUrl}/route/complex?${fromParams}&${toParams}&limit=8`);
                    if (!res.ok) throw new Error('Помилка сервера');

                    const journeys = await res.json();
                    routeResultsBox.innerHTML = '';

                    journeys.sort((a, b) => {
            const aBus = a.legs.find(l => l.route !== "Пішки") || a.legs[0];
            const bBus = b.legs.find(l => l.route !== "Пішки") || b.legs[0];
            return aBus.departureMin - bBus.departureMin;
        });

                    if (journeys.length === 0) {
                        routeResultsBox.innerHTML = '<div style="text-align: center; color: var(--text-muted); margin-top: 40px;">Brak połączeń dla tej trasy</div>';
                        return;
                    }

                    journeys.forEach(journey => {
                        const cardElement = buildJourneyCard(journey);
                        if (cardElement) routeResultsBox.appendChild(cardElement);
                    });

                    if (journeys.length > 0) {
                        const lastJourney = journeys[journeys.length - 1];
                        const transitLegs = lastJourney.legs.filter(l => l.route !== "Пішки" && l.route);
                        if (transitLegs.length > 0) {
                            lastJourneyDepartureMin = transitLegs[0].departureMin;
                        }
                    }

                    updateTrasaCountdowns();
                    if (!trasaCountdownInterval) {
                        trasaCountdownInterval = setInterval(updateTrasaCountdowns, 15000);
                    }

                } catch (error) {
                    console.error('Помилка пошуку:', error);
                    routeResultsBox.innerHTML = '<div style="text-align: center; color: var(--danger); margin-top: 40px;">Błąd wyszukiwania trasy.</div>';
                }
            });
        }
        trasaBottomIndicator = document.createElement('div');
        trasaBottomIndicator.innerHTML = '↻ Szukam późniejszych...';
        trasaBottomIndicator.style.textAlign = 'center';
        trasaBottomIndicator.style.color = 'var(--text-muted)';
        trasaBottomIndicator.style.height = '0';
        trasaBottomIndicator.style.overflow = 'hidden';
        trasaBottomIndicator.style.transition = 'height 0.2s ease-out';
        routeResultsBox.parentNode.insertBefore(trasaBottomIndicator, routeResultsBox.nextSibling);
        routeResultsBox.addEventListener('touchstart', (e) => {
            trasaStartY = e.touches[0].clientY;
            trasaIsAtBottom = Math.ceil(routeResultsBox.scrollTop + routeResultsBox.clientHeight) >= routeResultsBox.scrollHeight - 2;
        }, { passive: true });
        routeResultsBox.addEventListener('touchmove', (e) => {
            if (!trasaStartY || trasaIsRefreshing) return;
            const dy = e.touches[0].clientY - trasaStartY;
            if (dy < 0 && trasaIsAtBottom) {
                trasaBottomIndicator.style.height = Math.min(-dy, 50) + 'px';
            }
        }, { passive: true });
        routeResultsBox.addEventListener('touchend', async (e) => {
            if (!trasaStartY || trasaIsRefreshing) return;
            const dy = e.changedTouches[0].clientY - trasaStartY;

            if (dy < -60 && trasaIsAtBottom && lastJourneyDepartureMin !== null) {
                trasaIsRefreshing = true;
                trasaBottomIndicator.style.height = '40px';

                try {
                    let fromParams = '';
                    if (routeFromStop.ids) fromParams = `from=${routeFromStop.ids.join(',')}`;
                    else if (routeFromStop.lat && routeFromStop.lon) fromParams = `fromLat=${routeFromStop.lat}&fromLon=${routeFromStop.lon}`;

                    let toParams = '';
                    if (routeToStop.ids) toParams = `to=${routeToStop.ids.join(',')}`;
                    else if (routeToStop.lat && routeToStop.lon) toParams = `toLat=${routeToStop.lat}&toLon=${routeToStop.lon}`;

                    const nextSearchMin = lastJourneyDepartureMin + 1;
                    const res = await fetch(`${apiBaseUrl}/route/complex?${fromParams}&${toParams}&limit=8&time=${nextSearchMin}`);
                    if (!res.ok) throw new Error('Помилка сервера');

                    const newJourneys = await res.json();

                    newJourneys.sort((a, b) => {
            const aBus = a.legs.find(l => l.route !== "Пішки") || a.legs[0];
            const bBus = b.legs.find(l => l.route !== "Пішки") || b.legs[0];
            return aBus.departureMin - bBus.departureMin;
        });

                    if (newJourneys.length > 0) {
                        const lastJourney = newJourneys[newJourneys.length - 1];
                        const transitLegs = lastJourney.legs.filter(l => l.route !== "Пішки" && l.route);
                        if (transitLegs.length > 0) {
                            lastJourneyDepartureMin = transitLegs[0].departureMin;
                        }

                        newJourneys.forEach(journey => {
                            const cardElement = buildJourneyCard(journey);
                            if (cardElement) routeResultsBox.appendChild(cardElement);
                        });

                        updateTrasaCountdowns();
                    } else {
                        // ФІКС: Перестрибуємо "мертву зону" розкладу (додаємо 3 години)
                        lastJourneyDepartureMin += 180;
                        showToast('Szukam dalej...');
                    }
                } catch (err) {
                    showToast('Błąd sieci');
                }

                trasaBottomIndicator.style.height = '0';
                trasaIsRefreshing = false;
            } else {
                trasaBottomIndicator.style.height = '0';
            }
            trasaStartY = 0;
        });
    }

    return { initPlanner, enterPlanner, closePlannerAccordion, renderRecentRoutes };
}
