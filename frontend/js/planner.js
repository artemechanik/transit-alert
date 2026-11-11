import { createResultsState } from './planner-results.js';
import { createListMotion } from './list-motion.js';
import { apiFetch } from './backend-connection.js';
import { createPlannerInputs } from './planner-inputs.js';
import { createPlannerCards } from './planner-cards.js';
import { createPlannerLive } from './planner-live.js';

// Координація екрана Trasa: пошук, результати та завантаження пізніших поїздок.
export function createPlanner({
    apiBaseUrl, getMapTilerKey, locationService, getNearbyStops,
    showVehicleOnMap, showToast, addMinutesToTime, onAccordionOpen, onBack
}) {
    let initialized = false, active = false, query = null, state = createResultsState();
    let routeResultsBox, searchRouteBtn, indicator, bottomIndicator, loading = null, controller = null;
    let generation = 0, manualRefresh = false;
    let loadingLater = false, queuedLater = null;
    let listMotion;
    const { setupRouteAutocomplete, loadRouteDefaultSuggestions, updateRouteButtonState,
        getRoutePoints, saveRecentRoute, renderRecentRoutes } = createPlannerInputs({
        apiBaseUrl, getMapTilerKey, locationService, getNearbyStops, showToast
    });
    const { buildJourneyCard, updateJourneyCard, refreshOpenTrasaPassedStops, closePlannerAccordion } = createPlannerCards({
        apiBaseUrl, showVehicleOnMap, addMinutesToTime, onAccordionOpen, onBack, getRoutePoints
    });
    const { enterPlannerLive, leavePlanner, updateTrasaCountdowns, startPlannerPolling } = createPlannerLive({
        apiBaseUrl, refreshOpenTrasaPassedStops, refreshResults, tickResults: () => { if (active && query) renderResults([]); }
    });

    async function refreshResults({ later = false, manual = false } = {}) {
        if (!active || !query) return;
        if (manual) {
            manualRefresh = true;
            (later ? bottomIndicator : indicator).style.height = '24px';
        }
        if (loading) {
            if (!later || loadingLater) return loading;
            // A bottom swipe must not be consumed by an unrelated LIVE refresh.
            if (queuedLater?.version === generation) return queuedLater.promise;
            const queued = { version: generation, promise: null };
            queued.promise = loading.then(() => {
                if (active && generation === queued.version) return refreshResults({ later: true, manual });
            }).finally(() => {
                if (queuedLater === queued) queuedLater = null;
            });
            queuedLater = queued;
            return queued.promise;
        }
        const version = generation;
        loadingLater = later;
        controller = new AbortController();
        loading = (async () => {
            try {
                const response = await apiFetch(`${apiBaseUrl}/route/complex?${query}&limit=8${later ? `&time=${Math.max(...[...state.entries.values()].map(e => e.journey.legs.find(l => l.route !== 'Пішки').departureMin)) + 1}` : ''}`, { signal: controller.signal });
                if (!response.ok) throw new Error('Route refresh failed');
                const journeys = await response.json();
                if (!active || version !== generation) return;
                renderResults(journeys, later);
            } catch (error) {
                if (error.name !== 'AbortError' && active && version === generation) {
                    renderResults([]);
                    if (manualRefresh) showToast?.(later ? 'Błąd ładowania połączeń' : 'Błąd odświeżania trasy');
                }
            } finally {
                if (version === generation) {
                    loading = null; manualRefresh = false;
                    indicator.style.height = '0'; bottomIndicator.style.height = '0';
                }
            }
        })();
        return loading;
    }
    function renderResults(journeys, animateNew = false) {
        const scroll = routeResultsBox.scrollTop;
        const entries = state.update(journeys, Date.now() / 1000);
        if (!entries.size) {
            if (!routeResultsBox.dataset.empty) {
                routeResultsBox.innerHTML = '<div style="text-align:center;color:var(--text-muted);margin-top:40px">Brak połączeń dla tej trasy</div>';
                routeResultsBox.dataset.empty = 'true';
            }
            return;
        }
        if (routeResultsBox.dataset.empty) {
            routeResultsBox.innerHTML = '';
            delete routeResultsBox.dataset.empty;
        }
        const ordered = [...entries.entries()].filter(([, e]) => !e.expired)
            .sort((a, b) => a[1].journey.legs.find(l => l.route !== 'Пішки').departureEpoch - b[1].journey.legs.find(l => l.route !== 'Пішки').departureEpoch);
        // Departed wrappers remain at their existing index while other slots update.
        const pinned = [...routeResultsBox.children].map((node, index) => ({ node, index }))
            .filter(({node}) => entries.get(node.dataset.journeyKey)?.departedAt != null && !entries.get(node.dataset.journeyKey)?.expired);
        for (const [key, entry] of entries) {
            if (entry.expired && entry.node && !entry.removing) {
                entry.removing = true;
                entry.node.classList.add('trasa-result-exit');
                const node = entry.node;
                setTimeout(() => node.remove(), 250);

            }
        }
        for (const [key, entry] of ordered) {
            if (!entry.node) {
                entry.node = buildJourneyCard(entry.journey);
                if (!entry.node) continue;
                entry.node.dataset.journeyKey = key;
                routeResultsBox.appendChild(entry.node);
            }
            updateJourneyCard(entry.node, entry.journey);
            entry.node.classList.toggle('trasa-departed', entry.departedAt != null);
        }
        const desired = ordered.map(([,e]) => e.node).filter(n => n && !pinned.some(p => p.node === n));
        for (const {node,index} of pinned) desired.splice(Math.min(index, desired.length), 0, node);
        desired.forEach((node,index) => { const current = routeResultsBox.children[index]; if (current !== node) routeResultsBox.insertBefore(node, current || null); });
        if (!listMotion.isScrolling() && routeResultsBox.scrollTop !== scroll) {
            routeResultsBox.scrollTop = scroll;
        }
        const added = listMotion.sync(ordered.filter(([, entry]) => entry.node)
            .map(([key, entry]) => ({ key, node: entry.node })), animateNew);
        if (animateNew) listMotion.revealAdded(added);
    }
    function enterPlanner() {
        active = true;
        enterPlannerLive();
        updateRouteButtonState(true); updateRouteButtonState(false); renderRecentRoutes();
    }
    function leave() {
        active = false; generation++; controller?.abort(); loading = null; manualRefresh = false;
        leavePlanner();
        listMotion?.cancelScroll();
        if (indicator) indicator.style.height = '0';
        if (bottomIndicator) bottomIndicator.style.height = '0';
    }
    function initPlanner() {
        if (initialized) return;
        initialized = true;
        setupRouteAutocomplete('route-input-from', 'route-suggestions-from', true);
        setupRouteAutocomplete('route-input-to', 'route-suggestions-to', false);
        updateRouteButtonState(true); updateRouteButtonState(false);
        document.getElementById('route-input-from').addEventListener('focus', () => loadRouteDefaultSuggestions(true));
        document.getElementById('route-input-to').addEventListener('focus', () => loadRouteDefaultSuggestions(false));
        searchRouteBtn = document.getElementById('route-search-btn');
        routeResultsBox = document.getElementById('route-results-list');
        listMotion = createListMotion(routeResultsBox);
        indicator = document.createElement('div');
        indicator.textContent = 'Odświeżanie…'; indicator.className = 'trasa-refresh-indicator';
        routeResultsBox.parentNode.insertBefore(indicator, routeResultsBox);
        bottomIndicator = document.createElement('div');
        bottomIndicator.textContent = 'Ładowanie…';
        bottomIndicator.className = 'trasa-refresh-indicator trasa-later-indicator';
        routeResultsBox.parentNode.insertBefore(bottomIndicator, routeResultsBox.nextSibling);
        searchRouteBtn.addEventListener('click', async () => {
            const { routeFromStop: from, routeToStop: to } = getRoutePoints();
            if (!from || !to) return showToast('Wybierz przystanek początkowy i końcowy z listy!');
            for (const point of [from, to]) if (point.isDynamicGps) {
                const pos = locationService.getPosition();
                if (!pos) return showToast('Błąd: Brak sygnału GPS. Poczekaj chwilę.');
                point.lat = pos.lat; point.lon = pos.lon;
            }
            const params = (p, name) => p.ids ? `${name}=${p.ids.join(',')}` : `${name}Lat=${p.lat}&${name}Lon=${p.lon}`;
            generation++; controller?.abort(); loading = null; manualRefresh = false; indicator.style.height = '0';
            bottomIndicator.style.height = '0';
            query = `${params(from,'from')}&${params(to,'to')}`;
            state = createResultsState(); routeResultsBox.innerHTML = '';
            listMotion.reset();
            saveRecentRoute(from,to);
            const recent = document.getElementById('recent-routes-list'); if (recent) recent.style.display = 'none';
            await refreshResults();
            startPlannerPolling();
        });
        let gesture = null;
        function clearGesture() {
            gesture = null;
            if (!loading) {
                indicator.style.height = '0'; bottomIndicator.style.height = '0';
            }
        }
        routeResultsBox.addEventListener('touchstart', e => {
            gesture = active && (routeResultsBox.scrollTop <= 0 || routeResultsBox.scrollTop + routeResultsBox.clientHeight >= routeResultsBox.scrollHeight - 2) && e.touches.length === 1 ? { x:e.touches[0].clientX, y:e.touches[0].clientY, top: routeResultsBox.scrollTop <= 0, bottom: routeResultsBox.scrollTop + routeResultsBox.clientHeight >= routeResultsBox.scrollHeight - 2 } : null;
        }, {passive:true});
        routeResultsBox.addEventListener('touchmove', e => {
            if (!gesture) return;
            const touch = e.touches[0];
            if (e.touches.length !== 1) {
                clearGesture();
                return;
            }
            const dx = Math.abs(touch.clientX - gesture.x), dy = touch.clientY - gesture.y;
            // Use the edge captured on touchstart, as in the original bottom swipe.
            // Layout changes and small finger jitter must not discard a vertical gesture.
            const pull = dy > 0 && (gesture.direction === 'pull'
                || (!gesture.direction && gesture.top));
            const later = dy < 0 && (gesture.direction === 'later'
                || (!gesture.direction && gesture.bottom));
            if (!gesture.direction && ((dx > 25 && dx >= Math.abs(dy))
                || (!pull && !later && Math.abs(dy) > 12))) {
                clearGesture();
                return;
            }
            if ((pull || later) && active && query) {
                gesture.direction = pull ? 'pull' : 'later';
                e.preventDefault();
                if (Math.abs(dy) > 12) {
                    (later ? bottomIndicator : indicator).style.height = Math.min(32, Math.abs(dy) / 2) + 'px';
                }
            }
        }, {passive:false});
        routeResultsBox.addEventListener('touchend', e => {
            const later = gesture?.direction === 'later' && e.changedTouches[0].clientY - gesture.y < -60;
            const pull = gesture?.direction === 'pull' && e.changedTouches[0].clientY - gesture.y > 60;
            gesture = null;
            if (later && active && state.entries.size) return refreshResults({ later: true, manual: true });
            else if (pull && active) return updateTrasaCountdowns({ manual: true });
            else clearGesture();
        });
        routeResultsBox.addEventListener('touchcancel', clearGesture);
    }
    return { initPlanner, enterPlanner, leavePlanner: leave, closePlannerAccordion, renderRecentRoutes };
}
