/* run/tune_cem.js —— 交叉熵方法（CEM）调评估权重。
 * 文献依据: Tetris 上 noisy-CE/CMA-ES 以两个数量级碾压价值拟合类方法
 * (Szita & Lőrincz 2006; Thiery & Scherrer; Boumaza)。
 *
 * 做法: 种群 P 个权重向量，以对数正态绕 mu 采样（保持各项符号），
 * 在固定种子集上跑局取中位分；top-K 精英的几何均值成为下一代 mu，
 * sigma 逐代收缩。候选×种子摊平成任务池喂 12 worker。
 *
 * 用法: node src/run/tune_cem.js [gens] [pop] [seedsPerEval] [agentOptsJSON]
 *   node src/run/tune_cem.js 12 10 6 '{"depth":1,"grid":14}'
 * GAME_OPTS='{"maxDrops":600}' 控制截断。
 */
'use strict';
const { Worker } = require('worker_threads');
const os = require('os'), path = require('path'), fs = require('fs');
const E = require('../eval.js');

const GENS = +(process.argv[2] || 12);
const POP = +(process.argv[3] || 10);
const NSEEDS = +(process.argv[4] || 6);
const AGENT_OPTS = process.argv[5] ? JSON.parse(process.argv[5]) : { depth: 1, grid: 14 };
const GAME_OPTS = process.env.GAME_OPTS ? JSON.parse(process.env.GAME_OPTS) : {};
const NW = Math.min(os.cpus().length, +(process.env.NW || 12));
const KEYS = Object.keys(E.DEFAULT_W);
const OUT = path.join(__dirname, '..', '..', 'tune_cem_results.jsonl');
/* SEEDS 环境变量显式给种子列表（混合难度集），否则回退 8000+i*13 */
const SEEDS = process.env.SEEDS
  ? process.env.SEEDS.split(',').map(Number)
  : (() => { const s = []; for (let i = 0; i < NSEEDS; i++) s.push(8000 + i * 13); return s; })();
/* REMOTE='host:N' 额外起 N 个 ssh 远端 worker（对端须已同步仓库） */
const REMOTES = process.env.REMOTE
  ? process.env.REMOTE.split(',').map(s => { const [h, n] = s.split(':'); return { host: h, n: +n || 1 }; })
  : [];
/* SEED_W='{json}' 在 gen0 种群注入一个外来候选（如上一轮的 cem_best） */
const SEED_W = process.env.SEED_W ? JSON.parse(process.env.SEED_W) : null;

/* ssh 远端 worker：包一层 child_process，鸭子类型对齐 Worker 的
   postMessage/on/terminate/'message'/'error'/'exit' 接口 */
