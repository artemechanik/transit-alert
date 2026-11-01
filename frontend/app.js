// ==================== Конфіг ====================
let API_BASE_URL;

// Перевіряємо, чи ми зайшли через публічний тунель Cloudflare
if (window.location.hostname.includes('trycloudflare.com')) {
    API_BASE_URL = 'https://vice-craps-lesson-conscious.trycloudflare.com';
} else {
    // Якщо зайшли локально (192.168...), через localhost або Tailscale (100.x.x.x)
    API_BASE_URL = window.location.protocol + '//' + window.location.hostname + ':8080';
}
// ================================================

// ==================== Toast-повідомлення ====================
let toastTimeout;
function showToast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 2200);
}

function initializeLegacyHistory() {
    // Фіксуємо початковий стан при завантаженні
    window.history.replaceState({ screen: 'map' }, "");
}
// ==================== Карта (MapLibre GL) ====================
let vehicleMarker;
let allVehiclesClusterGroup = null;

// Заглушки, щоб старий код не крашив додаток
function trackUserLocation() { }
let clusterMarkers = [];
const cityMap = window.transitMigration.createCityMap({
    apiBaseUrl: API_BASE_URL,
    getMapTilerKey: () => MAPTILER_KEY,
    showToast,
    refreshMapVehicleArrows
});

const tripMap = window.transitMigration.createTripMap({
    apiBaseUrl: API_BASE_URL,
    getMapTilerKey: () => MAPTILER_KEY,
    showToast,
    refreshMapVehicleArrows,
    onOpen: () => history.pushState({ screen: 'vehicleMap' }, '')
});

function refreshMapVehicleArrows(mapInstance) {
    const mapBearing = mapInstance.getBearing();
    mapInstance.getContainer().querySelectorAll('.vehicle-arrow').forEach(a => {
        const b = parseFloat(a.dataset.bearing) || 0;
        a.style.transform = `rotate(${b - mapBearing}deg)`;
    });
}
// ==================== Тема (Авто / День / Ніч) ====================
const themeService = window.transitMigration.theme;

function getThemePref() {
    return themeService.getThemePref();
}

function getEffectiveTheme() {
    return themeService.getEffectiveTheme();
}

function mapStyleFor(effective) {
    return themeService.mapStyleFor(effective);
}

// Міняє стиль карти лише тоді, коли ефективна тема реально змінилась
function syncMapStyle() {
    return cityMap.applyMapTheme();
}

function applyTheme() {
    return themeService.applyTheme();
}

// Повідомляємо обидва контролери; мінікарта зберігає часткове очищення при зміні теми.
function synchronizeThemeMaps() {
    syncMapStyle();
    tripMap.handleThemeChange();
}

themeService.initTheme({ onChange: synchronizeThemeMaps });
// Старий пошук не ініціалізується автоматично; глобальні виклики делегують контролеру.
function initSearchBar() {
    return cityMap.initSearchBar();
}

function runStopSearch(q, listEl, inputEl) {
    return cityMap.runStopSearch(q, listEl, inputEl);
}

function flyToStop(stop) {
    return cityMap.flyToStop(stop);
}

// --- ЗМІННІ ДЛЯ МІНІ-КАРТИ ---

// ==================== Модальна міні-карта ====================
function showVehicleOnMap(tripId, routeContext) {
    return tripMap.showVehicleOnMap(tripId, routeContext);
}

function closeVehicleMapModal() {
    return tripMap.closeVehicleMapModal();
}

// Хрестик тепер просто імітує кнопку "Назад"
document.getElementById('close-modal-btn').addEventListener('click', () => {
  history.back();
});
// Сумісність зі старою гілкою refreshTrackedVehicle.
function fetchVehiclePosition(tripId, signal) {
    return tripMap.fetchVehiclePosition(tripId, signal);
}

// ЗАМОРОЖЕНО: Тут був код малювання маркера
function drawVehicleMarker(vehicle) {
  return;
}

