import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { closetPaths, pathKey } from '../lib/store.js';
import { moveToTrash, listTrash, restoreBatch, expireTrash } from '../lib/trash.js';
import { makeTempDir, removeDir, cleanupTempDirs } from './helpers.js';

const isWin = process.platform === 'win32';
const dirs = [];
after(() => dirs.forEach(removeDir));
after(cleanupTempDirs);
function newWorkspace() {
  const dir = makeTempDir('trash');
  dirs.push(dir);
  return dir;
}

/** 造一个文件并返回绝对路径 */
async function put(root, rel, body = 'content') {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, 'utf8');
  return abs;
}

// ---------------------------------------------------------------- 移入

test('moveToTrash：中文名与含空格文件能被移入，manifest 正确，原文件消失', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'tmp/修复 脚本.ps1', 'AAA');
  const b = await put(ws, 'a.bak', 'BBB');

  const r = await moveToTrash(ws, [{ path: a, reason: '临时脚本' }, { path: b }], { label: '测试 批次', root: ws });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  assert.equal(r.moved.length, 2);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);

  // 保持相对目录结构
  const movedA = r.moved.find((m) => m.from === a);
  assert.equal(movedA.to, path.join(r.batchDir, 'tmp', '修复 脚本.ps1'));
  assert.equal(await fsp.readFile(movedA.to, 'utf8'), 'AAA');
  assert.equal(movedA.reason, '临时脚本');
  assert.equal(movedA.size, 3);

  const manifest = JSON.parse(await fsp.readFile(path.join(r.batchDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.batch, r.batch);
  assert.equal(manifest.root, path.resolve(ws));
  assert.equal(manifest.label, '测试 批次');
  assert.equal(manifest.moved.length, 2);
  assert.deepEqual(manifest.failed, []);
  assert.ok(Date.parse(manifest.createdAt) > 0);
  assert.match(r.batch, /^\d{8}-\d{6}-测试_批次$/);
});

test('moveToTrash：工作区外的文件被拒绝（.. 穿越、大小写变体、绝对路径都挡）', async () => {
  const ws = newWorkspace();
  const outside = makeTempDir('outside');
  dirs.push(outside);
  const secret = await put(outside, 'secret.txt', 'SECRET');
  const parentFile = await put(path.dirname(ws), `escape-${path.basename(ws)}.txt`, 'PARENT');
  dirs.push(parentFile);

  const sneaky = [
    secret,
    path.join(ws, '..', path.basename(path.dirname(ws), '') && path.basename(outside), 'secret.txt'),
    path.join(ws, '..', path.basename(outside), 'secret.txt'),
    parentFile,
  ].map((p) => ({ path: p }));

  const r = await moveToTrash(ws, sneaky, { root: ws });
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed.length, sneaky.length);
  assert.ok(r.failed.every((f) => /不在工作区内/.test(f.error)));
  assert.equal(await fsp.readFile(secret, 'utf8'), 'SECRET', '工作区外文件必须原地不动');
  assert.equal(fs.existsSync(parentFile), true);
});

test('moveToTrash：工作区外文件在未传 root 时也必须被拒绝（不能靠调用方自觉）', async () => {
  const ws = newWorkspace();
  const outside = makeTempDir('outside2');
  dirs.push(outside);
  const secret = await put(outside, 'secret2.txt', 'SECRET2');
  const r = await moveToTrash(ws, [{ path: secret }]);
  assert.equal(r.moved.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(await fsp.readFile(secret, 'utf8'), 'SECRET2');
});

test('moveToTrash：工作区被软链接/目录联接绕过时也能挡住', { skip: !isWin }, async () => {
  const ws = newWorkspace();
  const outside = makeTempDir('outside3');
  dirs.push(outside);
  const secret = await put(outside, 'secret3.txt', 'SECRET3');
  let link;
  try {
    link = path.join(ws, 'link-out');
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    return; // 无权限建联接：跳过（不算失败）
  }
  const throughLink = path.join(link, 'secret3.txt');
  const r = await moveToTrash(ws, [{ path: throughLink }], { root: ws });
  assert.equal(r.moved.length, 0, '通过目录联接逃逸的路径必须被拒绝');
  assert.equal(await fsp.readFile(secret, 'utf8'), 'SECRET3');
});

test('moveToTrash：回收站内的文件不会被再次移入（大小写变体也不行）', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await fsp.mkdir(p.trash, { recursive: true });
  const inside = await put(p.trash, 'batch1/x.bak', 'X');
  const variant = isWin ? inside.toUpperCase() : inside;
  const r = await moveToTrash(ws, [{ path: variant }, { path: inside }], { root: ws });
  assert.equal(r.moved.length, 0);
  assert.equal(fs.existsSync(inside), true);
});

