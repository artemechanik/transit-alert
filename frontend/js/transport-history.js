// Одноразове скидання ID зі старого GTFS; решта localStorage залишається без змін.
export function resetLegacyTransportHistory(storage) {
    const marker = 'ta_gtfs_id_format';
    const version = 'zbiorkom-api6';
    try {
        storage ??= window.localStorage;
        if (storage.getItem(marker) === version) return;
        for (const key of ['ta_recent_stops', 'ta_recent_route_stops', 'ta_recent_routes']) {
            storage.removeItem(key);
        }
        storage.setItem(marker, version);
    } catch (error) {
        console.warn('Не вдалося очистити історію старого GTFS:', error);
    }
}
