/* env.js —— Node 侧 headless 环境装载器。
 * 在 vm 沙箱里跑 vendor/game.js + parts.js（与线上完全同一份物理），
 * 提供：种子化 RNG、可控时钟、DOM 桩、排行榜提交计数。
 * 产出 {G, S, rng, clock, reset} —— 交给 core.js 的函数使用。
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const VENDOR = path.join(__dirname, '..', 'vendor');

function mulberry32(seed) {
  let a = seed >>> 0;
  const f = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.getState = () => a;
  f.setState = (s) => { a = s >>> 0; };
  return f;
}

function makeCtx() {
  const g = { addColorStop() {} };
  return {
    setTransform() {}, save() {}, restore() {}, scale() {}, rotate() {}, translate() {},
    clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, ellipse() {}, clip() {}, stroke() {}, fill() {}, setLineDash() {},
    drawImage() {}, createLinearGradient: () => g, createRadialGradient: () => g,
    measureText: () => ({ width: 10 }), fillText() {}, strokeText() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
    font: '', textAlign: '', textBaseline: '', lineCap: ''
  };
}
function makeEl(id) {
  const el = {
    id, style: {}, textContent: '', width: 680, height: 112, hidden: false, _h: {},
    classList: { add() {}, remove() {}, contains: () => false },
    getContext: () => el._ctx || (el._ctx = makeCtx()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 700 }),
    addEventListener(t, fn) { el._h[t] = fn; },
    click() { el._h.click && el._h.click({ preventDefault() {} }); },
    querySelector: () => ({ textContent: '', style: {}, classList: { add() {}, remove() {} } }),
    setAttribute() {}, offsetWidth: 100
  };
  return el;
}

const EL_IDS = ['game', 'stage', 'overlay', 'score', 'best', 'finalScore', 'finalBest',
  'next', 'chain', 'soundBtn', 'resetBtn', 'restartBtn', 'revivePrompt', 'overPanel',
  'reviveScore', 'reviveLeft', 'reviveBtn', 'giveUpBtn', 'reviveBadge', 'reviveCount'];

function createEnv(seed) {
  const els = {};
  EL_IDS.forEach(id => els[id] = makeEl(id));
  const rng = mulberry32(seed === undefined ? 1 : seed);
  const derivedMath = Object.create(Math);
  derivedMath.random = rng;

  let fakeNow = 0;
  const submits = [];   // DanaiwaBoard.onGameOver 收到的分数

  const sandbox = {
    console, Math: derivedMath, Date, JSON, Object, Array, Number, String, Boolean, Error,
    isNaN, parseFloat, parseInt, Float32Array, Set, Map,
    performance: { now: () => fakeNow },
    requestAnimationFrame() { return 1; },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    document: {
      readyState: 'complete', getElementById: id => els[id] || null,
      addEventListener() {}, createElement: () => makeEl('tmp'),
      querySelector: () => null, querySelectorAll: () => []
    },
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
    addEventListener() {}, navigator: {},
    DanaiwaBoard: { onGameOver(s) { submits.push(s); } },
    Image: class {
      constructor() { this.width = 512; this.height = 512; }
      set src(v) { if (this.onload) this.onload(); } get src() { return ''; }
    }
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const load = f => vm.runInContext(fs.readFileSync(path.join(VENDOR, f), 'utf8'), sandbox, { filename: f });
  load('parts.js');
  load('game.js');

  const G = sandbox.__DNW__, S = G.state;
  G.reset();
  fakeNow += 1000;

  const env = {
    G, S, els, rng, submits,
    clock: { tick(dt) { fakeNow += (dt || 1 / 60) * 1000; }, now: () => fakeNow },
    reset(newSeed) {
      if (newSeed !== undefined) rng.setState(newSeed >>> 0);
      G.reset();
      fakeNow += 1000;
      submits.length = 0;
    },
    /* 快照时把 RNG 位一起存下，rollout 分叉时后续抽签可复现 */
    snapshot() {
      const core = env.core;
      const s = core.snapshot(S);
      s.rng = rng.getState();
      s.fakeNow = fakeNow;
      return s;
    },
    restore(s) {
      env.core.restore(S, s);
      rng.setState(s.rng);
      fakeNow = s.fakeNow;
    }
  };
  return env;
}

module.exports = { createEnv };
