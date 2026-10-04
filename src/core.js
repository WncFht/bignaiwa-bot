/* core.js —— 直接操作游戏状态 G/S 的底层工具。
 * 同一份代码在 Node 的 vm 环境和真实页面里都可用：
 *   Node 侧：env.js 装载 vendor/game.js 后把 {G,S,clock} 传进来
 *   页面侧：注入脚本直接传 __DNW__ 暴露的 {G,S}（clock 由页面自身驱动）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SuikaCore = api; }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const W = 420, H = 700, WALL = 10, DANGER_Y = 142, DROP_Y = 74;
  const R = [17, 23, 31, 39, 48, 58, 69, 81, 94, 108, 124];

  function aimRange(G, tier) {
    const r = R[tier] * G.shapeOf(tier).rb;
    return [WALL + r + 0.5, W - WALL - r - 0.5];
  }

  /* ---- 快照 / 恢复 ----
   * 覆盖模拟会触碰的一切：球列表、计分、队列、冷却、判负、复活、特效队列。
   * wx/wy/ws 是 syncParts 每子步从 (x,y,angle) 重算的派生态，不拷。
   * RNG 位由调用方负责（env 层管）。 */
  function snapshot(S) {
    return {
      balls: S.balls.map(b => Object.assign({}, b)),
      score: S.score, best: S.best, pending: S.pending, next: S.next,
      ready: S.ready, cooldown: S.cooldown, aimX: S.aimX,
      over: S.over, revives: S.revives, reviveGiven: S.reviveGiven,
      freeze: S.freeze, flash: S.flash, danger: S.danger,
      floats: S.floats.slice(), particles: S.particles.slice()
    };
  }
  function restore(S, s) {
    S.balls = s.balls.map(b => Object.assign({}, b));
    S.score = s.score; S.best = s.best; S.pending = s.pending; S.next = s.next;
    S.ready = s.ready; S.cooldown = s.cooldown; S.aimX = s.aimX;
    S.over = s.over; S.revives = s.revives; S.reviveGiven = s.reviveGiven;
    S.freeze = s.freeze; S.flash = s.flash; S.danger = s.danger;
    S.floats = s.floats.slice(); S.particles = s.particles.slice();
  }

  /* ---- 模拟推进 ----
   * env.clock 存在时用 env 的假时钟（Node），否则页面自己的 rAF 会推时间，
   * 这里只负责 update(dt) —— 两种情况对 stepPhysics 都是确定性的。 */
  function frame(env, dt) {
    if (env.clock) env.clock.tick(dt);
    env.G.update(dt === undefined ? 1 / 60 : dt);
  }

  /* 沉降：跑到所有球速度低于阈值且持续 calmFrames 帧，或超时/判负。 */
  function settle(env, opts) {
    const maxFrames = (opts && opts.maxFrames) || 150;
    const calmFrames = (opts && opts.calmFrames) || 10;
    const calmSpeed = (opts && opts.calmSpeed) || 55;
    const onFrame = opts && opts.onFrame;
    let calm = 0;
    for (let f = 0; f < maxFrames; f++) {
      frame(env);
      if (onFrame) onFrame(env.S);
      if (env.S.over) return f;
      let mv = 0;
      for (const b of env.S.balls) {
        const v = Math.hypot(b.vx, b.vy);
        if (v > mv) mv = v;
      }
      if (mv < calmSpeed) { if (++calm >= calmFrames) return f; }
      else calm = 0;
    }
    return maxFrames;
  }

  /* 等冷却结束再按 x 投放（模拟内可用；真实页面由注入层控节奏） */
  function dropNow(env, x) {
    const S = env.S;
    if (S.over) return false;
    let guard = 0;
    while (!S.ready && guard++ < 120) frame(env);
    S.aimX = x;
    env.G.tryDrop();
    return true;
  }

  /* 一次决策模拟：投放 + 沉降；越线有币自动复活（与真实策略一致） */
  function simDrop(env, x, opts) {
    dropNow(env, x);
    settle(env, opts);
    if (env.S.over && env.S.revives > 0) {
      env.G.revive();
      settle(env, opts);
    }
  }

  /* 只读观测 */
  function obs(env) {
    const S = env.S;
    let top = Infinity;
    const balls = [];
    for (const b of S.balls) {
      if (b.dead) continue;
      balls.push(b);
      const t = b.y - b.r;
      if (t < top) top = t;
    }
    return {
      balls, pending: S.pending, next: S.next, score: S.score,
      revives: S.revives, ready: S.ready, over: S.over,
      topEdge: top, nBalls: balls.length
    };
  }

  return { W, H, WALL, DANGER_Y, DROP_Y, R, aimRange, snapshot, restore, frame, settle, dropNow, simDrop, obs };
});
