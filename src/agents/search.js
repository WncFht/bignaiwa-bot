/* agents/search.js —— rollout 搜索 agent。
 * 决策流程：枚举候选 x → 各自快照/投放/沉降 → 评估 afterstate → 取最优。
 * depth=2 时对第一层前 topM 个候选，续投已知的 next 水果再评估。
 * 依赖注入：core（快照/模拟）与 evalFn（评估函数）都由工厂参数给，
 * 同一份代码可在 Node env 和页面 __DNW__ 上运行。
 */
(function (root, factory) {
  const api = factory(
    (typeof module !== 'undefined' && module.exports) ? require('../core.js') : root.SuikaCore,
    (typeof module !== 'undefined' && module.exports) ? require('../eval.js') : root.SuikaEval
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuikaSearch = api;
})(typeof self !== 'undefined' ? self : globalThis, function (C, E) {
  'use strict';

  const DEFAULTS = {
    grid: 16,            // 均布候选数
    sameOffsets: [-0.55, 0, 0.55],  // 同级球位两侧的偏移（按球径比例）
    dedupe: 4,           // 候选去重最小间距 px
    depth: 1,            // 1 或 2
    topM: 4,             // depth2 时续搜的第一层候选数
    grid2: 10,           // depth2 第二层均布候选数
    dyn: null,           // 动态加深: {topPx, ot} 满足任一 → 本步按 depth2 搜
    sim: { maxFrames: 110, calmFrames: 9, calmSpeed: 55 }
  };

  function candidates(env, grid, offs, dedupe) {
    const S = env.S, tier = S.pending;
    const [lo, hi] = C.aimRange(env.G, tier);
    const xs = [];
    for (let i = 0; i < grid; i++) xs.push(lo + (i + 0.5) * (hi - lo) / grid);
    /* 同级球位：贴上去求合成，左右各探一点 */
    const r = C.R[tier];
    for (const b of S.balls) {
      if (b.dead || b.tier !== tier) continue;
      for (const o of offs) xs.push(b.x + o * (r + b.r));
    }
    xs.sort((a, b) => a - b);
    const out = [], dd = dedupe == null ? 4 : dedupe;
    for (const x of xs) {
      const cx = Math.min(hi, Math.max(lo, x));
      if (!out.length || cx - out[out.length - 1] > dd) out.push(cx);
    }
    return out;
  }

  function createSearch(opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    o.sim = Object.assign({}, DEFAULTS.sim, (opts || {}).sim);
    const evalFn = o.evalFn || E.evaluate;
    const weights = o.weights;

    function decide(env) {
      const S = env.S;
      const snap = env.snapshot();
      const score0 = S.score;
      const xs = candidates(env, o.grid, o.sameOffsets, o.dedupe);
      let bestX = xs[Math.floor(xs.length / 2)], bestV = -Infinity;
      const layer1 = [];

      for (const x of xs) {
        env.restore(snap);
        C.simDrop(env, x, o.sim);
        const v = evalFn(env, score0, weights);
        layer1.push({ x, v });
        if (v > bestV) { bestV = v; bestX = x; }
      }

      /* 动态加深：决策前盘面已危险（顶压线/判负计时累积）才花 4× 代价搜第二层。
         门控用决策前状态而非 afterstate——危险来了才加深，安全期不浪费算力。 */
      let depthNow = o.depth;
      if (depthNow !== 2 && o.dyn) {
        let top = Infinity, maxOT = 0;
        for (const b of S.balls) {
          if (b.dead) continue;
          const t = b.y - b.r;
          if (t < top) top = t;
          if (b.overTime > maxOT) maxOT = b.overTime;
        }
        if ((o.dyn.topPx && top < o.dyn.topPx) || (o.dyn.ot && maxOT > o.dyn.ot)) depthNow = 2;
      }

      if (depthNow === 2) {
        layer1.sort((a, b) => b.v - a.v);
        const tops = layer1.slice(0, o.topM);
        let best2 = -Infinity;
        for (const c of tops) {
          /* 回到决策前快照，重放 x1，再对已知 next 搜 x2 */
          env.restore(snap);
          C.simDrop(env, c.x, o.sim);
          const after1 = env.snapshot();
          const xs2 = candidates(env, o.grid2, [0], o.dedupe);
          let v2best = -Infinity;
          for (const x2 of xs2) {
            env.restore(after1);
            C.simDrop(env, x2, o.sim);
            const v2 = evalFn(env, score0, weights);
            if (v2 > v2best) v2best = v2;
          }
          if (v2best > best2) { best2 = v2best; bestX = c.x; }
        }
      }

      env.restore(snap);
      return bestX;
    }
    return { decide, name: 'search', opts: o };
  }

  return { createSearch, candidates };
});
