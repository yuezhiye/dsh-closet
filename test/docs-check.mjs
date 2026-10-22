import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const zh = read('README.md');
const en = read('README.en.md');
const changelog = read('CHANGELOG.md');

// 从源码里取真实工具名，避免文档写漂
const { toolDefs } = await (async () => {
  const { registerHostStubs } = await import('./host-stubs.js');
  registerHostStubs();
  return import('../lib/index.js');
})();
const names = toolDefs.map((t) => t.name);

const missing = (label, text, items) => items.filter((n) => !text.includes('`' + n + '`')).map((n) => `${label} 缺 ${n}`);

// 允许写成不带反引号的纯文本（表格里有时会这样写），所以按「包含」判断而不是反引号形式
const problems = [
  ...names.filter((n) => !zh.includes(n)).map((n) => `README.md 未提到工具 ${n}`),
  ...names.filter((n) => !en.includes(n)).map((n) => `README.en.md 未提到工具 ${n}`),
];

// 目录结构说明里列出的模块必须真实存在
const modules = ['store.js', 'scan.js', 'run.js', 'trash.js', 'config.js', 'workspaces.js', 'routes.js', 'client.js', 'index.js'];
for (const m of modules) {
  if (!zh.includes(m)) problems.push(`README.md 未说明模块 ${m}`);
  readFileSync(join(ROOT, 'lib', m), 'utf8'); // 不存在会直接抛错，测试失败
}

if (!/0\.1\.0/.test(changelog)) problems.push('CHANGELOG 缺少 0.1.0 章节');
if (!/\[0\.1\.0\]/.test(changelog)) problems.push('CHANGELOG 版本标题格式不对');

// 不给自己挖坑：文档里不能承诺「确认后删除」这类与实际行为不符的说法
for (const [label, text] of [['README.md', zh], ['README.en.md', en]]) {
  if (/confirm:\s*true/.test(text)) problems.push(`${label} 仍写着不存在的 confirm 参数`);
}
void missing;

if (problems.length) {
  console.error('文档与实现不一致：\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`docs-check OK：${names.length} 个工具、${modules.length} 个模块在文档中均有覆盖`);
