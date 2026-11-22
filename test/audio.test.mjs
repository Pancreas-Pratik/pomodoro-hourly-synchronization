import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {current, initialState, change, MINUTE} from '../docs/timer.js';

const source = name => readFileSync(new URL(
  process.env.POMO_SOURCE_DIR ? `file://${process.env.POMO_SOURCE_DIR}/${name}` : `../docs/${name}`,
  import.meta.url), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

class Target {
  constructor(id = '') { this.id = id; this.listeners = {}; this.value = ''; this.dataset = {}; this.textContent = ''; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, detail = {}) { for (const fn of this.listeners[type] || []) fn({target: this, detail, preventDefault() {}}); }
  setAttribute(key, value) { this[key] = value; }
  replaceChildren() {}
}
function audioHarness({slow = false} = {}) {
  const document = new Target(), window = new Target();
  const ids = ['beforeBreakSound','beforeFocusSound','countdown','phase','toggle',
    'sync','sync100','reset','durations','soundVolume','soundVolumeValue','enable-sounds'];
  const elements = Object.fromEntries(ids.map(id => [id, new Target(id)]));
  elements.soundVolume.value = '100';
  const testButton = new Target(); testButton.dataset.testSound = 'beforeBreakSound';
  const started = [], sources = [], oscillators = [];
  let monotonic = 0, release;
  const decode = slow ? new Promise(resolve => { release = resolve; }) : Promise.resolve({duration: 15});
  const param = {setTargetAtTime(){}, setValueAtTime(){}, linearRampToValueAtTime(){}, exponentialRampToValueAtTime(){}};
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() { return {context: this, gain: {...param}, connect(){}}; }
    decodeAudioData() { return decode; }
    createBufferSource() {
      const s = new Target(); s.connect = s.disconnect = () => {};
      s.start = (...args) => { s.args = args; started.push(s); };
      s.stop = () => { s.stopped = true; };
      sources.push(s); return s;
    }
    createOscillator() {
      const s = new Target(); s.frequency = {...param}; s.connect = s.disconnect = () => {};
      s.start = () => { oscillators.push(s); };
      s.stop = () => { s.stopped = true; }; return s;
    }
  }
  window.AudioContext = AudioContext;
  document.getElementById = id => elements[id];
  document.querySelectorAll = selector => selector === '[data-test-sound]' ? [testButton] : [];
  vm.runInNewContext(source('sounds.js'), {
    document, window, console, performance: {now: () => monotonic},
    localStorage: {getItem: () => null, setItem(){}}, Option: class {},
    fetch: async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(1)})
  });
  return {
    elements, started, sources, oscillators,
    emit: detail => window.emit('pomo-live-timer', detail),
    arm: () => {
      // The old release had no explicit button: its generic gesture armed audio.
      if (elements['enable-sounds'].listeners.click) elements['enable-sounds'].emit('click');
      else document.emit('pointerdown');
    },
    gesture: () => document.emit('pointerdown'),
    preview: () => testButton.emit('click'),
    hide: () => window.emit('pagehide'),
    elapsed: ms => { monotonic += ms; },
    resolve: () => release({duration: 15})
  };
}
const base = {mode:'custom', phase:'focus', running:true, safeToNotify:true,
  remaining:15000, endsAt:100000, focus:50, rest:10, version:1};

