import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

async function setup(reduced = false) {
  let observer;
  const timers = new Map();
  let timerId = 0;
  const root = { children: [], scrollTop: 0, offsetTop: 100, getBoundingClientRect: () => ({ top: 100 }) };
  class Observer {
    constructor(callback, options) { this.callback = callback; this.options = options; this.nodes = new Set(); observer = this; }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  }
  const module = await loadBrowserModule(new URL('../js/list-motion.js', import.meta.url), {
    IntersectionObserver: Observer, matchMedia: () => ({ matches: reduced }),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  const motion = module.createListMotion(root);
  function node(key, contentTop = 100) {
    const classes = new Set(), listeners = {};
    return { dataset: { motionKey: key }, parentNode: root, classes, listeners,
      offsetTop: contentTop, offsetHeight: 80,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
      addEventListener: (event, callback) => { listeners[event] = callback; },
      getBoundingClientRect: () => ({ top: contentTop - root.scrollTop, bottom: contentTop + 80 - root.scrollTop }) };
  }
  return { module, root, motion, node, observer, timers,
    flush: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test('new offscreen cards wait for visibility, survive a rebuilt LIVE list and animate once', async () => {
  const h = await setup();
  const existing = h.node('existing'), added = h.node('added');
  h.motion.sync([{ key: 'existing', node: existing }], false);
  h.motion.sync([{ key: 'existing', node: existing }, { key: 'added', node: added }], true);
  assert.equal(existing.classes.size, 0);
  assert.equal(added.classes.has('list-card-pending'), true);
  h.observer.callback([{ target: added, isIntersecting: false }]);
  assert.equal(added.classes.has('list-card-enter'), false);
  // Przystanek rebuilds nodes on background updates; pending animation must survive.
  const rebuilt = h.node('added');
  added.parentNode = null;
  h.motion.sync([{ key: 'added', node: rebuilt }], false);
  h.observer.callback([{ target: added, isIntersecting: true }]);
  assert.equal(rebuilt.classes.has('list-card-pending'), true);
  h.observer.callback([{ target: rebuilt, isIntersecting: true }]);
  assert.equal(rebuilt.classes.has('list-card-pending'), false);
  assert.equal(rebuilt.classes.has('list-card-enter'), true);
  rebuilt.listeners.animationend();
  const refreshed = h.node('added');
  h.motion.sync([{ key: 'added', node: refreshed }], true);
  assert.equal(refreshed.classes.size, 0);
  assert.equal(h.observer.nodes.size, 0);
});

test('manual pagination reveals only the first three later cards after the indicator collapses', async () => {
  const h = await setup(), calls = [];
  Object.assign(h.root, { scrollTop: 100, clientHeight: 200, scrollHeight: 1500,
    scrollTo: options => calls.push(options) });
  const nodes = [300, 450, 600, 1000].map((top, i) => h.node(String(i), top));
  h.root.children = nodes;
  h.motion.revealAdded(nodes);
  assert.equal(calls.length, 0);
  h.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].top, 392);
  assert.equal(calls[0].behavior, 'smooth');
});

test('history reveals the nearest three added cards, and reduced motion skips smooth scrolling', async () => {
  const h = await setup(true), calls = [];
  Object.assign(h.root, { scrollTop: 400, clientHeight: 200, scrollHeight: 1500,
    scrollTo: options => calls.push(options) });
  const nodes = [100, 180, 260, 340].map((top, i) => h.node(String(i), top));
  h.root.children = nodes;
  h.motion.revealAdded(nodes, 'history');
  h.flush();
  assert.equal(calls[0].top, 68);
  assert.equal(calls[0].behavior, 'instant');
});

test('empty pages and cancelled or hidden lists do not auto-scroll', async () => {
  const h = await setup(), calls = [];
  Object.assign(h.root, { clientHeight: 200, scrollHeight: 1000, scrollTo: options => calls.push(options) });
  const node = h.node('new', 600);
  h.root.children = [node];
  h.motion.revealAdded([]);
  assert.equal(h.timers.size, 0);
  h.motion.revealAdded([node]);
  h.motion.reset();
  h.flush();
  assert.equal(calls.length, 0);
  h.motion.revealAdded([node]);
  h.root.clientHeight = 0;
  h.flush();
  assert.equal(calls.length, 0);
});

test('reduced motion reveals new cards without movement or waiting for visibility', async () => {
  const h = await setup(true), node = h.node('new');
  h.motion.sync([{ key: 'new', node }], true);
  assert.equal(node.classes.size, 0);
  assert.equal(h.observer.nodes.size, 0);
});

test('visible card stays at the same offset after old rows are removed above it', async () => {
  const h = await setup();
  h.root.scrollTop = 200;
  h.root.children = [h.node('old', 100), h.node('visible', 280)];
  const anchor = h.module.captureListAnchor(h.root);
  assert.equal(anchor.key, 'visible');
  // Removing a row above shifts the retained card up by 80 pixels.
  h.root.children = [h.node('visible', 200), h.node('new', 280)];
  assert.equal(h.module.restoreListAnchor(h.root, anchor), true);
  assert.equal(h.root.scrollTop, 120);
  assert.equal(h.root.children[0].getBoundingClientRect().top, 80);
});

test('scroll destination ignores entrance transforms and stays protected through LIVE reconciliation', async () => {
  const h = await setup(), calls = [];
  Object.assign(h.root, { scrollTop: 100, clientHeight: 200, scrollHeight: 1500,
    scrollTo: options => calls.push(options) });
  const node = h.node('new', 600);
  node.getBoundingClientRect = () => ({ top: 520, bottom: 600 }); // Visual translateY(20px).
  h.root.children = [node];
  const added = h.motion.sync([{ node, key: 'new' }], true);
  h.motion.revealAdded(added);
  assert.equal(h.motion.isScrolling(), true);
  h.flush();
  assert.equal(calls[0].top, 392); // Layout target, not the transformed visual bottom (412).
  h.motion.sync([{ node, key: 'new' }], false);
  assert.equal(h.motion.isScrolling(), true);
  h.flush(); // Fallback completion in a browser without scrollend.
  assert.equal(h.motion.isScrolling(), false);
});

test('anchor preservation uses layout coordinates even while a card is visually translated', async () => {
  const h = await setup();
  h.root.scrollTop = 200;
  const visible = h.node('visible', 280);
  visible.getBoundingClientRect = () => ({ top: 100, bottom: 180 }); // Includes +20px animation.
  h.root.children = [visible];
  const anchor = h.module.captureListAnchor(h.root);
  assert.equal(anchor.offset, -20);
  const rebuilt = h.node('visible', 200);
  rebuilt.getBoundingClientRect = () => ({ top: 7, bottom: 87 }); // Different animation phase.
  h.root.children = [rebuilt];
  h.module.restoreListAnchor(h.root, anchor);
  assert.equal(h.root.scrollTop, 120);
});

test('scrollend from an inner journey panel does not end the outer list animation',async()=>{
  const listeners={};let timer=0;
  const root={addEventListener(type,fn){listeners[type]=fn;}};
  const m=await loadBrowserModule(new URL('../js/list-motion.js',import.meta.url),{
    setTimeout:()=>++timer,clearTimeout(){}
  });
  const motion=m.createListMotion(root);motion.trackScroll(()=>{});
  listeners.scrollend({target:{}});assert.equal(motion.isScrolling(),true);
  listeners.scrollend({target:root});assert.equal(motion.isScrolling(),false);
});
