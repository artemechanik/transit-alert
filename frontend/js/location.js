let watchId = null;
let lastPosition = null;
let lastError = null;

export function isSupported() {
    return 'geolocation' in navigator;
}

// Лише позиція власного watch: раніше її доступність визначалася DOM-маркером.
export function getPosition() {
    return lastPosition;
}

export function getLocationState() {
    return { position: lastPosition, error: lastError, watching: watchId !== null };
}

export function startLocation(onPosition, onError) {
    if (watchId !== null || !isSupported()) return watchId;

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            lastPosition = {
                lat: position.coords.latitude,
                lon: position.coords.longitude,
                accuracy: position.coords.accuracy
            };
            lastError = null;
            onPosition(lastPosition);
        },
        (error) => {
            lastError = error;
            onError(error);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
    return watchId;
}

// Одноразові nearby-запити не змінюють позицію watch і не запускають його рендер.
export function requestPosition(onPosition, onError, options) {
    if (!isSupported()) return;
    return navigator.geolocation.getCurrentPosition(
        (position) => {
            lastError = null;
            onPosition(position);
        },
        (error) => {
            lastError = error;
            onError(error);
        },
        options
    );
}

export function disposeLocation() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}
