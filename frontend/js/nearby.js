const NEARBY_CACHE_TTL_MS = 120000;

let cachedNearbyStops = null;
let cachedNearbyTime = 0;

// Влучання в кеш повертає дані синхронно, як у старих екранах.
// Промах повертає Promise; координати не є частиною ключа кешу.
export function getNearbyStops(apiBaseUrl, lat, lon, checkStatus = false) {
  const now = Date.now();
  if (cachedNearbyStops && now - cachedNearbyTime < NEARBY_CACHE_TTL_MS) {
    return cachedNearbyStops;
  }

  return fetchAndCacheNearbyStops(apiBaseUrl, lat, lon, checkStatus, now);
}

async function fetchAndCacheNearbyStops(apiBaseUrl, lat, lon, checkStatus, requestedAt) {
  const res = await fetch(`${apiBaseUrl}/stops/nearby?lat=${lat}&lon=${lon}`);
  // Przystanek перевіряє HTTP-статус, Trasa історично читає JSON без цієї перевірки.
  if (checkStatus && !res.ok) throw new Error(`Код помилки: ${res.status}`);

  const groups = await res.json();
  cachedNearbyStops = groups;
  cachedNearbyTime = requestedAt;
  return groups;
}
