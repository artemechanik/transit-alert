// ==================== Конфіг ====================
const API_BASE_URL = 'http://100.95.178.22:8080'; // Chromebook через Tailscale mesh
const THUNDERFOREST_API_KEY = '4eaf1638dc4f415da1e41e6e364de9b5';
const LUBLIN_CENTER = [51.2465, 22.5684];
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

// ==================== Карта ====================
let map, reportMarkersLayer, searchMarker;

function initMap() {
  map = L.map('map', { zoomControl: false }).setView(LUBLIN_CENTER, 14);
  L.control.zoom({ position: 'bottomleft' }).addTo(map);

  const tileUrl = THUNDERFOREST_API_KEY
    ? `https://{s}.tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${THUNDERFOREST_API_KEY}`
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

  L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: THUNDERFOREST_API_KEY
      ? '&copy; OpenStreetMap contributors, tiles &copy; Thunderforest'
      : '&copy; OpenStreetMap contributors',
  }).addTo(map);

  reportMarkersLayer = L.layerGroup().addTo(map);
}

// ==================== Пошук зупинки (верхня панель) ====================
let searchDebounce;

function initSearchBar() {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  const list = document.getElementById('search-suggestions');

  input.addEventListener('input', () => {
    clearBtn.style.display = input.value ? 'block' : 'none';
    clearTimeout(searchDebounce);
    const q = input.value.trim();
    if (q.length < 2) { list.style.display = 'none'; return; }
    searchDebounce = setTimeout(() => runStopSearch(q, list, input), 250);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.style.display = 'none';
    list.style.display = 'none';
    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  });
}

async function runStopSearch(q, listEl, inputEl) {
  try {
    const res = await fetch(`${API_BASE_URL}/stops/search?q=${encodeURIComponent(q)}`);
    const stops = await res.json();
    if (!stops.length) {
      listEl.innerHTML = '<div id="search-empty">Нічого не знайдено</div>';
      listEl.style.display = 'block';
      return;
    }
    listEl.innerHTML = '';
    stops.forEach(s => {
      const row = document.createElement('div');
      row.innerHTML = `${s.name}<span class="code">${s.code}</span>`;
      row.onclick = () => {
        inputEl.value = `${s.name} ${s.code}`;
        listEl.style.display = 'none';
        flyToStop(s);
      };
      listEl.appendChild(row);
    });
    listEl.style.display = 'block';
  } catch (e) {
    console.warn('Пошук зупинок не вдався', e);
  }
}

function flyToStop(stop) {
  if (searchMarker) map.removeLayer(searchMarker);
  searchMarker = L.marker([stop.lat, stop.lon]).addTo(map)
    .bindPopup(`<b>${stop.name}</b><br>Platforma ${stop.code}`).openPopup();
  map.flyTo([stop.lat, stop.lon], 17);
}

