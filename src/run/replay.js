/* run/replay.js —— 用部署端 JSONL 决策日志离线复现整局。
 * 页面 RNG 不可复现，但日志记下了每步 pend/next/落点 x；
 * 物理引擎确定 → 强制 pending=记录值 + 按记录 x 投放即可逐帧复现。
 * 用法: node src/run/replay.js recordings/run-XXX.jsonl [--verify]
 *   --verify 每步核对复现分与记录分是否一致（引擎等价性检验）
 */
'use strict';
const fs = require('fs');
const { createEnv } = require('../env.js');
const C = require('../core.js');

const file = process.argv[2];
const VERIFY = process.argv.includes('--verify');
const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

const env = createEnv(1);
env.core = C;
env.reset(recs[0] && recs[0].seed || 1);   // 种子无关——fruit 序列全靠强制 pending

let gi = 0, drops = 0, mismatch = 0, firstBad = -1;
for (const rec of recs) {
  if (rec.end) {
    console.log(`[game ${++gi}] end: score=${rec.score} replayed=${env.S.score} drops=${drops}`);
    drops = 0;
    continue;
  }
  if (env.S.over) {
    if (env.S.revives > 0) { env.G.revive(); C.settle(env, { maxFrames: 60 }); }
    else { console.log(`  replay died at rec i=${rec.i} (logged score=${rec.score})`); }
  }
  while (!env.S.ready) C.frame(env);
  if (VERIFY && rec.score != null && env.S.score !== rec.score) {
    mismatch++; if (firstBad < 0) firstBad = rec.i;
  }
  env.S.pending = rec.pend;   // 强制本步投放的水果（覆盖 RNG 抽签）
  C.dropNow(env, rec.x);
  C.settle(env, { maxFrames: 110, calmFrames: 9, calmSpeed: 55 });
  drops++;
}
if (VERIFY)
  console.log(`verify: ${mismatch} mismatched steps${firstBad >= 0 ? ' (first at i=' + firstBad + ')' : ''} —— 0 差异 = 日志可完美复现`);
console.log(`done: ${gi || 1} game(s), ${drops} drops in last`);
