import { apiFetch } from './backend-connection.js';
import { createPlannerInputs } from './planner-inputs.js';
import { createPlannerCards } from './planner-cards.js';
import { createPlannerLive } from './planner-live.js';

// Координація екрана Trasa: пошук, результати та завантаження пізніших поїздок.
export function createPlanner({
    apiBaseUrl, getMapTilerKey, locationService, getNearbyStops,
    showVehicleOnMap, showToast, addMinutesToTime, onAccordionOpen, onBack
}) {
    let initialized = false;
    let lastJourneyDepartureMin = null;
    let trasaStartY = 0;
    let trasaIsAtBottom = false;
    let trasaIsRefreshing = false;
    let searchRouteBtn, routeResultsBox, trasaBottomIndicator;

    const { setupRouteAutocomplete, loadRouteDefaultSuggestions, updateRouteButtonState,
        getRoutePoints, saveRecentRoute, renderRecentRoutes } = createPlannerInputs({
        apiBaseUrl, getMapTilerKey, locationService, getNearbyStops, showToast
    });
    const { buildJourneyCard, refreshOpenTrasaPassedStops, closePlannerAccordion } = createPlannerCards({
        apiBaseUrl, showVehicleOnMap, addMinutesToTime, onAccordionOpen, onBack, getRoutePoints
    });
    const { enterPlannerLive, leavePlanner, updateTrasaCountdowns, startPlannerPolling } = createPlannerLive({
        apiBaseUrl, refreshOpenTrasaPassedStops
    });

    function enterPlanner() {
        enterPlannerLive();
        updateRouteButtonState(true);
        updateRouteButtonState(false);
        renderRecentRoutes();
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
                const { routeFromStop, routeToStop } = getRoutePoints();

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
                    const res = await apiFetch(`${apiBaseUrl}/route/complex?${fromParams}&${toParams}&limit=8`);
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
                    startPlannerPolling();

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
            const { routeFromStop, routeToStop } = getRoutePoints();
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
                    const res = await apiFetch(`${apiBaseUrl}/route/complex?${fromParams}&${toParams}&limit=8&time=${nextSearchMin}`);
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

    return { initPlanner, enterPlanner, leavePlanner, closePlannerAccordion, renderRecentRoutes };
}
