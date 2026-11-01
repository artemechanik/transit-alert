// ==================== Іконки теми ====================
// Авто: залите сонце з вирізаною літерою A
const ICON_AUTO = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <defs>
    <mask id="icoAutoMask">
      <rect width="24" height="24" fill="#fff"/>
      <path d="M9.3 15L12 8.8 14.7 15M10.2 13.2h3.6" stroke="#000" stroke-width="1.8"/>
    </mask>
  </defs>
  <circle cx="12" cy="12" r="5" fill="currentColor" stroke="currentColor" stroke-width="2" mask="url(#icoAutoMask)"/>
  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2"/>
</svg>`;

// День: залите сонце
const ICON_SUN = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="5" fill="currentColor" stroke="currentColor" stroke-width="2"/>
  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2"/>
</svg>`;

// Ніч: залитий місяць
const ICON_MOON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor" stroke="currentColor" stroke-width="2"/>
</svg>`;
// ==================== Тема (Авто / День / Ніч) ====================
const THEME_CYCLE = ['auto', 'day', 'night'];
const THEME_LABELS = { auto: 'Auto', day: 'Dzień', night: 'Noc' };
const THEME_ICONS = { auto: ICON_AUTO, day: ICON_SUN, night: ICON_MOON };

let osDarkQuery;
let themeChangeHandler;

export function initTheme({ onChange }) {
    if (osDarkQuery) return;
    osDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    themeChangeHandler = onChange;
    // Не застосовуємо тему при старті: початковий data-theme задає ранній script.
    osDarkQuery.addEventListener('change', () => {
        if (getThemePref() === 'auto') applyTheme();
    });
}

export function getThemePref() {
    const p = localStorage.getItem('themePref');
    return THEME_CYCLE.includes(p) ? p : 'auto';
}

// 'light' | 'dark' — з вибору користувача або з ОС
export function getEffectiveTheme() {
    const p = getThemePref();
    if (p === 'day') return 'light';
    if (p === 'night') return 'dark';
    return osDarkQuery.matches ? 'dark' : 'light';
}

export function mapStyleFor(effective) {
    return effective === 'dark' ? 'style-dark.json' : 'style-light.json';
}

export function applyTheme() {
    const eff = getEffectiveTheme();
    document.documentElement.dataset.theme = eff;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = eff === 'dark' ? '#14161a' : '#eef2f6';
    themeChangeHandler();
}

export function getThemeButton() {
    return {
        icon: THEME_ICONS[getThemePref()],
        title: `Motyw: ${THEME_LABELS[getThemePref()]}`
    };
}

export function cycleTheme(button) {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(getThemePref()) + 1) % THEME_CYCLE.length];
    localStorage.setItem('themePref', next);
    button.innerHTML = THEME_ICONS[next];
    button.title = `Motyw: ${THEME_LABELS[next]}`;
    applyTheme();
    return `Motyw: ${THEME_LABELS[next]}`;
}
