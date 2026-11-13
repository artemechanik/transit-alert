import { journeyCountdown, countdownMarkup, countdownColor } from './planner-countdown.js';
import { assessTransfer } from './planner-transfer.js';
import { apiFetch } from './backend-connection.js';
import { coloredTimeHtml, getLiveStatusBadge } from './planner-cards.js';

// Власник LIVE-сесії, запиту затримок і таймера Trasa.
export function createPlannerLive({ apiBaseUrl, refreshOpenTrasaPassedStops, refreshResults, tickResults }) {
    let trasaCountdownInterval = null;
    let plannerLiveSession = null;

    function rowLiveMin(row) {
        return parseInt(row.dataset.min, 10)
            + parseInt(row.dataset.delay, 10) - parseInt(row.dataset.delayInitial, 10);
    }

    async function updateTrasaCountdowns(options = {}) {
        const session = plannerLiveSession;
        if (!session) return;
        if (session.inFlight) return options.manual ? refreshResults?.(options) : undefined;
        session.inFlight = true;
        session.controller = new AbortController();
        try {
            await refreshResults?.(options);
            if (plannerLiveSession === session) await refreshTrasaCountdowns(session);
        } finally {
            session.inFlight = false;
        }
    }

    function startPlannerPolling() {
        if (!plannerLiveSession) return;
        if (!trasaCountdownInterval) {
            let ticks = 0;
            trasaCountdownInterval = setInterval(() => {
                tickResults?.();
                if (++ticks % 15 === 0) updateTrasaCountdowns();
            }, 1000);
        }
    }

    function leavePlanner() {
        const session = plannerLiveSession;
        plannerLiveSession = null;
        session?.controller?.abort();
        clearInterval(trasaCountdownInterval);
        trasaCountdownInterval = null;
    }

    async function refreshTrasaCountdowns(session) {
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
        if (!refreshResults && tripIds.size > 0) {
            try {
                const res = await apiFetch(`${apiBaseUrl}/live-vehicles/delays?tripIds=${Array.from(tripIds).join(',')}`, { signal: session.controller.signal });
                if (res.ok) {
                    liveDelays = await res.json();
                }
            } catch (e) {
                if (e.name !== 'AbortError') console.warn('Не вдалося оновити LIVE затримки:', e);
            }
        }

        if (plannerLiveSession !== session) return;
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

            // 4. Passenger-facing risk shared with LIVE. Routing eligibility is unchanged.
            rows.forEach((row, k) => {
                if (row.dataset.nextDep === undefined || !rows[k + 1]) return;
                const next = rows[k + 1];
                const nextDepLive = parseInt(row.dataset.nextDep, 10)
                    + parseInt(next.dataset.delay, 10) - parseInt(next.dataset.delayInitial, 10);
                const transfer = assessTransfer({ arrivalMin: rowLiveMin(row), departureMin: nextDepLive,
                    walkMin: parseFloat(row.dataset.transferWalk ?? '0'), platformChange: row.dataset.transferPlatformChange });

                const warn = row.querySelector('.trasa-transfer-warn');
                if (warn) warn.hidden = !transfer.risky;
                row.title = transfer.risky ? 'Ryzykowna przesiadka · możesz nie zdążyć' : '';
            });

            const firstRow = rows[0];
            const lastRow = rows[rows.length - 1];
            const firstDelay = parseInt(firstRow.dataset.delay, 10);
            const isLive = firstRow.dataset.live === 'true';

            // 5. Таймер відправлення — за першим рейсом
            const timerEl = timeline.querySelector('.trasa-dep-min');
            if (timerEl) {
                const journey = timeline.closest('.trasa-wrapper')?.journey;
                const expectedDepartureMin = rowLiveMin(firstRow);
                const departure = firstRow.dataset.departureEpoch ? Number(firstRow.dataset.departureEpoch)
                    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(expectedDepartureMin / 60), expectedDepartureMin % 60, 0).getTime() / 1000;
                const timing = journey ? journeyCountdown(journey, now.getTime() / 1000)
                    : { minutes: Math.ceil((departure - now.getTime() / 1000) / 60), color: countdownColor(isLive, firstDelay) };
                const html = countdownMarkup(timing);

                let content = timerEl.querySelector('.trasa-timer-content');
                if (!content) {
                    timerEl.innerHTML = '<div class="trasa-timer-content"></div>';
                    content = timerEl.querySelector('.trasa-timer-content');
                }
                if (content.innerHTML !== html) content.innerHTML = html;
                let badge = timerEl.querySelector('.trasa-live-blink');
                if (isLive && !badge) {
                    badge = document.createElement('span');
                    badge.className = 'trasa-live-blink';
                    badge.style.cssText = 'color:var(--danger);font-size:9px;font-weight:900;letter-spacing:.5px;margin-bottom:2px;animation:trasaLiveBlink 1.5s infinite;display:block;text-align:center';
                    badge.textContent = 'LIVE';
                    timerEl.prepend(badge);
                }

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

    function enterPlannerLive() {
        if (!plannerLiveSession) plannerLiveSession = { inFlight: false, controller: null };
        startPlannerPolling();
        updateTrasaCountdowns();
    }

    return { enterPlannerLive, leavePlanner, updateTrasaCountdowns, startPlannerPolling };
}
