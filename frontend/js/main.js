import { getNearbyStops } from './nearby.js';
import * as markerAnimation from './marker-animation.js';
import * as locationService from './location.js';
import * as themeService from './theme.js';

let startupPromise;

function startManagedLegacy() {
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }

    if (typeof window.maplibregl?.Map !== 'function') {
      throw new Error('MapLibre не завантажено');
    }
    if (window.transitMigration) {
      throw new Error('Міст запуску transit-alert уже існує');
    }

    markerAnimation.initAnimations({ maplibregl: window.maplibregl });
    const bridge = { mode: 'managed', getNearbyStops, markerAnimation, location: locationService, theme: themeService };
    window.transitMigration = bridge;

    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // app.js залишається класичним скриптом із глобальними обробниками.
      script.src = new URL('../app.js', import.meta.url).href;
      script.onload = () => {
        if (typeof bridge.start !== 'function') {
          reject(new Error('app.js не завершив підготовку до запуску'));
          return;
        }
        resolve();
      };
      script.onerror = () => {
        reject(new Error('Не вдалося завантажити app.js'));
      };
      document.body.appendChild(script);
    });

    bridge.start();
  })();

  return startupPromise;
}

startManagedLegacy().catch(error => {
  console.error('Не вдалося запустити transit-alert:', error);
});
