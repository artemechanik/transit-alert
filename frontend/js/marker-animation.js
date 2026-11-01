export const MOVE_SMOOTHING = 0.4;   // 1.0 = рух триває весь інтервал; 0.6 = швидше, але з паузами
export const MOVE_MIN_MS = 1000;
export const MOVE_MAX_MS = 20000;
const TELEPORT_M = 600;       // стрибок далі за це — без анімації

let LngLat;
let animationTickHandler = () => {};
const animatingMarkers = new Set();
let animLoopRunning = false;
let lastClusterTs = 0;

export function initAnimations({ maplibregl }) {
    LngLat = maplibregl.LngLat;
}

export function setAnimationTickHandler(handler) {
    animationTickHandler = handler;
}

// Власник карти окремо очищає стан і видаляє сам маркер.
export function cancelMarkerAnimation(marker) {
    animatingMarkers.delete(marker);
}

export function animateMarkerTo(marker, lngLat, durationMs, onUpdate) {
    const from = marker.getLngLat();             // під час руху це вже проміжна точка
    const to = new LngLat(lngLat[0], lngLat[1]);
    const d = from.distanceTo(to);
    if (d < 0.5) {
        if (onUpdate) onUpdate(marker.getLngLat());
        return;
    }
    if (d > TELEPORT_M || document.hidden) {
        marker.setLngLat(to);
        marker._anim = null;
        animatingMarkers.delete(marker);
        if (onUpdate) onUpdate(marker.getLngLat());
        return;
    }
    marker._anim = { from, to, start: performance.now(), duration: durationMs, onUpdate };
    animatingMarkers.add(marker);
    if (!animLoopRunning) {
        animLoopRunning = true;
        requestAnimationFrame(animStep);
    }
}

function animStep(now) {
    animatingMarkers.forEach(marker => {
        const a = marker._anim;
        if (!a) { animatingMarkers.delete(marker); return; }
        const t = Math.min(1, (now - a.start) / a.duration);
        const e = 1 - Math.pow(1 - t, 3);
        marker.setLngLat([
            a.from.lng + (a.to.lng - a.from.lng) * e,
            a.from.lat + (a.to.lat - a.from.lat) * e,
        ]);
        if (a.onUpdate) a.onUpdate(marker.getLngLat());
        if (t >= 1) { marker._anim = null; animatingMarkers.delete(marker); }
    });
    // Кластери перераховуємо раз на ~0.6 с, а не щокадру
    if (now - lastClusterTs > 600) { lastClusterTs = now; animationTickHandler(); }
    if (animatingMarkers.size) {
        requestAnimationFrame(animStep);
    } else {
        animLoopRunning = false;
        animationTickHandler();
    }
}
