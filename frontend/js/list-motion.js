// Keep animation identity across refreshes, including lists that rebuild their DOM.
export function createListMotion(root) {
    const states = new Map();
    let scrollTimer = null;
    let settleTimer = null;
    let scrolling = false;
    const idleWaiters = new Set();
    const finishScroll = () => {
        clearTimeout(settleTimer); settleTimer = null; scrolling = false;
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
    };
    root.addEventListener?.('scrollend', event => {
        if (!event || event.target === root) finishScroll();
    });
    root.addEventListener?.('scroll', () => {
        if (!scrolling || scrollTimer !== null) return;
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finishScroll, 180);
    }, { passive: true });
    const reducedMotion = () => typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const node = entry.target;
            if (node.parentNode !== root) continue;
            observer.unobserve(node);
            states.set(node.dataset.motionKey, 'done');
            node.classList.remove('list-card-pending');
            if (!reducedMotion()) {
                node.classList.add('list-card-enter');
                node.addEventListener('animationend', () => node.classList.remove('list-card-enter'), { once: true });
            }
        }
    }, { root, threshold: 0.01 }) : null;

    return {
        isScrolling() { return scrolling; },
        whenIdle() { return scrolling ? new Promise(resolve => idleWaiters.add(resolve)) : Promise.resolve(); },
        cancelScroll() {
            const moving = scrolling && scrollTimer === null;
            clearTimeout(scrollTimer); scrollTimer = null;
            if (moving && typeof root.scrollTo === 'function') {
                root.scrollTo({ top: root.scrollTop, behavior: 'instant' });
            }
            finishScroll();
        },
        trackScroll(action) {
            this.cancelScroll();
            scrolling = true;
            settleTimer = setTimeout(finishScroll, 1000);
            try { action(); } catch (error) { finishScroll(); throw error; }
        },
        reset() { this.cancelScroll(); observer?.disconnect(); states.clear(); },
        sync(items, animateNew) {
            const added = [];
            const currentKeys = new Set(items.map(item => item.key));
            for (const key of states.keys()) if (!currentKeys.has(key)) states.delete(key);
            observer?.disconnect();
            for (const { node, key } of items) {
                node.dataset.motionKey = key;
                if (!states.has(key)) {
                    states.set(key, animateNew ? 'pending' : 'done');
                    if (animateNew) added.push(node);
                }
                if (states.get(key) !== 'pending') continue;
                if (!observer || reducedMotion()) {
                    states.set(key, 'done');
                    node.classList.remove('list-card-pending');
                    continue;
                }
                node.classList.add('list-card-pending');
                observer.observe(node);
            }
            return added;
        },
        revealAdded(nodes, direction = 'later') {
            if (!nodes.length || typeof root.scrollTo !== 'function') return;
            this.cancelScroll();
            scrolling = true;
            const selected = direction === 'history' ? nodes.slice(-3) : nodes.slice(0, 3);
            const key = (direction === 'history' ? selected[0] : selected.at(-1)).dataset.motionKey;
            // Let the loading indicator collapse before measuring the viewport.
            scrollTimer = setTimeout(() => {
                scrollTimer = null;
                if (!root.clientHeight) { finishScroll(); return; }
                const node = [...root.children].find(child => child.dataset.motionKey === key);
                if (!node) { finishScroll(); return; }
                // offset geometry excludes the translateY used by the card's entrance animation.
                const top = itemLayoutTop(root, node);
                const destination = direction === 'history' ? top - 12
                    : top + node.offsetHeight - root.clientHeight + 12;
                const target = Math.max(0, Math.min(root.scrollHeight - root.clientHeight,
                    direction === 'history' ? Math.min(root.scrollTop, destination)
                        : Math.max(root.scrollTop, destination)));
                if (!Number.isFinite(target) || target === root.scrollTop) { finishScroll(); return; }
                // scrollend is primary; the scroll debounce also supports older browsers.
                settleTimer = setTimeout(finishScroll, 1000);
                root.scrollTo({ top: target, behavior: reducedMotion() ? 'instant' : 'smooth' });
                if (reducedMotion()) finishScroll();
            }, 220);
        }
    };
}

function layoutTop(element) {
    let top = 0;
    for (let current = element; current; current = current.offsetParent) {
        top += current.offsetTop + (current.offsetParent?.clientTop || 0);
    }
    return top;
}

export function itemLayoutTop(root, node) {
    return layoutTop(node) - layoutTop(root) - (root.clientTop || 0);
}

export function captureListAnchor(root) {
    const node = [...root.children].find(child => child.dataset.motionKey
        && itemLayoutTop(root, child) + child.offsetHeight > root.scrollTop);
    return node ? { key: node.dataset.motionKey, offset: itemLayoutTop(root, node) - root.scrollTop } : null;
}

export function restoreListAnchor(root, anchor) {
    if (!anchor) return false;
    const node = [...root.children].find(child => child.dataset.motionKey === anchor.key);
    if (!node) return false;
    const top = itemLayoutTop(root, node) - anchor.offset;
    if (Number.isFinite(top) && root.scrollTop !== top) root.scrollTop = top;
    return true;
}
