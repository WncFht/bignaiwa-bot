/* run/game.js —— 打完整局游戏的驱动循环（Node/worker 共用）。
 * agent 只管 decide(env)→x；这里负责节奏：等冷却、投放、沉降、自动复活。
 */
'use strict';
const C = require('../core.js');

function playGame(env, agent, opts) {
  opts = opts || {};
  const maxDrops = opts.maxDrops || 3000;
  let drops = 0, merges10 = 0, explosions = 0;
  let prevFlash = 0;
  const traj = opts.probeEvery ? [] : null;   // {d,score,rv,ex,m10} 每 probeEvery 投

  while (drops < maxDrops) {
    if (env.S.over) {
      if (env.S.revives > 0) { env.G.revive(); C.settle(env, { maxFrames: 60 }); }
      else break;
    }
    if (!env.S.ready) { C.frame(env); continue; }

    const x = agent.decide(env);
    C.dropNow(env, x);
    drops++;
    const sim = Object.assign({}, opts.sim, {
      /* flash=1 是合成神奶蛙，flash=1.4 是双瓜引爆，只有 0.45 秒窗口，逐帧采 */
      onFrame(S) {
        if (S.flash > 1.3 && S.flash > prevFlash) { explosions++; prevFlash = S.flash; }
        else if (S.flash >= 0.99 && S.flash > prevFlash) { merges10++; prevFlash = S.flash; }
        if (S.flash < prevFlash) prevFlash = S.flash;
      }
    });
    C.settle(env, sim);
    if (traj && (drops % opts.probeEvery === 0 || env.S.over)) {
      const S = env.S;
      const FLOOR = C.H - C.WALL;
      let top = FLOOR, ot = 0;
      for (const b of S.balls) {
        if (b.dead) continue;
        if (b.y - b.r < top) top = b.y - b.r;
        if (b.overTime > ot) ot = b.overTime;
      }
      traj.push({
        d: drops, score: S.score, rv: S.revives,
        rvUsed: S.reviveGiven - S.revives,
        ex: explosions, m10: merges10,
        top: Math.round(top), ot: +ot.toFixed(2)
      });
    }
  }

  const r = {
    score: env.S.score, drops,
    merges10, explosions, revivesUsed: env.S.reviveGiven - env.S.revives,
    over: env.S.over, submits: env.submits.slice()
  };
  if (traj) r.traj = traj;
  return r;
}

module.exports = { playGame };
