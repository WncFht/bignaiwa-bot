/* deploy/bundle.mjs —— 拼接 dist/bot.js：core + eval + search + inject */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const files = [
  'src/core.js', 'src/eval.js', 'src/agents/search.js', 'src/deploy/inject.js'
];
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
fs.writeFileSync(path.join(ROOT, 'dist', 'bot.js'), out);
console.log('dist/bot.js written', (out.length / 1024).toFixed(1) + 'KB');
