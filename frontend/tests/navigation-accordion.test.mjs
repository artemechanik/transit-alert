import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';

async function setup() {
  const stack=[{screen:'route'}], listeners={};let index=0,closed=0,entered=0;
  const history={get state(){return stack[index];},
    pushState(state){stack.splice(index+1);stack.push(state);index++;},
    back(){if(index){index--;listeners.popstate?.({state:stack[index]});}}};
  const element={style:{},classList:{add(){},remove(){}},addEventListener(){}};
  const m=await loadBrowserModule(new URL('../js/navigation.js',import.meta.url),{
    history, window:{history,addEventListener(type,fn){listeners[type]=fn;}},
    document:{getElementById:()=>element,querySelectorAll:()=>[]}
  });
  const nav=m.createNavigation({closeVehicleMapModal(){},stopVehicleTracking(){},enterStops(){},
    enterPlanner(){entered++;},leavePlanner(){},openReports(){},closeForms(){},
    closePlannerAccordion(){closed++;},closeDepartureAccordion(){}});
  nav.initNavigation();
  return {nav,history,stack,closed:()=>closed,entered:()=>entered};
}

test('A → B → header Back closes the accordion on the first action',async()=>{
  const h=await setup();h.nav.pushPlannerAccordionHistory();h.nav.pushPlannerAccordionHistory();
  assert.equal(h.stack.length,2);assert.equal(h.history.state.overlay,'accordion');
  h.nav.back();assert.equal(h.closed(),1);assert.equal(h.history.state.screen,'route');
  assert.equal(h.history.state.overlay,undefined);assert.equal(h.entered(),1);
});

test('A → B → system Back returns directly to the route without an extra overlay',async()=>{
  const h=await setup();h.nav.pushPlannerAccordionHistory();h.nav.pushPlannerAccordionHistory();
  h.history.back();assert.equal(h.closed(),1);assert.equal(h.history.state.overlay,undefined);
});

test('fullscreen map retains its own Back layer above the shared accordion',async()=>{
  const h=await setup();h.nav.pushPlannerAccordionHistory();h.nav.pushPlannerAccordionHistory();
  h.nav.pushVehicleMapHistory();assert.equal(h.stack.length,3);
  h.history.back();assert.equal(h.closed(),0);assert.equal(h.history.state.overlay,'accordion');
  h.history.back();assert.equal(h.closed(),1);assert.equal(h.history.state.overlay,undefined);
});
