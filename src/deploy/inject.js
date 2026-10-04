/* deploy/inject.js —— 页面内 bot 入口。
 * 拼接在 core.js / eval.js / agents/search.js 之后（dist/bot.js），
 * 依赖全局 SuikaCore / SuikaEval / SuikaSearch 与游戏暴露的 __DNW__。
 * 页面物理即模型：决策时对真实状态快照 → 候选投放模拟 → 恢复 → 投最优。
 *
 * 选项（注入前设 window.HECHENG_OPTS 覆盖）：
 *   SUBMIT:   结算是否真交排行榜（默认 false——真打但不上榜）
 *   SEARCH:   createSearch 的参数（grid/depth/…）
 *   MAXGAMES: 打几局后停（默认 Infinity）
 */
(function () {
  'use strict';
  const OPTS = Object.assign({ SUBMIT: false, SEARCH: {}, MAXGAMES: Infinity },
    window.HECHENG_OPTS || {});
  const C = window.SuikaCore, E = window.SuikaEval, Search = window.SuikaSearch;
  const G = window.__DNW__, S = G.state;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 页面侧 env 适配层：G,S 就是真实游戏；快照不含 RNG（Math.random 不可存，
     反正抽签本来就随机——rollout 消耗它对对局无影响） */
  const env = {
    G, S,
    snapshot() { return C.snapshot(S); },
    restore(s) { C.restore(S, s); }
  };
  /* depth2 常开：决策时 rAF 冻结不占对局时间（E10/E12 结论） */
  const agent = Search.createSearch(Object.assign({ grid: 16, depth: 2 }, OPTS.SEARCH));

  /* ---- 模拟副作用屏蔽 ----
   * sim 里越线会调 gameOver()→settle()→DanaiwaBoard.onGameOver()（假提交）
   * 与 DOM 弹窗；addScore 可能写 localStorage 最高分（把 S.best 抬到无穷就绕开）。
   * decide() 是同步的：包一层进出处理。 */
  const overlayEl = $('overlay'), revivePromptEl = $('revivePrompt');
  const realBoard = window.DanaiwaBoard;
  function simGuardOn() {
    window.DanaiwaBoard = { onGameOver() {} };
    S.__bestSave = S.best; S.best = 1e15;
  }
  function simGuardOff() {
    window.DanaiwaBoard = realBoard;
    S.best = S.__bestSave;
    overlayEl && overlayEl.classList.remove('show');
    if (revivePromptEl) revivePromptEl.hidden = true;
  }

  /* 静音：页面没暴露 Sound，直接点一次音效按钮 */
  function ensureMuted() {
    const btn = $('soundBtn');
    if (btn && btn.querySelector('.lbl') && btn.querySelector('.lbl').textContent === '音效开') btn.click();
  }

  async function waitCalm(maxMs) {
    const t0 = performance.now();
    let calm = 0;
    while (performance.now() - t0 < (maxMs || 4000)) {
      let mv = 0;
      for (const b of S.balls) { const v = Math.hypot(b.vx, b.vy); if (v > mv) mv = v; }
      if (mv < 55) { if (++calm >= 3) return; } else calm = 0;
      await sleep(60);
    }
  }

  async function playOne() {
    /* 思考徽章：decide() 是同步的，depth2 下单次十几秒，rAF/绘制全冻结——
       看起来就是"页面卡死"。先写好徽章 → rAF 让它画出来 → 再进 decide。 */
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;left:10px;top:10px;z-index:99999;' +
      'background:rgba(30,30,40,.88);color:#ffd76e;padding:5px 10px;' +
      'border-radius:8px;font:13px/1.4 sans-serif;pointer-events:none';
    document.body.appendChild(badge);
    let drops = 0, tDec = 0;
    while (true) {
      if (S.over) {
        if (S.revives > 0) { G.revive(); await waitCalm(1500); continue; }
        badge.remove();
        return;                                  // 结算（是否上榜由 SUBMIT 决定）
      }
      if (!S.ready) { await sleep(50); continue; }
      const pend = S.pending, next = S.next, score0 = S.score;
      badge.textContent = `思考中… 第${drops + 1}投 (上次 ${tDec}s)`;
      await new Promise(r => requestAnimationFrame(r));   // 让徽章先画出来
      const t0 = Date.now();
      simGuardOn();
      let x;
      try { x = agent.decide(env); } finally { simGuardOff(); }
      tDec = ((Date.now() - t0) / 1000).toFixed(1);
      drops++;
      S.aimX = x;
      G.tryDrop();
      badge.textContent = `第${drops}投 x=${x.toFixed(0)} 思考${tDec}s 分${S.score}`;
      /* 逐步决策日志：Playwright 侧定期取走（splice 抽干），供复盘/分享 */
      const log = window.__HECHENG_LOG = window.__HECHENG_LOG || [];
      let top = 1e9;
      for (const b of S.balls) if (!b.dead && b.y - b.r < top) top = b.y - b.r;
      log.push({ i: log.length, pend, next, x: +x.toFixed(1), score: score0,
        balls: S.balls.length, top: top === 1e9 ? null : +top.toFixed(0), rv: S.revives });
      await waitCalm();
    }
  }

  async function main() {
    ensureMuted();
    if (!OPTS.SUBMIT) window.DanaiwaBoard = { onGameOver() {} };   // 真打也不交
    let n = 0;
    while (n++ < OPTS.MAXGAMES) {
      await playOne();
      console.log('[hecheng] game over, score =', S.score);
      (window.__HECHENG_LOG = window.__HECHENG_LOG || []).push({ end: true, score: S.score });
      await sleep(1500);
      /* 「再来一局」等价于 reset —— 直接调 R 键路径 */
      const e = new KeyboardEvent('keydown', { code: 'KeyR' });
      window.dispatchEvent(e);
      await sleep(400);
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => setTimeout(main, 800));
  else setTimeout(main, 800);
})();
