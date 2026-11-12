import { captureListAnchor, restoreListAnchor } from './list-motion.js';

// Both presentations use the same keyed wrappers, accordion and LIVE DOM contract.
// Changing presentation never rebuilds cards or starts a data request.
export function createPlannerPresentation(root, motion, buttons, cardPosition) {
    let current = 'classic';
    function select(value) {
        if (value === current || !['classic', 'new'].includes(value)) return;
        motion.cancelScroll();
        const anchor = captureListAnchor(root);
        const expandedKey = [...root.children].find(node =>
            node.querySelector('.trasa-card.fullscreen-expanded'))?.dataset.journeyKey;
        current = value;
        root.dataset.presentation = value;
        cardPosition?.modeChanged();
        for (const [name, button] of Object.entries(buttons)) {
            button.ariaPressed = String(name === value);
        }
        // The entry identified by journeyKey retains its exact DOM, including
        // loaded stops, internal scroll and the navigation history overlay.
        if (expandedKey) {
            const expanded = [...root.children].find(node => node.dataset.journeyKey === expandedKey);
            expanded?.querySelector('.trasa-card')?.classList.add('fullscreen-expanded');
            expanded?.querySelector('.trasa-middle-scroll')?.lubusTimeline?.visibilityChanged();
        }
        restoreListAnchor(root, anchor);
    }
    root.dataset.presentation = current;
    for (const [name, button] of Object.entries(buttons)) {
        button.addEventListener('click', () => select(name));
    }
    return { select };
}
