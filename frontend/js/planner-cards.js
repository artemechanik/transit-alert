import { assessTransfer, transferPlatformChange, transferWalkMinutes } from './planner-transfer.js';
import { setupJourneyTimeline } from './planner-timeline.js';
import { expandedMarkup, bindExpandedPanels, updateExpandedLive, preserveInlineAnchor } from './planner-expanded.js';
import { initialWalkRisk } from './planner-results.js';
import { apiFetch } from './backend-connection.js';
// Картки поїздок, розгортання зупинок і відкриття мінікарти.
function formatTime(minutes) {
    // Додаємо % 24, щоб після 23:59 годинник скидався на 00:xx
    const h = (Math.floor(minutes / 60) % 24).toString().padStart(2, '0');
    const m = (minutes % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
}

export function coloredTimeHtml(min, delay) {
    const timeStr = formatTime(min);
    if (delay > 0) return `<span style="color: var(--danger); font-weight: 700;">${timeStr}</span>`;
    if (delay < 0) return `<span style="color: var(--blue); font-weight: 700;">${timeStr}</span>`;
    return timeStr;
}

export function getLiveStatusBadge(isLive, delayMinutes) {
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
        return `<div style="display:flex; align-items:center; color: var(--live-green);"><div class="svg-icon icon-ok" style="${iconStyle}"></div></div> <span style="opacity:0.4">•</span> `;
    }
}

