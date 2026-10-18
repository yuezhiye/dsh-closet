import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { closetPaths, pathKey, walk } from '../lib/store.js';
import { classify, scan, listLogs, sanitizeName } from '../lib/scan.js';
import { makeTempDir, removeDir, snapshotTree, cleanupTempDirs } from './helpers.js';

const isWin = process.platform === 'win32';
const dirs = [];
after(() => dirs.forEach(removeDir));
after(cleanupTempDirs);

function newWorkspace() {
  const dir = makeTempDir('scan');
  dirs.push(dir);
  return dir;
}

/** 造一棵包含各种遗留物的假工作区 */
async function makeTree(ws) {
  const files = {
    'tmp/fix-net.ps1': 'Write-Host fix',
    'tmp/helper.ps1': 'Write-Host helper',
    '.dsh-fix/scripts/fix-dsh.ps1': 'Write-Host dsh',
    'a.bak': 'backup',
    'a.log': 'log line',
    'notes.txt': 'notes',
    'node_modules/pkg/index.js': 'module.exports=1',
    '.git/hooks/pre-commit.sh': '#!/bin/sh',
    'fix-root.ps1': 'Write-Host root',
    'restart-dsh.cmd': '@echo off',
    'upgrade-x.py': 'print(1)',
    'src/app.js': 'console.log(1)',
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, body, 'utf8');
  }
  return files;
}

// ---------------------------------------------------------------- classify

test('classify：备份/日志/临时目录脚本/根目录脚本各有分类与理由', () => {
  const empty = new Set();
  const at = (rel, body = 'x') => ({ path: path.join('E:', 'ws', rel), size: body.length, mtimeMs: 0 });

  const bak = classify(at('a.bak'), empty);
  assert.equal(bak.category, 'artifact');
  assert.match(bak.reason, /\.bak/);
  assert.equal(bak.script, false);

  assert.equal(classify(at('a.bak.20260101'), empty).category, 'artifact');
  assert.equal(classify(at('a.tmp'), empty).category, 'artifact');
  assert.equal(classify(at('a.orig'), empty).category, 'artifact');
  assert.equal(classify(at('a.rej'), empty).category, 'artifact');
  assert.equal(classify(at('registry.json.corrupt-1712345678901'), empty).category, 'artifact');
  assert.equal(classify(at('a.ps1~'), empty).category, 'artifact');
  assert.equal(classify(at('a.log'), empty).category, 'log');
  assert.equal(classify(at('a.log.1'), empty).category, 'log');

  const tmpScript = classify(at('tmp/fix-net.ps1'), empty);
  assert.equal(tmpScript.category, 'script');
  assert.equal(tmpScript.script, true);
  assert.match(tmpScript.reason, /临时目录/);
  assert.match(tmpScript.reason, /fix/);

  const unknownScriptInTmp = classify(at('tmp/whatever.py'), empty);
  assert.equal(unknownScriptInTmp.category, 'script');
  assert.doesNotMatch(unknownScriptInTmp.reason, /fix/);

  const rootScript = classify(at('fix-root.ps1'), empty);
  assert.equal(rootScript.category, 'script');
  assert.match(rootScript.reason, /未登记/);

  // 不属于遗留物
  assert.equal(classify(at('src/app.js'), empty), null);
  assert.equal(classify(at('notes.txt'), empty), null);
  assert.equal(classify(at('scripts/deploy.ps1'), empty), null);
  assert.equal(classify(at('README.md'), empty), null);
});

test('classify：已登记的脚本照常返回分类，但登记状态如实反映（否则扫不出用户自己登记过的脚本）', () => {
  const p = path.join('E:', 'ws', 'fix-root.ps1');
  const keys = new Set([pathKey(p)]);
  const cls = classify({ path: p, size: 1, mtimeMs: 0 }, keys);
  assert.equal(cls.category, 'script');
  assert.equal(cls.registered, true);
  // 未登记时理由里带「（未登记）」，已登记时标记为 true 但理由不出现该字样
  assert.doesNotMatch(cls.reason, /未登记/);

  const unregistered = classify({ path: p, size: 1, mtimeMs: 0 }, new Set());
  assert.equal(unregistered.registered, false);
  assert.match(unregistered.reason, /未登记/);
});

// ---------------------------------------------------------------- scan

test('scan：分类/理由/suggestion 正确，跳过 node_modules 与 .git，保留已登记信息', async () => {
  const ws = newWorkspace();
  await makeTree(ws);
  // 登记两个：一个 active、一个 done
  const registry = {
    schemaVersion: 1,
    scripts: [
      { id: 's_1', path: path.join(ws, '.dsh-fix', 'scripts', 'fix-dsh.ps1'), status: 'active' },
      { id: 's_2', path: path.join(ws, 'restart-dsh.cmd'), status: 'done' },
    ],
  };

  const { items, summary, truncated } = await scan(ws, registry);
  const byRel = Object.fromEntries(items.map((i) => [i.relative.split(path.sep).join('/'), i]));

  assert.equal(truncated, false);

  // 临时目录脚本
  assert.equal(byRel['tmp/fix-net.ps1'].category, 'script');
  assert.match(byRel['tmp/fix-net.ps1'].reason, /临时目录 tmp/);
  assert.equal(byRel['tmp/fix-net.ps1'].suggestion, 'review');
  assert.equal(byRel['tmp/helper.ps1'].registered, false);

  // 备份与日志
  assert.equal(byRel['a.bak'].category, 'artifact');
  assert.equal(byRel['a.log'].category, 'log');
  assert.equal(byRel['a.bak'].suggestion, 'review');

  // 已登记：active 保持、done 归档
  // 注意：.dsh-fix/ 是插件自己的收纳间，里面的东西由登记册管，scan 一律不列（见 scan.test.js 末尾的用例）
  assert.equal(byRel['.dsh-fix/scripts/fix-dsh.ps1'], undefined);
  assert.equal(byRel['restart-dsh.cmd'].registered, true);
  assert.equal(byRel['restart-dsh.cmd'].suggestion, 'archive');

  // 必须跳过的
  assert.equal(byRel['node_modules/pkg/index.js'], undefined);
  assert.equal(byRel['.git/hooks/pre-commit.sh'], undefined);
  assert.equal(byRel['notes.txt'], undefined);
  assert.equal(byRel['src/app.js'], undefined);

  // 统计自洽
  assert.equal(summary.total, items.length);
  assert.equal(
    Object.values(summary.byCategory).reduce((a, b) => a + b, 0),
    items.length,
  );
  assert.equal(
    Object.values(summary.bySuggestion).reduce((a, b) => a + b, 0),
    items.length,
  );
  assert.ok(summary.bytes > 0);
  // 每个条目都有 complete 的字段
  for (const it of items) {
    assert.ok(it.path && it.relative && it.category && it.reason && it.suggestion);
    assert.ok(Date.parse(it.mtime) > 0);
  }
});

