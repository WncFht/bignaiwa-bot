/* run/remote_worker.js —— SSH 远端 worker：stdin 收 JSON 行任务、stdout 回 JSON 行结果。
 * 与 worker.js 同一任务协议 {id,seed,opts,agent}→{…,seed,task}，
 * 供本机 tune_cem 经 `ssh host node remote_worker.js` 拉起做跨机并行。
 */
'use strict';
const readline = require('readline');
const { createEnv } = require('../env.js');
const C = require('../core.js');
const Search = require('../agents/search.js');
const Simple = require('../agents/simple.js');
const MC = require('../agents/mc.js');
const { playGame } = require('./game.js');

const env = createEnv(1);
env.core = C;

function makeAgent(cfg) {
  switch (cfg.type) {
    case 'random': return Simple.rand(env);
    case 'match': return Simple.match(env);
    case 'sorted': return Simple.sorted(env);
    case 'search': return Search.createSearch(cfg.opts || {});
    case 'mc': return MC.createMC(cfg.opts || {});
    default: throw new Error('unknown agent ' + cfg.type);
  }
}

let agent = null, agentKey = null;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const task = JSON.parse(line);
  const key = JSON.stringify(task.agent);
  if (key !== agentKey) { agentKey = key; agent = makeAgent(task.agent); }
  env.reset(task.seed);
  const r = playGame(env, agent, task.opts);
  r.seed = task.seed; r.task = task.id;
  process.stdout.write(JSON.stringify(r) + '\n');
});
