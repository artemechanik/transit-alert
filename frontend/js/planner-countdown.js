import { hasFreshLive } from './planner-results.js';

// One rounding rule and absolute departure for every passenger-facing countdown.
export function legCountdown(leg, now) {
    const live = hasFreshLive(leg, now);
    const departure = live ? leg.departureEpoch : leg?.scheduledDepartureEpoch;
    return { live, departure, minutes: Number.isFinite(departure) ? Math.ceil((departure - now) / 60) : null };
}

export function departureClock(departure) {
    return Number.isFinite(departure) ? new Date(departure * 1000).toLocaleTimeString('pl-PL', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Warsaw'
    }) : '—';
}

// Kotlin omits the default delayMinutes=0 from JSON; explicit null stays unknown.
export function countdownColor(live, delayMinutes = 0) {
    if (!live || !Number.isFinite(delayMinutes)) return 'var(--text-muted)';
    return delayMinutes > 0 ? 'var(--danger)' : delayMinutes < 0 ? 'var(--early)' : 'var(--live-green)';
}

export function journeyCountdown(journey, now, index = 0) {
    const transit = journey.legs.filter(leg => leg.route && leg.route !== 'Пішки');
    const leg = transit[index];
    const timing = legCountdown(leg, now);
    return { ...timing, color: countdownColor(timing.live, leg?.delayMinutes) };
}

export function countdownMarkup({ minutes, color, departure }, presentation = 'classic') {
    if (minutes === null) return `<span style="color:${color}">—</span>`;
    if (presentation === 'new' && (minutes <= 0 || minutes > 60)) {
        if (!Number.isFinite(departure)) return `<span style="color:${color}">—</span>`;
        const clock = departureClock(departure);
        return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;height:38px;color:${color}"><span style="font-size:10px;font-weight:700;letter-spacing:.5px;opacity:.8">odjazd o:</span><span style="font-size:16px;font-weight:700;margin-top:2px">${clock}</span></div>`;
    }
    const count = Math.max(0, minutes);
    const label = count === 1 ? 'minuta' : count % 10 >= 2 && count % 10 <= 4
        && (count % 100 < 12 || count % 100 > 14) ? 'minuty' : 'minut';
    if (count < 60 || (presentation === 'new' && count === 60)) return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;color:${color}"><span style="font-size:26px;font-weight:800;letter-spacing:-1px">${count || '&lt;1'}</span><span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:2px;opacity:.8">${count ? label : 'minuta'}</span></div>`;
    return `<div style="display:flex;flex-direction:column;align-items:center;line-height:1;color:${color}"><span style="font-size:10px;font-weight:600;opacity:.8;margin-bottom:3px">odjazd za:</span><span style="font-size:16px;font-weight:700">${Math.floor(count / 60)}h ${String(count % 60).padStart(2, '0')}m</span></div>`;
}
