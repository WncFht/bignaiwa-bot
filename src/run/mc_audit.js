/* run/mc_audit.js —— 用 MC rollout oracle 审计线性评估函数。
 * 从导出 JSONL 里抽样决策点，重建真实状态进环境，跑 K 条随机 rollout 得到
 * 无偏价值估计，回答两个问题:
 *   A. 线性 V 与真实回报（ret）/oracle（MC值）的相关性 —— V 的质量
 *   B. 逐候选 MC-argmax 与专家记录 x 的一致率 —— 决策层面的一致度
 * 用法: node src/run/mc_audit.js <jsonl> [nCorr] [nAction]
 */
'use strict';
const fs = require('fs'), path = require('path');
const { createEnv } = require('../env.js');
const C = require('../core.js');
const E = require('../eval.js');
const MC = require('../agents/mc.js');
const Search = require('../agents/search.js');

const FILE = process.argv[2];
const NCORR = +(process.argv[3] || 120);
const NACTION = +(process.argv[4] || 24);

/* parts 表（碰撞外形 rb 系数） */
const vm = require('vm');
const _sb = { window: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '..', '..', 'vendor', 'parts.js'), 'utf8'), _sb);
const PARTS = _sb.window.SUIKA_PARTS;

function ballOf(b) {
  const [x, y, vx, vy, tier, angle, overTime] = b;
  const r = C.R[tier], sh = PARTS[tier], n = sh.parts.length;
  return {
    x, y, vx, vy, px: x, py: y, r, tier, angle,
    mass: r * r, invMass: 1 / (r * r), bornAt: 0, overTime,
    landed: true, dead: false, contacts: 0, pvx: 0, pvy: 0, sq: 0, sqA: 0,
    parts: sh.parts, rb: sh.rb * r,
    wx: new Float32Array(n), wy: new Float32Array(n), ws: new Float32Array(n)
  };
}
function stateOf(o) {
  return {
    balls: o.b.map(ballOf), score: o.s, best: 1e15, pending: o.p, next: o.n,
    ready: true, cooldown: 0, aimX: 210, over: false, revives: o.rv,
    reviveGiven: Math.floor(o.s / 2000),
    freeze: 0, flash: 0, danger: false, floats: [], particles: []
  };
}

const env = createEnv(1); env.core = C;
const mc = MC.createMC({ k: 6, rollDrops: 30, sim: { maxFrames: 90, calmFrames: 8, calmSpeed: 55 } });

const rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
console.log(`${rows.length} decisions loaded`);

function corr(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  return c / Math.sqrt(vx * vy + 1e-12);
}

/* A. 价值相关性：每 N 行抽样 */
const stride = Math.max(1, Math.floor(rows.length / NCORR));
const mcs = [], lvs = [], rets = [], ds = [];
for (let i = 0; i < rows.length && mcs.length < NCORR; i += stride) {
  const r = rows[i];
  env.restore(stateOf(r.o));
  const mcv = mc.mcValue(env);
  env.restore(stateOf(r.o));                       // 重置后再取线性 V
  const lv = E.evaluate(env, env.S.score, E.DEFAULT_W);
  mcs.push(mcv); lvs.push(lv); rets.push(r.ret); ds.push(r.d);
  if (mcs.length % 20 === 0) console.log(`  corr ${mcs.length}/${NCORR}`);
}
console.log(`\n== 价值相关性 (n=${mcs.length}) ==`);
console.log(`corr(MC, ret)   = ${corr(mcs, rets).toFixed(3)}   <- oracle 自证`);
console.log(`corr(V,  ret)   = ${corr(lvs, rets).toFixed(3)}   <- 线性V对回报`);
console.log(`corr(V,  MC)    = ${corr(lvs, mcs).toFixed(3)}   <- 线性V对oracle`);

/* B. 动作一致性：均匀抽 NACTION 行，逐候选 MC-argmax vs 专家 x */
let hit10 = 0, hit20 = 0, nA = 0; const deltas = [];
const aStride = Math.max(1, Math.floor(rows.length / NACTION));
for (let i = 0; i < rows.length && nA < NACTION; i += aStride) {
  const r = rows[i];
  env.restore(stateOf(r.o));
  const snap = env.snapshot();
  const xs = Search.candidates(env, 8, [0]);
  let bx = xs[0], bv = -Infinity;
  for (const x of xs) {
    env.restore(snap);
    C.simDrop(env, x, { maxFrames: 90, calmFrames: 8, calmSpeed: 55 });
    const mv = mc.mcValue(env);
    if (mv > bv) { bv = mv; bx = x; }
  }
  const d = Math.abs(bx - r.x);
  deltas.push(d); if (d <= 10) hit10++; if (d <= 20) hit20++;
  nA++;
  if (nA % 6 === 0) console.log(`  action ${nA}/${NACTION}`);
}
deltas.sort((a, b) => a - b);
console.log(`\n== 动作一致性 (n=${nA}) ==`);
console.log(`MC-argmax 与专家x 差 ≤10px: ${(100 * hit10 / nA).toFixed(0)}%   ≤20px: ${(100 * hit20 / nA).toFixed(0)}%`);
console.log(`|dx| 中位=${deltas[nA >> 1].toFixed(1)} p75=${deltas[(nA * 0.75) | 0].toFixed(1)} max=${deltas[nA - 1].toFixed(1)}`);
