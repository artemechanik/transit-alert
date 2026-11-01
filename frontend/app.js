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
const REPORT_TTL_MS = 45 * 60 * 1000; // синхронно з REPORT_TTL_MINUTES на бекенді

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

// ==================== Fingerprint пристрою ====================
function getFingerprint() {
  let fp = localStorage.getItem('ta_fingerprint');
  if (!fp) {
    fp = 'fp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('ta_fingerprint', fp);
  }
  return fp;
}
function initializeLegacyHistory() {
    // Фіксуємо початковий стан при завантаженні
    window.history.replaceState({ screen: 'map' }, "");
}
// ==================== Карта (MapLibre GL) ====================
let reportMarkersLayer, vehicleMarker;
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
    if (typeof openDrawer === 'function') openDrawer('Zgłoszenia', renderReportsList);
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
  if (typeof closeModal === 'function') closeModal();
  if (typeof closeQuickModal === 'function') closeQuickModal(); // <-- Додано
});
// ==================== Стрічка (drawer + маркери на карті) ====================
let reportsById = {};

/** "Температурний" колір маркера: свіжий допис — насичений, ближче до TTL (45 хв) — блідне. */
function ageColor(createdAtIso) {
  const ageMs = Date.now() - new Date(createdAtIso).getTime();
  const t = Math.min(Math.max(ageMs / REPORT_TTL_MS, 0), 1);
  const from = [229, 57, 53];   // свіжий — насичений червоний
  const to = [255, 205, 200];   // майже протух — блідий
  const rgb = from.map((c, i) => Math.round(c + (to[i] - c) * t));
  return { color: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, opacity: 0.9 - t * 0.4 };
}

async function fetchReports() {
  const res = await fetch(`${API_BASE_URL}/reports`);
  const reports = await res.json();
  reportsById = Object.fromEntries(reports.map(r => [r.id, r]));
  return reports;
}

