/* run/worker_data.js —— 数据导出 worker：打一整局，逐决策回报 JSON 行。 */
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { createEnv } = require('../env.js');
const C = require('../core.js');
const E = require('../eval.js');
const Search = require('../agents/search.js');
const { playGame } = require('./game.js');

const env = createEnv(1);
env.core = C;
const agent = Search.createSearch(workerData.opts || {});

function dumpObs(S) {
  return {
    b: S.balls.filter(b => !b.dead).map(b =>
      [+b.x.toFixed(1), +b.y.toFixed(1), +b.vx.toFixed(1), +b.vy.toFixed(1), b.tier, +b.angle.toFixed(2), +b.overTime.toFixed(2)]),
    p: S.pending, n: S.next, s: S.score, rv: S.revives
  };
}

parentPort.on('message', (task) => {
  env.reset(task.seed);
  const recs = [];
  /* 手动复制 playGame 主循环以便在每步记录观测 */
  let drops = 0;
  const maxDrops = (task.opts && task.opts.maxDrops) || 3000;
  while (drops < maxDrops) {
    if (env.S.over) {
      if (env.S.revives > 0) { env.G.revive(); C.settle(env, { maxFrames: 60 }); }
      else break;
    }
    if (!env.S.ready) { C.frame(env); continue; }
    const obs = dumpObs(env.S);
    const f = E.features(env.S, env.S.score);
    const x = agent.decide(env);
    recs.push({ s: task.seed, d: drops, o: obs, f, x: +x.toFixed(2) });
    C.dropNow(env, x);
    drops++;
    C.settle(env, { maxFrames: 110, calmFrames: 9, calmSpeed: 55 });
  }
  const final = env.S.score;
  for (const r of recs) {
    r.ret = final - r.o.s;          // 该决策后的剩余得分（含本步）
    parentPort.postMessage(JSON.stringify(r) + '\n');
  }
  parentPort.postMessage(null);     // 本局结束
});
