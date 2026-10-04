/* run/ablate.js —— 消融控制矩阵：多配置在同一种子集上跑批出对比表。
 * 用法: node src/run/ablate.js [gamesPerCfg] [agentOptsJSON]
 *   node src/run/ablate.js 6 '{"grid":14,"depth":1}'
 *   SEED0=6000 GAME_OPTS='{"maxDrops":600}' node src/run/ablate.js
 *   ABLATE_CFGS='[["w_a",{"weights":{"score":1}}]]' —— 自定义对比表（bake-off）
 */
'use strict';
const { Worker } = require('worker_threads');
const os = require('os'), path = require('path');
const E = require('../eval.js');

const NG = +(process.argv[2] || 6);
const BASE = process.argv[3] ? JSON.parse(process.argv[3]) : { grid: 14, depth: 1 };
const GAME_OPTS = process.env.GAME_OPTS ? JSON.parse(process.env.GAME_OPTS) : {};
const NW = Math.min(os.cpus().length, +(process.env.NW || 12));
const SEED0 = +(process.env.SEED0 || 6000);

/* 老 11 维权重（v2 前） */
const W11 = {}; for (const k of ['score', 'topSafe', 'overTime', 'aboveArea', 'sameAdj',
  'orderX', 'smallUnder', 'bump', 'maxPair', 'nMax', 'mergeDist']) W11[k] = E.DEFAULT_W[k];
const V2ONLY = { score: 1 };
for (const k of ['pendTgt', 'pendAdj', 'nextTgt', 'massTotal', 'cave', 'freeTop', 'nAboveSoft'])
  V2ONLY[k] = E.DEFAULT_W[k];

const DEFAULT_CONFIGS = [
  ['full_v2', { weights: E.DEFAULT_W }],
  ['full_v1', { weights: W11 }],
  ['score_only', { weights: { score: 1 } }],
  ['geom_only', { weights: Object.assign({}, W11, { score: 0 }) }],
  ['survival', { weights: { score: 1, topSafe: -2, overTime: -4, aboveArea: -3 } }],
  ['v2_only', { weights: V2ONLY }],
  ['no_align', { weights: W11, sameOffsets: [] }],
  ['depth2', { weights: W11, depth: 2 }],
  ['sim_short', { weights: W11, sim: { maxFrames: 60, calmFrames: 6, calmSpeed: 55 } }],
  ['sim_long', { weights: W11, sim: { maxFrames: 160, calmFrames: 14, calmSpeed: 55 } }]
];
/* ABLATE_CFGS='[["name",{opts}],...]' 整体替换配置表（bake-off 复用） */
const CONFIGS = process.env.ABLATE_CFGS ? JSON.parse(process.env.ABLATE_CFGS) : DEFAULT_CONFIGS;

const median = a => { const s = a.slice().sort((x, y) => x - y); return s[(s.length / 2) | 0]; };

function evalCfg(name, opts, cb) {
  const scores = []; const tasks = [];
  for (let i = 0; i < NG; i++) tasks.push(SEED0 + i * 11);
  let idx = 0; const pool = [];
  const send = (w, sd) => { w.__sd = sd; w.__inflight = true; w.postMessage({ id: idx, seed: sd, opts: GAME_OPTS, agent: { type: 'search', opts } }); };
  const spawn = () => {
    const w = new Worker(path.join(__dirname, 'worker.js'));
    pool.push(w);
    w.on('message', r => {
      w.__inflight = false;
      scores.push(r.score);
      process.stdout.write(`  ${name} seed=${r.seed} score=${r.score}\n`);
      if (idx < tasks.length) send(w, tasks[idx++]);
      else if (scores.length === tasks.length) { w.__retire = true; pool.forEach(x => x.terminate()); cb(scores); }
    });
    const respawn = e => {
      if (w.__retire || !w.__inflight) return;
      console.error('worker died, requeue seed', w.__sd, e && e.message || '');
      send(spawn(), w.__sd);
    };
    w.on('error', respawn);
    w.on('exit', c => { if (c !== 0) respawn(); });
    return w;
  };
  for (let i = 0; i < NW && idx < tasks.length; i++) { const w = spawn(); send(w, tasks[idx++]); }
}

const results = {};
let ci = 0;
function next() {
  if (ci >= CONFIGS.length) {
    console.log('\n=== 消融对比 (median / mean / min-max) ===');
    for (const [n] of CONFIGS) {
      const s = results[n], m = s.reduce((a, b) => a + b) / s.length;
      console.log(`${n.padEnd(11)} ${median(s).toString().padStart(6)} / ${m.toFixed(0).padStart(6)} / ${Math.min(...s)}-${Math.max(...s)}`);
    }
    return;
  }
  const [name, extra] = CONFIGS[ci++];
  const opts = Object.assign({}, BASE, extra);
  console.log(`\n[${name}] ${JSON.stringify(opts)}`);
  evalCfg(name, opts, s => { results[name] = s; next(); });
}
next();
