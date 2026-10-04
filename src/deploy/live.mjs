/* deploy/live.mjs —— Playwright 驱动真实页面跑分。
 * 用法:
 *   node src/deploy/bundle.mjs            # 先拼 dist/bot.js
 *   node src/deploy/live.mjs [--submit] [--games N] [--headless] [--chrome] [--record]
 *   --chrome: 驱动系统安装的 Google Chrome（有头窗口给真人围观）
 *   --record: 每局独立录屏 recordings/*.webm + 逐步决策日志 recordings/*.jsonl
 *
 * 录像设计：每局一个 context——打完即封盘，中途 kill 最多丢当前局；
 * SIGINT/SIGTERM 会优雅关 context 保住视频。JSONL 全程流式追加，
 * 内含 pend/next/落点x——配合 replay.js 可离线复现整场对局。
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const URL = process.env.GAME_URL || 'https://yhsome.github.io/BigNaiWa/';
const args = process.argv.slice(2);
const SUBMIT = args.includes('--submit');
const HEADLESS = args.includes('--headless');
const CHROME = args.includes('--chrome');
const RECORD = args.includes('--record');
const games = +(args[args.indexOf('--games') + 1] || 1);

if (!fs.existsSync(path.join(ROOT, 'dist', 'bot.js')))
  execSync('node src/deploy/bundle.mjs', { cwd: ROOT, stdio: 'inherit' });

const browser = await chromium.launch(
  CHROME ? { channel: 'chrome', headless: false } : { headless: HEADLESS });

const REC_DIR = path.join(ROOT, 'recordings');
let logStream = null;
const openCtxs = new Set();
if (RECORD) {
  fs.mkdirSync(REC_DIR, { recursive: true });
  logStream = fs.createWriteStream(
    path.join(REC_DIR, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`), { flags: 'a' });
}

async function boot(page, nGames) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__DNW__ && window.__DNW__.state);
  await page.evaluate(({ SUBMIT, games }) => {
    window.HECHENG_OPTS = { SUBMIT, MAXGAMES: games };
  }, { SUBMIT, games: nGames });
  await page.addScriptTag({ path: path.join(ROOT, 'dist', 'bot.js') });
}

async function waitGameOver(page) {
  const deadline = Date.now() + 6 * 3600 * 1000;
  while (Date.now() < deadline) {
    let st;
    try {
      st = await page.evaluate(() => ({
        over: window.__DNW__.state.over,
        revives: window.__DNW__.state.revives,
        score: window.__DNW__.state.score,
        log: window.__HECHENG_LOG ? window.__HECHENG_LOG.splice(0) : []
      }));
    } catch { return -2; }                       // 页面/窗口被人为关掉 → -2 全局停跑
    for (const r of st.log) logStream && logStream.write(JSON.stringify(r) + '\n');
    /* over 且还有复活币是瞬态——bot 的 playOne 会立刻 revive，不算终局 */
    if (st.over && st.revives === 0) return st.score;
    await page.waitForTimeout(3000).catch(() => {});
    if (page.isClosed()) return -2;
  }
  return -1;
}

async function newRecordedCtx() {
  /* screencast 按 CSS 像素录制（deviceScaleFactor 无效），把 .stage 撑到
     1400px 让 canvas backing 变成 840×1400 才是真的 2x 渲染 */
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 1500 },
    recordVideo: { dir: REC_DIR, size: { width: 1200, height: 1500 } }
  });
  openCtxs.add(ctx);
  ctx.on('close', () => openCtxs.delete(ctx));
  const page = await ctx.newPage();
  page.on('console', m => { if (m.text().includes('[hecheng]')) console.log('PAGE>', m.text()); });
  return { ctx, page };
}

/* 信号优雅关闭：抢在进程死前关 context，webm 才能封盘 */
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log(sig, 'received, closing contexts to flush video...');
    for (const c of openCtxs) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(0);
  });
}

console.log(`playing ${games} game(s) on ${URL} (submit=${SUBMIT}, chrome=${CHROME}, record=${RECORD})`);

if (RECORD) {
  /* 每局独立 context：打完即封盘一个 webm；用户关窗 = 全停 */
  for (let g = 1; g <= games; g++) {
    const { ctx, page } = await newRecordedCtx();
    await boot(page, 1);
    await page.addStyleTag({ content: '.stage { height: 1400px !important; }' });
    const score = await waitGameOver(page);
    console.log(`game ${g}: score=${score}`);
    await ctx.close().catch(() => {});
    if (score === -2) { console.log('window closed, stopping'); break; }
  }
} else {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  openCtxs.add(ctx);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.text().includes('[hecheng]')) console.log('PAGE>', m.text()); });
  await boot(page, games);
  for (let g = 1; g <= games; g++) {
    if (g > 1) {
      /* 等 bot 按 R 重启后再等终局，否则会吃到上一局的残留 over */
      await page.waitForFunction(() => window.__DNW__ && !window.__DNW__.state.over,
        null, { timeout: 60000 }).catch(() => {});
    }
    const score = await waitGameOver(page);
    console.log(`game ${g}: score=${score}`);
    if (score < 0) break;                 // -1 超时 / -2 关窗 都全停
  }
  await ctx.close().catch(() => {});
}
await browser.close();
if (RECORD) {
  logStream && logStream.end();
  console.log('recordings ->', REC_DIR, fs.readdirSync(REC_DIR));
}
