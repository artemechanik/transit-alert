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
                const depDate = firstRow.dataset.departureEpoch ? new Date(Number(firstRow.dataset.departureEpoch) * 1000) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(expectedDepartureMin / 60), expectedDepartureMin % 60, 0);
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
                    ? `<span style="color: var(--danger); font-size: 9px; font-weight: 900; letter-spacing: 0.5px; margin-bottom: 2px; animation: trasaLiveBlink 1.5s infinite;">LIVE</span>`
                    : '';

                let timerHtml = '';
                if (countdown < 60) {
                    let numStr = countdown === 0 ? '<1' : countdown;
                    let labelStr = countdown === 0 ? 'minuta' : getMinLabel(countdown);
                    let colorStr = countdown <= 30 ? 'var(--live-green)' : 'var(--text)';

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

                let content = timerEl.querySelector('.trasa-timer-content');
                if (!content) {
                    timerEl.innerHTML = '<div class="trasa-timer-content"></div>';
                    content = timerEl.querySelector('.trasa-timer-content');
                }
                const html = timerHtml.replace(liveBadgeHtml, '');
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
