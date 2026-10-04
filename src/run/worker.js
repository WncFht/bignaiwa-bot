/* run/worker.js —— worker_threads 工作线程：每收一个任务打一整局，回传统计。 */
'use strict';
const { parentPort } = require('worker_threads');
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
parentPort.on('message', (task) => {
  const key = JSON.stringify(task.agent);
  if (key !== agentKey) { agentKey = key; agent = makeAgent(task.agent); }
  env.reset(task.seed);
  const r = playGame(env, agent, task.opts);
  r.seed = task.seed; r.task = task.id;
  parentPort.postMessage(r);
});