export function createPlannerCards({
    apiBaseUrl, showVehicleOnMap, addMinutesToTime, onAccordionOpen, onBack, getRoutePoints, inlineMapServices, onInlineOpen, onInlineClose, onInlineLayout
}) {
    function splitStopName(fullName) {
        if (!fullName) return { name: '', code: '' };
        const parts = fullName.split(' ');
        const lastPart = parts[parts.length - 1];

        // Перевіряємо, чи останнє слово - це рівно 2 цифри (код платформи, напр "01")
        if (/^\d{2}$/.test(lastPart)) {
            parts.pop();
            return { name: parts.join(' '), code: lastPart };
        }

        // Якщо це адреса або системна мітка - повертаємо як є
        return { name: fullName, code: '' };
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
            let colorStr = countdown <= 30 ? 'var(--live-green)' : 'var(--text)';

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
        timelineHtml += '<div class="trasa-timeline-connector" style="position:absolute; left: 55px; top: 8px; bottom: 8px; border-left: 2px dotted var(--border); z-index: 1;"></div>';

        const rowStyle = 'position:relative; padding:2px 0; display: flex; align-items: center;';
        const timeStyle = 'width: 44px; text-align: center; font-size: 15px; font-weight: 600; color: var(--text); flex-shrink: 0;';
        const dotWrapperStyle = 'width: 24px; display: flex; justify-content: center; z-index: 2; flex-shrink: 0;';

        // 1. ПЕРША ЗУПИНКА
        timelineHtml += `<div class="trasa-row" ${rowAttrs(firstTransitLeg, firstTransitLeg.departureMin)} style="${rowStyle}">
        <div class="time" style="${timeStyle}">${depTime}</div>
        <div class="trasa-stop-dot" style="${dotWrapperStyle}"><div style="width: 8px; height: 8px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 3px var(--card);"></div></div>
        <div class="stop-name" style="flex: 1; font-size: 15px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; padding-right: 65px;">${fromStop.name} ${fromStop.code ? `<span class="stop-code" style="color:var(--text); font-size:15px; font-weight:600;">(${fromStop.code})</span>` : ''}</div>
    </div>`;

        // 2. ПРОМІЖНІ ЗУПИНКИ
        for (let i = 0; i < transitLegs.length - 1; i++) {
            const tStop = splitStopName(transitLegs[i].toStopName);
            const nextLeg = transitLegs[i + 1];
            const platformChange = transferPlatformChange(transitLegs[i], nextLeg);
            const walkMin = transferWalkMinutes(legs, transitLegs[i], nextLeg);
            const transfer = assessTransfer({ arrivalMin: transitLegs[i].arrivalMin, departureMin: nextLeg.departureMin, walkMin, platformChange });
            timelineHtml += `<div class="trasa-row trasa-transfer-row" ${rowAttrs(transitLegs[i], transitLegs[i].arrivalMin)} data-next-dep="${nextLeg.departureMin}" data-transfer-walk="${walkMin ?? ""}" data-transfer-platform-change="${platformChange}" title="${transfer.risky ? 'Ryzykowna przesiadka · możesz nie zdążyć' : ''}" style="${rowStyle} opacity: 0.8;">
            <div class="time" style="${timeStyle} font-size: 14px; font-weight: 500; color: var(--text-muted);">${coloredTimeHtml(transitLegs[i].arrivalMin, transitLegs[i].delayMinutes || 0)}</div>
            <div class="trasa-stop-dot" style="${dotWrapperStyle}"><div style="width: 8px; height: 8px; border-radius: 50%; background: var(--border); box-shadow: 0 0 0 3px var(--card);"></div></div>
            <div class="stop-name" style="flex: 1; font-size: 14px; font-weight: 500; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; padding-right: 65px;"><span class="trasa-transfer-warn" ${transfer.risky ? '' : 'hidden'} style="color: var(--danger); font-weight: 700;">⚠ </span>➔ ${tStop.name} ${tStop.code ? `<span class="stop-code" style="font-size: 14px; font-weight: 500; color: var(--text-muted);">(${tStop.code})</span>` : ''}</div>
        </div>`;
        }

        // 3. ОСТАННЯ ЗУПИНКА
        timelineHtml += `<div class="trasa-row" ${rowAttrs(lastTransitLeg, lastTransitLeg.arrivalMin)} style="${rowStyle}">
        <div class="time" style="${timeStyle}">${arrTime}</div>
        <div class="trasa-stop-dot" style="${dotWrapperStyle}"><div style="width: 8px; height: 8px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 3px var(--card);"></div></div>
        <div class="stop-name" style="flex: 1; font-size: 15px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; padding-right: 65px;">${toStop.name} ${toStop.code ? `<span class="stop-code" style="color:var(--text); font-size:15px; font-weight:600;">(${toStop.code})</span>` : ''}</div>
    </div>`;

        // 4. ТАЙМЕР АБСОЛЮТНИЙ (відцентрований відносно всього таймлайну!)
        timelineHtml += `<div class="trasa-dep-min" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); z-index: 5;">${isLive ? '<span class="trasa-live-blink" style="color:var(--danger);font-size:9px;font-weight:900;letter-spacing:.5px;margin-bottom:2px;animation:trasaLiveBlink 1.5s infinite;display:block;text-align:center">LIVE</span>' : ''}<div class="trasa-timer-content">${timerHtml}</div></div>`;

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
            ${walkMin > 0 ? `<div class="trasa-initial-walk" style="display:flex; align-items:center; gap:2px;"><div class="svg-icon icon-walk" style="width:13px;height:13px;"></div><span class="trasa-initial-walk-warn" ${initialWalkRisk(journey, Date.now() / 1000) ? '' : 'hidden'} style="color:var(--danger);font-weight:700;">⚠</span>${walkMin}m</div> <span style="opacity:0.4">•</span>` : ''}
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
            const current = wrapper.journey || journey;
            toggleTrasaExpand(card, current.legs, current.legs.filter(l => l.route !== "Пішки" && l.route));
        });

        wrapper.appendChild(card);

        return wrapper;
    }

    function updateJourneyCard(wrapper, journey) {
        wrapper.journey = journey;
        updateExpandedLive(wrapper, journey, addMinutesToTime);
        const walkWarning = wrapper.querySelector('.trasa-initial-walk-warn');
        if (walkWarning) walkWarning.hidden = !initialWalkRisk(journey, Date.now() / 1000);
        const transit = journey.legs.filter(l => l.route !== 'Пішки' && l.route);
        const rows = [...wrapper.querySelectorAll('.trasa-row[data-trip-id]')];
        rows.forEach((row, index) => {
            const leg = index === 0 ? transit[0] : transit[index - 1];
            if (!leg) return;
            const min = index === 0 ? leg.departureMin : leg.arrivalMin;
            Object.assign(row.dataset, { min, delay:leg.delayMinutes || 0, delayInitial:leg.delayMinutes || 0, live:String(leg.isRealTime), departureEpoch:leg.departureEpoch });
            if (row.dataset.nextDep !== undefined && transit[index]) {
                row.dataset.nextDep = transit[index].departureMin;
                row.dataset.transferWalk = transferWalkMinutes(journey.legs, leg, transit[index]) ?? '';
                row.dataset.transferPlatformChange = transferPlatformChange(leg, transit[index]);
            }
        });
    }

    async function refreshOpenTrasaPassedStops() {
        const containers = document.querySelectorAll('.trasa-card.fullscreen-expanded .trasa-leg-stops[data-trip-id]');
        await Promise.all([...containers].map(async container => {
            const { tripId, fromStopId, toStopId } = container.dataset;
            const panel = container.closest('.trasa-middle-scroll');
            const token = panel?.lubusLoadToken;
            const includeLive = container.closest('#route-results-list')?.dataset.presentation === 'new';
            const stops = await fetchLegStops({ tripId, fromStopId, toStopId }, includeLive);
            if (container.isConnected === false || panel?.lubusLoadToken !== token) return;
            const siblings = [...(panel?.querySelectorAll('.trasa-leg-stops') || [])];
            panel?.lubusTimeline?.update(siblings.indexOf(container), stops);
            const rows = container.querySelectorAll('.trasa-leg-stop');
            // Рядки рендерились із того самого запиту, тож порядок збігається; інакше — не чіпаємо
            if (stops.length !== rows.length) return;
            rows.forEach((row, i) => row.classList.toggle('dep-expand-stop-passed', !!stops[i].isPassed));
        }));
    }

    async function fetchLegStops(leg, includeLive = false) {
        if (!leg.tripId || leg.tripId === 'WALK' || !leg.fromStopId) return [];
        try {
            const res = await apiFetch(`${apiBaseUrl}/trips/${leg.tripId}/upcoming-stops?fromStopId=${encodeURIComponent(leg.fromStopId)}${includeLive ? '&includeLive=true&includePrevious=true' : ''}`);
            if (!res.ok) return [];
            const response = await res.json();
            const stops = Array.isArray(response) ? response : response.stops;
            if (!Array.isArray(stops)) return [];
            const live = !Array.isArray(response) ? response.live : null;
            const boardingSequence = response.boardingStopSequence
                ?? stops.find(s => s.stopId === leg.fromStopId)?.stopSequence;
            const fromIndex = includeLive ? stops.findIndex(s => s.stopId === leg.fromStopId
                && s.stopSequence === boardingSequence) : 0;
            if (includeLive && fromIndex < 0) return [];
            const journeyStops = includeLive ? stops.slice(fromIndex) : stops;
            // Never guess which occurrence is the destination after boarding on a loop.
            if (includeLive && journeyStops.filter(s => s.stopId === leg.toStopId).length !== 1) return [];
            // Матчимо по toStopId (реальний ID зупинки висадки), а не по назві —
            // назви можуть повторюватись раніше в маршруті й обрізати список зарано.
            const cutIdx = leg.toStopId
                ? journeyStops.findIndex(s => s.stopId === leg.toStopId)
                : -1;
            const selected = cutIdx >= 0 ? journeyStops.slice(0, cutIdx + 1) : journeyStops.slice(0, 8);
            selected.live = live;
            selected.boardingSequence = boardingSequence;
            if (includeLive) {
                selected.timelineStops = stops.slice(0, fromIndex + cutIdx + 1);
                selected.tripStops = stops; // LIVE may know the next stop beyond the chosen alighting.
            }
            return selected;
        } catch (e) {
            return [];
        }
    }

    async function toggleTrasaExpand(card, legs, transitLegs) {
        const isOpen = card.classList.contains('fullscreen-expanded');
        const scrollPanel = card.querySelector('.trasa-middle-scroll');
        const restoreAnchor = preserveInlineAnchor(card);

        document.querySelectorAll('.trasa-card.fullscreen-expanded').forEach(c => {
            if (c !== card) {
                c.classList.remove('fullscreen-expanded');
                const p = c.querySelector('.trasa-middle-scroll');
                onInlineClose?.(c.parentNode);
                if (p) { p.lubusTimeline?.destroy(); p.lubusLoadToken = null; p.innerHTML = ''; p.style.display = 'none'; }
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
        restoreAnchor();
        onInlineOpen?.(card.parentNode);
        const loadToken = {};
        scrollPanel.lubusLoadToken = loadToken;
        try {
            const includeLive = card.closest('#route-results-list')?.dataset.presentation === 'new';
            const legStopsResults = await Promise.all(transitLegs.map(leg => fetchLegStops(leg, includeLive)));
            // A closed/replaced accordion must not be populated by a late response.
            if (!card.classList.contains('fullscreen-expanded') || scrollPanel.lubusLoadToken !== loadToken) return;

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
                                <div style="position: absolute; left: 26px; top: 50%; bottom: 0; border-left: 2px dashed var(--border); z-index: 1;"></div>                                <span style="font-weight: 700; color: var(--text); font-size: 15px;">${getRoutePoints().routeFromStop.name}</span>
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
                                <span style="font-weight: 700; color: var(--text); font-size: 15px;">${getRoutePoints().routeToStop.name}</span>
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
                        <div class="trasa-leg-stop${s.isPassed ? ' dep-expand-stop-passed' : ''}" data-journey-event="${s.stopId === leg.fromStopId ? 'Wsiądź' : s.stopId === leg.toStopId ? 'Wysiądź' : ''}" style="position: relative; padding: 10px 14px 10px 42px; display: flex; justify-content: space-between; align-items: center;">
                            <div style="position: absolute; left: ${dotLeft}; top: 50%; transform: translateY(-50%); width: ${dotSize}; height: ${dotSize}; border-radius: 50%; background: ${dotColor}; z-index: 2;"></div>

                            ${drawLineDown ? `<div style="position: absolute; left: 26px; top: 50%; bottom: ${lineBottom}; width: 2px; background: var(--border); z-index: 1;"></div>` : ''}

                            <span style="font-weight: ${fontWeight}; color: ${textColor}; font-size: 15px;">
                                ${stopName}
                                <span class="stop-code" style="color:${textColor}; font-size:13px; font-weight: 500;">${platformCode}</span>
                            </span>
                            <span class="trasa-stop-time" style="font-weight: ${fontWeight}; color: ${textColor}; font-size: 15px;">${realEta}</span><span class="lubus-stop-time" data-scheduled-eta="${s.eta}">${realEta}</span>
                        </div>`;
                        }).join('') : '<div style="padding: 10px; text-align: center; color: var(--text-muted);">Brak danych</div>';

                        html += `<div class="trasa-leg-stops" data-trip-id="${leg.tripId || ''}" data-from-stop-id="${leg.fromStopId || ''}" data-to-stop-id="${leg.toStopId || ''}" style="padding-bottom: 0;">${stopsHtml}</div>`;
                        transitIdx++;
                    });
            const restoreLoadedAnchor = preserveInlineAnchor(card);
            scrollPanel.innerHTML = expandedMarkup(html || '<p>Brak danych</p>', { legs });
            bindExpandedPanels(scrollPanel, mapActions);
            setupJourneyTimeline(scrollPanel, transitLegs, legStopsResults, mapActions, addMinutesToTime, inlineMapServices);
            onInlineLayout?.();
            restoreLoadedAnchor();
            const wrapper = card.parentNode;
            if (wrapper?.journey) updateExpandedLive(wrapper, wrapper.journey, addMinutesToTime);
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
            if (scrollPanel.lubusLoadToken !== loadToken || !card.classList.contains('fullscreen-expanded')) return;
            scrollPanel.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--danger);">Błąd serwera</div>';
            onInlineLayout?.();
        }
    }

    function closePlannerAccordion() {
        const openCards = [...document.querySelectorAll('.trasa-card.fullscreen-expanded')];
        const restoreAnchor = openCards.length ? preserveInlineAnchor(openCards[0]) : () => {};
        openCards.forEach(card => {
            onInlineClose?.(card.parentNode);
            card.classList.remove('fullscreen-expanded');
            const p = card.querySelector('.trasa-middle-scroll');
            if (p) {
                p.lubusTimeline?.destroy();
                p.lubusTimeline = null;
                p.lubusLoadToken = null;
                p.innerHTML = '';
                p.style.display = 'none';
            }
        });
        restoreAnchor();
    }

    function disposeJourneyCard(wrapper) {
        onInlineClose?.(wrapper);
        wrapper.querySelector('.trasa-middle-scroll')?.lubusTimeline?.destroy();
    }
    function suspendPlannerMaps() {
        document.querySelectorAll('.trasa-card.fullscreen-expanded .trasa-middle-scroll').forEach(panel => panel.lubusTimeline?.suspend());
    }
    function resumePlannerMaps() {
        document.querySelectorAll('.trasa-card.fullscreen-expanded .trasa-middle-scroll').forEach(panel => panel.lubusTimeline?.resume());
    }
    return { buildJourneyCard, updateJourneyCard, refreshOpenTrasaPassedStops, closePlannerAccordion,
        disposeJourneyCard, suspendPlannerMaps, resumePlannerMaps };
}
