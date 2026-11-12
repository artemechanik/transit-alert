import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const load = () => loadBrowserModule(new URL('../js/planner-transfer.js', import.meta.url), {});

test('presentation risk uses three minutes only for a confirmed platform change and keeps longer walks', async () => {
    const {assessTransfer:f} = await load();
    for (const [platformChange,walkMin,gap,risky,waiting,walk] of [
        ['same',0,0,true,0,0], ['same',0,1,false,1,0],
        ['different',0,3,true,0,3], ['different',0,4,false,1,3],
        ['different',2,2,true,-1,3], ['different',6,6,true,0,6],
        ['different',6,7,false,1,6], ['unknown',0,1,false,1,0],
        ['different',3.5,4,true,0.5,3.5],
    ]) {
        const result=f({arrivalMin:1450,departureMin:1450+gap,walkMin,platformChange});
        assert.equal(result.risky,risky);assert.equal(result.waitingMin,waiting);assert.equal(result.walkMin,walk);
    }
    for (const patch of [{arrivalMin:null},{departureMin:NaN},{walkMin:null},{walkMin:-1}]) {
        const result=f({arrivalMin:10,departureMin:20,walkMin:0,...patch});
        assert.equal(result.waitingMin,null);assert.equal(result.risky,false);
    }
});

test('platform identity and intermediate walking legs are read without changing journey inputs', async () => {
    const {transferPlatformChange:change,transferWalkMinutes:walk}=await load();
    const first={route:'7',toStopId:'x'},next={route:'153',fromStopId:'y'};
    const legs=[first,{route:'Пішки',departureMin:10,arrivalMin:12},{departureMin:12,arrivalMin:15},next];
    const before=JSON.stringify(legs);
    assert.equal(change(first,next),'different');assert.equal(walk(legs,first,next),5);
    assert.equal(JSON.stringify(legs),before);
    assert.equal(change(first,{...next,fromStopId:'x'}),'same');
    assert.equal(change(first,{...next,fromStopId:null}),'unknown');
    assert.equal(walk([first,next],first,next),0);
    assert.equal(walk([first,{route:'Пішки'},next],first,next),null);
});
