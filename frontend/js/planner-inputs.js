import { apiFetch } from './backend-connection.js';
// Поля Trasa, вибрані точки, історія та підказки зупинок/адрес.
export function createPlannerInputs({
    apiBaseUrl, locationService, getNearbyStops, showToast
}) {
    let routeFromStop = null;
    let routeToStop = null;
    const searches = new Map([true, false].map(key => [key, { version: 0, controller: null }]));

    function cancelSearch(isFrom) {
        const state = searches.get(isFrom);
        state.version++;
        state.controller?.abort();
        state.controller = null;
    }

    function clearSelectedPoint(isFrom) {
        if (isFrom) routeFromStop = null;
        else routeToStop = null;
    }

    function escapeAddressText(text) {
        return String(text).replace(/[&<>"']/g, char =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    async function fetchAddresses(query, signal) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(abort, 5000);
        try {
            const response = await apiFetch(
                `${apiBaseUrl}/addresses/search?q=${encodeURIComponent(query)}&limit=4`,
                { signal: controller.signal });
            // Queries valid for stops (e.g. platform numbers) may be invalid for PRG.
            if (response.status === 400) return { results: [], unavailable: false };
            if (!response.ok) throw new Error('Address search unavailable');
            const data = await response.json();
            if (!Array.isArray(data.results)) throw new Error('Invalid address response');
            return {
                results: data.results.filter(item =>
                    (item.type === 'street' || item.type === 'address') &&
                    typeof item.street === 'string' && typeof item.locality === 'string' &&
                    typeof item.house_number === 'string' &&
                    Number.isFinite(item.lat) && Number.isFinite(item.lon)),
                unavailable: false
            };
        } catch {
            return { results: [], unavailable: !signal.aborted };
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', abort);
        }
    }

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
        cancelSearch(true);
        cancelSearch(false);
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
      cancelSearch(true);
      cancelSearch(false);
      document.getElementById('route-suggestions-from').style.display = 'none';
      document.getElementById('route-suggestions-to').style.display = 'none';
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
        cancelSearch(isFrom);
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
                    cancelSearch(isFrom);
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
            cancelSearch(isFrom);
            clearSelectedPoint(isFrom);
            suggestionsBox.innerHTML = '';
            suggestionsBox.style.display = 'none';
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

            const state = searches.get(isFrom);
            const version = state.version;
            const controller = new AbortController();
            state.controller = controller;
            const isCurrent = () => state.version === version && !controller.signal.aborted;

            try {
                const stopsPromise = apiFetch(`${apiBaseUrl}/stops/search?q=${encodeURIComponent(query)}`,
                    { signal: controller.signal })
                    .then(r => r.ok ? r.json() : [])
                    .catch(() => []);
                const addressesPromise = fetchAddresses(query, controller.signal);
                const [stops, addresses] = await Promise.all([stopsPromise, addressesPromise]);
                if (!isCurrent()) return;

                if (stops.length === 0 && addresses.results.length === 0) {
                    suggestionsBox.innerHTML = `<div style="padding: 10px; color: var(--text-muted);">${addresses.unavailable
                        ? 'Wyszukiwanie adresów jest chwilowo niedostępne.' : 'Brak wyników'}</div>`;
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
                            cancelSearch(isFrom);
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

                // PRG streets and addresses share the existing address card and selection model.
                if (addresses.results.length > 0) {
                    addresses.results.slice(0, 4).forEach(address => {
                        const div = document.createElement('div');
                        div.className = 'stop-card';
                        div.style = 'padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg); display: flex; align-items: center; justify-content: space-between; gap: 12px;';

                        const shortName = address.type === 'street' ? address.street
                            : `${address.street || address.locality} ${address.house_number}`.trim();
                        const contextParts = address.locality;

                        div.innerHTML = `
                        <div class="address-main-click" style="display: flex; align-items: center; gap: 12px; flex: 1; cursor: pointer;">
                            <div class="svg-icon icon-map-pin" style="color: var(--text-muted); flex-shrink: 0;"></div>
                            <div style="overflow: hidden;">
                                <div style="font-weight: bold; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeAddressText(shortName)}</div>
                                <div style="font-size: 0.85em; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeAddressText(contextParts)}</div>
                            </div>
                        </div>
                        <div class="address-copy-btn" style="padding: 4px 8px; cursor: pointer; color: var(--text-muted); font-size: 20px; font-weight: bold; flex-shrink: 0;">↖</div>
                    `;

                        div.querySelector('.address-main-click').addEventListener('click', () => {
                            cancelSearch(isFrom);
                            input.value = shortName;
                            suggestionsBox.innerHTML = '';
                            suggestionsBox.style.display = 'none';

                            const routeObj = { name: shortName, lat: address.lat, lon: address.lon };
                            if (isFrom) routeFromStop = routeObj; else routeToStop = routeObj;
                            saveRecentRouteStop(routeObj);

                            // Знімаємо фокус і оновлюємо стан кнопки
                            input.blur();
                            updateRouteButtonState(isFrom);
                        });

                        div.querySelector('.address-copy-btn').addEventListener('click', (e) => {
                            e.stopPropagation();
                            cancelSearch(isFrom);
                            clearSelectedPoint(isFrom);
                            input.value = shortName + ' ';
                            input.focus();
                            updateRouteButtonState(isFrom);
                        });

                        suggestionsBox.appendChild(div);
                    });
                }

                if (addresses.unavailable) {
                    const notice = document.createElement('div');
                    notice.style = 'padding: 10px; color: var(--text-muted);';
                    notice.textContent = 'Wyszukiwanie adresów jest chwilowo niedostępne.';
                    suggestionsBox.appendChild(notice);
                }
                suggestionsBox.style.display = 'block';
            } catch (error) {
                if (isCurrent()) console.error('Помилка пошуку:', error);
            } finally {
                if (state.version === version) state.controller = null;
            }
        });

        document.addEventListener('click', (e) => {
            if (!input.contains(e.target) && !suggestionsBox.contains(e.target)) {
                cancelSearch(isFrom);
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
            cancelSearch(isFrom);
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

    function getRoutePoints() {
        return { routeFromStop, routeToStop };
    }

    return { setupRouteAutocomplete, loadRouteDefaultSuggestions, updateRouteButtonState,
        getRoutePoints, saveRecentRoute, renderRecentRoutes };
}
