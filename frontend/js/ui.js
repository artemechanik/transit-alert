// Спільні операції відображення; timeout toast належить тільки цьому модулю.
let toastTimeout;

export function showToast(msg) {
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

export function refreshMapVehicleArrows(mapInstance) {
    const mapBearing = mapInstance.getBearing();
    mapInstance.getContainer().querySelectorAll('.vehicle-arrow').forEach(a => {
        const b = parseFloat(a.dataset.bearing) || 0;
        a.style.transform = `rotate(${b - mapBearing}deg)`;
    });
}
