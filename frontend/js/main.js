import { initBackendConnection } from './backend-connection.js';
import { readConfig } from './config.js';
import { resetLegacyTransportHistory } from './transport-history.js';
import { showToast, refreshMapVehicleArrows } from './ui.js';
import { getNearbyStops } from './nearby.js';
import * as markerAnimation from './marker-animation.js';
import * as locationService from './location.js';
import * as themeService from './theme.js';
import { createCityMap } from './city-map.js';
import { createTripMap } from './trip-map.js';
import { createStops } from './stops.js';
import { createPlanner } from './planner.js';
import { createReports } from './reports.js';
import { createNavigation } from './navigation.js';

let startupPromise;

function startApp() {
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }

    resetLegacyTransportHistory();

    if (typeof window.maplibregl?.Map !== 'function') {
      throw new Error('MapLibre не завантажено');
    }

    markerAnimation.initAnimations({ maplibregl: window.maplibregl });
    const { apiBaseUrl, getMapTilerKey } = readConfig();
    const cityMap = createCityMap({
      maplibregl: window.maplibregl, themeService, locationService, animation: markerAnimation,
      apiBaseUrl, getMapTilerKey, showToast, refreshMapVehicleArrows
    });
    const tripMap = createTripMap({
      maplibregl: window.maplibregl, themeService, locationService, animation: markerAnimation,
      apiBaseUrl, getMapTilerKey, showToast, refreshMapVehicleArrows,
      onOpen: () => navigation.pushVehicleMapHistory()
    });
    const navigation = createNavigation({
      closeVehicleMapModal: tripMap.closeVehicleMapModal,
      // Стара tracking-гілка не запускається; зберігаємо її потрібну дію для polling мінікарти.
      stopVehicleTracking: tripMap.stopPolling,
      enterStops: options => stops.enterStops(options),
      enterPlanner: () => planner.enterPlanner(),
      leavePlanner: () => planner.leavePlanner(),
      openReports: () => reports.openReports(),
      closeForms: () => reports.closeForms(),
      closePlannerAccordion: () => planner.closePlannerAccordion(),
      closeDepartureAccordion: () => stops.closeDepartureAccordion()
    });

    themeService.initTheme({ onChange: () => {
      cityMap.applyMapTheme();
      tripMap.handleThemeChange();
    } });

    const reports = createReports({
      apiBaseUrl, showToast,
      openDrawer: navigation.openDrawer,
      closeDrawer: navigation.closeDrawer,
      setOverlayVisible: navigation.setOverlayVisible
    });
    reports.initReports();

    const planner = createPlanner({
      inlineMapServices: { maplibregl: window.maplibregl, themeService, getMapTilerKey },
      apiBaseUrl, getMapTilerKey, locationService, getNearbyStops,
      showVehicleOnMap: tripMap.showVehicleOnMap, showToast,
      addMinutesToTime: (timeStr, mins) => stops.addMinutesToTime(timeStr, mins),
      onAccordionOpen: navigation.pushPlannerAccordionHistory,
      onBack: navigation.back
    });
    planner.initPlanner();

    const stops = createStops({
      apiBaseUrl, locationService, getNearbyStops,
      showVehicleOnMap: tripMap.showVehicleOnMap,
      onAccordionOpen: navigation.pushDepartureAccordionHistory,
      onBack: navigation.back
    });
    stops.initStops();
    navigation.initNavigation();
    initBackendConnection(apiBaseUrl, () => stops.recoverConnection());

    cityMap.initCityMap();
    planner.renderRecentRoutes();
    navigation.initializeHistory();
  })();

  return startupPromise;
}

startApp().catch(error => {
  console.error('Не вдалося запустити transit-alert:', error);
});
