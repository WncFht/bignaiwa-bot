/* agents/simple.js —— 基线 agent：随机 / 同级匹配启发式 / 大小排序位。
 * 接口与 search 一致：create(opts).decide(env) → x
 */
(function (root, factory) {
  const api = factory(
    (typeof module !== 'undefined' && module.exports) ? require('../core.js') : root.SuikaCore
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuikaSimple = api;
})(typeof self !== 'undefined' ? self : globalThis, function (C) {
  'use strict';

  function rand(env) {
    const [lo, hi] = C.aimRange(env.G, env.S.pending);
    return { decide: (e) => lo + e.rng() * (hi - lo), name: 'random' };
  }

  /* 投同级：场上找同级球往它上面投；没有则按「大左小右」摆位 */
  function match(env) {
    return {
      name: 'match',
      decide(e) {
        const S = e.S;
        const [lo, hi] = C.aimRange(e.G, S.pending);
        let target = null;
        for (const b of S.balls) {
          if (!b.dead && b.tier === S.pending) { target = b.x; break; }
        }
        if (target === null)
          for (const b of S.balls) {
            if (!b.dead && b.tier === S.next) { target = b.x; break; }
          }
        if (target === null)
          target = lo + (1 - S.pending / 10) * (hi - lo) * 0.9 + (hi - lo) * 0.05;
        return Math.min(hi, Math.max(lo, target));
      }
    };
  }

  /* 大小排序：按 tier 线性摆位，大水果靠左 */
  function sorted(env) {
    return {
      name: 'sorted',
      decide(e) {
        const [lo, hi] = C.aimRange(e.G, e.S.pending);
        return lo + (1 - e.S.pending / 10) * (hi - lo) * 0.9 + (hi - lo) * 0.05;
      }
    };
  }

  return { rand, match, sorted };
});