test('moveToTrash：同名不同目录的文件互不覆盖；目录与非普通文件被拒绝', async () => {
  const ws = newWorkspace();
  const b1 = await put(ws, 'd1/same.txt', 'ONE');
  const b2 = await put(ws, 'd2/same.txt', 'TWO');
  await fsp.mkdir(path.join(ws, 'aDir'), { recursive: true });
  const r = await moveToTrash(ws, [{ path: b1 }, { path: b2 }, { path: path.join(ws, 'aDir') }], { root: ws });
  assert.equal(r.moved.length, 2);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /不是普通文件/);
  const bodies = await Promise.all(r.moved.map((m) => fsp.readFile(m.to, 'utf8')));
  assert.deepEqual(bodies.sort(), ['ONE', 'TWO']);
});

test('moveToTrash：不存在的文件进 failed 且不抛错；一个都没搬成时不留下空批次', async () => {
  const ws = newWorkspace();
  const r = await moveToTrash(ws, [{ path: path.join(ws, 'nope.txt') }], { root: ws });
  assert.equal(r.moved.length, 0);
  assert.match(r.failed[0].error, /无法读取/);
  assert.equal(r.batch, null, '没搬成任何文件时不应生成批次名');
  assert.equal(r.batchDir, null, '没搬成任何文件时不应生成批次目录');

  // 空批次会污染回收站清单（显示 0 条目 0 体积），必须是干净的
  assert.deepEqual(await listTrash(ws), []);

  const empty = await moveToTrash(ws, [], { root: ws });
  assert.equal(empty.moved.length, 0);
  assert.equal(empty.batchDir, null);
});

test('moveToTrash：items 传纯字符串数组也能搬（路由层/面板走这条路径）', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'str-a.txt', 'AAA');
  const b = await put(ws, 'str-b.txt', 'BB');
  // 面板 POST /clean 传的是 ['绝对路径', ...]，历史实现只认 {path} 对象，
  // 于是每项都被当成「空路径」跳过 —— 面板清运永远搬不动文件。
  const r = await moveToTrash(ws, [a, b], { root: ws, label: 'panel' });
  assert.equal(r.moved.length, 2, '字符串数组必须能正常搬走');
  assert.equal(r.failed.length, 0);
  assert.ok(r.batch);
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);

  const list = await listTrash(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].bytes, 5);
});

test('moveToTrash：字符串里的空串/空白项不会造出空批次', async () => {
  const ws = newWorkspace();
  const r = await moveToTrash(ws, ['', '   '], { root: ws });
  assert.equal(r.moved.length, 0);
  assert.equal(r.batch, null);
  assert.deepEqual(await listTrash(ws), []);
});

// ---------------------------------------------------------------- 列出

test('listTrash：统计文件数与字节数，按批次倒序', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'one.txt', '12345');
  const b = await put(ws, 'two.txt', '123');
  await moveToTrash(ws, [{ path: a }], { label: 'first', root: ws });
  await new Promise((r) => setTimeout(r, 1100)); // 批次名精确到秒
  await moveToTrash(ws, [{ path: b }], { label: 'second', root: ws });

  const list = await listTrash(ws);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'second', '最新的批次应排在最前');
  assert.equal(list[0].count, 1);
  assert.equal(list[0].bytes, 3);
  assert.equal(list[1].bytes, 5);
  assert.ok(Date.parse(list[0].createdAt) > 0);

  assert.deepEqual(await listTrash(newWorkspace()), []);
});

test('listTrash：没有 manifest 的手工批次也能统计（不崩）', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await put(p.trash, 'manual/x.txt', '1234567');
  const list = await listTrash(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 1);
  assert.equal(list[0].bytes, 7);
  assert.equal(list[0].label, '');
});

// ---------------------------------------------------------------- 还原

test('restoreBatch：文件回到原路径且内容不变，批次目录被清空', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'sub dir/中文 名.ps1', 'ORIGINAL');
  const b = await put(ws, 'b.bak', 'B');
  const r = await moveToTrash(ws, [{ path: a }, { path: b }], { root: ws });

  const res = await restoreBatch(ws, r.batch);
  assert.deepEqual(res.failed, []);
  assert.equal(res.restored.length, 2);
  assert.equal(await fsp.readFile(a, 'utf8'), 'ORIGINAL');
  assert.equal(await fsp.readFile(b, 'utf8'), 'B');
  assert.equal(fs.existsSync(r.batchDir), false, '还原干净后批次目录应被清理');
  assert.deepEqual(await listTrash(ws), []);
});