// БЕЗПЕЧНО: Залишаємо
async function refreshTrackedVehicle() {
  if (!trackedTripId) return;
  const vehicle = await fetchVehiclePosition(trackedTripId);
  if (!vehicle) {
    stopVehicleTracking();
    showToast('Pojazd zniknął z GPS (kurs zakończony?)');
    return;
  }
  drawVehicleMarker(vehicle); // Просто викличе безпечну порожню функцію вище
}

// БЕЗПЕЧНО: Залишаємо
function stopVehicleTracking() {
    if (typeof vehicleTrackInterval !== 'undefined' && vehicleTrackInterval) {
        clearInterval(vehicleTrackInterval);
        vehicleTrackInterval = null;
    }
    tripMap.stopPolling();
    trackedTripId = null;
}

// ==================== Нижня навігація ====================
function switchScreen(screenId, btn, isBackAction = false) {
  // --- ВИПРАВЛЕНО: Закриваємо міні-карту БЕЗ виклику history.back() ---
  if (typeof closeVehicleMapModal === 'function') {
    closeVehicleMapModal();
  }
  // --------------------------------------------------------------------

  // Оновлюємо активну кнопку
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));

  if (btn) {
      btn.classList.add('active');
  } else {
      // Якщо btn не передали, шукаємо кнопку по ID
      const activeBtn = document.getElementById(`nav-${screenId}`);
      if (activeBtn) activeBtn.classList.add('active');
  }

  // Елементи, які належать тільки до карти
  const mapSearchBar = document.getElementById('search-bar');
  const fabReport = document.getElementById('fab-report');

  // Ховаємо ВСІ екрани за замовчуванням (щоб не накладалися)
  const stopScreen = document.getElementById('screen-stop');
  if (stopScreen) stopScreen.style.display = 'none';

  const routeScreen = document.getElementById('screen-route');
  if (routeScreen) routeScreen.style.display = 'none';

  // 3. Обробляємо логіку для кожної вкладки
  if (screenId === 'map') {
    if (typeof closeDrawer === 'function') closeDrawer(false);
    if (mapSearchBar) mapSearchBar.style.display = 'flex';
    if (fabReport) fabReport.style.display = 'flex';

  } else if (screenId === 'stop') {
      if (typeof stopVehicleTracking === 'function') stopVehicleTracking();
      if (typeof closeDrawer === 'function') closeDrawer(false);
      if (mapSearchBar) mapSearchBar.style.display = 'none';
      if (fabReport) fabReport.style.display = 'none';
      if (stopScreen) stopScreen.style.display = 'flex';

      stops.enterStops({ isBackAction });

  } else if (screenId === 'reports') {
    if (typeof stopVehicleTracking === 'function') stopVehicleTracking();
    if (typeof openDrawer === 'function') reports.openReports();
    if (mapSearchBar) mapSearchBar.style.display = 'flex';
    if (fabReport) fabReport.style.display = 'flex';

  } else if (screenId === 'route') {
    if (typeof stopVehicleTracking === 'function') stopVehicleTracking();
    if (typeof closeDrawer === 'function') closeDrawer(false);
    if (routeScreen) routeScreen.style.display = 'flex';
    if (mapSearchBar) mapSearchBar.style.display = 'none';
    if (fabReport) fabReport.style.display = 'none';
    planner.enterPlanner();
  } // <--- ВИПРАВЛЕНО: ЦЯ ДУЖКА ЗАКРИВАЄ БЛОК 'ROUTE'

  // МАГІЯ ІСТОРІЇ: Тепер це працює для ВСІХ вкладок
  if (!isBackAction) {
      const currentState = window.history.state;
      if (!currentState || currentState.screen !== screenId) {
          window.history.pushState({ screen: screenId }, "");
      }
  }
}
function openDrawer(title, fillFn) {
  document.querySelector('#drawer-header h2').textContent = title;
  const drawer = document.getElementById('reports-drawer');
  const list = document.getElementById('drawer-list');
  list.innerHTML = '<div id="drawer-empty">Завантаження...</div>';
  drawer.classList.add('open');
  document.getElementById('overlay').classList.add('show');
  if (fillFn) fillFn(list);
}

