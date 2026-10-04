/* run/fit_value.js —— 价值回归：用导出决策数据拟合 V(s)=w·f(s) ≈ ret。
 * 用法: node src/run/fit_value.js <jsonl> [--split]
 * 输出: 拟合权重（可直接当 agent weights，score 维度固定 1.0）+
 *       R²、各特征单变量相关、留一消融 ΔR² —— 兼作特征有效性报告。
 *
 * 方法说明:
 *   X = 10 个非 score 特征 + 常数项；y = ret（该局剩余得分）。
 *   ridge: (XᵀX + λI)w = Xᵀy，λ 在 [1e-4..1e-1]×tr(XᵀX)/p 里按留出集 R² 选。
 *   这是蒙特卡洛策略评估（对当前策略的回报回归），不是策略改进本身；
 *   得到的权重进 search 后即构成近似策略迭代的一步。
 */
'use strict';
const fs = require('fs');
const C = require('../core.js');
const E = require('../eval.js');

const FILE = process.argv[2];
const SPLIT = process.argv.includes('--split');

const FEATS = Object.keys(E.DEFAULT_W).filter(k => k !== 'score');   // score 是转移奖励不进 V

function rowToState(o) {
  return {
    balls: o.b.map(([x, y, vx, vy, tier, angle, overTime]) =>
      ({ x, y, vx, vy, tier, angle, overTime, r: C.R[tier], dead: false })),
    score: o.s, pending: o.p, next: o.n, revives: o.rv, over: false
  };
}

const rows = [];
for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  /* 老数据没有 f 列或缺少新特征时，从原始 obs 重算（特征纯依赖球集合+pending/next） */
  let f = r.f;
  const S = rowToState(r.o);
  if (!f || !FEATS.every(k => k in f)) f = E.features(S, r.o.s);
  rows.push({ x: FEATS.map(k => f[k] || 0), y: r.ret, d: r.d, s: r.s });
}
console.log(`loaded ${rows.length} decisions from ${FILE}`);

/* ---- ridge: 解 (XᵀX+λI)w=Xᵀy ---- */
function solve(data, ymap, lam) {
  const p = data[0].x.length + 1;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (const r of data) {
    const v = [r.x, 1].flat();
    const y = ymap(r.y);
    for (let i = 0; i < p; i++) { b[i] += v[i] * y; for (let j = 0; j < p; j++) A[i][j] += v[i] * v[j]; }
  }
  const tr = A.reduce((s, _, i) => s + A[i][i], 0) / p;
  for (let i = 0; i < p; i++) A[i][i] += lam * tr;
  /* 高斯消元 */
  for (let c = 0; c < p; c++) {
    let m = c; for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]];[b[c], b[m]] = [b[m], b[c]];
    for (let r = 0; r < p; r++) {
      if (r === c || !A[r][c]) continue;
      const t = A[r][c] / A[c][c];
      for (let k = c; k < p; k++) A[r][k] -= t * A[c][k];
      b[r] -= t * b[c];
    }
  }
  return b.map((bi, i) => bi / A[i][i]);
}
const predict = (w, x) => [...x, 1].reduce((s, v, i) => s + v * w[i], 0);
function r2(data, w, ymap, yinv) {
  let ss = 0, st = 0, mean = 0;
  for (const r of data) mean += r.y;
  mean /= data.length;
  for (const r of data) { const e = r.y - yinv(predict(w, r.x)); ss += e * e; st += (r.y - mean) ** 2; }
  return 1 - ss / st;
}

/* 目标变换: ret 跨 0..33k，试三种 */
const MAPS = {
  raw: [y => y, y => y],
  log1p: [y => Math.log1p(y), y => Math.expm1(y)],
  sqrt: [y => Math.sqrt(Math.max(0, y)), y => y * y]
};

const n = rows.length, idx = rows.map((_, i) => i);
for (let i = n - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[idx[i], idx[j]] = [idx[j], idx[i]]; }
const tr = idx.slice(0, n * 0.8 | 0).map(i => rows[i]);
const va = idx.slice(n * 0.8 | 0).map(i => rows[i]);

let best = null;
for (const [name, [ymap, yinv]] of Object.entries(MAPS)) {
  for (const lam of [1e-4, 1e-3, 1e-2, 1e-1, 1]) {
    const w = solve(tr, ymap, lam);
    const R = r2(va, w, ymap, yinv);
    if (!best || R > best.R) best = { name, lam, w, R };
    console.log(`  ${name} lam=${lam}: val R²=${R.toFixed(4)}`);
  }
}
console.log(`\nbest: target=${best.name} lam=${best.lam} val R²=${best.R.toFixed(4)}`);

/* 单变量相关 + 留一消融 */
console.log('\nfeature    univar-r    ΔR²(LOO)');
const [ymap] = MAPS[best.name];
for (let k = 0; k < FEATS.length; k++) {
  const xs = rows.map(r => r.x[k]), ys = rows.map(r => r.y);
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
  const corr = cov / Math.sqrt(vx * vy + 1e-12);
  const trSub = tr.map(r => ({ x: r.x.filter((_, i) => i !== k), y: r.y }));
  const vaSub = va.map(r => ({ x: r.x.filter((_, i) => i !== k), y: r.y }));
  const w2 = solve(trSub, ymap, best.lam);
  let ss = 0, st = 0, mean = 0;
  for (const r of vaSub) mean += r.y;
  mean /= vaSub.length;
  for (const r of vaSub) { const e = r.y - MAPS[best.name][1](predict(w2, r.x)); ss += e * e; st += (r.y - mean) ** 2; }
  const R2loo = 1 - ss / st;
  console.log(`${FEATS[k].padEnd(11)} ${corr >= 0 ? ' ' : ''}${corr.toFixed(3)}      ${(best.R - R2loo).toFixed(4)}`);
}

const wOut = { score: 1.0 };
FEATS.forEach((k, i) => wOut[k] = +best.w[i].toFixed(4));
wOut.__bias = +best.w[FEATS.length].toFixed(2);
console.log('\nfitted weights:', JSON.stringify(wOut));

if (SPLIT) {
  for (const [tag, filt] of [['early(d<300)', r => r.d < 300], ['late(d>=300)', r => r.d >= 300]]) {
    const d2 = rows.filter(filt);
    if (d2.length < 50) continue;
    const w2 = solve(d2, ymap, best.lam);
    const ww = {}; FEATS.forEach((k, i) => ww[k] = +w2[i].toFixed(3));
    console.log(`[${tag}] n=${d2.length}: ` + JSON.stringify(ww));
  }
}
