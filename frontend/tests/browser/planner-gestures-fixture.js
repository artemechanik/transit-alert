// Loaded only by check-planner-gestures.py in a disposable Chrome profile.
import { createPlanner } from '../../js/planner.js';
import { createNavigation } from '../../js/navigation.js';
const now = Math.floor(Date.now() / 1000);
window.fixture = { ready: false, routeRequests: 0, headerBacks: 0 };
window.fetch = async url => ({ ok: true, json: async () => {
    if (url.includes('/route/complex')) {
        fixture.routeRequests++;
        return Array.from({ length: 12 }, (_,i) => ({ legs: [{ tripId: `t${i}`, route: '7',
            fromStopId: 'a', toStopId: 'b', fromStopName: 'A 01', toStopName: 'B 01',
            departureMin: 600+i, arrivalMin: 620+i,
            scheduledDepartureEpoch: now+3600+i*60, departureEpoch: now+3600+i*60 }] }));
    }
    if (url.includes('upcoming-stops')) return { boardingStopSequence: 1,
        stops: Array.from({ length: 30 }, (_,i) => ({ stopId: i===0?'a':i===29?'b':`s${i}`,
            stopSequence: i+1, name: i===0?'A':i===29?'B':`Stop ${i}`, eta: '10:00' })),
        live: { tripId: url.match(/trips\/(t\d+)/)?.[1], gpsTimestamp: now,
            currentStopSequence: 1, currentStatus: 'STOPPED_AT', isFresh: true } };
    return [];
} });
const screen = document.querySelector('#screen-route');
screen.style.cssText = 'display:flex;position:fixed;inset:0;height:100vh;padding:10px;z-index:99999;background:var(--bg)';
localStorage.setItem('ta_recent_routes', JSON.stringify([{ from: {name:'A',ids:['a']}, to:{name:'B',ids:['b']} }]));
let nav;
const planner = createPlanner({ apiBaseUrl: '', getMapTilerKey: () => '',
    locationService: { getPosition: () => null }, getNearbyStops: () => [], showVehicleOnMap() {}, showToast() {},
    addMinutesToTime: t => t, onAccordionOpen: () => nav.pushPlannerAccordionHistory(),
    onBack() { fixture.headerBacks++; nav.back(); } });
nav = createNavigation({ closeVehicleMapModal() {}, stopVehicleTracking() {}, enterStops() {},
    enterPlanner: () => planner.enterPlanner(), leavePlanner: () => planner.leavePlanner(), openReports() {}, closeForms() {},
    closePlannerAccordion: () => planner.closePlannerAccordion(), closeDepartureAccordion() {} });
nav.initNavigation(); history.replaceState({screen:'route'}, '');
planner.initPlanner(); planner.enterPlanner(); document.querySelector('#recent-routes-list .stop-card').click();
await new Promise(resolve => setTimeout(resolve,60)); document.querySelector('#trasa-presentation-new').click();
const root = document.querySelector('#route-results-list');
Object.assign(fixture, { root, planner,
    async open(index=0) {
        const card = root.querySelectorAll('.trasa-card')[index];
        if (!card.classList.contains('fullscreen-expanded')) card.click();
        await new Promise(resolve => setTimeout(resolve,100));
    },
    metrics() {
        const live = root.querySelector('.fullscreen-expanded .lubus-live');
        return { outer:root.scrollTop, inner:live?.scrollTop, liveHeight:live?.clientHeight,
            liveContent:live?.scrollHeight, requests:fixture.routeRequests, open:!!root.querySelector('.fullscreen-expanded') };
    }
});
await fixture.open(); fixture.ready = true;
