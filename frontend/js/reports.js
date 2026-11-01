// Звіти й обидві форми володіють своїми даними та обробниками; оболонка керує drawer/overlay.
export function createReports({ apiBaseUrl, showToast, openDrawer, closeDrawer, setOverlayVisible }) {
    let initialized = false;
    const REPORT_TTL_MS = 45 * 60 * 1000;
    let reportMarkersLayer;
    let reportsById = {};
    let allRoutesCache = null;
    let selectedPrzystanekStopId = null;
    let isStopLiniaSelected = false;
    let updateContext = null;
    let currentQuickSelection = 'Linia 14';
    let routeInput, routeSuggestions, stopNameInput, stopNameSuggestions, stopIdInput, stopIdSuggestions;

    function getFingerprint() {
      let fp = localStorage.getItem('ta_fingerprint');
      if (!fp) {
        fp = 'fp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('ta_fingerprint', fp);
      }
      return fp;
    }

    function ageColor(createdAtIso) {
      const ageMs = Date.now() - new Date(createdAtIso).getTime();
      const t = Math.min(Math.max(ageMs / REPORT_TTL_MS, 0), 1);
      const from = [229, 57, 53];   // свіжий — насичений червоний
      const to = [255, 205, 200];   // майже протух — блідий
      const rgb = from.map((c, i) => Math.round(c + (to[i] - c) * t));
      return { color: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, opacity: 0.9 - t * 0.4 };
    }

    async function fetchReports() {
      const res = await fetch(`${apiBaseUrl}/reports`);
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
        <button class="rc-vote-btn confirm">✓ Widzę (${r.confirms})</button>
        <button class="rc-vote-btn deny">✕ Już nie ma (${r.denies})</button>
        <button class="rc-vote-btn update">🔄 Update</button>
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
        const res = await fetch(`${apiBaseUrl}/reports/${id}`);
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
        container.querySelectorAll('.report-card').forEach((card, index) => {
          const report = reports[index];
          card.querySelector('.confirm').addEventListener('click', event => vote(report.id, 'confirm', event.currentTarget));
          card.querySelector('.deny').addEventListener('click', event => vote(report.id, 'deny', event.currentTarget));
          card.querySelector('.update').addEventListener('click', () => openUpdateModal(report.id));
        });
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
        const res = await fetch(`${apiBaseUrl}/reports/${reportId}/${type}`, {
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

    function openModal() {
      document.getElementById('report-modal').classList.add('show');
      setOverlayVisible(true);
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
      setOverlayVisible(false);
      document.querySelector('#modal-header h2').textContent = 'Zgłoś kanara';
      updateContext = null;
    }

    function openQuickModal() {
      document.getElementById('quick-report-modal').classList.add('open');
      setOverlayVisible(true);
    }

    function closeQuickModal() {
      document.getElementById('quick-report-modal').classList.remove('open');
      setOverlayVisible(false);
    }

    function openManualFromQuick() {
      closeQuickModal();
      setTimeout(() => { openModal(); }, 200);
    }

    function selectQuickOption(btnEl, value) {
      // Знімаємо клас 'selected' з усіх опцій
      document.querySelectorAll('.quick-option').forEach(b => b.classList.remove('selected'));
      // Додаємо його тій, на яку клікнули
      btnEl.classList.add('selected');

      // Запам'ятовуємо вибір
      currentQuickSelection = value;
    }

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

    async function loadRoutesForAutocomplete() {
      try {
        const res = await fetch(`${apiBaseUrl}/routes`);
        allRoutesCache = await res.json();
      } catch (e) {
        allRoutesCache = [];
      }
    }

    async function loadDirectionsForRoute(route) {
      const select = document.getElementById('direction-select');
      select.innerHTML = '<option value="">Завантаження...</option>';
      select.disabled = true;
      try {
        const res = await fetch(`${apiBaseUrl}/routes/${encodeURIComponent(route)}/directions`);
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
        const res = await fetch(`${apiBaseUrl}/reports`, {
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

    function openReports() {
        openDrawer('Zgłoszenia', renderReportsList);
    }

    function closeForms() {
        closeModal();
        closeQuickModal();
    }

    function initReports() {
        if (initialized) return;
        initialized = true;
        document.getElementById('tab-btn-linia').addEventListener('click', event => switchFormTab('linia', event.currentTarget));
        document.getElementById('tab-btn-przystanek').addEventListener('click', event => switchFormTab('przystanek', event.currentTarget));
        document.querySelectorAll('.quick-option').forEach(button => {
          button.addEventListener('click', () => selectQuickOption(button, button.dataset.reportValue));
        });
        document.querySelector('#quick-report-modal .btn-cancel').addEventListener('click', closeQuickModal);
        document.getElementById('quick-confirm-btn').addEventListener('click', sendQuickReport);
        document.querySelector('#quick-report-modal .manual-link').addEventListener('click', event => {
          openManualFromQuick();
          event.preventDefault();
        });
        document.getElementById('fab-report').addEventListener('click', openModal);
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('drawer-add').addEventListener('click', () => {
          closeDrawer(); // Акуратно ховаємо стрічку
          openModal();   // Відкриваємо форму створення репорту
        });
        routeInput = document.getElementById('route-input');
        routeSuggestions = document.getElementById('route-suggestions');
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
        stopNameInput = document.getElementById('stop-name-input');
        stopNameSuggestions = document.getElementById('stop-name-suggestions');
        stopNameInput.addEventListener('input', () => {
          isStopLiniaSelected = false;
          const q = stopNameInput.value.trim();
          if (q.length < 2) { stopNameSuggestions.style.display = 'none'; return; }
          fetch(`${apiBaseUrl}/stops/search?q=${encodeURIComponent(q)}`)
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
        stopIdInput = document.getElementById('stop-id-input');
        stopIdSuggestions = document.getElementById('stop-id-suggestions');
        stopIdInput.addEventListener('input', () => {
          selectedPrzystanekStopId = null;
          const q = stopIdInput.value.trim();
          if (q.length < 2) { stopIdSuggestions.style.display = 'none'; return; }
          fetch(`${apiBaseUrl}/stops/search?q=${encodeURIComponent(q)}`)
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
        document.getElementById('submit-btn').addEventListener('click', submitReport);
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


    }

    return { initReports, openReports, closeForms, openQuickModal };
}
