/* run/probe_traj.js —— 中间信号探针（E17）。
 * 问题:fitness 只能靠打完整局吗?逐投轨迹(score/复活币/爆炸/顶高)里哪些信号
 * 在局中段就能预测终分——验证"提前进入复活循环=高分"假设,为 racing 式
 * 早停/中途淘汰做依据。
 * 方法:10 个质量分层的策略臂 × 3 种子(难/中/易),每 25 投记录
 * {d,score,rv,rvUsed,ex,m10,top,ot},终分与 drops 落 probe_traj.jsonl。
 * 用法: NW=4 node src/run/probe_traj.js   (SEEDS 可覆写)
 */
'use strict';
const { Worker } = require('worker_threads');
const os = require('os'), path = require('path'), fs = require('fs');
const E = require('../eval.js');

const NW = +(process.env.NW || 3);
const SEEDS = (process.env.SEEDS || '3000,4000,6000').split(',').map(Number);
const GAME_OPTS = { maxDrops: 600, probeEvery: 25 };
const OUT = path.join(__dirname, '..', '..', 'probe_traj.jsonl');
const AG = { grid: 14, depth: 1 };

const V2ONLY = { score: 1 };
for (const k of ['pendTgt', 'pendAdj', 'nextTgt', 'massTotal', 'cave', 'freeTop', 'nAboveSoft'])
  V2ONLY[k] = E.DEFAULT_W[k];

/* E5 爬山第 5 轮接受权重（11 维）/ E6 CEM 最优（17 维） */
const HILL = { score: 0.7178799072710741, topSafe: -2.4029753240709297, overTime: -3.431160409374406, aboveArea: -3.344649237040614, sameAdj: 2.819389416353478, orderX: 1.3430600225343874, smallUnder: -2.6791533230321427, bump: -0.735532721183162, maxPair: 3.9568984958833315, nMax: 1.4358471621454993, mergeDist: 2.2325341757996817 };
const CEM = { score: 2.8117197395093467, topSafe: -0.6070202414211049, overTime: -5.759833228421873, aboveArea: -4.575526850352387, sameAdj: 3.9890545631407592, orderX: 1.2632647717987806, smallUnder: -4.227425598266319, bump: -0.6465109208459267, maxPair: 126.23317364360544, nMax: 2.3806457835669104, mergeDist: 1.7502421330247917, pendTgt: 2.980297971058397, pendAdj: 1.4451347324382904, nextTgt: 0.6010390668829667, massTotal: 0.4219426741041487, cave: -1.3061798535715163, freeTop: 1.1313389696962235, nAboveSoft: -0.6408423347945085 };

const ARMS = [
  ['random',    { type: 'random' }],
  ['geom_only', { type: 'search', opts: Object.assign({}, AG, { weights: Object.assign({}, E.DEFAULT_W, { score: 0 }) }) }],
  ['score_only',{ type: 'search', opts: Object.assign({}, AG, { weights: { score: 1 } }) }],
  ['v2_only',   { type: 'search', opts: Object.assign({}, AG, { weights: V2ONLY }) }],
  ['survival',  { type: 'search', opts: Object.assign({}, AG, { weights: { score: 1, topSafe: -2, overTime: -4, aboveArea: -3 } }) }],
  ['hill',      { type: 'search', opts: Object.assign({}, AG, { weights: HILL }) }],
  ['hand',      { type: 'search', opts: Object.assign({}, AG, { weights: E.DEFAULT_W }) }],
  ['cem',       { type: 'search', opts: Object.assign({}, AG, { weights: CEM }) }],
  ['hand_dyn',  { type: 'search', opts: Object.assign({}, AG, { weights: E.DEFAULT_W, dyn: { topPx: 172, ot: 0.3 } }) }],
  ['hand_d2',   { type: 'search', opts: Object.assign({}, AG, { weights: E.DEFAULT_W, depth: 2 }) }]
];

const tasks = [];
ARMS.forEach((a, ai) => SEEDS.forEach(sd => tasks.push({ ai, sd })));
let idx = 0, done = 0;
const t0 = Date.now();
console.log(`probe: ${ARMS.length} arms × ${SEEDS.length} seeds = ${tasks.length} games, NW=${NW}, out=${OUT}`);

function spawn() {
  const w = new Worker(path.join(__dirname, 'worker.js'));
  w.on('message', r => {
    const arm = ARMS[tasks[w.__ti].ai][0];
    fs.appendFileSync(OUT, JSON.stringify({
      arm, seed: r.seed, score: r.score, drops: r.drops,
      rvUsed: r.revivesUsed, ex: r.explosions, m10: r.merges10, over: r.over, traj: r.traj
    }) + '\n');
    console.log(`[${++done}/${tasks.length}] ${arm} seed=${r.seed} score=${r.score} drops=${r.drops} (${((Date.now() - t0) / 60000).toFixed(0)}min)`);
    if (idx < tasks.length) send(w, idx++);
    else { w.__retire = true; w.terminate(); if (done === tasks.length) console.log('DONE'); }
  });
  const respawn = e => {
    if (w.__retire) return;
    console.error('worker died, requeue', e && e.message || '');
    const ti = w.__ti; send(spawn(), ti);
  };
  w.on('error', respawn);
  w.on('exit', c => { if (c !== 0 && !w.__retire) respawn(); });
  return w;
}
function send(w, ti) {
  w.__ti = ti;
  const t = tasks[ti];
  w.postMessage({ id: ti, seed: t.sd, opts: GAME_OPTS, agent: ARMS[t.ai][1] });
}
for (let i = 0; i < NW && idx < tasks.length; i++) { const w = spawn(); send(w, idx++); }