// Reproduce the extra hourly alert: opening Settings/colors used to unlock
// every background timer page even though no timer control was touched.
test('cosmetic clicks cannot enable automatic audio', async () => {
  const h = audioHarness(); h.gesture(); await flush(); h.emit(base); await flush();
  assert.equal(h.started.length, 0);
});
test('Test previews do not arm automatic alerts', async () => {
  const h = audioHarness(); h.preview(); await flush(); assert.equal(h.started.length, 1);
  h.emit(base); await flush(); assert.equal(h.started.length, 1);
});
test('15-second clip fires once and never with minutes remaining', async () => {
  const h = audioHarness(); h.arm(); await flush();
  for (const remaining of [600000,60000,15001]) h.emit({...base,remaining});
  await flush(); assert.equal(h.started.length, 0);
  for (const remaining of [15000,14750,10000,1000]) { h.emit({...base,remaining}); await flush(); }
  assert.equal(h.started.length, 1);
});
test('connection flaps and version changes do not replay the same deadline', async () => {
  const h = audioHarness(); h.arm(); await flush(); h.emit(base); await flush();
  h.emit({...base,safeToNotify:false}); assert.equal(h.started[0].stopped,true);
  h.emit({...base,remaining:12000,safeToNotify:true}); await flush();
  h.emit({...base,remaining:11000,version:2}); await flush();
  assert.equal(h.started.length,1);
});
test('pause, mute, and page exit stop audio', async () => {
  for (const action of ['pause','mute','exit']) {
    const h = audioHarness(); h.arm(); await flush(); h.emit(base); await flush();
    if(action==='pause') h.emit({...base,running:false});
    if(action==='mute') h.arm();
    if(action==='exit') h.hide();
    assert.equal(h.started[0].stopped,true,action);
  }
});
test('switching to 100/20 cancels a pending decode before new state arrives', async () => {
  const h = audioHarness({slow:true}); h.arm(); h.gesture(); h.emit(base);
  h.elements.sync100.emit('click'); h.resolve(); await flush();
  assert.equal(h.started.length,0);
});
test('slow audio decoding cannot play after a remote timer change', async () => {
  const h=audioHarness({slow:true});h.arm();h.emit(base);
  h.emit({...base,endsAt:700000,remaining:600000}); h.resolve(); await flush();
  assert.equal(h.started.length,0);
});
test('late loads align to remaining time, expired loads stay silent', async () => {
  for(const elapsed of [4000,16000]) {
    const h=audioHarness({slow:true});h.arm();h.emit(base);h.elapsed(elapsed);h.resolve();await flush();
    assert.equal(h.started.length,elapsed<15000?1:0);
    if(elapsed<15000) assert.deepEqual(h.started[0].args,[0,4,11]);
  }
});
test('Off and unsafe/invalid timer states are silent', async () => {
  const h=audioHarness();h.arm();await flush();
  for(const detail of [{safeToNotify:false},{running:false},{remaining:NaN},
    {remaining:0},{remaining:-10},{endsAt:null},{phase:'invalid'},{mode:'invalid'}]) {
    h.emit({...base,...detail}); await flush();
  }
  h.elements.beforeBreakSound.value='off';h.emit(base);await flush();
  assert.equal(h.started.length,0);
});
test('short tones fire once at 3, 2, 1 seconds; next phase uses its own preference', async () => {
  const h=audioHarness();h.arm();await flush();h.elements.beforeBreakSound.value='beep';
  h.elements.beforeFocusSound.value='off';
  for(const remaining of [4000,3000,2900,2000,1900,1000,900]) h.emit({...base,remaining});
  assert.equal(h.oscillators.length,3);
  h.emit({...base,phase:'break',endsAt:200000,remaining:1000});
  assert.equal(h.oscillators.length,3);
});
for(const mode of ['hourly','twohour','custom']) {
  test(`${mode}: simulated schedule has no extra hourly alerts`, async () => {
    const h=audioHarness();h.arm();await flush();
    const start=Date.parse('2026-11-22T16:00:00-05:00');
    const state=mode==='custom'
      ? change(change(initialState(),{type:'durations',focus:100,rest:20},start),{type:'start'},start)
      : {...initialState(),mode};
    const alerts=[];
    // Walk two full hours with the same current() used by the published app.
    for(let seconds=0;seconds<=7200;seconds++) {
      const t=start+seconds*1000; const before=h.started.length;
      h.emit({...current(state,t),safeToNotify:true}); await flush();
      if(h.started.length>before) alerts.push(seconds);
    }
    assert.deepEqual(alerts, mode==='hourly' ? [2985,3585,6585,7185] : [5985,7185]);
  });
}

