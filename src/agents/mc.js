/* agents/mc.js —— 蒙特卡洛评估 agent（Leiden 论文的最强路线复刻）。
 * 每个候选 x：模拟投放 → 然后 K 条随机 rollout（随机 x 续投 D 步或到死），
 * 价值 = rollout 平均终分。无特征、无权重——用真实回报估计当裁判。
 * 在线太慢（~10-30s/决策），主要作离线 oracle：给其他评估函数打真值标签、
 * 或审计"线性 V 离无偏评估差多远"。
 */
(function (root, factory) {
  const api = factory(
    (typeof module !== 'undefined' && module.exports) ? require('../core.js') : root.SuikaCore);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuikaMC = api;
})(typeof self !== 'undefined' ? self : globalThis, function (C) {
  'use strict';
  const Search = (typeof module !== 'undefined' && module.exports)
    ? require('./search.js') : root.SuikaSearch;

  const DEFAULTS = { grid: 10, k: 4, rollDrops: 25, sim: { maxFrames: 90, calmFrames: 8, calmSpeed: 55 } };

  function createMC(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    o.sim = Object.assign({}, DEFAULTS.sim, (opts || {}).sim);

    function randomDrop(env) {
      const [lo, hi] = C.aimRange(env.G, env.S.pending);
      const x = lo + Math.random() * (hi - lo);
      if (env.S.over) return;
      C.simDrop(env, x, o.sim);
    }

    function mcValue(env) {
      /* 当前 S 已是候选沉降后的 afterstate；从这里 K 条随机 rollout。
         snapshot 会回滚 rng，故每条 rollout 重新播种保证抽签序列去相关 */
      const snap = env.snapshot();
      let tot = 0;
      for (let i = 0; i < o.k; i++) {
        env.restore(snap);
        if (env.rng) env.rng.setState((snap.rng ^ (i * 2654435761)) >>> 0);
        let d = 0;
        while (d++ < o.rollDrops) {
          if (env.S.over) {
            if (env.S.revives > 0) { env.G.revive(); C.settle(env, { maxFrames: 60 }); continue; }
            break;
          }
          if (!env.S.ready) { C.frame(env); continue; }
          randomDrop(env);
        }
        tot += env.S.score;
      }
      env.restore(snap);
      return tot / o.k;
    }

    function decide(env) {
      const snap0 = env.snapshot();
      const xs = Search.candidates(env, o.grid, [0]);
      let bestX = xs[0], bestV = -Infinity;
      for (const x of xs) {
        env.restore(snap0);
        C.simDrop(env, x, o.sim);
        const v = mcValue(env);
        if (v > bestV) { bestV = v; bestX = x; }
      }
      env.restore(snap0);
      return bestX;
    }
    return { decide, mcValue, name: 'mc', opts: o };
  }
  return { createMC };
});
