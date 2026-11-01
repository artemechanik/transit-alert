// Та сама логіка вибору API; клієнтський ключ карти читається лише за запитом.
export function readConfig() {
    // ==================== Конфіг ====================
    let API_BASE_URL;

    if (window.location.hostname.endsWith('.ts.net')) {
        API_BASE_URL = window.location.origin.replace(/:\d+$/, '') + ':8443';
    } else if (window.location.hostname.includes('trycloudflare.com')) {
        API_BASE_URL = 'https://vice-craps-lesson-conscious.trycloudflare.com';
    } else {
        API_BASE_URL = window.location.protocol + '//' + window.location.hostname + ':8080';
    }
    // ================================================

    return { apiBaseUrl: API_BASE_URL, getMapTilerKey: () => MAPTILER_KEY };
}
