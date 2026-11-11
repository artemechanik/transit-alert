import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

async function setup() {
  const root = { children: [], dataset: {}, scrollTop: 130, offsetTop: 0 };
  let cancellations = 0;
  const buttons = Object.fromEntries(['classic', 'new'].map(name => [name, {
    ariaPressed: String(name === 'classic'),
    addEventListener(type, callback) { this.click = callback; }
  }]));
  const module = await loadBrowserModule(new URL('../js/planner-presentation.js', import.meta.url), {});
  const motion = { cancelScroll() { cancellations++; } };
  function node(key, top, expanded = false) {
    const card = { expanded, scrollTop: 51, stops: ['boarding', 'destination'],
      classList: { add(value) { if (value === 'fullscreen-expanded') card.expanded = true; } } };
    return { dataset: { journeyKey: key, motionKey: key }, offsetTop: top, offsetHeight: 100,
      card, querySelector(selector) { return selector.includes('fullscreen-expanded') ? (card.expanded ? card : null) : card; } };
  }
  const first = node('trip-a:platform-01:day-1', 0);
  const visible = node('trip-b:platform-02:day-1', 100, true);
  const last = node('trip-c:platform-01:day-1', 200);
  root.children = [first, visible, last];
  // Simulate layout changes synchronously applied by the browser on theme selection,
  // including a changed order: the anchor must be found by key, never old index.
  let presentation;
  Object.defineProperty(root.dataset, 'presentation', {
    get: () => presentation,
    set(value) {
      presentation = value;
      if (!root.children.length) return;
      if (value === 'new') {
        root.children = [last, first, visible];
        last.offsetTop = 0; first.offsetTop = 120; visible.offsetTop = 240;
      } else {
        root.children = [first, visible, last];
        first.offsetTop = 0; visible.offsetTop = 100; last.offsetTop = 200;
      }
    }
  });
  const view = module.createPlannerPresentation(root, motion, buttons);
  return { root, buttons, view, visible, first, last, cancellations: () => cancellations };
}

test('switch restores the visible journey by key across layout and sorting changes', async () => {
  const h = await setup();
  h.buttons.new.click();
  assert.equal(h.root.scrollTop, 270); // Same journey, same -30px viewport offset.
  assert.equal(h.root.children[2], h.visible);
  assert.equal(h.buttons.new.ariaPressed, 'true');
  assert.equal(h.buttons.classic.ariaPressed, 'false');
  h.buttons.classic.click();
  assert.equal(h.root.scrollTop, 130);
  assert.equal(h.cancellations(), 2);
});

test('switch retains the keyed accordion, loaded stops and internal scroll without duplicate trees', async () => {
  const h = await setup();
  const card = h.visible.card, stops = card.stops;
  for (const variant of ['new', 'classic', 'new']) {
    h.view.select(variant);
    assert.equal(h.root.children.length, 3);
    assert.equal(h.root.children.find(node => node.dataset.journeyKey === h.visible.dataset.journeyKey).card, card);
    assert.equal(card.expanded, true);
    assert.equal(card.scrollTop, 51);
    assert.equal(card.stops, stops);
    assert.equal(h.root.children.filter(node => node.card.expanded).length, 1);
  }
});

test('empty list, unchanged selection and unsupported variants do not disturb state', async () => {
  const h = await setup();
  h.root.children = [];
  h.view.select('classic'); h.view.select('invalid');
  assert.equal(h.cancellations(), 0);
  h.view.select('new');
  assert.equal(h.root.dataset.presentation, 'new');
  assert.equal(h.root.children.length, 0);
});
