import { captureListAnchor, restoreListAnchor } from './list-motion.js';
import { journeyCountdown, countdownMarkup } from './planner-countdown.js';
import { updateBoardingTime } from './planner-cards.js';

// Both presentations use the same keyed wrappers, accordion and LIVE DOM contract.
// Changing presentation never rebuilds cards or starts a data request.
export function createPlannerPresentation(root, motion, buttons, cardPosition, search = typeof location === 'undefined' ? '' : location.search) {
    let current = new URLSearchParams(search).get('trasa') === 'classic' ? 'classic' : 'new';
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
        for (const node of root.children) {
            const timer = node.querySelector('.trasa-timer-content');
            if (node.journey) {
                const now = Date.now() / 1000;
                if (timer) timer.innerHTML = countdownMarkup(journeyCountdown(node.journey, now), current);
                updateBoardingTime(node, node.journey, now, current);
            }
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
        button.ariaPressed = String(name === current);
        button.addEventListener('click', () => select(name));
    }
    return { select };
}