function spawnRemote(host) {
  const cp = require('child_process').spawn('ssh',
    ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', host,
      'node ~/src/hecheng/src/run/remote_worker.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const handlers = { message: [], error: [], exit: [] };
  const w = {
    postMessage(m) { cp.stdin.write(JSON.stringify(m) + '\n'); },
    on(ev, fn) { (handlers[ev] || (handlers[ev] = [])).push(fn); return w; },
    terminate() { try { cp.kill('SIGTERM'); } catch (e) {} return Promise.resolve(); }
  };
  require('readline').createInterface({ input: cp.stdout })
    .on('line', l => handlers.message.forEach(f => f(JSON.parse(l))));
  cp.on('error', e => handlers.error.forEach(f => f(e)));
  cp.on('exit', c => handlers.exit.forEach(f => f(c)));
  return w;
}

const median = a => { const s = a.slice().sort((x, y) => x - y); return s[(s.length / 2) | 0]; };
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

/* 跑一整代: tasks = pop×seeds 摊平池化；worker 崩溃自动按同类型重派在飞任务 */
function evalGen(cands, cb) {
  const scores = cands.map(() => []);
  let idx = 0; const tasks = [];
  cands.forEach((c, ci) => SEEDS.forEach(sd => tasks.push({ ci, sd })));
  const launch = (w, t) => {
    t = t || (idx < tasks.length ? tasks[idx++] : null);
    if (!t) { w.__retire = true; w.terminate(); return; }
    w.__t = t; w.__inflight = true;
    w.postMessage({
      id: idx, seed: t.sd, opts: GAME_OPTS,
      agent: { type: 'search', opts: Object.assign({}, AGENT_OPTS, { weights: cands[t.ci] }) }
    });
  };
  const wire = (w, make) => {
    w.__make = make;
    w.on('message', r => { w.__inflight = false; scores[w.__t.ci].push(r.score); launch(w); });
    const respawn = e => {
      if (w.__retire || !w.__inflight) return;   // 正常退休或空闲退出不算崩溃
      console.error('worker died, requeue task', JSON.stringify(w.__t), e && e.message || '');
      launch(w.__make(), w.__t);
    };
    w.on('error', respawn);
    w.on('exit', c => { if (c !== 0) respawn(); });
    return w;
  };
  const spawnLocal = () => wire(new Worker(path.join(__dirname, 'worker.js')), spawnLocal);
  const spawners = [];
  for (let i = 0; i < NW; i++) spawners.push(spawnLocal);
  REMOTES.forEach(({ host, n }) => {
    for (let i = 0; i < n; i++) {
      const make = () => wire(spawnRemote(host), make);
      spawners.push(make);
    }
  });
  spawners.forEach(make => launch(make()));
  const check = setInterval(() => {
    if (scores.every(s => s.length === SEEDS.length)) { clearInterval(check); cb(scores.map(median)); }
  }, 500);
}

let mu = Object.assign({}, E.DEFAULT_W);
let sigma = 0.6;
const t0 = Date.now();
const NWORKERS = NW + REMOTES.reduce((s, r) => s + r.n, 0);
console.log(`CEM: ${GENS} gens × pop ${POP} × ${SEEDS.length} seeds [${SEEDS}], ` +
  `workers=${NWORKERS} (local ${NW}${REMOTES.length ? ' + ' + REMOTES.map(r => `${r.host}:${r.n}`).join(',') : ''}), ` +
  `agent=${JSON.stringify(AGENT_OPTS)}`);

/* 先评基线 */
evalGen([mu], ([m0]) => {
  let gen = 0, bestScore = m0, bestW = Object.assign({}, mu);
  console.log(`[base] median=${m0}`);
  fs.appendFileSync(OUT, JSON.stringify({ gen: -1, median: m0, weights: mu }) + '\n');

  function next() {
    if (gen >= GENS) {
      console.log(`DONE best median=${bestScore}\nbest=${JSON.stringify(bestW)}\nelapsed=${((Date.now() - t0) / 60000) | 0}min`);
      return;
    }
    const cands = [bestW];   // 精英保底: 每代必含当前最优
    if (gen === 0 && SEED_W) cands.push(Object.assign({}, SEED_W));  // 外来种子候选
    while (cands.length < POP) {
      const c = {};
      for (const k of KEYS) c[k] = mu[k] * Math.exp(sigma * randn());
      cands.push(c);
    }
    evalGen(cands, meds => {
      const order = meds.map((m, i) => [m, i]).sort((a, b) => b[0] - a[0]);
      const elites = order.slice(0, Math.max(1, POP >> 2)).map(([, i]) => cands[i]);
      for (const k of KEYS)
        mu[k] = Math.exp(elites.reduce((s, c) => s + Math.log(Math.abs(c[k]) || 1e-9), 0) / elites.length) * Math.sign(mu[k]);
      if (meds[order[0][1]] > bestScore) { bestScore = meds[order[0][1]]; bestW = cands[order[0][1]]; }
      console.log(`[${gen}] best=${meds[order[0][1]]} muMed=${meds[order[(order.length / 2) | 0][1]]} runningBest=${bestScore} sigma=${sigma.toFixed(2)} (${((Date.now() - t0) / 60000).toFixed(0)}min)`);
      fs.appendFileSync(OUT, JSON.stringify({ gen, meds, order: order.map(o => o[1]), bestScore }) + '\n');
      sigma *= 0.92; gen++; next();
    });
  }
  next();
});
