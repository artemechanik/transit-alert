// Passenger-facing advice only. Never used to select or rank route results.
export function transferPlatformChange(current, next) {
    if (!current?.toStopId || !next?.fromStopId) return 'unknown';
    return current.toStopId === next.fromStopId ? 'same' : 'different';
}

export function transferWalkMinutes(legs, current, next) {
    const start = legs.indexOf(current), end = legs.indexOf(next);
    if (start < 0 || end <= start) return null;
    const walks = legs.slice(start + 1, end).filter(leg => !leg.route || leg.route === 'Пішки');
    if (walks.some(leg => !Number.isFinite(leg.departureMin) || !Number.isFinite(leg.arrivalMin))) return null;
    return walks.reduce((sum, leg) => sum + Math.max(0, leg.arrivalMin - leg.departureMin), 0);
}

export function assessTransfer({ arrivalMin, departureMin, walkMin, platformChange }) {
    if (![arrivalMin, departureMin, walkMin].every(Number.isFinite) || walkMin < 0) {
        return { walkMin: null, waitingMin: null, risky: false };
    }
    const walk = platformChange === 'different' ? Math.max(3, walkMin) : walkMin;
    const waitingMin = departureMin - arrivalMin - walk;
    return { walkMin: walk, waitingMin, risky: waitingMin < 1 };
}
