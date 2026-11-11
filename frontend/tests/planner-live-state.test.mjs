import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from './helpers/load-browser-module.mjs';
const load = () => loadBrowserModule(new URL('../js/planner-live-state.js', import.meta.url), {});
function segment(sequence=1,status='IN_TRANSIT_TO') {
    const all=[1,4,9,20,31].map((stopSequence,i)=>({stopSequence,stopId:i===0||i===3?'repeat':'s'+i,name:'Stop '+stopSequence}));
    const stops=all.slice(3);stops.timelineStops=all;stops.boardingSequence=20;
    stops.live={tripId:'t',currentStopSequence:sequence,currentStatus:status,gpsTimestamp:1000,isFresh:true};
    return {leg:{tripId:'t',route:'7',fromStopId:'repeat',scheduledDepartureEpoch:9999999999},stops};
}

test('transitions use ordered stops, distinguish transit/incoming/stopped and never infer passenger boarding',async()=>{
    const {passengerLiveState:f}=await load();
    const cases=[
        [1,'IN_TRANSIT_TO','approaching',4,1], [4,'STOPPED_AT','approaching',2,9],
        [9,'IN_TRANSIT_TO','approaching',2,9], [9,'INCOMING_AT','approaching',2,9],
        [9,'STOPPED_AT','near',1,20], [20,'IN_TRANSIT_TO','near',1,20],
        [20,'INCOMING_AT','near',1,20], [20,'STOPPED_AT','boarding',0,31],
        [31,'IN_TRANSIT_TO','in_progress',0,31], [31,'STOPPED_AT','in_progress',0,null],
        [40,'IN_TRANSIT_TO','in_progress',0,null]
    ];
    for(const [seq,status,state,count,next] of cases){
        const r=f(segment(seq,status),1000);
        assert.equal(r.state,state,`${seq}/${status}`);assert.equal(r.stopsToBoarding,count);
        assert.equal(r.nextStop?.stopSequence??null,next);assert.ok(r.hint);
        assert.doesNotMatch(r.hint,/jesteś w|wsiadłeś|wsiadłaś/i);
    }
    assert.match(f(segment(4,'STOPPED_AT'),1000).hint,/stoi/);
    assert.match(f(segment(9,'INCOMING_AT'),1000).hint,/wcześniejszego/);
});

test('missing stale future mismatched GPS and missing status never claim a position or unstarted course',async()=>{
    const {passengerLiveState:f}=await load();
    for(const patch of [null,{isFresh:false},{gpsTimestamp:699},{gpsTimestamp:1001},{gpsTimestamp:0},
        {currentStopSequence:null},{currentStatus:null},{currentStatus:'OTHER'},{tripId:'other'}]){
        const s=segment();s.stops.live=patch===null?null:{...s.stops.live,...patch};
        const r=f(s,1000);assert.equal(r.state,'unknown');assert.equal(r.nextStop,null);
        assert.notEqual(r.label,'Kurs jeszcze się nie rozpoczął');
    }
    const s=segment();s.stops.live.gpsTimestamp=700;assert.equal(f(s,1000).state,'approaching');
    s.stops.live=null;assert.equal(f(s,1000).state,'unknown');
    s.stops.live=segment(20,'STOPPED_AT').stops.live;assert.equal(f(s,1000).state,'boarding');
});

test('ambiguous boarding stays neutral while independently known next stop stays visible',async()=>{
    const {passengerLiveState:f}=await load();
    const s=segment(4,'STOPPED_AT');delete s.stops.boardingSequence;
    assert.equal(f(s,1000).state,'unknown');assert.equal(f(s,1000).nextStop.name,'Stop 9');
    s.stops.boardingSequence=1;assert.equal(f(s,1000).state,'in_progress');
    s.stops.boardingSequence=20;assert.equal(f(s,1000).state,'approaching');
    s.stops.boardingSequence=9;assert.equal(f(s,1000).state,'unknown');
    assert.equal(f(s,1000).nextStop.name,'Stop 9');
});

test('invalid duplicate sequence and unknown sequence gaps are neutral without guessing movement',async()=>{
    const {passengerLiveState:f}=await load();
    assert.equal(f(segment(7),1000).state,'unknown');
    const s=segment();s.stops.timelineStops[1].stopSequence=1;
    assert.equal(f(s,1000).state,'unknown');assert.equal(f(s,1000).nextStop,null);
});

test('known next stop beyond alighting is retained for LIVE without expanding the chosen itinerary',async()=>{
    const {passengerLiveState:f}=await load();const s=segment(31,'STOPPED_AT');
    s.stops.tripStops=[...s.stops.timelineStops,{stopSequence:90,stopId:'later',name:'Later stop'}];
    const r=f(s,1000);assert.equal(r.state,'in_progress');assert.equal(r.nextStop.name,'Later stop');
    assert.equal(s.stops.at(-1).stopSequence,31);assert.equal(s.stops.timelineStops.at(-1).stopSequence,31);
});