test('scan：includeRegistered=false 时过滤掉已登记条目', async () => {
  const ws = newWorkspace();
  await makeTree(ws);
  const registry = { scripts: [{ id: 's_1', path: path.join(ws, 'fix-root.ps1'), status: 'active' }] };
  const { items } = await scan(ws, registry, { includeRegistered: false });
  assert.equal(items.some((i) => i.relative === 'fix-root.ps1'), false);
  // 未登记的 fix-root 之外，其它条目仍在
  assert.ok(items.length > 0);
});

test('scan：maxFiles 限制生效并标记 truncated', async () => {
  const ws = newWorkspace();
  await makeTree(ws);
  // maxFiles 约束的是「遍历到的文件数」而不是「留下的遗留物数」：
  // makeTree 里 node_modules/.git 被忽略，实际遍历 10 个文件
  const limited = await scan(ws, { scripts: [] }, { maxFiles: 3 });
  assert.equal(limited.truncated, true);
  const full = await scan(ws, { scripts: [] });
  assert.equal(full.truncated, false);
  assert.ok(limited.items.length < full.items.length, '截断后条目必须更少');
});

test('scan 不修改任何文件：前后文件列表、mtime、内容哈希完全一致', async () => {
  const ws = newWorkspace();
  await makeTree(ws);
  const before = snapshotTree(ws, crypto);
  await scan(ws, { scripts: [] });
  const afterSnap = snapshotTree(ws, crypto);
  assert.deepEqual(afterSnap, before, 'scan 必须是纯只读：不得新增/删除/改写任何文件');
});

test('scan：回收站自身不被扫（避免把自己的历史清运结果再列一遍）', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await fsp.mkdir(path.join(p.trash, '20240101-000000-old'), { recursive: true });
  await fsp.writeFile(path.join(p.trash, '20240101-000000-old', 'x.bak'), 'x');
  const { items } = await scan(ws, { scripts: [] });
  assert.equal(items.some((i) => i.path.includes('trash')), false);
});

// ---------------------------------------------------------------- 辅助函数

test('sanitizeName：去掉盘符与非法字符，保留中文', () => {
  assert.equal(sanitizeName('C:\\a\\b.ps1'), 'a_b.ps1');
  assert.equal(sanitizeName('a/b:c*d?.ps1'), 'a_b_c_d_.ps1');
  assert.equal(sanitizeName('中文 脚本.ps1'), '中文 脚本.ps1');
  assert.equal(sanitizeName(''), '_');
  assert.equal(sanitizeName(undefined), '_');
  // 全是点/空的返回值绝不能是「上级目录」意义上的名字
  assert.equal(sanitizeName('..'), '_');
  assert.equal(sanitizeName('...'), '_');
  assert.equal(sanitizeName('___').length > 0, true);
  assert.ok(sanitizeName('x'.repeat(200)).length <= 80);
});

test('listLogs：只列 .log、按时间倒序、目录不存在返回空数组、无法穿越目录', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  assert.deepEqual(await listLogs(ws, 'fix-a.ps1'), []);

  const dir = path.join(p.logs, 'fix-a.ps1');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '20240101-000000.log'), 'old');
  await new Promise((r) => setTimeout(r, 15));
  await fsp.writeFile(path.join(dir, '20240102-000000.log'), 'new');
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'x');

  const logs = await listLogs(ws, 'fix-a.ps1');
  assert.equal(logs.length, 2);
  assert.equal(path.basename(logs[0].name), '20240102-000000.log');
  assert.ok(logs[0].size > 0);

  // 路径穿越：'../。。' 之类必须被 sanitize，不能读到收纳间外
  const escaped = await listLogs(ws, '../../etc');
  assert.deepEqual(escaped, []);
});

test('walk 在 scan 中不会把软链接目标当作工作区文件', async () => {
  const ws = newWorkspace();
  const outside = makeTempDir('outside');
  dirs.push(outside);
  await fsp.writeFile(path.join(outside, 'secret.bak'), 'secret');
  await fsp.writeFile(path.join(ws, 'real.txt'), 'x');
  if (!isWin) return;
  try {
    fs.symlinkSync(outside, path.join(ws, 'link-out'), 'junction');
  } catch {
    return;
  }
  const files = await walk(ws);
  assert.equal(files.some((f) => f.path.includes('link-out')), false);
});