function closeDrawer(resetNav = true) {
  document.getElementById('reports-drawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');

  if (resetNav) {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('nav-map').classList.add('active');

    const stopScreen = document.getElementById('screen-stop');
    if (stopScreen) stopScreen.style.display = 'none';

    // Повертаємо елементи карти
    const mapSearchBar = document.getElementById('search-bar');
    const fabReport = document.getElementById('fab-report');
    if (mapSearchBar) mapSearchBar.style.display = 'flex';
    if (fabReport) fabReport.style.display = 'flex';
  }
}
document.getElementById('drawer-close').addEventListener('click', () => closeDrawer(true));
document.getElementById('overlay').addEventListener('click', () => {
  closeDrawer(true);
  reports.closeForms();
});
// ==================== Звіти й форми ====================
const reports = window.transitMigration.createReports({
    apiBaseUrl: API_BASE_URL,
    showToast,
    openDrawer,
    closeDrawer,
    setOverlayVisible: visible => document.getElementById('overlay').classList.toggle('show', visible)
});
reports.initReports();

// ==================== Старт ====================
function initializeLegacyMap() {
    cityMap.initCityMap();
}

function trackUserLocation() {
    return cityMap.trackUserLocation();
}
// ==================== Планувальник Trasa ====================
const planner = window.transitMigration.createPlanner({
    apiBaseUrl: API_BASE_URL,
    getMapTilerKey: () => MAPTILER_KEY,
    showVehicleOnMap: tripMap.showVehicleOnMap,
    showToast,
    addMinutesToTime: (timeStr, mins) => stops.addMinutesToTime(timeStr, mins),
    onAccordionOpen: () => history.pushState({ screen: 'route', overlay: 'accordion' }, ''),
    onBack: () => history.back()
});
planner.initPlanner();

// Запускаємо відмальовку останніх маршрутів при завантаженні сторінки
function initializeLegacyRecentRoutes() {
    planner.renderRecentRoutes();
}

// ==================== Вкладка "Przystanek" ====================
const stops = window.transitMigration.createStops({
    apiBaseUrl: API_BASE_URL,
    showVehicleOnMap: tripMap.showVehicleOnMap,
    onAccordionOpen: () => history.pushState({ screen: 'stop', overlay: 'depAccordion' }, ''),
    onBack: () => history.back()
});
stops.initStops();

window.addEventListener('popstate', (event) => {
  // 1. Закриваємо міні-карту, якщо вона відкрита
  if (typeof closeVehicleMapModal === 'function') {
    closeVehicleMapModal();
  }

  // 2. ЗАКРИВАЄМО АКОРДЕОН ТРАСИ
  if (!event.state || event.state.overlay !== 'accordion') {
    planner.closePlannerAccordion();
  }

  // 3. Закриваємо акордеон зупинок через його власника.
  if (!event.state || event.state.overlay !== 'depAccordion') {
    stops.closeDepartureAccordion();
  }

  // 4. Перемикання вкладок нижнього меню
  if (event.state && event.state.screen) {
    const targetScreenId = event.state.screen;
    let targetButton;
    switch(targetScreenId) {
      case 'map': targetButton = document.getElementById('nav-map'); break;
      case 'route': targetButton = document.getElementById('nav-route'); break;
      case 'stop': targetButton = document.getElementById('nav-stop'); break;
      case 'reports': targetButton = document.getElementById('nav-reports'); break;
    }
    if (targetButton) {
      switchScreen(targetScreenId, targetButton, true);
    }
  }
});

// Автозапуск лише після виконання всіх негайних прив'язок та оголошень стану.
let legacyAppStarted = false;

function startLegacyApp() {
  if (legacyAppStarted) return;
  legacyAppStarted = true;

  // Раніше document-обробники виконувалися перед window-обробником історії.
  initializeLegacyMap();
  initializeLegacyRecentRoutes();
  initializeLegacyHistory();
}

const legacyStartupBridge = window.transitMigration;

if (legacyStartupBridge?.mode === 'managed') {
  legacyStartupBridge.start = startLegacyApp;
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startLegacyApp, { once: true });
} else {
  startLegacyApp();
}
