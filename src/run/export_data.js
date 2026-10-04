/* run/export_data.js —— 数据导出驱动：worker 池打局，JSONL 落盘。
 * 数据契约见 docs/api.md：每行一次决策 {s,d,o:{b,p,n,s,rv},x,ret}。
 * 用法: node src/run/export_data.js <games> <outfile> [agentOptsJSON]
 */
'use strict';
const { Worker } = require('worker_threads');
const os = require('os'), path = require('path'), fs = require('fs');

const GAMES = +(process.argv[2] || 100);
const OUTF = process.argv[3] || 'data/rollouts.jsonl';
const AGENT_OPTS = process.argv[4] ? JSON.parse(process.argv[4]) : { depth: 1, grid: 16 };
const GAME_OPTS = process.env.GAME_OPTS ? JSON.parse(process.env.GAME_OPTS) : {};
const NW = Math.min(os.cpus().length, +(process.env.NW || 12));

fs.mkdirSync(path.dirname(path.resolve(OUTF)), { recursive: true });
const out = fs.createWriteStream(OUTF);

const tasks = [];
for (let i = 0; i < GAMES; i++) tasks.push({ seed: 20000 + i, opts: GAME_OPTS });
let idx = 0, done = 0, lines = 0;

function pump(w) {
  if (idx >= tasks.length) { w.terminate(); return; }
  w.postMessage(tasks[idx++]);
}

for (let i = 0; i < NW; i++) {
  const w = new Worker(path.join(__dirname, 'worker_data.js'), { workerData: { opts: AGENT_OPTS } });
  w.on('message', (m) => {
    if (m === null) {
      done++;
      console.log(`[${done}/${GAMES}] games done, ${lines} records`);
      pump(w);
      if (done === GAMES) out.end();
      return;
    }
    lines++;
    out.write(m);
  });
  w.on('error', e => console.error('worker error', e));
  pump(w);
}