test('switching schedules leaves no :50 alarm in the active page or a cosmetic-only second page', async () => {
  const active = audioHarness(), otherPage = audioHarness();
  active.arm(); otherPage.gesture(); await flush();
  const start = Date.parse('2026-11-22T16:30:00-05:00');
  let state = change(initialState(), {type:'sync'}, start);
  active.emit({...current(state,start),safeToNotify:true});
  active.elements.sync100.emit('click');
  state = change(state, {type:'sync100'}, start);
  const alerts = [];
  for (let seconds=0;seconds<=5400;seconds++) {
    const time = start + seconds*1000, before = active.started.length;
    active.emit({...current(state,time),safeToNotify:true});
    otherPage.emit({...current({...initialState(),mode:'hourly'},time),safeToNotify:true});
    await flush();
    if (active.started.length>before) alerts.push(seconds);
  }
  assert.deepEqual(alerts,[4185,5385]); // 17:39:45 and 17:59:45 only.
  assert.equal(otherPage.started.length,0);
});

test('all timer controls enable audio without a generic global gesture', async () => {
  for(const id of ['toggle','sync','sync100','durations']) {
    const h=audioHarness();h.elements[id].emit(id==='durations'?'submit':'click');
    await flush();h.emit(base);await flush();assert.equal(h.started.length,1,id);
  }
});

function appHarness(discord) {
  const ids=['countdown','phase','toggle','reset','sync','sync100','apply','focus','rest',
    'next','schedule','connection','clock','message','durations'];
  const elements=Object.fromEntries(ids.map(id => {
    const el=new Target(id);el.firstChild={textContent:''};el.getAttribute=k=>el[k];return [id,el];
  }));
  const events=[];
  const window=new Target();window.dispatchEvent=event=>events.push(event.detail);
  const document=new Target();document.querySelectorAll=()=>Object.values(elements);
  document.body={classList:{toggle(){}}};
  const context=vm.createContext({document,window,console,Date,Intl,URLSearchParams,
    location:{search:discord?'?frame_id=test':''},
    initialState,current,change,DISCORD_CLIENT_ID:'',SharedTimer:class{},
    setTimeout(){},clearTimeout(){},CustomEvent:class{constructor(type,opts){this.detail=opts.detail;}}});
  vm.runInContext(source('app.js').replace(/^import[\s\S]*?;\n/gm,''),context);
  return {events,run:code=>vm.runInContext(code,context),latest:()=>events.at(-1)};
}
test('Discord never sounds its fallback hourly timer without confirmed shared state',()=>{
  const h=appHarness(true);assert.equal(h.latest().safeToNotify,false);
  h.run("sharedReady=true; sharedConnection='online'; tick();");
  assert.equal(h.latest().safeToNotify,true);
  h.run("pending=true; tick();");assert.equal(h.latest().safeToNotify,false);
  h.run("pending=false; sharedConnection='reconnecting'; tick();");
  assert.equal(h.latest().safeToNotify,false);
});
test('local website remains eligible once the user explicitly enables sound',()=>{
  const h=appHarness(false);assert.equal(h.latest().safeToNotify,true);
});
test('shared refresh mutes old state until fresh state is applied',async()=>{
  const context=vm.createContext({});
  vm.runInContext(source('shared.js').replace('export class SharedTimer','class SharedTimer')+'\nthis.SharedTimer=SharedTimer;',context);
  const order=[];
  const shared=new context.SharedTimer({url:'https://example.invalid',key:'test',instanceId:'test',
    onStatus:s=>order.push(s),onState:()=>order.push('state')});
  let release;
  shared.rpc=()=>new Promise(resolve=>{release=resolve;});
  shared.live=true;
  const result=shared.refresh();
  assert.deepEqual(order,['reconnecting']);
  release({payload:{state:{instance_id:'test',version:1,mode:'custom'},server_now:1000},begunAt:1000,arrivedAt:1000});
  await result; assert.deepEqual(order,['reconnecting','state','online']);
});
