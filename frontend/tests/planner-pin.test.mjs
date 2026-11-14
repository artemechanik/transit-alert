import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

async function setup() {
    let now=1000,next=0,toggles=0,enabled=true,attached=true;
    const timers=new Map(),listeners=new Map(),wrapper={dataset:{journeyKey:'trip-a'}};
    const card={parentNode:wrapper,closest:()=>null};
    const other={parentNode:{},closest:()=>null};
    const root={contains:node=>attached&&node===card,addEventListener(type,fn,options){listeners.set(type,{fn,options});}};
    class Clock extends Date { static now(){return now;} }
    const m=await loadBrowserModule(new URL('../js/planner-pin.js',import.meta.url),{
        Date:Clock,setTimeout(fn,delay){const id=++next;timers.set(id,{fn,at:now+delay});return id;},clearTimeout:id=>timers.delete(id)
    });
    const binding=m.bindJourneyPinHold(root,{isEnabled:()=>enabled,onToggle:node=>{assert.equal(node,wrapper);toggles++;}});
    const target=(interactive=false,owner=card)=>({closest:selector=>selector==='.trasa-card'?owner:interactive?{}:null});
    function emit(type,extra={}) {
        let prevented=false,stopped=false;
        listeners.get(type).fn({target:target(),touches:[{identifier:1,clientX:10,clientY:10}],detail:1,
            preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;},...extra});
        return {prevented,stopped};
    }
    function advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}}
    return {m,root,card,target,emit,advance,binding,timers,listeners,toggles:()=>toggles,
        enabled:value=>{enabled=value;},attached:value=>{attached=value;},other};
}

test('compact SVG button and indicator share the existing pinned class and accessible state',async()=>{
    const h=await setup(),classes=new Set(),button={innerHTML:h.m.PIN_ICON};
    const wrapper={classList:{toggle(c,on){on?classes.add(c):classes.delete(c);}},querySelector:()=>button};
    for(const pinned of [true,false,true]) {
        h.m.syncJourneyPin(wrapper,pinned);
        assert.equal(classes.has('trasa-pinned'),pinned);assert.equal(button.ariaPressed,String(pinned));
        assert.equal(button.ariaLabel,pinned?'Odepnij podróż':'Przypnij podróż');
        assert.equal(button.innerHTML,h.m.PIN_ICON,'state updates retain the icon');
        const markup=h.m.pinButtonMarkup(pinned);
        assert.match(markup,/<svg/);assert.match(markup,new RegExp(`aria-pressed="${pinned}"`));
        assert.doesNotMatch(markup,/📌|>Przypnij|>Odepnij/);
    }
});

test('ordinary tap stays native; one long touch toggles once and consumes its following click',async()=>{
    const h=await setup();assert.deepEqual(h.emit('touchstart'),{prevented:false,stopped:false});
    h.advance(549);h.emit('touchend');h.advance(1);assert.equal(h.toggles(),0);
    assert.equal(h.emit('click').prevented,false);
    h.emit('touchstart');h.advance(550);assert.equal(h.toggles(),1);
    h.advance(1000);assert.equal(h.toggles(),1);h.emit('touchend');
    assert.deepEqual(h.emit('click'),{prevented:true,stopped:true});assert.equal(h.toggles(),1);
    h.emit('touchstart');h.emit('touchend');assert.equal(h.emit('click').prevented,false,'next real tap is available');
    assert.equal(h.listeners.get('touchstart').options.passive,true);
    assert.equal(h.listeners.get('touchmove').options.passive,true);
    assert.equal(h.listeners.get('click').options.capture,true);
});

for(const [x,y] of [[10,19],[19,10],[17,17]]) {
    test(`movement to ${x},${y} permanently cancels the hold without claiming scrolling`,async()=>{
        const h=await setup();h.emit('touchstart');
        assert.equal(h.emit('touchmove',{touches:[{identifier:1,clientX:x,clientY:y}]}).prevented,false);
        h.emit('touchmove');h.advance(1000);h.emit('touchend');
        assert.equal(h.toggles(),0);assert.equal(h.emit('click').prevented,false);
    });
}

for(const type of ['touchcancel','scroll','wheel','touchend']) {
    test(`${type} cancels a pending hold`,async()=>{
        const h=await setup();h.emit('touchstart');h.advance(400);h.emit(type);h.advance(200);
        assert.equal(h.toggles(),0);assert.equal(h.timers.size,0);
        if(type==='scroll')assert.equal(h.listeners.get(type).options.capture,true,'also observe inner scrolling');
    });
}

test('interactive areas, multiple fingers, disabled mode and detached cards never toggle',async()=>{
    const h=await setup();h.emit('touchstart',{target:h.target(true)});h.advance(600);assert.equal(h.toggles(),0);
    h.emit('touchstart');h.emit('touchstart',{touches:[{identifier:1},{identifier:2}]});h.advance(600);assert.equal(h.toggles(),0);
    h.enabled(false);h.emit('touchstart');h.advance(600);assert.equal(h.toggles(),0);
    h.enabled(true);h.emit('touchstart');h.attached(false);h.advance(600);assert.equal(h.toggles(),0);
    h.attached(true);h.emit('touchstart');h.enabled(false);h.advance(600);assert.equal(h.toggles(),0);
});

test('hold click suppression is scoped, expires and leaves keyboard activation available',async()=>{
    const h=await setup();h.emit('touchstart');h.advance(550);h.emit('touchend');
    assert.equal(h.emit('click',{detail:0}).prevented,false,'keyboard activation is not the companion touch click');
    assert.equal(h.emit('click',{target:h.target(false,h.other)}).prevented,false);
    h.emit('touchstart');h.advance(550);h.emit('touchend');h.advance(801);
    assert.equal(h.emit('click').prevented,false);
    h.emit('touchstart');h.advance(550);h.emit('touchcancel');assert.equal(h.emit('click').prevented,true);
});

test('context menu is suppressed only for the held card; cleanup cancels pending work',async()=>{
    const h=await setup();assert.equal(h.emit('contextmenu').prevented,false);
    h.emit('touchstart');assert.equal(h.emit('contextmenu').prevented,true);
    assert.equal(h.emit('contextmenu',{target:h.target(false,h.other)}).prevented,false);
    h.binding.cancel();h.advance(1000);assert.equal(h.toggles(),0);assert.equal(h.emit('click').prevented,false);
});