test('restoreBatch：原位置已被新文件占用时不能覆盖用户的新文件', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'x.txt', 'OLD');
  const r = await moveToTrash(ws, [{ path: a }], { root: ws });
  await put(ws, 'x.txt', 'NEW-IMPORTANT');

  const res = await restoreBatch(ws, r.batch).catch((e) => e);
  const current = await fsp.readFile(a, 'utf8');
  assert.equal(current, 'NEW-IMPORTANT', '绝不允许覆盖用户现有文件');
  if (!(res instanceof Error)) {
    assert.equal(res.failed.length, 1, '冲突必须被报告为失败');
  }
});

test('restoreBatch：批次不存在或清单损坏时报错清晰', async () => {
  const ws = newWorkspace();
  await assert.rejects(() => restoreBatch(ws, 'no-such-batch'), /manifest/);

  const p = closetPaths(ws);
  await fsp.mkdir(path.join(p.trash, 'broken'), { recursive: true });
  await fsp.writeFile(path.join(p.trash, 'broken', 'manifest.json'), '{oops', 'utf8');
  await assert.rejects(() => restoreBatch(ws, 'broken'), /manifest/);

  // 批次名穿越
  await assert.rejects(() => restoreBatch(ws, '..\\..'), /manifest|批次/);
});

// ---------------------------------------------------------------- 过期

test('expireTrash：dryRun 不删任何东西，只报告将被删的批次', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'y.txt', 'Y');
  const r = await moveToTrash(ws, [{ path: a }], { root: ws });

  const dry = await expireTrash(ws, { days: 0, dryRun: true, now: Date.now() + 1000 });
  assert.equal(dry.expired.length, 1);
  assert.deepEqual(dry.removed, []);
  assert.equal(fs.existsSync(r.batchDir), true, 'dryRun 之后批次目录必须还在');
  assert.equal(await fsp.readFile(path.join(r.batchDir, 'y.txt'), 'utf8'), 'Y');
});

test('expireTrash：未过期批次保留，过期批次才真删；唯一真删入口', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'z.txt', 'Z');
  const r = await moveToTrash(ws, [{ path: a }], { root: ws });

  const notYet = await expireTrash(ws, { days: 30 });
  assert.equal(notYet.expired.length, 0);
  assert.equal(fs.existsSync(r.batchDir), true);

  const later = await expireTrash(ws, { days: 30, now: Date.now() + 31 * 86400 * 1000 });
  assert.equal(later.expired.length, 1);
  assert.deepEqual(later.removed, [r.batch]);
  assert.equal(fs.existsSync(r.batchDir), false);
});

test('expireTrash：批次名里的日期不能成为「过期」依据（伪造名字不触发删除）', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  // 手工放一个名字看起来是 1999 年、但没有 manifest 的批次
  await put(p.trash, '19990101-000000-ancient/x.txt', 'KEEP');
  const dry = await expireTrash(ws, { days: 30, dryRun: true });
  // 无 manifest 时 createdAt 取自目录 mtime（刚创建），所以不该被判定过期
  assert.equal(dry.expired.length, 0, '刚创建的无清单批次不能被误判为过期');
});

test('expireTrash：过期判断使用本地时区（批次名下一天不能被提前删除）', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 't.txt', 'T');
  const r = await moveToTrash(ws, [{ path: a }], { root: ws });
  const manifest = JSON.parse(await fsp.readFile(path.join(r.batchDir, 'manifest.json'), 'utf8'));
  const created = Date.parse(manifest.createdAt);
  // 差 1 小时未足 30 天 → 不能删
  const justUnder = await expireTrash(ws, { days: 30, dryRun: true, now: created + 30 * 86400 * 1000 - 3600 * 1000 });
  assert.equal(justUnder.expired.length, 0);
  const justOver = await expireTrash(ws, { days: 30, dryRun: true, now: created + 30 * 86400 * 1000 + 3600 * 1000 });
  assert.equal(justOver.expired.length, 1);
});

// ---------------------------------------------------------------- 不可变性

test('moveToTrash：同一路径重复传入时第二次进 failed，不产生幽灵条目', async () => {
  const ws = newWorkspace();
  const a = await put(ws, 'dup.txt', 'D');
  const dup = [{ path: a }, { path: a }];
  const r = await moveToTrash(ws, dup, { root: ws });
  assert.equal(r.moved.length, 1);
  assert.equal(r.failed.length, 1);
  const manifest = JSON.parse(await fsp.readFile(path.join(r.batchDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.moved.length, 1);
  assert.equal(manifest.moved[0].from, a);
  assert.ok(pathKey(manifest.moved[0].to).startsWith(pathKey(closetPaths(ws).trash)));
});
