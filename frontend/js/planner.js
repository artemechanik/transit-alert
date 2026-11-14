import { createPlannerCardPosition } from './planner-card-position.js';
import { createResultsState } from './planner-results.js';
import { createListMotion, captureListAnchor, restoreListAnchor } from './list-motion.js';
import { createPlannerPresentation } from './planner-presentation.js';
import { apiFetch } from './backend-connection.js';
import { createPlannerInputs } from './planner-inputs.js';
import { createPlannerCards } from './planner-cards.js';
import { createPlannerLive } from './planner-live.js';
import { bindJourneyPinHold } from './planner-pin.js';

// Координація екрана Trasa: пошук, результати та завантаження пізніших поїздок.
export function createPlanner({
    apiBaseUrl, getMapTilerKey, locationService, getNearbyStops, inlineMapServices,
    showVehicleOnMap, showToast, addMinutesToTime, onAccordionOpen, onBack
}) {
    let initialized = false, active = false, query = null, state = createResultsState();
    let routeResultsBox, searchRouteBtn, indicator, bottomIndicator, loading = null, controller = null;
    let generation = 0, manualRefresh = false, searchFormRevision = 0;
    let loadingLater = false, queuedLater = null;
    let listMotion, cardPosition, pinHold;
    let queuedReconcile = false;
    const { setupRouteAutocomplete, loadRouteDefaultSuggestions, updateRouteButtonState,
        getRoutePoints, saveRecentRoute, renderRecentRoutes } = createPlannerInputs({
        apiBaseUrl, getMapTilerKey, locationService, getNearbyStops, showToast
    });
    const { buildJourneyCard, updateJourneyCard, refreshOpenTrasaPassedStops, closePlannerAccordion, disposeJourneyCard, suspendPlannerMaps, resumePlannerMaps } = createPlannerCards({
        apiBaseUrl, showVehicleOnMap, addMinutesToTime, onAccordionOpen, onBack, getRoutePoints, inlineMapServices,
        getPresentation: () => routeResultsBox?.dataset.presentation,
        onInlineOpen: node => cardPosition?.open(node),
        onInlineClose: node => cardPosition?.close(node),
        onInlineLayout: () => cardPosition?.sync(),
        onPinToggle: toggleJourneyPin
    });

    function toggleJourneyPin(node) {
        const key = node.dataset.journeyKey;
        const entry = state.entries.get(key);
        if (entry && state.setPinned(key, !entry.pinned)) {
            updateJourneyCard(node, entry.journey, !!entry.pinned);
            renderResults([]);
        }
    }
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
                return journeys.length > 0;
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
        const deferOrder = cardPosition?.isAligning();
        if (deferOrder && !queuedReconcile) {
            queuedReconcile = true;
            const version = generation;
            listMotion.whenIdle().then(() => {
                queuedReconcile = false;
                if (active && version === generation) renderResults([]);
            });
        }
        const scroll = routeResultsBox.scrollTop;
        const anchor = routeResultsBox.dataset.presentation === 'new' && !listMotion.isScrolling()
            ? captureListAnchor(routeResultsBox) : null;
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
        // Pinned and departed wrappers retain their list slot while other results update.
        const pinned = [...routeResultsBox.children].map((node, index) => ({ node, index }))
            .filter(({node}) => {
                const entry = entries.get(node.dataset.journeyKey);
                return entry && !entry.expired && (entry.pinned || entry.departedAt != null);
            });
        for (const [key, entry] of entries) {
            if (!deferOrder && entry.expired && entry.node && !entry.removing) {
                entry.removing = true;
                entry.node.classList.add('trasa-result-exit');
                const node = entry.node;
                const remove = () => {
                    if (cardPosition?.isAligning()) { listMotion.whenIdle().then(remove); return; }
                    const anchor = routeResultsBox.dataset.presentation === 'new' && !listMotion.isScrolling()
                        ? captureListAnchor(routeResultsBox) : null;
                    disposeJourneyCard(node);
                    node.remove();
                    cardPosition?.sync();
                    if (anchor) restoreListAnchor(routeResultsBox, anchor);
                };
                setTimeout(remove, 250);

            }
        }
        for (const [key, entry] of ordered) {
            if (!entry.node) {
                entry.node = buildJourneyCard(entry.journey);
                if (!entry.node) continue;
                entry.node.dataset.journeyKey = key;
                routeResultsBox.appendChild(entry.node);
            }
            updateJourneyCard(entry.node, entry.journey, !!entry.pinned);
            entry.node.classList.toggle('trasa-departed', entry.departedAt != null);
        }
        const desired = ordered.map(([,e]) => e.node).filter(n => n && !pinned.some(p => p.node === n));
        for (const {node,index} of pinned) desired.splice(Math.min(index, desired.length), 0, node);
        if (!deferOrder) desired.forEach((node,index) => { const current = routeResultsBox.children[index]; if (current !== node) routeResultsBox.insertBefore(node, current || null); });
        cardPosition?.sync();
        if (!listMotion.isScrolling()) {
            const restored = anchor && restoreListAnchor(routeResultsBox, anchor);
            if (!restored && routeResultsBox.scrollTop !== scroll) routeResultsBox.scrollTop = scroll;
        }
        const added = listMotion.sync(ordered.filter(([, entry]) => entry.node)
            .map(([key, entry]) => ({ key, node: entry.node })), animateNew);
        if (animateNew) listMotion.revealAdded(added);
    }
    function enterPlanner() {
        active = true;
        if (query) renderResults([]);
        cardPosition?.sync();
        resumePlannerMaps();
        enterPlannerLive();
        updateRouteButtonState(true); updateRouteButtonState(false); renderRecentRoutes();
    }
    function leave() {
        active = false; generation++; controller?.abort(); loading = null; manualRefresh = false;
        pinHold?.cancel();
        cardPosition?.cancel();
        leavePlanner();
        suspendPlannerMaps();
        listMotion?.cancelScroll();
        if (indicator) indicator.style.height = '0';
        if (bottomIndicator) bottomIndicator.style.height = '0';
    }
    function setSearchButtonCollapsed(collapsed) {
        searchRouteBtn.dataset.collapsed = String(collapsed);
        searchRouteBtn.inert = collapsed;
        searchRouteBtn.ariaHidden = String(collapsed);
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
        setSearchButtonCollapsed(false);
        function revealSearchButton() {
            searchFormRevision++;
            setSearchButtonCollapsed(false);
        }
        for (const field of ['from', 'to']) {
            const input = document.getElementById(`route-input-${field}`);
            input.addEventListener('focus', revealSearchButton);
            input.addEventListener('input', revealSearchButton);
            document.getElementById(`route-clear-${field}`)?.addEventListener('click', revealSearchButton);
        }
        routeResultsBox = document.getElementById('route-results-list');
        listMotion = createListMotion(routeResultsBox);
        cardPosition = createPlannerCardPosition(routeResultsBox, listMotion);
        createPlannerPresentation(routeResultsBox, listMotion, {
            classic: document.getElementById('trasa-presentation-classic'),
            new: document.getElementById('trasa-presentation-new')
        }, cardPosition);
        indicator = document.createElement('div');
        indicator.textContent = 'Odświeżanie…'; indicator.className = 'trasa-refresh-indicator';
        routeResultsBox.parentNode.insertBefore(indicator, routeResultsBox);
        bottomIndicator = document.createElement('div');
        bottomIndicator.textContent = 'Ładowanie…';
        bottomIndicator.className = 'trasa-refresh-indicator trasa-later-indicator';
        routeResultsBox.parentNode.insertBefore(bottomIndicator, routeResultsBox.nextSibling);
        searchRouteBtn.addEventListener('click', async () => {
            setSearchButtonCollapsed(false);
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
            pinHold.cancel();
            [...routeResultsBox.children].forEach(disposeJourneyCard);
            state = createResultsState(); routeResultsBox.innerHTML = '';
            listMotion.reset();
            saveRecentRoute(from,to);
            const recent = document.getElementById('recent-routes-list'); if (recent) recent.style.display = 'none';
            const searchVersion = generation, formRevision = searchFormRevision;
            const found = await refreshResults();
            // Only this completed search may hide the button. Editing or background
            // refreshes must never collapse the user's current search controls.
            if (active && searchVersion === generation && formRevision === searchFormRevision && found) {
                setSearchButtonCollapsed(true);
            }
            startPlannerPolling();
        });
        let gesture = null;
        function clearGesture() {
            gesture = null;
            if (!loading) {
                indicator.style.height = '0'; bottomIndicator.style.height = '0';
            }
        }
        function nestedPanelOwnsGesture(target) {
            if (!target.closest('.trasa-card.fullscreen-expanded')) return false;
            if (routeResultsBox.dataset.presentation !== 'new') return true;
            if (!target.closest('.trasa-middle-scroll')) return false;
            const live = target.closest('.lubus-live');
            // A fitting LIVE panel has no native scrolling of its own. Reuse the
            // ordinary list gestures; overflowing LIVE, Podróż and Mapa keep theirs.
            return !live || live.scrollHeight > live.clientHeight + 1;
        }
        routeResultsBox.addEventListener('touchstart', e => {
            // Nested panel gestures belong to its native scroll container.
            // The inline summary still permits ordinary list scrolling and swipes.
            if (nestedPanelOwnsGesture(e.target)) {
                clearGesture();
                return;
            }
            gesture = active && (routeResultsBox.scrollTop <= 0 || routeResultsBox.scrollTop + routeResultsBox.clientHeight >= routeResultsBox.scrollHeight - 2) && e.touches.length === 1 ? { x:e.touches[0].clientX, y:e.touches[0].clientY, top: routeResultsBox.scrollTop <= 0, bottom: routeResultsBox.scrollTop + routeResultsBox.clientHeight >= routeResultsBox.scrollHeight - 2 } : null;
        }, {passive:true});
        routeResultsBox.addEventListener('touchmove', e => {
            if (nestedPanelOwnsGesture(e.target)) {
                clearGesture();
                return;
            }
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
        pinHold = bindJourneyPinHold(routeResultsBox, {
            isEnabled: () => active && !!query && routeResultsBox.dataset.presentation === 'new',
            onToggle: toggleJourneyPin
        });
    }
    function isPlannerAccordionOpen() {
        const card = routeResultsBox?.querySelector('.trasa-card.fullscreen-expanded');
        return !!card && !card.closest('.trasa-result-exit');
    }
    return { initPlanner, enterPlanner, leavePlanner: leave, closePlannerAccordion, isPlannerAccordionOpen, renderRecentRoutes };
}
