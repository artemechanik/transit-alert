import { apiFetch } from './backend-connection.js';
import { createListMotion, captureListAnchor, restoreListAnchor } from './list-motion.js';
// Стан Przystanek і його DOM-обробники мають одного власника.
export function createStops({
    apiBaseUrl, locationService, getNearbyStops,
    showVehicleOnMap, onAccordionOpen, onBack
}) {
    let initialized = false;
    let currentDeparturesData = [];
    let topTimeOffset = 0;
    let bottomTimeOffset = 0;
    let isFetchingMore = false;
    let currentStopIdForDepartures = null;
    let departuresRefreshInterval = null;
    let pendingDepartureRequests = 0;
    let startY = 0;
    let isRefreshing = false;
    let startScrollTop = 0;
    let isAtBottom = false;
    let listMotion;
    let accordionTask = null;
    let stopSearchInput, stopSuggestionsBox, stopTitleContainer, stopNameDisplay, departuresList, stopScreenContainer, ptrIndicator, ptrBottomIndicator;

    // Список зупинок рейсу від поточної платформи; помилку обробляє викликач.
    async function renderDepExpand(panel, dep) {
      const res = await apiFetch(`${apiBaseUrl}/trips/${dep.tripId}/upcoming-stops?fromStopId=${encodeURIComponent(currentStopIdForDepartures)}`);
      if (!res.ok) throw new Error('not found');
      const stops = await res.json();
      await listMotion.whenIdle();
      if (!panel.classList.contains('open') || panel.isConnected === false) return;

      const stopsHtml = stops.length
        ? stops.map(s => `<div class="dep-expand-stop${s.isPassed ? ' dep-expand-stop-passed' : ''}"><span>${s.name}</span><span class="dep-expand-eta">${s.eta}</span></div>`).join('')
        : '<div class="dep-expand-loading">To ostatni przystanek na trasie</div>';

      panel.innerHTML = `
    <div class="dep-expand-stops">${stopsHtml}</div>
    <button class="dep-expand-map-btn"> <div class="svg-icon icon-map-pin"></div> Pokaż na mapie</button>
  `;
      bindDepartureMapButton(panel, dep.tripId);
    }

    async function toggleDepExpand(card, panel, dep) {
      listMotion.cancelScroll();
      const isOpen = panel.classList.contains('open');
      // Схлопуємо всі інші відкриті картки
      document.querySelectorAll('.dep-expand.open').forEach(p => { if (p !== panel) { p.classList.remove('open'); p.innerHTML = ''; } });
      document.querySelectorAll('.dep-card.expandable.open').forEach(c => { if (c !== card) c.classList.remove('open'); });

      if (isOpen) {
          onBack(); // Замість ручного закриття просто робимо крок назад
          return;
        }

        // ДОДАЄМО: записуємо відкриття акордеону в історію
        onAccordionOpen();

        card.classList.add('open');
        panel.classList.add('open');
      panel.innerHTML = '<div class="dep-expand-loading">Ładowanie trasy...</div>';
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      accordionTask = pending;

      try {
        await renderDepExpand(panel, dep);

        // Let the accordion expand before giving its scroll priority over pagination.
        await new Promise(resolve => setTimeout(resolve, 150));
        if (panel.isConnected === false || !panel.classList.contains('open')
            || stopScreenContainer.style.display === 'none') return;
        listMotion.trackScroll(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));

      } catch (e) {
        panel.innerHTML = '<div class="dep-expand-loading">Nie udało się załadować trasy</div>';
      } finally {
        release();
        if (accordionTask === pending) accordionTask = null;
      }
    }

    function getRecentStops() {
        try {
            return JSON.parse(localStorage.getItem('ta_recent_stops')) || [];
        } catch (e) { return []; }
    }

    function saveRecentStop(stop) {
        let recents = getRecentStops();
        // Видаляємо дублікат, якщо ця зупинка вже є (щоб підняти її наверх)
        recents = recents.filter(s => s.stopId !== stop.stopId);
        recents.unshift(stop); // Додаємо на початок
        if (recents.length > 2) recents.length = 2; // Лишаємо тільки 2 останні
        localStorage.setItem('ta_recent_stops', JSON.stringify(recents));
    }

    function createStopSuggestionElement(stop, distanceStr = '') {
        const item = document.createElement('div');
        item.className = 'stop-suggestion-item';

        const title = document.createElement('div');
        title.className = 'stop-suggestion-title';
        title.innerHTML = `${stop.name} <span class="stop-suggestion-code">${stop.code}</span>`;

        // Якщо передали дистанцію (для GPS) - малюємо її праворуч
        if (distanceStr) {
            title.innerHTML += ` <span style="float: right; font-size: 13px; color: #888;">${distanceStr}</span>`;
        }
        item.appendChild(title);

        // Малюємо карусель ліній, якщо вони є
        if (stop.routes && stop.routes.length > 0) {
            const carousel = document.createElement('div');
            carousel.className = 'stop-routes-carousel';
            stop.routes.forEach(r => {
                const pill = document.createElement('div');
                pill.className = 'route-pill';
                pill.innerHTML = `<span class="route-pill-num">${r.route}</span><span class="route-pill-dir">${r.direction}</span>`;
                carousel.appendChild(pill);
            });
            item.appendChild(carousel);
        }

        // Обробка кліку по картці
        item.addEventListener('click', () => {
            stopSuggestionsBox.style.display = 'none';
            stopSearchInput.value = '';
            stopTitleContainer.style.display = 'block';
            stopNameDisplay.textContent = `${stop.name} ${stop.code}`;

            saveRecentStop(stop); // 💾 ЗБЕРІГАЄМО В ІСТОРІЮ ПРИ КЛІКУ

            currentStopIdForDepartures = stop.stopId;
            topTimeOffset = 0;
            bottomTimeOffset = 0;
            loadDepartures(currentStopIdForDepartures);
        });

        return item;
    }

    function loadNearbyStopsDefault() {
        if (stopSearchInput.value.trim() !== '') return;

        stopSuggestionsBox.innerHTML = '';


        // 1. ОСТАННІ ПОШУКИ (малюємо миттєво з пам'яті браузера)
        const recents = getRecentStops();
        if (recents.length > 0) {
            const recentsHeader = document.createElement('div');
            recentsHeader.style = 'padding: 10px; font-weight: bold; color: var(--blue); display: flex; align-items: center; gap: 12px;';
            recentsHeader.innerHTML = '<div class="svg-icon icon-clock"></div> Ostatnio wyszukiwane';
            stopSuggestionsBox.appendChild(recentsHeader);

            recents.forEach(stop => {
                stopSuggestionsBox.appendChild(createStopSuggestionElement(stop)); // Без дистанції
            });
        }

        // 2. ГОТУЄМО КОНТЕЙНЕР ДЛЯ ЗУПИНОК ПОРУЧ
        const nearbyContainer = document.createElement('div');
        nearbyContainer.id = 'nearby-container';
        nearbyContainer.style.margin = '0';
        nearbyContainer.style.padding = '0';
        stopSuggestionsBox.appendChild(nearbyContainer);
        stopSuggestionsBox.style.display = 'block';

        // 3. ЗАПУСКАЄМО GPS ЛОГІКУ
        const position = locationService.getPosition();
        if (position) {
            const lat = position.lat;
            const lon = position.lon;
            showNearbyStops(lat, lon);
            return;
        }

        nearbyContainer.innerHTML = '<div style="padding: 10px; color: var(--text-muted);"><div class="svg-icon icon-walk"></div>Szukam lokalizacji...</div>';

        if (locationService.isSupported()) {
            locationService.requestPosition(
                (position) => {
                    const lat = position.coords.latitude;
                    const lon = position.coords.longitude;
                    showNearbyStops(lat, lon);
                },
                (error) => {
                    console.warn('GPS помилка:', error.message);
                    nearbyContainer.innerHTML = '<div style="padding: 10px; color: red;">Увімкніть GPS для Przystanki w pobliżu</div>';
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
        }
    }

    async function showNearbyStops(lat, lon) {
        const nearbyContainer = document.getElementById('nearby-container');
        if (!nearbyContainer) return;

        try {
            const nearbyResult = getNearbyStops(apiBaseUrl, lat, lon, true);
            const groups = nearbyResult instanceof Promise ? await nearbyResult : nearbyResult;

            if (groups.length === 0) {
                nearbyContainer.innerHTML = `<div style="padding: 10px; color: var(--text-muted);">Brak przystanków w pobliżu lub GPS</div>`;
                return;
            }

            nearbyContainer.innerHTML = '<div style="padding: 10px; font-weight: bold; color: var(--blue); display: flex; align-items: center; gap: 12px;"><div class="svg-icon icon-map-pin"></div> Przystanki w pobliżu</div>';

            groups.forEach(group => {
                group.stops.forEach(stop => {
                    nearbyContainer.appendChild(createStopSuggestionElement(stop, `${group.distance}m`));
                });
            });
        } catch (error) {
            nearbyContainer.innerHTML = `<div style="padding: 10px; color: red;">Помилка: ${error.message}</div>`;
        }
    }

    function addMinutesToTime(timeStr, mins) {
      const [h, m] = timeStr.split(':').map(Number);
      const d = new Date();
      d.setHours(h, m + mins, 0, 0);
      return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    }

    async function loadDepartures(stopId, isBackgroundRefresh = false, fetchOffset = 0, pageDirection = null) {
      pendingDepartureRequests++;
      if (!isBackgroundRefresh && !pageDirection && fetchOffset === 0) {
        listMotion.reset();
        departuresList.innerHTML = '<div style="text-align: center; margin-top: 40px; color: var(--text-muted);">Завантаження... <div class="svg-icon icon-hourglass"></div></div>';
      }

      try {
        const res = await apiFetch(`${apiBaseUrl}/stops/${stopId}/departures?offset=${fetchOffset}`);
        if (!res.ok) throw new Error('Не вдалося завантажити розклад');

        const fetchedDepartures = await res.json();
        if (isBackgroundRefresh) {
          // Keep both the current DOM and scroll position until manual movement finishes.
          while (accordionTask || listMotion.isScrolling()) {
            if (accordionTask) await accordionTask;
            await listMotion.whenIdle();
          }
        }
        if (stopId !== currentStopIdForDepartures) return;

        // 1. РОЗУМНИЙ МЕНЕДЖМЕНТ СПИСКУ
        if (!pageDirection && fetchOffset === 0 && !isBackgroundRefresh) {
          currentDeparturesData = fetchedDepartures;
        }
            else if (pageDirection === 'history') {
          // Свайп вниз (Історія) -> Додаємо 3 старі рейси
          const currentOldest = currentDeparturesData.length > 0 ? currentDeparturesData[0].minutesLeft : 0;
          const existingKeys = new Set(currentDeparturesData.map(d => `${d.route}-${d.scheduledTime}`));

          const freshHistory = fetchedDepartures
            .filter(d => !existingKeys.has(`${d.route}-${d.scheduledTime}`))
            .filter(d => d.minutesLeft < currentOldest)
            .sort((a, b) => b.minutesLeft - a.minutesLeft);

          const itemsToAdd = freshHistory.slice(0, 3).reverse();
          currentDeparturesData = [...itemsToAdd, ...currentDeparturesData];

        }
        else if (pageDirection === 'later') {
          // Свайп вверх (Майбутнє) -> Додаємо 3 нові рейси
          const currentNewest = currentDeparturesData.length > 0 ? currentDeparturesData[currentDeparturesData.length - 1].minutesLeft : 0;
          const existingKeys = new Set(currentDeparturesData.map(d => `${d.route}-${d.scheduledTime}`));

          const freshFuture = fetchedDepartures
            .filter(d => !existingKeys.has(`${d.route}-${d.scheduledTime}`))
            .filter(d => d.minutesLeft > currentNewest)
            .sort((a, b) => a.minutesLeft - b.minutesLeft);

          const itemsToAdd = freshFuture.slice(0, 3);
          currentDeparturesData = [...currentDeparturesData, ...itemsToAdd];

        }
        else if (isBackgroundRefresh) {
          // Якщо ми не дивимося історію/майбутнє — просто чисто оновлюємо список
          if (topTimeOffset === 0 && bottomTimeOffset === 0) {
            currentDeparturesData = fetchedDepartures;
          } else {
            fetchedDepartures.forEach(fetchedDep => {
              const key = `${fetchedDep.route}-${fetchedDep.scheduledTime}`;
              const existingIndex = currentDeparturesData.findIndex(d => `${d.route}-${d.scheduledTime}` === key);
              if (existingIndex !== -1) {
                currentDeparturesData[existingIndex] = fetchedDep;
              }
            });
          }
        }

        // 2. РЕНДЕРИНГ ЗІ ЗБЕРЕЖЕННЯМ ПОЗИЦІЇ СКРОЛУ
        if (currentDeparturesData.length === 0) {
          departuresList.innerHTML = '<div style="text-align: center; margin-top: 40px; color: var(--text-muted);">Brak odjazdów 🚏</div>';
        } else {
          // ЗАПАМ'ЯТОВУЄМО СКРОЛ ПЕРЕД ОЧИЩЕННЯМ!
          const oldScrollTop = departuresList.scrollTop;
          const oldScrollHeight = departuresList.scrollHeight;
          const anchor = captureListAnchor(departuresList);
          const motionItems = [];

          // Запам'ятовуємо відкриту панель зупинок, щоб перерендер її не закрив
          const openCard = departuresList.querySelector('.dep-card.open');
          const openKey = openCard ? openCard.dataset.depKey : null;
          const openPanelHtml = openCard ? openCard.nextElementSibling.innerHTML : '';

          departuresList.innerHTML = '';

          currentDeparturesData.forEach(dep => {
            const isHistory = dep.minutesLeft < 0;
            const isGhost = !dep.isRealTime && dep.minutesLeft === 0;
            const isPast = isHistory || isGhost;
            const minClass = (dep.isRealTime && !isPast) ? 'dep-min live' : 'dep-min';

                                // ФОРМАТУВАННЯ ЧАСУ ТА САТЕЛІТ-ІКОНКА
            let timeText;
            let schedHtml = dep.scheduledTime;
            let hideSchedBottom = false; // Прибираємо дублювання часу знизу для далеких рейсів
            const absMins = Math.abs(dep.minutesLeft);

            if (isHistory) {
              if (absMins >= 60) {
                timeText = dep.scheduledTime;
                hideSchedBottom = true;
              } else {
                timeText = `${dep.minutesLeft} min`;
              }
            } else if (isGhost) {
              timeText = '0 min';
            } else {
              if (dep.minutesLeft >= 60) {
                timeText = dep.scheduledTime; // Далекі рейси показуємо як точний час (будильник)
                hideSchedBottom = true;
              } else {
                timeText = dep.minutesLeft === 0 ? '< 1 min' : `${dep.minutesLeft} min`;
              }
            }

            let statusHtml = '';
            const liveIcon = ''; // Надпис LIVE

            if (dep.isRealTime) {
              if (dep.delayMinutes > 0) {
                const realTime = addMinutesToTime(dep.scheduledTime, dep.delayMinutes);
                if (hideSchedBottom) {
                   timeText = realTime; // Якщо далекий рейс затримується — зсуваємо великий час
                   schedHtml = `<s>${dep.scheduledTime}</s>`;
                } else {
                   schedHtml = `<s>${dep.scheduledTime}</s> <span class="time-mod time-delay">${realTime}</span>`;
                }
                statusHtml = `<div class="dep-status status-delay">${liveIcon}Opóźnienie: ${dep.delayMinutes} min</div>`;
              } else if (dep.delayMinutes < 0) {
                const earlyMins = Math.abs(dep.delayMinutes);
                const realTime = addMinutesToTime(dep.scheduledTime, dep.delayMinutes);
                if (hideSchedBottom) {
                   timeText = realTime;
                   schedHtml = `<s>${dep.scheduledTime}</s>`;
                } else {
                   schedHtml = `<s>${dep.scheduledTime}</s> <span class="time-mod time-early">${realTime}</span>`;
                }
                statusHtml = `<div class="dep-status status-early">${liveIcon}Przed czasem: ${earlyMins} min</div>`;
              } else {
                if (hideSchedBottom) schedHtml = '';
                statusHtml = `<div class="dep-status status-ontime">${liveIcon}Punktualnie</div>`;
              }
            } else {
               if (hideSchedBottom) schedHtml = '';
            }

            // Статуси для історії та звичайного розкладу без GPS
            if (isPast) {
              statusHtml = `<div class="dep-status status-sched">Odjechał</div>`;
            } else if (!dep.isRealTime) {
              statusHtml = `<div class="dep-status status-sched">Rozkład jazdy</div>`;
            }

                    // ... (твій код статусів залишається без змін) ...

            const ghostClass = isPast ? ' ghost' : '';
            const wrapper = document.createElement('div');
            wrapper.className = 'dep-item';

            const card = document.createElement('div');
            card.className = `dep-card${ghostClass}`;
            card.dataset.tripId = dep.tripId || '';
            card.dataset.depKey = `${dep.tripId}-${dep.scheduledTime}`;

            // Перевіряємо чи є бортовий номер і тип
            const vehicleIdHtml = dep.vehicleId ? dep.vehicleId : '';
            // Очищаємо номер від усього зайвого (залишаємо тільки цифри)
            const routeNum = parseInt(dep.route, 10);
            const trolleyClass = (routeNum >= 150) ? ' trolleybus' : '';
            // ОНОВЛЕНА РОЗМІТКА КАРТКИ
                    // Перевіряємо чи рейс онлайн, щоб додати напис
            const liveLabelHtml = dep.isRealTime ? '<span class="live-label">LIVE</span>' : '';

            // ОНОВЛЕНА РОЗМІТКА КАРТКИ
            card.innerHTML = `
          <div class="dep-route-wrap">
            <div class="dep-route-box${trolleyClass}">
                ${dep.route}
                ${liveLabelHtml} <!-- Вставляємо наше малесеньке слово -->
            </div>
            <div class="dep-vehicle-id">${vehicleIdHtml}</div>
          </div>
          <div class="dep-info">
            <div class="dep-dir">${dep.direction}</div>
            ${statusHtml}
          </div>
          <div class="dep-times">
            <div class="${minClass}">${timeText}</div>
            <div class="dep-sched">${schedHtml}</div>
          </div>
        `;

            const expandPanel = document.createElement('div');
            expandPanel.className = 'dep-expand';

            if (!isPast && dep.tripId) {
              card.classList.add('expandable');
              card.addEventListener('click', () => toggleDepExpand(card, expandPanel, dep));

              // Відновлюємо відкриту панель: одразу старий вміст (без стрибка скролу),
              // потім тихо підтягуємо свіжі isPassed — зупинки сіріють, поки автобус їде
              if (openKey && card.dataset.depKey === openKey) {
                card.classList.add('open');
                expandPanel.classList.add('open');
                expandPanel.innerHTML = openPanelHtml;
                bindDepartureMapButton(expandPanel, dep.tripId);
                renderDepExpand(expandPanel, dep).catch(() => {}); // при збої лишаємо попередній список
              }
            }

            wrapper.appendChild(card);
            wrapper.appendChild(expandPanel);
            departuresList.appendChild(wrapper);
            const key = `${dep.route}-${dep.scheduledTime}`;
            wrapper.dataset.motionKey = key;
            motionItems.push({ node: wrapper, key });
          });

          // М'ЯКО ВІДНОВЛЮЄМО СКРОЛ!
          if (pageDirection === 'history') {
            // Якщо додали картки зверху, зсуваємо скрол вниз на їхню висоту
            departuresList.scrollTop = oldScrollTop + (departuresList.scrollHeight - oldScrollHeight);
          } else {
            // Інакше залишаємо екран рівно там, де він був
            departuresList.scrollTop = oldScrollTop;
          }
          restoreListAnchor(departuresList, anchor);
          const added = listMotion.sync(motionItems, pageDirection !== null);
          if (pageDirection && !isBackgroundRefresh) {
            listMotion.revealAdded(added, pageDirection);
          }
        }

        if (!departuresRefreshInterval) {
          departuresRefreshInterval = setInterval(() => {
            if (currentStopIdForDepartures && stopScreenContainer.style.display !== 'none') {
              loadDepartures(currentStopIdForDepartures, true, 0);
            }
          }, 15000);
        }

      } catch (error) {
        console.error('Помилка завантаження розкладу:', error);
        if (!isBackgroundRefresh) {
          departuresList.innerHTML = '<div style="text-align: center; margin-top: 40px; color: var(--danger);">Błąd połączenia ⚠️</div>';
        }
      } finally {
        pendingDepartureRequests--;
      }
    }

    function bindDepartureMapButton(panel, tripId) {
        const button = panel.querySelector('.dep-expand-map-btn');
        if (button) button.addEventListener('click', () => showVehicleOnMap(String(tripId)));
    }

    function enterStops({ isBackAction = false } = {}) {
        if (!isBackAction && !currentStopIdForDepartures) loadNearbyStopsDefault();
        recoverConnection();
    }

    function closeDepartureAccordion() {
        listMotion?.cancelScroll();
        document.querySelectorAll('.dep-expand.open').forEach(p => {
            p.classList.remove('open');
            p.innerHTML = '';
        });
        document.querySelectorAll('.dep-card.expandable.open').forEach(c => {
            c.classList.remove('open');
        });
    }

    function initStops() {
        if (initialized) return;
        initialized = true;
        stopSearchInput = document.getElementById('stop-screen-search');
        stopSuggestionsBox = document.getElementById('stop-screen-suggestions');
        stopTitleContainer = document.getElementById('stop-title-container');
        stopNameDisplay = document.getElementById('stop-name-display');
        departuresList = document.getElementById('departures-list');
        listMotion = createListMotion(departuresList);
        stopScreenContainer = document.getElementById('screen-stop');
        ptrIndicator = document.createElement('div');
        ptrIndicator.id = 'ptr-indicator';
        ptrIndicator.innerHTML = 'Odświeżanie…';
        departuresList.parentNode.insertBefore(ptrIndicator, departuresList);
        ptrBottomIndicator = document.createElement('div');
        ptrBottomIndicator.id = 'ptr-indicator-bottom';
        ptrBottomIndicator.innerHTML = 'Ładowanie…';
        departuresList.parentNode.insertBefore(ptrBottomIndicator, departuresList.nextSibling);
        stopSearchInput.addEventListener('focus', loadNearbyStopsDefault);
        stopSearchInput.addEventListener('input', async (e) => {
          const query = e.target.value.trim();

          if (query.length < 2) {
            if (query.length === 0) loadNearbyStopsDefault();
            else stopSuggestionsBox.style.display = 'none';
            return;
          }

          try {
            const res = await apiFetch(`${apiBaseUrl}/stops/search?q=${encodeURIComponent(query)}`);
            if (!res.ok) throw new Error('Помилка мережі');

            const stops = await res.json();

            if (stops.length === 0) {
              stopSuggestionsBox.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">Нічого не знайдено</div>';
              stopSuggestionsBox.style.display = 'block';
              return;
            }

            stopSuggestionsBox.innerHTML = '';
            stops.forEach(stop => {
              stopSuggestionsBox.appendChild(createStopSuggestionElement(stop));
            });

            stopSuggestionsBox.style.display = 'block';
          } catch (error) {
            console.error('Помилка пошуку зупинки:', error);
          }
        });
        document.addEventListener('click', (e) => {
          if (
            !stopSearchInput.contains(e.target) &&
            !stopSuggestionsBox.contains(e.target) &&
            !e.target.closest('.nav-item')
          ) {
            stopSuggestionsBox.style.display = 'none';
          }
        });
        departuresList.addEventListener('touchstart', (e) => {
          startY = e.touches[0].clientY;
          startScrollTop = departuresList.scrollTop;
          // Перевіряємо, чи ми зараз на самому дні списку
          isAtBottom = Math.ceil(startScrollTop + departuresList.clientHeight) >= departuresList.scrollHeight - 2;
        }, { passive: true });
        departuresList.addEventListener('touchmove', (e) => {
          if (!startY || isRefreshing) return;
          const dy = e.touches[0].clientY - startY;

          // 1. Тягнемо ВНИЗ (за історією)
          if (dy > 0 && startScrollTop === 0) {
            ptrIndicator.style.height = Math.min(32, dy / 2) + 'px';
          }
          // 2. Тягнемо ВВЕРХ (за майбутнім), будучи на дні
          else if (dy < 0 && isAtBottom) {
            ptrBottomIndicator.style.height = Math.min(32, -dy / 2) + 'px';
          }
        }, { passive: true });
        departuresList.addEventListener('touchend', async (e) => {
          if (!startY || isRefreshing) return;
          const dy = e.changedTouches[0].clientY - startY;

          // 1. Відпустили ІСТОРІЮ
          if (dy > 60 && startScrollTop === 0 && currentStopIdForDepartures) {
            isRefreshing = true;
            ptrIndicator.style.height = '24px';
            ptrIndicator.innerHTML = 'Ładowanie historii…';

            // РОЗУМНИЙ СТРИБОК У МИНУЛЕ: беремо час найстарішого автобуса на екрані і віднімаємо 30 хв
            if (currentDeparturesData.length > 0) {
              topTimeOffset = currentDeparturesData[0].minutesLeft - 30;
            } else {
              topTimeOffset -= 60; // Запасний варіант, якщо екран порожній
            }

            await loadDepartures(currentStopIdForDepartures, false, topTimeOffset, 'history');

            ptrIndicator.style.height = '0';
            setTimeout(() => { ptrIndicator.innerHTML = 'Odświeżanie…'; }, 200);
            isRefreshing = false;
          }
          // 2. Відпустили МАЙБУТНЄ
          else if (dy < -60 && isAtBottom && currentStopIdForDepartures) {
            isRefreshing = true;
            ptrBottomIndicator.style.height = '24px';
            ptrBottomIndicator.innerHTML = 'Ładowanie…';

            // РОЗУМНИЙ СТРИБОК У МАЙБУТНЄ: беремо час найдальшого автобуса і просимо наступні!
            if (currentDeparturesData.length > 0) {
              const lastBus = currentDeparturesData[currentDeparturesData.length - 1];
              bottomTimeOffset = lastBus.minutesLeft + 15;
            } else {
              bottomTimeOffset += 60; // Запасний варіант, якщо екран порожній
            }

            await loadDepartures(currentStopIdForDepartures, false, bottomTimeOffset, 'later');

            ptrBottomIndicator.style.height = '0';
            setTimeout(() => { ptrBottomIndicator.innerHTML = 'Ładowanie…'; }, 200);
            isRefreshing = false;
          }
          // 3. Не дотягнули
          else {
            ptrIndicator.style.height = '0';
            ptrBottomIndicator.style.height = '0';
          }
          startY = 0;
        });
    }

    // A failed first load never installed the normal refresh interval.
    // Otherwise the existing polling owns refresh after reconnection.
    function recoverConnection() {
        if (!departuresRefreshInterval && pendingDepartureRequests === 0 && currentStopIdForDepartures
            && stopScreenContainer.style.display !== 'none') {
            void loadDepartures(currentStopIdForDepartures, true, 0);
        }
    }

    return { initStops, enterStops, closeDepartureAccordion, addMinutesToTime, recoverConnection };
}
