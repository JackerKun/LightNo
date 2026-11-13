/**
 * LIGHTNO · 静态校验（零依赖）
 * - 所有 JS 语法检查（把 .js 复制到临时目录后按 ESM 解析）
 * - index.html 引用的本地文件是否存在
 * - JS 中 $('#id') / getElementById 引用的 id 是否在 HTML 或 JS 模板中声明
 * - sw.js 预缓存的文件是否存在
 *
 * 运行：node tools/verify.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const files = walk(root).filter(
  (f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}tools${path.sep}`) && !f.includes(`${path.sep}tests${path.sep}`)
);
const jsFiles = files.filter((f) => /\.(m?js)$/.test(f));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

/* ---------- 1. 语法 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightno-'));
for (const file of jsFiles) {
  const target = path.join(tmp, path.basename(file, path.extname(file)) + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.copyFileSync(file, target);
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`语法错误 ${path.relative(root, file)}\n${(err.stderr || '').toString().trim()}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✓ 已解析 ${jsFiles.length} 个 JS 文件`);

/* ---------- 2. HTML 本地引用 ---------- */
const htmlRefs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
for (const ref of new Set(htmlRefs)) {
  const target = path.join(root, ref.replace(/^\.\//, '').split('?')[0]);
  if (!fs.existsSync(target)) problems.push(`index.html 引用了不存在的文件：${ref}`);
}
console.log(`✓ 已检查 ${new Set(htmlRefs).size} 个 HTML 本地引用`);

/* ---------- 3. DOM id ---------- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsSource = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
for (const m of jsSource.matchAll(/\bid="([A-Za-z][\w-]*)"/g)) htmlIds.add(m[1]);

const idRefs = new Set();
for (const m of jsSource.matchAll(/\$\('#([A-Za-z][\w-]*)'/g)) idRefs.add(m[1]);
for (const m of jsSource.matchAll(/getElementById\('([^']+)'\)/g)) idRefs.add(m[1]);
for (const m of jsSource.matchAll(/querySelector\('#([A-Za-z][\w-]*)'\)/g)) idRefs.add(m[1]);

for (const id of idRefs) {
  if (!htmlIds.has(id)) problems.push(`JS 引用了不存在的 id：#${id}`);
}
console.log(`✓ 已检查 ${idRefs.size} 个 DOM id 引用`);

/* ---------- 4. Service Worker 预缓存 ---------- */
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const precache = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
for (const entry of new Set(precache)) {
  if (!fs.existsSync(path.join(root, entry))) problems.push(`sw.js 预缓存了不存在的文件：${entry}`);
}
console.log(`✓ 已检查 ${new Set(precache).size} 个预缓存文件`);

/* ---------- 5. manifest ---------- */
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons || []) {
    const target = path.join(root, icon.src.replace(/^\.\//, ''));
    if (!fs.existsSync(target)) problems.push(`manifest 图标不存在：${icon.src}`);
  }
  if (!manifest.start_url || !manifest.scope) problems.push('manifest 缺少 start_url / scope');
} catch (err) {
  problems.push('manifest.webmanifest 不是合法 JSON：' + err.message);
}
console.log('✓ manifest 校验完成');

if (problems.length) {
  console.error('\n发现 ' + problems.length + ' 个问题：\n');
  for (const p of problems) console.error(' • ' + p + '\n');
  process.exit(1);
}
console.log('\n全部校验通过。');