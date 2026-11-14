// Explicit closing tags match innerHTML serialization, so LIVE does not replace
// its touch targets on every tick just because the SVG string differs.
export const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 4h8l-1 6 3 3v2H6v-2l3-3-1-6Zm4 11v6"></path></svg>';

export function pinButtonMarkup(pinned) {
    const label = pinned ? 'Odepnij podróż' : 'Przypnij podróż';
    return `<button type="button" class="trasa-pin-button" aria-pressed="${!!pinned}" aria-label="${label}" title="${label}">${PIN_ICON}</button>`;
}

export function syncJourneyPin(wrapper, pinned) {
    wrapper.classList.toggle('trasa-pinned', pinned);
    const button = wrapper.querySelector('.trasa-pin-button');
    if (!button) return;
    button.ariaPressed = String(pinned);
    button.ariaLabel = pinned ? 'Odepnij podróż' : 'Przypnij podróż';
    button.title = button.ariaLabel;
}

// Observe native touch scrolling; only a completed hold owns its following click.
export function bindJourneyPinHold(root, { isEnabled, onToggle }) {
    const interactive = 'button, a, input, select, textarea, label, [role="button"], [contenteditable], .lubus-tabs, .lubus-map, .lubus-journey, .maplibregl-map';
    let hold = null, timer = null, suppressed = null;
    function cancelHold() {
        clearTimeout(timer); timer = null; hold = null;
    }
    function finishTouch() {
        cancelHold();
        if (suppressed) suppressed.until = Date.now() + 800;
    }
    root.addEventListener('touchstart', event => {
        cancelHold(); suppressed = null;
        if (!isEnabled() || event.touches.length !== 1 || event.target.closest(interactive)) return;
        const card = event.target.closest('.trasa-card');
        if (!card || !root.contains(card) || card.closest('.trasa-result-exit')) return;
        const touch = event.touches[0];
        const gesture = { card, id: touch.identifier, x: touch.clientX, y: touch.clientY };
        hold = gesture;
        timer = setTimeout(() => {
            timer = null;
            if (hold !== gesture || !isEnabled() || !root.contains(card) || card.closest('.trasa-result-exit')) return cancelHold();
            suppressed = { card, until: Infinity };
            onToggle(card.parentNode);
        }, 550);
    }, { passive: true });
    root.addEventListener('touchmove', event => {
        if (!hold) return;
        const touch = [...event.touches].find(t => t.identifier === hold.id);
        if (event.touches.length !== 1 || !touch || Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > 8) cancelHold();
    }, { passive: true });
    root.addEventListener('touchend', finishTouch, { passive: true });
    root.addEventListener('touchcancel', finishTouch, { passive: true });
    root.addEventListener('scroll', cancelHold, { capture: true, passive: true });
    root.addEventListener('wheel', cancelHold, { passive: true });
    root.addEventListener('contextmenu', event => {
        if ((hold?.card || suppressed?.card) === event.target.closest('.trasa-card')) event.preventDefault();
    });
    root.addEventListener('click', event => {
        if (!suppressed || event.detail === 0) return;
        const previous = suppressed;
        suppressed = null;
        if (Date.now() > previous.until || event.target.closest('.trasa-card') !== previous.card) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, { capture: true });
    return { cancel() { cancelHold(); suppressed = null; } };
}
