// Єдиний власник навігаційних обробників, drawer, overlay та History API.
export function createNavigation({
    closeVehicleMapModal, stopVehicleTracking,
    enterStops, enterPlanner, leavePlanner, openReports, closeForms,
    closePlannerAccordion, closeDepartureAccordion, isPlannerAccordionOpen = () => false
}) {
    let initialized = false;
    let historyInitialized = false;

    function switchScreen(screenId, btn, isBackAction = false) {
      if (screenId !== 'route') leavePlanner();
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

          enterStops({ isBackAction });

      } else if (screenId === 'reports') {
        if (typeof stopVehicleTracking === 'function') stopVehicleTracking();
        if (typeof openDrawer === 'function') openReports();
        if (mapSearchBar) mapSearchBar.style.display = 'flex';
        if (fabReport) fabReport.style.display = 'flex';

      } else if (screenId === 'route') {
        if (typeof stopVehicleTracking === 'function') stopVehicleTracking();
        if (typeof closeDrawer === 'function') closeDrawer(false);
        if (routeScreen) routeScreen.style.display = 'flex';
        if (mapSearchBar) mapSearchBar.style.display = 'none';
        if (fabReport) fabReport.style.display = 'none';
        enterPlanner();
      } // <--- ВИПРАВЛЕНО: ЦЯ ДУЖКА ЗАКРИВАЄ БЛОК 'ROUTE'

      // МАГІЯ ІСТОРІЇ: Тепер це працює для ВСІХ вкладок
      if (!isBackAction) {
          const currentState = window.history.state;
          if (!currentState || currentState.screen !== screenId) {
              window.history.pushState({ screen: screenId }, "");
          }
          // The retained card needs its own Back layer above this visit's route entry.
          if (screenId === 'route' && isPlannerAccordionOpen()) pushPlannerAccordionHistory();
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

    function handlePopState(event) {
      // 1. Закриваємо міні-карту, якщо вона відкрита
      if (typeof closeVehicleMapModal === 'function') {
        closeVehicleMapModal();
      }

      // 2. ЗАКРИВАЄМО АКОРДЕОН ТРАСИ
      if (!event.state || event.state.overlay !== 'accordion') {
        closePlannerAccordion();
      }

      // 3. Закриваємо акордеон зупинок через його власника.
      if (!event.state || event.state.overlay !== 'depAccordion') {
        closeDepartureAccordion();
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
    }

    function setOverlayVisible(visible) {
        document.getElementById('overlay').classList.toggle('show', visible);
    }

    function back() {
        history.back();
    }

    function pushVehicleMapHistory() {
        history.pushState({ screen: 'vehicleMap' }, '');
    }

    function pushPlannerAccordionHistory() {
        const current = window.history.state;
        // Inline A → B replaces the open card, not the navigation layer.
        if (current?.screen === 'route' && current.overlay === 'accordion') return;
        history.pushState({ screen: 'route', overlay: 'accordion' }, '');
    }

    function pushDepartureAccordionHistory() {
        history.pushState({ screen: 'stop', overlay: 'depAccordion' }, '');
    }

    function initNavigation() {
        if (initialized) return;
        initialized = true;
        document.getElementById('close-modal-btn').addEventListener('click', back);
        document.getElementById('drawer-close').addEventListener('click', () => closeDrawer(true));
        document.getElementById('overlay').addEventListener('click', () => {
            closeDrawer(true);
            closeForms();
        });
        ['map', 'route', 'stop', 'reports'].forEach(screen => {
            const button = document.getElementById('nav-' + screen);
            button.addEventListener('click', () => switchScreen(screen, button));
        });
        window.addEventListener('popstate', handlePopState);
    }

    function initializeHistory() {
        if (historyInitialized) return;
        historyInitialized = true;
        window.history.replaceState({ screen: 'map' }, '');
    }

    return {
        initNavigation, initializeHistory, switchScreen, openDrawer, closeDrawer, setOverlayVisible,
        back, pushVehicleMapHistory, pushPlannerAccordionHistory, pushDepartureAccordionHistory
    };
}
