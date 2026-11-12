import { itemLayoutTop } from './list-motion.js';

// One alignment per explicit opening. Data/layout updates only maintain scroll room.
export function createPlannerCardPosition(root, motion) {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(root) : root.style || {};
    const originalPadding = root.style.paddingBottom || '';
    const bottomPadding = parseFloat(style.paddingBottom) || 0;
    const topPadding = parseFloat(style.paddingTop) || 0;
    let opened = null, aligning = false, revision = 0;
    function cancel() {
        revision++;
        if (aligning) motion.cancelScroll();
        aligning = false;
        delete root.dataset.cardAligning;
    }
    function close(node) {
        if (node && node !== opened) return;
        cancel(); opened = null;
        root.style.paddingBottom = originalPadding;
    }
    function sync() {
        if (!opened) return;
        if (root.dataset.presentation !== 'new' || opened.parentNode !== root) { close(); return; }
        if (!root.clientHeight) return;
        const top = Math.max(0, itemLayoutTop(root, opened) - topPadding);
        const end = Math.max(...[...root.children].map(node => itemLayoutTop(root, node) + node.offsetHeight));
        const padding = Math.max(bottomPadding, top + root.clientHeight - end);
        if (Number.isFinite(padding)) root.style.paddingBottom = `${padding}px`;
    }
    function open(node) {
        cancel();
        if (root.dataset.presentation !== 'new' || node?.parentNode !== root || !root.clientHeight) return;
        opened = node; sync();
        const top = Math.max(0, itemLayoutTop(root, node) - topPadding);
        if (!Number.isFinite(top) || top === root.scrollTop) return;
        const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) { root.scrollTo({ top, behavior: 'instant' }); return; }
        aligning = true; root.dataset.cardAligning = 'true';
        const version = ++revision;
        motion.trackScroll(() => root.scrollTo({ top, behavior: 'smooth' }));
        motion.whenIdle().then(() => {
            if (version !== revision) return;
            aligning = false; delete root.dataset.cardAligning;
        });
    }
    for (const type of ['wheel', 'touchstart', 'pointerdown']) {
        root.addEventListener(type, cancel, { passive: true });
    }
    root.addEventListener('keydown', event => {
        if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)
            && !event.target.closest('input, textarea, select, button')) cancel();
    });
    return { open, close, cancel, sync,
        isAligning: () => aligning && motion.isScrolling(),
        modeChanged() {
            close();
            if (root.dataset.presentation !== 'new') return;
            opened = [...root.children].find(node => node.querySelector('.trasa-card.fullscreen-expanded')) || null;
            sync(); // Switching modes preserves the anchor; it does not initiate alignment.
        }
    };
}
