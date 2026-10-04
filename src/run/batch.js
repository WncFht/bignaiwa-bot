/* run/batch.js —— 批量并行跑局。
 * 用法: node src/run/batch.js <agent> <games> [optsJSON]
 *   node src/run/batch.js search 24 '{"depth":1,"grid":20}'
 *   node src/run/batch.js match 12
 * 12 核 worker 池，每局一个种子（可复现）。
 */
'use strict';
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const AGENT = process.argv[2] || 'search';
const GAMES = +(process.argv[3] || 12);
const AGENT_OPTS = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const GAME_OPTS = process.env.GAME_OPTS ? JSON.parse(process.env.GAME_OPTS) : {};
const NW = Math.min(os.cpus().length, 12);
const SEED0 = +(process.env.SEED0 || 1000);

function median(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function pct(a, p) { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

const tasks = [];
for (let i = 0; i < GAMES; i++)
  tasks.push({ id: i, seed: SEED0 + i, agent: { type: AGENT, opts: AGENT_OPTS }, opts: GAME_OPTS });

const results = [];
let idx = 0, done = 0;
const t0 = Date.now();

function pump(w) {
  if (idx >= tasks.length) { w.terminate(); return; }
  w.postMessage(tasks[idx++]);
}

for (let i = 0; i < NW; i++) {
  const w = new Worker(path.join(__dirname, 'worker.js'));
  w.on('message', (r) => {
    results.push(r); done++;
    process.stdout.write(
      `[${done}/${tasks.length}] seed=${r.seed} score=${r.score} drops=${r.drops}` +
      ` t10=${r.merges10} boom=${r.explosions} revUsed=${r.revivesUsed}\n`);
    pump(w);
  });
  w.on('error', (e) => { console.error('worker error', e); pump(w); });
  pump(w);
}

process.on('beforeExit', () => {
  if (!results.length) return;
  const sc = results.map(r => r.score);
  console.log(`\n=== ${AGENT} ${JSON.stringify(AGENT_OPTS)} ===`);
  console.log(`games=${results.length} median=${median(sc)} mean=${(sc.reduce((a, b) => a + b, 0) / sc.length).toFixed(0)} ` +
    `p25=${pct(sc, .25)} p75=${pct(sc, .75)} max=${Math.max(...sc)} min=${Math.min(...sc)}`);
  console.log(`total t10=${results.reduce((a, r) => a + r.merges10, 0)} booms=${results.reduce((a, r) => a + r.explosions, 0)} ` +
    `elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
});
