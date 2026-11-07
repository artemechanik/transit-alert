// Observes only our API. Recovery never replays application requests.
export function createBackendConnection({ apiBaseUrl, fetchImpl = (...args) => fetch(...args),
    document, onUnavailable, onRecovered = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let unavailable = false;
    let checking = null;
    let retryTimer = null;
    let started = false;

    function scheduleRetry() {
        if (!unavailable || document.hidden || retryTimer !== null) return;
        retryTimer = setTimer(() => {
            retryTimer = null;
            check();
        }, 10000);
    }

    function check() {
        if (checking) return checking;
        if (retryTimer !== null) clearTimer(retryTimer);
        retryTimer = null;
        // Defer work so checking is assigned even with synchronous test transports.
        checking = Promise.resolve().then(async () => {
            const controller = new AbortController();
            const timeout = setTimer(() => controller.abort(), 5000);
            let recovered = false;
            try {
                const response = await fetchImpl(`${apiBaseUrl}/status`, {
                    signal: controller.signal, cache: 'no-store'
                });
                if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Invalid status');
                recovered = unavailable;
                unavailable = false;
                onUnavailable(false);
            } catch {
                // This controller is owned by the probe: abort here means timeout,
                // never cancellation of an application request.
                unavailable = true;
                onUnavailable(true);
            } finally {
                clearTimer(timeout);
                checking = null;
                scheduleRetry();
            }
            if (recovered) onRecovered();
        });
        return checking;
    }

    async function request(url, options) {
        try {
            const response = await fetchImpl(url, options);
            if (response.status >= 500 && !unavailable) void check();
            return response;
        } catch (error) {
            if (error.name !== 'AbortError' && !options?.signal?.aborted && !unavailable) void check();
            throw error;
        }
    }

    function start() {
        if (started) return;
        started = true;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (retryTimer !== null) clearTimer(retryTimer);
                retryTimer = null;
            } else {
                void check();
            }
        });
        void check();
    }

    return { start, request };
}

let connection;
export function initBackendConnection(apiBaseUrl, onRecovered) {
    if (connection) return;
    const banner = document.getElementById('backend-connection-status');
    connection = createBackendConnection({ apiBaseUrl, document, onRecovered,
        onUnavailable: value => { banner.hidden = !value; }
    });
    connection.start();
}

export function apiFetch(...args) {
    return connection ? connection.request(...args) : fetch(...args);
}
