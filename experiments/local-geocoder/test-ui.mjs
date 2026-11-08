// UI behavior without a browser: test actual app.js with a small DOM/event double.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(){ this.children=[];this.attrs={};this.events={};this.value='';this.hidden=false; }
  setAttribute(k,v){this.attrs[k]=v}
  removeAttribute(k){delete this.attrs[k]}
  append(e){this.children.push(e)}
  replaceChildren(){this.children=[]}
  addEventListener(k,fn){this.events[k]=fn}
  scrollIntoView(){}
}
const els=Object.fromEntries(['query','results','status','selection','selected-name','details','stats'].map(n=>[n,new Element()]));
let timer, pending=[], sequence=0;
const sample={id:'source.uuid',source_id:'source.uuid.version',display_name:'Motycz 69B',
  simc:'0383461',terc:'0609082',lat:51.25,lon:22.35};
const context=vm.createContext({
 document:{querySelector:s=>els[s.slice(1)],createElement:()=>new Element()},
 AbortController, URLSearchParams,
 setTimeout:fn=>{timer=fn;return ++sequence},clearTimeout:()=>{timer=null},
 fetch: async url=> url==='/stats' ? {json:async()=>({addresses:96009,unique_simc:290,packages:16})} :
   await new Promise(resolve=>pending.push(resolve))
});
vm.runInContext(fs.readFileSync(new URL('./app.js',import.meta.url),'utf8'),context);
const key=k=>els.query.events.keydown({key:k,preventDefault(){}});
async function input(value){
  els.query.value=value;els.query.events.input();assert.equal(els.results.children.length,0);
  const cb=timer;timer=null; const request=cb();await Promise.resolve();return {request};
}
const response=(name='Motycz 69B')=>({ok:true,json:async()=>({results:[{...sample,display_name:name}],elapsed_ms:2})});
let first=await input('Motycz 69B');
pending.shift()(response());await first.request;
assert.equal(els.results.children.length,1);
key('ArrowDown');assert.equal(els.query.attrs['aria-activedescendant'],'option-0');
key('Enter');assert.equal(els.selection.hidden,false);assert.match(els.details.textContent,/51.25/);
assert.equal(els.query.value,'Motycz 69B');assert.equal(els.query.attrs['aria-expanded'],'false');
let street=await input('lipo');
pending.shift()({ok:true,json:async()=>({results:[{...sample,type:'street',street:'Lipowa',
  display_name:'Lipowa, Lublin',coordinate_kind:'street_representative'}],elapsed_ms:1})});
await street.request;
key('ArrowDown');key('Enter');
assert.equal(els.query.value,'Lipowa ');
assert.match(els.details.textContent,/репрезентативна/);
assert.match(els.status.textContent,/дописати номер/);
let refined=await input(els.query.value+'12');
pending.shift()(response('Lipowa 12, Lublin'));await refined.request;
key('Enter');
assert.equal(els.query.value,'Lipowa 12, Lublin');
let old=await input('old'), fresh=await input('fresh');
pending[1](response('fresh'));await fresh.request;
pending[0](response('old'));await old.request;pending=[];
assert.equal(els.results.children[0].textContent,'fresh','stale response cannot overwrite');
key('Escape');assert.equal(els.results.children.length,0);
let empty=await input('unknown');
pending.shift()({ok:true,json:async()=>({results:[],elapsed_ms:1})});await empty.request;
assert.match(els.status.textContent,/не доводить/);
console.log('UI checks passed: debounce, keyboard selection, coordinates, stale response, Escape, no-results wording.');
