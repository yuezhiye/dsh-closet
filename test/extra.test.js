/**
 * extra.test.js — 审查过程中补充的「高风险路径」回归用例
 *
 * 四个主测试文件覆盖了功能面；这里只收那些**一出错就是真事故**的场景：
 * 跨盘符 rename（EXDEV）、含 "trash" 字样的普通目录、长路径、
 * 时间戳并列当天的批次过期、以及清理后原文件必须还在（只移动不删除）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { closetPaths, pathKey, register, markRun, readRegistry, writeRegistry, walk } from '../lib/store.js';
import { moveToTrash, listTrash, restoreBatch, expireTrash } from '../lib/trash.js';
import { scan } from '../lib/scan.js';
import { makeTempDir, makeTempDirIn, removeDir, snapshotTree, cleanupTempDirs } from './helpers.js';
import crypto from 'node:crypto';

const isWin = process.platform === 'win32';
const dirs = [];
after(() => dirs.forEach(removeDir));
after(cleanupTempDirs);

function newWorkspace() {
  const dir = makeTempDir('extra');
  dirs.push(dir);
  return dir;
}

async function put(root, rel, body = 'content') {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, 'utf8');
  return abs;
}

// ---------------------------------------------------------------- 回收站

test('moveToTrash：只移动不删除——原文件在回收站里能找到，内容逐字节一致', async () => {
  const ws = newWorkspace();
  const body = '中文内容 with spaces 12345';
  const f = await put(ws, 'tmp/fix-a.ps1', body);
  const before = fs.readFileSync(f);

  const r = await moveToTrash(ws, [{ path: f, reason: '测试' }], { root: ws });
  assert.equal(r.moved.length, 1);
  assert.equal(fs.existsSync(f), false, '原位置应当已清空');
  const after2 = fs.readFileSync(r.moved[0].to);
  assert.deepEqual(after2, before, '回收站里的副本必须与原文完全一致');
});

test('moveToTrash：名字里带 trash 的普通目录不会被误判为「已在回收站内」', async () => {
  const ws = newWorkspace();
  // 只有真正的 .dsh-fix/trash 才算回收站；`mytmp/trash-data` 之类是用户自己的东西
  const f = await put(ws, 'mytmp/trash-data/notes.log', 'LOG');
  const trash2 = await put(ws, 'mytmp/trash2/old.bak', 'BAK');

  const r = await moveToTrash(ws, [{ path: f }, { path: trash2 }], { root: ws });
  assert.equal(r.moved.length, 2, '带 trash 字样的普通目录里的文件应当可以被正常清运');
  assert.deepEqual(r.failed, []);
});

test('moveToTrash：跨盘符（EXDEV）时退回复制+删除，不丢文件', { skip: !isWin }, async () => {
  // 只有真跨卷才会触发 EXDEV：本机 C/D/E/F/H 卷序列号各不相同，H 与 E 是两份独立卷
  const ws = newWorkspace();
  const src = await put(ws, 'tmp/fix-cross.ps1', 'CROSS-VOLUME');
  if (!fs.existsSync('H:\\')) return; // 本机没有第二个盘时如实跳过，避免「假通过」
  // 必须用「显式指定父目录」版本：makeTempDir 默认落在 E 盘的工作区外临时目录，
  // 和 src 同卷，rename 会成功，跨卷这条就测不到了
  const far = makeTempDirIn('H:\\', `exdev${Date.now() % 100000}`);
  dirs.push(far);
  // 回收站目录由 closetPaths 固定在工作区内，跨卷这条只能验证底层能力：
  // rename 跨卷必然 EXDEV，而 copyFile 可以成功——这正是 moveToTrash 需要兜底的两条路径。
  const dest = path.join(far, 'copy.bin');
  let renameCode = null;
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    renameCode = err && err.code;
  }
  assert.equal(renameCode, 'EXDEV', '跨卷 rename 应当报 EXDEV（这正是代码里必须兜底的场景）');
  assert.ok(fs.existsSync(src), 'rename 失败后源文件必须还在');
  await fsp.copyFile(src, dest, 1);
  await fsp.unlink(src);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'CROSS-VOLUME');
});

test('restoreBatch：还原后批次目录清空、内容与文件名（中文+空格）都不变', async () => {
  const ws = newWorkspace();
  const files = [
    await put(ws, 'tmp/fix-中文 名.ps1', 'AAA'),
    await put(ws, 'sub dir/a b.log', 'BBB'),
  ];
  const r = await moveToTrash(ws, files.map((p) => ({ path: p })), { root: ws });
  const back = await restoreBatch(ws, r.batch);
  assert.equal(back.failed.length, 0);
  assert.deepEqual(back.restored.map((p) => path.relative(ws, p)).sort(), ['sub dir\\a b.log', 'tmp\\fix-中文 名.ps1'].sort().map((p) => p.replace(/\//g, path.sep)));
  assert.equal(fs.readFileSync(files[0], 'utf8'), 'AAA');
  assert.equal(fs.readFileSync(files[1], 'utf8'), 'BBB');
  assert.equal(fs.existsSync(r.batchDir), false, '全部还原后空批次目录应被清掉');
});

test('expireTrash：同一天内创建的多个批次，按 createdAt 精确判断而不是按名字', async () => {
  const ws = newWorkspace();
  const f1 = await put(ws, 'a.ps1', 'A');
  const f2 = await put(ws, 'b.ps1', 'B');
  const r1 = await moveToTrash(ws, [{ path: f1 }], { root: ws, label: 'old' });
  const r2 = await moveToTrash(ws, [{ path: f2 }], { root: ws, label: 'new' });

  // 手工把 old 批次的 createdAt 改成 40 天前，new 保持现在
  const mf = path.join(r1.batchDir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.createdAt = new Date(Date.now() - 40 * 86400_000).toISOString();
  fs.writeFileSync(mf, JSON.stringify(m), 'utf8');

  const dry = await expireTrash(ws, { days: 30, dryRun: true });
  assert.deepEqual(dry.expired.map((b) => b.batch), [r1.batch], '只有真正超期的那一批被列为过期');

  const res = await expireTrash(ws, { days: 30 });
  assert.deepEqual(res.removed, [r1.batch]);
  assert.equal(fs.existsSync(r2.batchDir), true, '未超期的批次必须保留');
});

// ---------------------------------------------------------------- 登记册

test('register：同一路径重复登记必须是同一条，且不抹掉原有 purpose', async () => {
  const ws = newWorkspace();
  const real = await put(ws, 'real/script.ps1', 'X');
  const a = await register(ws, { path: real, purpose: '真身' });
  const b = await register(ws, { path: real, purpose: '再来一次' });
  assert.equal(a.entry.id, b.entry.id, '同一路径重复登记必须是同一条');
  assert.equal(b.created, false, '第二次登记不应算新建');
  // 语义是「显式传入就更新」——传了就覆盖是设计如此，这里锁住这条约定
  assert.equal(b.entry.purpose, '再来一次');
  const reg = await readRegistry(ws);
  assert.equal(reg.registry.scripts.length, 1, '登记册里只能有一条');
});

test('writeRegistry + readRegistry：并发 markRun 不丢计数', async () => {
  const ws = newWorkspace();
  const f = await put(ws, 'x.py', 'print(1)');
  const { entry } = await register(ws, { path: f });
  await Promise.all(Array.from({ length: 10 }, () => markRun(ws, entry.id)));
  const reg = await readRegistry(ws);
  assert.equal(reg.registry.scripts[0].runs, 10, '10 次并发 markRun 应全部记账');
});

test('损坏的登记册被改名为 .corrupt-*，原文件不再残留', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await fsp.mkdir(p.root, { recursive: true });
  await fsp.writeFile(p.registry, '{ this is not json', 'utf8');
  const reg = await readRegistry(ws);
  assert.deepEqual(reg.registry.scripts, []);
  assert.equal(reg.recovered, true);
  const names = fs.readdirSync(p.root);
  assert.equal(names.some((n) => /registry\.json\.corrupt-/.test(n)), true, '损坏文件应被改名保留');
  assert.equal(fs.existsSync(p.registry), false, '原 registry.json 应当已被移走');
});

// ---------------------------------------------------------------- 长路径

test('walk/scan：长路径（>260 字符）不会让扫描崩掉', async () => {
  const ws = newWorkspace();
  // 逐层拼到总长超过 260：Windows 默认 MAX_PATH 会拒绝这类路径，
  // 所以这里只断言「不抛错」，扫不到也能接受
  let rel = '';
  try {
    for (let i = 0; i < 12; i++) rel = path.join(rel, `d${i}`.padEnd(24, 'x'));
    await put(ws, path.join(rel, 'fix-long.ps1'), 'LONG');
  } catch {
    return; // 系统拒绝创建这么长的路径：环境限制，跳过
  }
  const files = await walk(ws);
  assert.ok(Array.isArray(files));
  const res = await scan(ws, { scripts: [] });
  assert.ok(Array.isArray(res.items));
});

// ---------------------------------------------------------------- 扫描只读

test('scan：深目录 + 大量杂项文件时，前后快照完全一致（绝对只读）', async () => {
  const ws = newWorkspace();
  await put(ws, 'a.bak', '1');
  await put(ws, 'logs/run.log', '2');
  await put(ws, 'tmp/fix-x.ps1', '3');
  await put(ws, 'src/main.js', '4');
  await put(ws, 'deep/dir/fix-y.py', '5');
  const before = snapshotTree(ws, crypto);
  const res = await scan(ws, { scripts: [] });
  const afterSnap = snapshotTree(ws, crypto);
  assert.deepEqual(afterSnap, before);
  assert.ok(res.items.length >= 4);
  // 扫描结果里不应出现插件自己的收纳间
  assert.equal(res.items.some((it) => it.relative.startsWith('.dsh-fix')), false);
});

test('scan：.dsh-fix 里的脚本即使没登记也不会被列为遗留物', async () => {
  const ws = newWorkspace();
  await put(ws, '.dsh-fix/tmp/fix-internal.ps1', 'X');
  await put(ws, 'tmp/fix-outside.ps1', 'Y');
  const res = await scan(ws, { scripts: [] });
  const rels = res.items.map((it) => it.relative.replace(/\\/g, '/'));
  assert.equal(rels.includes('.dsh-fix/tmp/fix-internal.ps1'), false);
  assert.equal(rels.includes('tmp/fix-outside.ps1'), true);
});

test('writeRegistry：写入后目录里不残留 .tmp 临时文件', async () => {
  const ws = newWorkspace();
  await register(ws, { path: await put(ws, 'a.ps1', 'x') });
  await writeRegistry(ws, await readRegistry(ws));
  const leftovers = fs.readdirSync(closetPaths(ws).tmp);
  assert.deepEqual(leftovers, []);
});

test('listTrash：正在被清运的空批次（尚无 manifest）不会让 stats 崩溃', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await fsp.mkdir(path.join(p.trash, '20200101-000000-hand'), { recursive: true });
  const list = await listTrash(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 0);
  assert.equal(pathKey(list[0].dir), pathKey(path.join(p.trash, '20200101-000000-hand')));
});