// ==================== Нижня навігація ====================
function switchScreen(screen, btn) {
  // 1. Оновлюємо активну кнопку
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  // Елементи, які належать тільки до карти
  const mapSearchBar = document.getElementById('search-bar');
  const fabReport = document.getElementById('fab-report');

  // Ховаємо екран зупинки за замовчуванням
  const stopScreen = document.getElementById('screen-stop');
  if (stopScreen) stopScreen.style.display = 'none';

  // 3. Обробляємо логіку для кожної вкладки
  if (screen === 'map') {
    closeDrawer(false); 
    // Показуємо елементи карти
    if (mapSearchBar) mapSearchBar.style.display = 'flex';
    if (fabReport) fabReport.style.display = 'flex';
    
  } else if (screen === 'stop') {
    closeDrawer(false); 
    // ХОВАЄМО пошук карти та кнопку, бо тут є свій пошук
    if (mapSearchBar) mapSearchBar.style.display = 'none';
    if (fabReport) fabReport.style.display = 'none';
    if (stopScreen) stopScreen.style.display = 'flex'; 
    
  } else if (screen === 'reports') {
    openDrawer('Zgłoszenia', renderReportsList);
    if (mapSearchBar) mapSearchBar.style.display = 'flex';
    if (fabReport) fabReport.style.display = 'flex';
    
  } else if (screen === 'route') {
    openDrawer('Trasa', (container) => {
      container.innerHTML = '<div id="drawer-empty">Перегляд маршруту й прибуттів з\'явиться пізніше...</div>';
    });
    if (mapSearchBar) mapSearchBar.style.display = 'flex';
    if (fabReport) fabReport.style.display = 'flex';
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
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initSearchBar();
  refreshMapMarkers();
  setInterval(refreshMapMarkers, 45000); 

  // ДОДАТИ ЦЕ: Плавний скрол поля вводу над клавіатурою
  document.querySelectorAll('#report-modal input').forEach(input => {
    input.addEventListener('focus', function() {
      // Затримка 300мс дає час клавіатурі повністю виїхати
      setTimeout(() => {
        this.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    });
  });
});
// ==================== Вкладка "Przystanek" (Розклад) ====================

const stopSearchInput = document.getElementById('stop-screen-search');
const stopSuggestionsBox = document.getElementById('stop-screen-suggestions');
const stopTitleContainer = document.getElementById('stop-title-container');
const stopNameDisplay = document.getElementById('stop-name-display');
const departuresList = document.getElementById('departures-list');
const stopScreenContainer = document.getElementById('screen-stop');

// Створюємо кнопку оновлення та індикатор свайпу програмно
const ptrIndicator = document.createElement('div');
ptrIndicator.id = 'ptr-indicator';
ptrIndicator.innerHTML = '↻ Odświeżanie...';
departuresList.parentNode.insertBefore(ptrIndicator, departuresList);

const refreshFab = document.createElement('div');
refreshFab.id = 'refresh-fab';
refreshFab.innerHTML = '↻';
stopScreenContainer.appendChild(refreshFab);

let currentStopIdForDepartures = null;
let departuresRefreshInterval = null;

// Крок 1: Обробка вводу тексту для пошуку
stopSearchInput.addEventListener('input', async (e) => {
  const query = e.target.value.trim();
  
  if (query.length < 2) {
    stopSuggestionsBox.style.display = 'none';
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/stops/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error('Помилка мережі');
    
    const stops = await res.json();
    
    if (stops.length === 0) {
      stopSuggestionsBox.innerHTML = '<div style="padding: 10px; color: var(--text-muted);">Нічого не знайдено</div>';
      stopSuggestionsBox.style.display = 'block';
      return;
    }

    stopSuggestionsBox.innerHTML = '';
    stops.forEach(stop => {
      const item = document.createElement('div');
      item.className = 'stop-suggestion-item';
      
     // 1. Малюємо назву зупинки та номер платформи
      const title = document.createElement('div');
      title.className = 'stop-suggestion-title';
      title.innerHTML = `${stop.name} <span class="stop-suggestion-code">${stop.code}</span>`;
      item.appendChild(title);

      // 2. Якщо бекенд прислав маршрути, малюємо карусель
      if (stop.routes && stop.routes.length > 0) {
        const carousel = document.createElement('div');
        carousel.className = 'stop-routes-carousel';
        
        stop.routes.forEach(r => {
          const pill = document.createElement('div');
          pill.className = 'route-pill';
          pill.innerHTML = `<span class="route-pill-num">${r.route}</span><span class="route-pill-dir">${r.direction}</span>`;
          carousel.appendChild(pill);
        });
        
        item.appendChild(carousel);
      }
      
      // 3. Обробка кліку
      item.addEventListener('click', () => {
        stopSuggestionsBox.style.display = 'none';
        stopSearchInput.value = '';
        stopTitleContainer.style.display = 'block';
        stopNameDisplay.textContent = `${stop.name} ${stop.code}`;
        
        currentStopIdForDepartures = stop.stopId;
        loadDepartures(currentStopIdForDepartures);
        refreshFab.style.display = 'flex'; // Показуємо кнопку оновлення
      });
      
      stopSuggestionsBox.appendChild(item);
    });
    
    stopSuggestionsBox.style.display = 'block';
  } catch (error) {
    console.error('Помилка пошуку зупинки:', error);
  }
});

document.addEventListener('click', (e) => {
  if (!stopSearchInput.contains(e.target) && !stopSuggestionsBox.contains(e.target)) {
    stopSuggestionsBox.style.display = 'none';
  }
});

function addMinutesToTime(timeStr, mins) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m + mins, 0, 0);
  return d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}