function reportCardHtml(r) {
  const time = new Date(r.createdAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  const routeLine = r.route ? `Linia ${r.route}${r.direction ? ' → ' + r.direction : ''}` : '';

  let quoteBlock = '';
  if (r.previousReportId) {
    const original = reportsById[r.previousReportId];
    if (original) {
      const origTime = new Date(original.createdAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

      // Формуємо контекст: якщо була лінія - показуємо її, інакше - зупинку
      const origContext = original.route
        ? `Linia ${original.route}${original.direction ? ' → ' + original.direction : ''}`
        : `${original.stopName} ${original.stopCode}`;

      quoteBlock = `
        <div class="rc-update-block">
          <div class="rc-update-header">upd: ${origContext} (${origTime})</div>
          ${original.comment ? `<div class="rc-update-comment">${escapeHtml(original.comment)}</div>` : ''}
        </div>`;
    } else {
      quoteBlock = `
        <div class="rc-update-block">
          <div class="rc-update-header">upd: zgłoszenie #${r.previousReportId} (nie znaleziono)</div>
        </div>`;
    }
  }

  return `
    <div class="report-card" data-id="${r.id}">
      ${quoteBlock}
      <div class="rc-top">
        <span class="rc-stop">${r.stopName} ${r.stopCode}</span>
        <span class="rc-time">${time}</span>
      </div>
      ${routeLine ? `<div class="rc-route">${routeLine}</div>` : ''}
      ${r.comment ? `<div class="rc-comment">${escapeHtml(r.comment)}</div>` : ''}
      <div class="rc-votes">
        <button class="rc-vote-btn confirm" onclick="vote(${r.id}, 'confirm', this)">✓ Widzę (${r.confirms})</button>
        <button class="rc-vote-btn deny" onclick="vote(${r.id}, 'deny', this)">✕ Już nie ma (${r.denies})</button>
        <button class="rc-vote-btn update" onclick="openUpdateModal(${r.id})">🔄 Update</button>
      </div>
    </div>`;
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function fetchReportById(id) {
  if (reportsById[id]) return reportsById[id];
  try {
    const res = await fetch(`${API_BASE_URL}/reports/${id}`);
    if (!res.ok) return null;
    const report = await res.json();
    reportsById[id] = report;
    return report;
  } catch (e) {
    return null;
  }
}

async function renderReportsList(container) {
  try {
    const reports = await fetchReports();
    if (!reports.length) {
      container.innerHTML = '<div id="drawer-empty">Zero zgłoszeń w ostatnich 45 minutach. Spokojnie.</div>';
      return;
    }
    // Довантажуємо оригінали для апдейтів, чий батько вже випав з 45-хв стрічки —
    // без цього цитата в rc-quote не мала б звідки взяти текст.
    const missingIds = reports
      .map(r => r.previousReportId)
      .filter(id => id != null && !reportsById[id]);
    await Promise.all([...new Set(missingIds)].map(fetchReportById));

    container.innerHTML = reports.map(reportCardHtml).join('');
  } catch (e) {
    container.innerHTML = '<div id="drawer-empty">Не вдалось завантажити стрічку</div>';
  }
}

async function refreshMapMarkers() {
return;
  try {
    const reports = await fetchReports();
    reportMarkersLayer.clearLayers();
    reports.forEach(r => {
      const { color, opacity } = ageColor(r.createdAt);
      const marker = L.circleMarker([r.lat, r.lon], {
        radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: opacity,
      }).addTo(reportMarkersLayer);
      const routeLine = r.route ? `Linia ${r.route}${r.direction ? ' → ' + r.direction : ''}<br>` : '';
      marker.bindPopup(`<b>${r.stopName} ${r.stopCode}</b><br>${routeLine}${r.comment ? escapeHtml(r.comment) : ''}`);
    });
  } catch (e) {
    console.warn('Не вдалось оновити маркери', e);
  }
}

async function vote(reportId, type, btnEl) {
  try {
    const res = await fetch(`${API_BASE_URL}/reports/${reportId}/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: getFingerprint() }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const card = btnEl.closest('.report-card');
    card.querySelector('.confirm').textContent = `✓ Widzę (${data.confirms})`;
    card.querySelector('.deny').textContent = `✕ Już nie ma (${data.denies})`;
  } catch (e) {
    console.warn('Голос не пройшов', e);
  }
}

// ==================== Модалка допису ====================
let allRoutesCache = null;
let selectedPrzystanekStopId = null;
let isStopLiniaSelected = false;
let updateContext = null; // { previousReportId } коли модалка відкрита як "Update" існуючого допису

function openModal() {
  document.getElementById('report-modal').classList.add('show');
  document.getElementById('overlay').classList.add('show');
  loadRoutesForAutocomplete();
}

async function openUpdateModal(reportId) {
  const original = reportsById[reportId];
  if (!original) return;

  updateContext = { previousReportId: reportId };
  document.querySelector('#modal-header h2').textContent = `Update zgłoszenia #${reportId}`;

  openModal();
  await loadRoutesForAutocomplete();

  if (original.route) {
    // оригінал був через вкладку Linia — переключаємось і підставляємо ті самі route/direction/stopName
    document.getElementById('tab-btn-linia').click();
    routeInput.value = original.route;
    stopNameInput.value = original.stopName;
    isStopLiniaSelected = true;
    await loadDirectionsForRoute(original.route);
    document.getElementById('direction-select').value = original.direction || '';
  } else {
    // оригінал був через вкладку Przystanek
    document.getElementById('tab-btn-przystanek').click();
    stopIdInput.value = `${original.stopName} ${original.stopCode}`;
    selectedPrzystanekStopId = original.stopId;
  }
}

function closeModal() {
  document.getElementById('report-modal').classList.remove('show');
  document.getElementById('overlay').classList.remove('show');
  document.querySelector('#modal-header h2').textContent = 'Zgłoś kanara';
  updateContext = null;
}

document.getElementById('fab-report').addEventListener('click', openModal);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('drawer-add').addEventListener('click', () => {
  closeDrawer(); // Акуратно ховаємо стрічку
  openModal();   // Відкриваємо форму створення репорту
});

// --- Логіка швидкого репорту (Kanar obok) ---
let currentQuickSelection = 'Linia 14'; // Значення за замовчуванням

function openQuickModal() {
  document.getElementById('quick-report-modal').classList.add('open');
  document.getElementById('overlay').classList.add('show');
}

function closeQuickModal() {
  document.getElementById('quick-report-modal').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

function openManualFromQuick() {
  closeQuickModal();
  setTimeout(() => { openModal(); }, 200);
}

// Функція вибору зі списку (робить кнопку червоною)
function selectQuickOption(btnEl, value) {
  // Знімаємо клас 'selected' з усіх опцій
  document.querySelectorAll('.quick-option').forEach(b => b.classList.remove('selected'));
  // Додаємо його тій, на яку клікнули
  btnEl.classList.add('selected');

  // Запам'ятовуємо вибір
  currentQuickSelection = value;
}

// Функція відправки (після натискання "Potwierdzam")
function sendQuickReport() {
  if (!currentQuickSelection) return;

  closeQuickModal();
  showToast('Zgłoszenie wysłane: ' + currentQuickSelection + ' ✓');

  // У майбутньому тут ми братимемо координати / ID і відправлятимемо POST-запит
}

function switchFormTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-linia').classList.toggle('active', tab === 'linia');
  document.getElementById('tab-przystanek').classList.toggle('active', tab === 'przystanek');
  document.getElementById('form-hint').textContent = '';
}

function getActiveFormTab() {
  return document.getElementById('tab-linia').classList.contains('active') ? 'linia' : 'przystanek';
}

// --- Автокомпліт номера лінії (завжди свіжий список при відкритті модалки) ---
async function loadRoutesForAutocomplete() {
  try {
    const res = await fetch(`${API_BASE_URL}/routes`);
    allRoutesCache = await res.json();
  } catch (e) {
    allRoutesCache = [];
  }
}

const routeInput = document.getElementById('route-input');
const routeSuggestions = document.getElementById('route-suggestions');

routeInput.addEventListener('input', () => {
  const val = routeInput.value.trim();
  document.getElementById('direction-select').innerHTML = '<option value="">— спершу оберіть лінію —</option>';
  document.getElementById('direction-select').disabled = true;

  if (!val || !allRoutesCache) { routeSuggestions.style.display = 'none'; return; }
  const matches = allRoutesCache.filter(r => r.toLowerCase().startsWith(val.toLowerCase())).slice(0, 8);
  if (!matches.length) { routeSuggestions.style.display = 'none'; return; }

  routeSuggestions.innerHTML = '';
  matches.forEach(r => {
    const row = document.createElement('div');
    row.textContent = r;
    row.onclick = () => {
      routeInput.value = r;
      routeSuggestions.style.display = 'none';
      loadDirectionsForRoute(r);
    };
    routeSuggestions.appendChild(row);
  });
  routeSuggestions.style.display = 'block';
});

async function loadDirectionsForRoute(route) {
  const select = document.getElementById('direction-select');
  select.innerHTML = '<option value="">Завантаження...</option>';
  select.disabled = true;
  try {
    const res = await fetch(`${API_BASE_URL}/routes/${encodeURIComponent(route)}/directions`);
    if (!res.ok) throw new Error('not found');
    const directions = await res.json();
    if (!directions.length) {
      select.innerHTML = '<option value="">Немає активних напрямків зараз</option>';
      return;
    }
    select.innerHTML = '<option value="">— оберіть напрямок —</option>' +
      directions.map(d => `<option value="${d}">${d}</option>`).join('');
    select.disabled = false;
  } catch (e) {
    select.innerHTML = '<option value="">Невірний номер лінії</option>';
  }
}

// --- Автокомпліт назви зупинки (вкладка Linia — без коду платформи) ---
const stopNameInput = document.getElementById('stop-name-input');
const stopNameSuggestions = document.getElementById('stop-name-suggestions');

stopNameInput.addEventListener('input', () => {
  isStopLiniaSelected = false;
  const q = stopNameInput.value.trim();
  if (q.length < 2) { stopNameSuggestions.style.display = 'none'; return; }
  fetch(`${API_BASE_URL}/stops/search?q=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .then(stops => {
      const uniqueNames = [...new Set(stops.map(s => s.name))].slice(0, 8);
      if (!uniqueNames.length) { stopNameSuggestions.style.display = 'none'; return; }
      stopNameSuggestions.innerHTML = '';
      uniqueNames.forEach(name => {
        const row = document.createElement('div');
        row.textContent = name;
        row.onclick = () => {
          stopNameInput.value = name;
          isStopLiniaSelected = true;
          stopNameSuggestions.style.display = 'none';
        };
        stopNameSuggestions.appendChild(row);
      });
      stopNameSuggestions.style.display = 'block';
    });
});

stopNameInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (!isStopLiniaSelected) stopNameInput.value = '';
  }, 150);
});

// --- Автокомпліт зупинки з платформою (вкладка Przystanek) ---
const stopIdInput = document.getElementById('stop-id-input');
const stopIdSuggestions = document.getElementById('stop-id-suggestions');

stopIdInput.addEventListener('input', () => {
  selectedPrzystanekStopId = null;
  const q = stopIdInput.value.trim();
  if (q.length < 2) { stopIdSuggestions.style.display = 'none'; return; }
  fetch(`${API_BASE_URL}/stops/search?q=${encodeURIComponent(q)}`)
    .then(r => r.json())
    .then(stops => {
      if (!stops.length) { stopIdSuggestions.style.display = 'none'; return; }
      stopIdSuggestions.innerHTML = '';
      stops.slice(0, 10).forEach(s => {
        const row = document.createElement('div');
        row.innerHTML = `${s.name}<span style="color:#6b7684;margin-left:6px;">${s.code}</span>`;
        row.onclick = () => {
          stopIdInput.value = `${s.name} ${s.code}`;
          selectedPrzystanekStopId = s.stopId;
          stopIdSuggestions.style.display = 'none';
        };
        stopIdSuggestions.appendChild(row);
      });
      stopIdSuggestions.style.display = 'block';
    });
});

stopIdInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (!selectedPrzystanekStopId) stopIdInput.value = '';
  }, 150);
});

// --- Сабміт ---
document.getElementById('submit-btn').addEventListener('click', submitReport);

async function submitReport() {
  const hint = document.getElementById('form-hint');
  const submitBtn = document.getElementById('submit-btn');
  const comment = document.getElementById('comment-input').value.trim();
  const tabType = getActiveFormTab();

  const requestData = { fingerprint: getFingerprint() };
  if (comment) requestData.comment = comment;
  if (updateContext) requestData.previousReportId = updateContext.previousReportId;
  const wasUpdate = !!updateContext;

  if (tabType === 'linia') {
    const route = routeInput.value.trim();
    const direction = document.getElementById('direction-select').value;
    const stopName = stopNameInput.value.trim();
    if (!route || !direction || !stopName) {
      hint.textContent = 'Wypełnij linię, przystanek i kierunek';
      return;
    }
    requestData.route = route;
    requestData.direction = direction;
    requestData.stopName = stopName;
  } else {
    if (!selectedPrzystanekStopId) {
      hint.textContent = 'Wybierz przystanek z listy';
      return;
    }
    requestData.stopId = selectedPrzystanekStopId;
  }

  submitBtn.disabled = true;
  hint.textContent = 'Wysyłanie...';
  try {
    const res = await fetch(`${API_BASE_URL}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestData),
    });
    if (res.status === 429) {
      hint.textContent = 'Zaczekaj kilka minut przed kolejnym zgłoszeniem';
      submitBtn.disabled = false;
      return;
    }
    if (!res.ok) {
      const msg = await res.text();
      hint.textContent = msg || 'Coś poszło nie tak';
      submitBtn.disabled = false;
      return;
    }
    resetForm();
    closeModal();
    refreshMapMarkers();
    showToast(wasUpdate ? 'Zgłoszenie zaktualizowane ✓' : 'Zgłoszenie dodane ✓');
  } catch (e) {
    hint.textContent = 'Brak połączenia z serwerem';
  } finally {
    submitBtn.disabled = false;
  }
}

function resetForm() {
  routeInput.value = '';
  stopNameInput.value = '';
  stopIdInput.value = '';
  document.getElementById('comment-input').value = '';
  document.getElementById('direction-select').innerHTML = '<option value="">— спершу оберіть лінію —</option>';
  document.getElementById('direction-select').disabled = true;
  document.getElementById('form-hint').textContent = '';
  selectedPrzystanekStopId = null;
  isStopLiniaSelected = false;
}

// ==================== Старт ====================
function initializeLegacyMap() {
    cityMap.initCityMap();
}

function trackUserLocation() {
    return cityMap.trackUserLocation();
}
// Прокручуємо лише форму, якщо активне поле виходить за її видимі межі.
document.getElementById('report-modal').addEventListener('focusin', (event) => {
  const modal = event.currentTarget;
  const field = event.target;
  if (!field.matches('input, textarea')) return;

  setTimeout(() => {
    if (!modal.classList.contains('show') || document.activeElement !== field || !modal.contains(field)) return;
    if (modal.clientHeight === 0) return;

    const modalRect = modal.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    const visibleTop = modalRect.top + modal.clientTop;
    const visibleBottom = visibleTop + modal.clientHeight;

    if (fieldRect.top < visibleTop) {
      modal.scrollTop += fieldRect.top - visibleTop - 8;
    } else if (fieldRect.bottom > visibleBottom) {
      modal.scrollTop += fieldRect.bottom - visibleBottom + 8;
    }
  }, 300);
});

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
