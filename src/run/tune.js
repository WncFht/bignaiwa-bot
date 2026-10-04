/* run/tune.js —— 评估权重随机搜索。
 * 固定种子集做公平比较：每个候选权重在同一批种子上跑 N 局，目标函数 = 中位分。
 * 策略：从 DEFAULT_W 出发，每轮对权重乘 log-均匀扰动，优则接纳（爬山）。
 * 用法: node src/run/tune.js <rounds> <gamesPerEval> [depthJSON]
 *   node src/run/tune.js 30 6 '{"depth":1,"grid":14}'
 */
'use strict';
const { Worker } = require('worker_threads');
const os = require('os'), path = require('path'), fs = require('fs');
const E = require('../eval.js');

const ROUNDS = +(process.argv[2] || 30);
const NEVAL = +(process.argv[3] || 6);
const AGENT_OPTS = process.argv[4] ? JSON.parse(process.argv[4]) : { depth: 1, grid: 14 };
const GAME_OPTS = process.env.GAME_OPTS ? JSON.parse(process.env.GAME_OPTS) : {};
const NW = Math.min(os.cpus().length, 12);
const SEEDS = [];
for (let i = 0; i < NEVAL; i++) SEEDS.push(5000 + i * 7);   // 固定种子集
const OUT = path.join(__dirname, '..', '..', 'tune_results.jsonl');

function evalWeights(weights, cb) {
  let idx = 0, done = 0;
  const scores = [];
  const workers = [];
  for (let i = 0; i < Math.min(NW, SEEDS.length); i++) {
    const w = new Worker(path.join(__dirname, 'worker.js'));
    workers.push(w);
    w.on('message', (r) => {
      scores.push(r.score); done++;
      if (idx < SEEDS.length) w.postMessage({ id: idx, seed: SEEDS[idx++], agent: { type: 'search', opts: Object.assign({ weights }, AGENT_OPTS) }, opts: GAME_OPTS });
      else if (done === SEEDS.length) cb(scores);
    });
    w.on('error', (e) => { console.error('worker error', e); });
    w.postMessage({ id: idx, seed: SEEDS[idx++], agent: { type: 'search', opts: Object.assign({ weights }, AGENT_OPTS) }, opts: GAME_OPTS });
  }
  const cleanup = () => workers.forEach(w => w.terminate());
  const orig = cb;
  cb = (s) => { cleanup(); orig(s); };
}

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function perturb(w, scale) {
  const out = {};
  for (const k in w) {
    const f = Math.exp((Math.random() * 2 - 1) * scale);
    out[k] = w[k] * f;
  }
  return out;
}

let best = Object.assign({}, E.DEFAULT_W);
let round = 0;
const t0 = Date.now();

console.log(`tune: ${ROUNDS} rounds × ${NEVAL} games/eval, seeds=${SEEDS.join(',')}`);
console.log(`baseline weights: ${JSON.stringify(best)}`);

evalWeights(best, function (scores) {
  let bestScore = median(scores);
  console.log(`[init] median=${bestScore} scores=${scores.join(',')}`);
  fs.appendFileSync(OUT, JSON.stringify({ round: -1, median: bestScore, scores, weights: best }) + '\n');

  function nextRound() {
    if (round >= ROUNDS) {
      console.log(`\nDONE best median=${bestScore}`);
      console.log(`best weights: ${JSON.stringify(best)}`);
      console.log(`elapsed ${((Date.now() - t0) / 60000).toFixed(1)}min`);
      return;
    }
    const scale = 0.5 * Math.pow(0.95, round);          // 扰动幅度随轮次收缩
    const cand = perturb(best, scale);
    evalWeights(cand, (scores2) => {
      const m = median(scores2);
      const accept = m >= bestScore;
      if (accept) { bestScore = m; best = cand; }
      fs.appendFileSync(OUT, JSON.stringify({ round, median: m, accept, scores: scores2, weights: cand }) + '\n');
      console.log(`[${round}] median=${m} ${accept ? 'ACCEPT' : 'reject'} (best=${bestScore}) scores=${scores2.join(',')}`);
      round++;
      nextRound();
    });
  }
  nextRound();
});