// Крок 3: Завантаження та малювання розкладу
async function loadDepartures(stopId, isBackgroundRefresh = false) {
  if (!isBackgroundRefresh) {
    departuresList.innerHTML = '<div style="text-align: center; margin-top: 40px; color: var(--text-muted);">Завантаження... ⏳</div>';
  }
  
  try {
    const res = await fetch(`${API_BASE_URL}/stops/${stopId}/departures`);
    if (!res.ok) throw new Error('Не вдалося завантажити розклад');
    
    const departures = await res.json();
    
    if (departures.length === 0) {
      departuresList.innerHTML = '<div style="text-align: center; margin-top: 40px; color: var(--text-muted);">Brak odjazdów 🚏</div>';
    } else {
      departuresList.innerHTML = '';
      
      departures.forEach(dep => {
        const minClass = dep.isRealTime ? 'dep-min live' : 'dep-min';
        const timeText = dep.minutesLeft === 0 ? '< 1 min' : `${dep.minutesLeft} min`;
        
        let schedHtml = dep.scheduledTime;
        let statusHtml = '';

        if (dep.isRealTime) {
          if (dep.delayMinutes > 0) {
            const realTime = addMinutesToTime(dep.scheduledTime, dep.delayMinutes);
            schedHtml = `<s>${dep.scheduledTime}</s> <span class="time-mod time-delay">${realTime}</span>`;
            statusHtml = `<div class="dep-status status-delay">Opóźnienie: ${dep.delayMinutes} min</div>`;
          } else if (dep.delayMinutes < 0) {
            const earlyMins = Math.abs(dep.delayMinutes);
            const realTime = addMinutesToTime(dep.scheduledTime, dep.delayMinutes);
            schedHtml = `<s>${dep.scheduledTime}</s> <span class="time-mod time-early">${realTime}</span>`;
            statusHtml = `<div class="dep-status status-early">Przed czasem: ${earlyMins} min</div>`;
          } else {
            statusHtml = `<div class="dep-status status-ontime">Punktualnie</div>`;
          }
        } else {
          statusHtml = `<div class="dep-status status-sched">Rozkład jazdy</div>`;
        }
        
        const card = document.createElement('div');
        card.className = 'dep-card';
        card.innerHTML = `
          <div class="dep-route">${dep.route}</div>
          <div class="dep-info">
            <div class="dep-dir">${dep.direction}</div>
            ${statusHtml}
          </div>
          <div class="dep-times">
            <div class="${minClass}">${timeText}</div>
            <div class="dep-sched">${schedHtml}</div>
          </div>
        `;
        departuresList.appendChild(card);
      });
    }

    // Запускаємо автоматичне оновлення, якщо воно ще не працює
    if (!departuresRefreshInterval) {
      departuresRefreshInterval = setInterval(() => {
        // Оновлюємо, тільки якщо екран розкладу зараз відкритий
        if (currentStopIdForDepartures && stopScreenContainer.style.display !== 'none') {
          loadDepartures(currentStopIdForDepartures, true);
        }
      }, 15000); // кожні 15 секунд
    }
    
  } catch (error) {
    console.error('Помилка завантаження розкладу:', error);
    if (!isBackgroundRefresh) {
      departuresList.innerHTML = '<div style="text-align: center; margin-top: 40px; color: var(--danger);">Błąd połączenia ⚠️</div>';
    }
  }
}

// --- Ручне оновлення (Кнопка) ---
refreshFab.addEventListener('click', async () => {
  if (currentStopIdForDepartures) {
    refreshFab.classList.add('spin');
    await loadDepartures(currentStopIdForDepartures, true);
    setTimeout(() => refreshFab.classList.remove('spin'), 500); // Даємо анімації докрутитися
  }
});

// --- Ручне оновлення (Swipe down / Pull-to-refresh) ---
let startY = 0;
let isRefreshing = false;

departuresList.addEventListener('touchstart', (e) => {
  if (departuresList.scrollTop === 0) startY = e.touches[0].clientY;
  else startY = 0;
}, { passive: true });

departuresList.addEventListener('touchmove', (e) => {
  if (!startY || isRefreshing) return;
  const dy = e.touches[0].clientY - startY;
  // Якщо ми на самому верху списку і тягнемо вниз
  if (dy > 0 && departuresList.scrollTop === 0) {
    ptrIndicator.style.height = Math.min(dy, 50) + 'px';
  }
}, { passive: true });

departuresList.addEventListener('touchend', async (e) => {
  if (!startY || isRefreshing) return;
  const dy = e.changedTouches[0].clientY - startY;
  
  if (dy > 60 && departuresList.scrollTop === 0 && currentStopIdForDepartures) {
    isRefreshing = true;
    ptrIndicator.style.height = '40px'; // Фіксуємо індикатор
    await loadDepartures(currentStopIdForDepartures, true);
    ptrIndicator.style.height = '0';    // Ховаємо
    isRefreshing = false;
  } else {
    ptrIndicator.style.height = '0';    // Якщо потягнули недостатньо сильно — ховаємо
  }
  startY = 0;
});
