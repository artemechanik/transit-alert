import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const {createResultsState, boardingDeadline, initialWalkRisk, journeyKey} = await loadBrowserModule(new URL('../js/planner-results.js', import.meta.url), {});
const journey = (live = false) => ({legs:[{route:'7',tripId:'a',fromStopId:'x',toStopId:'y',scheduledDepartureEpoch:1000,scheduledArrivalEpoch:1600,departureEpoch:1120,arrivalEpoch:1720,isRealTime:live,liveObservedEpoch:990,departureMin:18,arrivalMin:28,delayMinutes:2}]});
test('departure uses fresh LIVE, otherwise schedule, including stale LIVE', () => {
 assert.equal(boardingDeadline(journey(true),1000),1120);
 assert.equal(boardingDeadline(journey(),1000),1000);
 assert.equal(boardingDeadline(journey(true),1400),1000);
});
test('departure stays for 60 seconds and cannot resurrect in the same search', () => {
 const state=createResultsState(), j=journey(); const key=journeyKey(j);
 state.update([j],999); state.update([],1000);
 assert.equal(state.entries.get(key).departedAt,1000);
 state.update([],1059); assert.equal(state.entries.get(key).expired,false);
 state.update([j],1060); assert.equal(state.entries.get(key).expired,true);
 state.update([j],1061); assert.equal(state.entries.get(key).expired,true);
 assert.equal(createResultsState().entries.size,0);
});
test('temporary LIVE loss and API failure preserve last fresh prediction, recovery adds routes', () => {
 const state=createResultsState(), j=journey(true), key=journeyKey(j);
 state.update([j],999); state.update([],1001); state.update([journey()],1002);
 assert.equal(state.entries.get(key).journey.legs[0].departureEpoch,1120);
 assert.equal(state.entries.get(key).departedAt,null);
 const next=journey(); next.legs[0].tripId='next'; next.legs[0].scheduledDepartureEpoch=2000;
 state.update([next],1003); assert.equal(state.entries.size,2);
 state.update([],1400); assert.equal(state.entries.get(key).departedAt,1400);
 state.update([],1460); assert.equal(state.entries.get(key).expired,true);
});
test('identity survives forecast changes, distinguishes service dates and platforms', () => {
 const a=journey(), b=journey(true); assert.equal(journeyKey(a),journeyKey(b));
 b.legs[0].scheduledDepartureEpoch+=86400; assert.notEqual(journeyKey(a),journeyKey(b));
});
test('walking and infeasible transfer never imply that the first bus departed', () => {
 const j=journey(true); j.legs[0].liveObservedEpoch=900; j.legs.unshift({route:'Пішки',departureMin:0,arrivalMin:7});
 assert.equal(boardingDeadline(j,940),1120);
 assert.equal(initialWalkRisk(j,940),true);
 j.legs.push({...journey().legs[0],tripId:'b',scheduledDepartureEpoch:1620});
 assert.equal(boardingDeadline(j,940),1120);
 const state=createResultsState(); state.update([j],940);
 assert.equal([...state.entries.values()][0].departedAt,null);
});
test('two minute initial walk fits fresh LIVE +5 minutes; final walk is excluded', () => {
 const j=journey(true); j.legs[0].liveObservedEpoch=800; j.legs.unshift({route:'Пішки',departureMin:0,arrivalMin:2});
 j.legs.push({route:'Пішки',departureMin:30,arrivalMin:60});
 assert.equal(initialWalkRisk(j,820),false);
 j.legs.shift(); assert.equal(initialWalkRisk(j,1100),false);
});
test('GTFS independently controls departure and initial walking risk without usable LIVE', () => {
 for (const live of [false,true]) {
  const j=journey(live); j.legs[0].liveObservedEpoch=1;
  j.legs.unshift({route:'Пішки',departureMin:0,arrivalMin:7});
  const state=createResultsState(); state.update([j],940);
  assert.equal(initialWalkRisk(j,940),true);
  assert.equal([...state.entries.values()][0].departedAt,null);
  state.update([],1001); assert.equal([...state.entries.values()][0].departedAt,1001);
 }
});
test('60 seconds start at detection, even if departure was long ago', () => {
 const state=createResultsState(), j=journey(); state.update([j],1100);
 assert.equal([...state.entries.values()][0].departedAt,1100);
 state.update([],1159); assert.equal([...state.entries.values()][0].expired,false);
 state.update([],1160); assert.equal([...state.entries.values()][0].expired,true);
});
test('fresh LIVE during gray period restores the same entry node and resets removal deadline', () => {
 const state=createResultsState(), j=journey(true), key=journeyKey(j);
 state.update([j],1121); const node={}; state.entries.get(key).node=node;
 const corrected=journey(true); Object.assign(corrected.legs[0],{departureEpoch:1300,liveObservedEpoch:1140});
 state.update([corrected],1140);
 assert.equal(state.entries.get(key).departedAt,null);
 assert.equal(state.entries.get(key).expired,false);
 assert.equal(state.entries.get(key).node,node);
 state.update([],1181); assert.equal(state.entries.get(key).expired,false);
 state.update([],1301); assert.equal(state.entries.get(key).departedAt,1301);
});
