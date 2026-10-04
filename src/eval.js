/* eval.js —— afterstate 评估：对「投放并沉降之后」的棋盘打分。
 * 特征基于球集合的几何关系，权重可调（tune.js 随机搜索）。
 * 双端共用：Node 里 require，页面里是 SuikaEval。
 */
(function (root, factory) {
  const core = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : root.SuikaCore;
  const api = factory(core);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuikaEval = api;
})(typeof self !== 'undefined' ? self : globalThis, function (C) {
  'use strict';

  const FLOOR = C.H - C.WALL, DANGER = C.DANGER_Y, SOFT = DANGER + 40;

  const DEFAULT_W = {
    score: 1.0,      // roll 内得分（合成 + 引爆）
    topSafe: -2.0,   // 堆顶接近/越过软警戒带的线性罚
    overTime: -4.0,  // 警戒线上方攒得最久的判负计时
    aboveArea: -3.0, // 警戒线上方的水果面积占比
    sameAdj: 3.0,    // 同级球贴身对数（合成潜力）
    orderX: 1.5,     // x 方向大小单调性（任一方向）
    smallUnder: -2.0,// 小球托大球
    bump: -0.8,      // 列剖面起伏
    maxPair: 6.0,    // 双神奶蛙相邻（引爆蓄能）
    nMax: 1.5,       // 场上神奶蛙数
    mergeDist: 2.0,  // 最近同级间距越近越好
    /* ---- v2 特征：条件化（评估时点 pending 已轮换为已知的前 next）+ 结构 ---- */
    pendTgt: 2.0,    // 场上与 pending 同级的球数（下一步合成靶子）
    pendAdj: 3.0,    // 同级球中与 pending 同级的贴身对数（落地即合概率）
    nextTgt: 1.0,    // 场上与 next 同级的球数（两步视角）
    massTotal: 0.3,  // 全场 tier 总和（堆的投资规模）
    cave: -2.0,      // 剖面凹陷（两侧高中间低的口袋，困小球位）
    freeTop: 1.5,    // 软线以下连续可用着陆带宽度
    nAboveSoft: -1.5 // 顶部越过软警戒带的球数
  };

  function features(S, scoreBefore) {
    const balls = S.balls.filter(b => !b.dead);
    let top = FLOOR, maxOT = 0, aboveArea = 0;
    for (const b of balls) {
      const t = b.y - b.r;
      if (t < top) top = t;
      if (t < DANGER) {
        aboveArea += Math.PI * b.r * b.r;
        if (b.overTime > maxOT) maxOT = b.overTime;
      }
    }

    let sameAdj = 0, bestGap = Infinity, nMax = 0, maxPair = 0;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.tier === 10) nMax++;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (a.tier !== b.tier) continue;
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r);
        if (gap < bestGap) bestGap = gap;
        if (gap < (a.r + b.r) * 0.15 + 6) {
          sameAdj++;
          if (a.tier === 10) maxPair = 1;
        }
      }
    }

    const sx = balls.slice().sort((a, b) => a.x - b.x);
    let inv = 0, tot = 0;
    for (let i = 0; i < sx.length; i++) for (let j = i + 1; j < sx.length; j++) {
      tot++;
      if (sx[i].tier > sx[j].tier) inv++;
    }
    const orderX = tot ? Math.abs(0.5 - inv / tot) * 2 : 0;

    let smallUnder = 0;
    for (const a of balls) for (const b of balls) {
      if (a !== b && a.tier < b.tier && a.y > b.y + 10 &&
          Math.abs(a.x - b.x) < (a.r + b.r) * 0.55)
        smallUnder += (b.tier - a.tier) / 10;
    }

    const NC = 21, prof = new Array(NC).fill(FLOOR);
    for (const b of balls) {
      const l = Math.max(0, Math.floor((b.x - b.r) / C.W * NC));
      const rgt = Math.min(NC - 1, Math.floor((b.x + b.r) / C.W * NC));
      for (let c = l; c <= rgt; c++) prof[c] = Math.min(prof[c], b.y - b.r);
    }
    let bump = 0;
    for (let i = 1; i < NC; i++)
      if (prof[i] < FLOOR && prof[i - 1] < FLOOR) bump += Math.abs(prof[i] - prof[i - 1]);
    bump /= C.H;

    /* v2: 条件特征——评估时点 S.pending 已轮换为已知的前 next，
       因此"pending 在场上有几个同级靶子/有没有贴好的同级对"是可用的下一步合成潜力 */
    let pendTgt = 0, pendAdj = 0, nextTgt = 0, massTotal = 0, nAboveSoft = 0;
    for (const b of balls) {
      massTotal += b.tier + 1;
      if (b.tier === S.pending) pendTgt++;
      if (b.tier === S.next) nextTgt++;
      if (b.y - b.r < SOFT) nAboveSoft++;
    }
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.tier !== S.pending) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.tier !== S.pending) continue;
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r);
        if (gap < (a.r + b.r) * 0.15 + 6) pendAdj++;
      }
    }

    /* 剖面凹陷（口袋）与可用着陆带 */
    let cave = 0, freeTop = 0, run = 0;
    for (let i = 1; i < NC - 1; i++) {
      if (prof[i] >= FLOOR || prof[i - 1] >= FLOOR || prof[i + 1] >= FLOOR) continue;
      const pk = Math.min(prof[i - 1], prof[i + 1]) - prof[i];
      if (pk > 0) cave += pk / C.H;
    }
    for (let i = 0; i < NC; i++) {
      if (prof[i] > SOFT) { run++; if (run > freeTop) freeTop = run; }
      else run = 0;
    }
    freeTop /= NC;

    return {
      score: S.score - scoreBefore,
      topSafe: Math.max(0, SOFT - top) / SOFT,
      overTime: maxOT,
      aboveArea: aboveArea / (C.W * DANGER),
      sameAdj, orderX, smallUnder, bump, maxPair, nMax,
      mergeDist: isFinite(bestGap) ? Math.max(0, 1 - bestGap / 150) : 0,
      pendTgt, pendAdj, nextTgt, massTotal: massTotal / 60,
      cave, freeTop, nAboveSoft
    };
  }

  function evaluate(env, scoreBefore, w) {
    w = w || DEFAULT_W;
    if (env.S.over && env.S.revives <= 0) return -1e6;
    const f = features(env.S, scoreBefore);
    /* 分段线性: w={two:1, gate:"massTotal", thr:0.5, early:{...}, late:{...}}
       用某特征值门控选权重——E4 显示早晚期最优权重方向会变 */
    if (w.two) w = (f[w.gate] < w.thr) ? w.early : w.late;
    let v = 0;
    for (const k in w) {
      if (k === 'two' || k === 'gate' || k === 'thr' || k === 'early' || k === 'late') continue;
      v += w[k] * f[k];
    }
    return v;
  }

  return { DEFAULT_W, features, evaluate };
});
