import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
async function setup(reduced = false) {
    const listeners = {}, calls = [], waiters = [];
    const root = { style: { paddingTop: '12px', paddingBottom: '12px' }, dataset: { presentation: 'new' },
        clientHeight: 400, scrollTop: 50, offsetTop: 0, children: [],
        addEventListener(type, fn) { listeners[type] = fn; },
        scrollTo(options) { calls.push(options); if (options.behavior === 'instant') this.scrollTop = options.top; } };
    let scrolling = false;
    const finish = () => { scrolling = false; for (const fn of waiters.splice(0)) fn(); };
    const motion = { isScrolling: () => scrolling,
        trackScroll(fn) { scrolling = true; fn(); },
        whenIdle: () => scrolling ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve(),
        cancelScroll() { if (scrolling) root.scrollTo({ top: root.scrollTop, behavior: 'instant' }); finish(); } };
    function node(key, top, height) {
        return { dataset: { journeyKey: key, motionKey: key }, parentNode: root,
            offsetTop: top, offsetHeight: height, querySelector: () => null };
    }
    const a=node('a',0,180),b=node('b',190,180),c=node('c',380,120);root.children=[a,b,c];
    const module=await loadBrowserModule(new URL('../js/planner-card-position.js',import.meta.url),{
        getComputedStyle: node => node.style,matchMedia:()=>({matches:reduced})
    });
    const position=module.createPlannerCardPosition(root,motion);
    return {root,calls,listeners,position,motion,finish,a,b,c};
}

test('last expanded card gets exactly enough scroll room to align its header at the list padding',async()=>{
    const h=await setup();h.position.open(h.c);
    assert.equal(h.calls.length,1);assert.equal(h.calls[0].top,368);assert.equal(h.calls[0].behavior,'smooth');
    assert.equal(h.root.style.paddingBottom,'268px');assert.equal(h.position.isAligning(),true);
    // Late stop data changes height; it must neither restart nor retarget the scroll.
    h.c.offsetHeight=400;h.position.sync();assert.equal(h.calls.length,1);
    assert.equal(h.root.style.paddingBottom,'12px');
    h.finish();await Promise.resolve();assert.equal(h.position.isAligning(),false);
    assert.equal(h.root.dataset.cardAligning,undefined);
});

test('card taller than the viewport aligns its header, without trying to reveal its bottom',async()=>{
    const h=await setup();h.c.offsetHeight=700;h.position.open(h.c);
    assert.equal(h.calls[0].top,368);assert.equal(h.root.style.paddingBottom,'12px');
});

test('manual input cancels alignment and updates never resume it or alter the inner scroll',async()=>{
    const h=await setup();h.position.open(h.c);h.root.scrollTop=90;
    const child={scrollTop:73};let prevented=false;
    h.listeners.touchstart({target:child,preventDefault(){prevented=true;}});
    assert.equal(h.position.isAligning(),false);assert.equal(h.calls.at(-1).behavior,'instant');
    const count=h.calls.length;h.c.offsetHeight=390;
    for(let i=0;i<20;i++)h.position.sync();
    assert.equal(h.calls.length,count);assert.equal(child.scrollTop,73);assert.equal(prevented,false);
    assert.equal(h.root.scrollTop,90);
    h.position.open(h.b);assert.equal(h.calls.length,count+1,'a new explicit opening may align again');
});

test('mode changes, closing and hidden lists do not start alignment; reduced motion skips animation',async()=>{
    const h=await setup();h.root.dataset.presentation='classic';h.position.open(h.c);assert.equal(h.calls.length,0);
    h.root.dataset.presentation='new';h.root.clientHeight=0;h.position.open(h.c);assert.equal(h.calls.length,0);
    h.root.clientHeight=400;h.position.open(h.c);h.position.close(h.b);assert.equal(h.position.isAligning(),true);
    h.position.close(h.c);assert.equal(h.root.style.paddingBottom,'12px');assert.equal(h.position.isAligning(),false);
    const count=h.calls.length;h.position.modeChanged();assert.equal(h.calls.length,count);
    const r=await setup(true);r.position.open(r.c);
    assert.equal(r.calls.length,1);assert.equal(r.calls[0].behavior,'instant');assert.equal(r.position.isAligning(),false);
});
