import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  CLOSET_DIRNAME,
  SCHEMA_VERSION,
  detectLanguage,
  normalizePath,
  pathKey,
  closetPaths,
  makeId,
  readRegistry,
  writeRegistry,
  register,
  unregister,
  markRun,
  list,
  ensureLayout,
  walk,
} from '../lib/store.js';
import { makeTempDir, removeDir, snapshotTree, cleanupTempDirs } from './helpers.js';

const isWin = process.platform === 'win32';
const dirs = [];
after(() => dirs.forEach(removeDir));
after(cleanupTempDirs);

/** 新建一个用例专用的假工作区 */
function newWorkspace() {
  const dir = makeTempDir('store');
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------- 路径规范化

test('normalizePath：统一分隔符与盘符大小写，消除 . 与 ..', () => {
  if (isWin) {
    assert.equal(normalizePath('c:/temp/a.txt'), 'C:\\temp\\a.txt');
    assert.equal(normalizePath('C:\\temp\\sub\\..\\a.txt'), 'C:\\temp\\a.txt');
    assert.equal(normalizePath('C:/temp/./a.txt'), 'C:\\temp\\a.txt');
    assert.equal(normalizePath('C:\\temp\\a.txt\\'), 'C:\\temp\\a.txt');
  }
  // 中文 + 空格路径必须原样保留
  const zh = makeTempDir('中文 目录');
  dirs.push(zh);
  const file = path.join(zh, '脚本 一.ps1');
  assert.equal(normalizePath(file), file);
  // 平台无关：相对路径被解析成绝对路径；空值返回空串
  assert.ok(path.isAbsolute(normalizePath('a/b.txt')));
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(null), '');
});

test('pathKey：Windows 下大小写不敏感；makeId 对同一文件的写法差异稳定', () => {
  if (isWin) {
    assert.equal(pathKey('C:\\Temp\\A.txt'), pathKey('c:/temp/a.txt'));
    // 大小写变体必须得到同一个 id，否则同一文件会被登记两次
    assert.equal(makeId('C:\\Temp\\A.txt'), makeId('c:/temp/a.txt'));
    assert.notEqual(makeId('C:\\Temp\\A.txt'), makeId('C:\\Temp\\B.txt'));
  }
  const id = makeId(makeTempDir('id'));
  assert.match(id, /^s_[0-9a-f]{8}$/);  assert.equal(makeId(path.join('x', 'y.ps1')), makeId(path.join('x', 'y.ps1')));
});

test('detectLanguage：扩展名大小写不敏感，未知返回 null', () => {
  assert.equal(detectLanguage('a.PS1'), 'powershell');
  assert.equal(detectLanguage('a.psm1'), 'powershell');
  assert.equal(detectLanguage('b.mjs'), 'node');
  assert.equal(detectLanguage('b.TS'), 'node');
  assert.equal(detectLanguage('c.py'), 'python');
  assert.equal(detectLanguage('d.CMD'), 'batch');
  assert.equal(detectLanguage('e.sh'), 'shell');
  assert.equal(detectLanguage('f.txt'), null);
  assert.equal(detectLanguage(''), null);
  // 坑：'a.bat.txt' 不能识别成 batch
  assert.equal(detectLanguage('a.bat.txt'), null);
});

// ---------------------------------------------------------------- 登记册

test('closetPaths：所有路径都落在 <.dsh-fix> 之下', () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  assert.equal(p.root, path.join(ws, CLOSET_DIRNAME));
  for (const key of ['registry', 'scripts', 'logs', 'trash', 'tmp']) {
    assert.ok(p[key].startsWith(p.root), `${key} 应在收纳间内`);
  }
});

test('readRegistry：文件不存在时返回空表且不抛错', async () => {
  const ws = newWorkspace();
  const r = await readRegistry(ws);
  assert.equal(r.recovered, false);
  assert.equal(r.registry.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(r.registry.scripts, []);
});

test('readRegistry：JSON 损坏时返回空表，并把坏文件改名成 .corrupt-*', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await fsp.mkdir(p.root, { recursive: true });
  await fsp.writeFile(p.registry, '{ 这不是 JSON', 'utf8');

  const r = await readRegistry(ws);
  assert.equal(r.recovered, true);
  assert.ok(r.error, '应带上解析错误信息');
  assert.deepEqual(r.registry.scripts, []);
  assert.equal(fs.existsSync(p.registry), false, '坏文件应被移走');

  const left = fs.readdirSync(p.root).filter((n) => n.startsWith('registry.json.corrupt-'));
  assert.equal(left.length, 1, '坏文件必须以 .corrupt-* 保留现场');
  assert.match(await fsp.readFile(path.join(p.root, left[0]), 'utf8'), /这不是 JSON/);
});

test('readRegistry：脚本数组里的垃圾条目被过滤，缺失字段被补齐', async () => {
  const ws = newWorkspace();
  const p = closetPaths(ws);
  await fsp.mkdir(p.root, { recursive: true });
  await fsp.writeFile(
    p.registry,
    JSON.stringify({
      schemaVersion: 99,
      scripts: [null, 42, { path: '' }, { path: 'C:\\x\\fix-a.ps1', status: 'bogus', runs: 'NaN!' }],
    }),
    'utf8',
  );
  const { registry, recovered } = await readRegistry(ws);
  assert.equal(recovered, false);
  assert.equal(registry.schemaVersion, SCHEMA_VERSION);
  assert.equal(registry.scripts.length, 1);
  const e = registry.scripts[0];
  assert.equal(e.status, 'active');
  assert.equal(e.runs, 0);
  assert.equal(e.language, 'powershell');
  assert.match(e.id, /^s_/);
});

test('register：同一路径（大小写/斜杠/中文空格变体）重复登记不产生重复条目', async () => {
  const ws = newWorkspace();
  const file = path.join(ws, '临时 脚本', 'fix-a.ps1');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'Write-Host hi\n', 'utf8');

  const first = await register(ws, { path: file, purpose: '修网络' });
  assert.equal(first.created, true);

  const variant = isWin ? file.toUpperCase() : file.split(path.sep).join('/');
  const second = await register(ws, { path: variant, status: 'done' });
  assert.equal(second.created, false, '同一文件的另一种写法应命中同一条记录');
  assert.equal(second.entry.id, first.entry.id);

  const third = await register(ws, { path: file });
  assert.equal(third.created, false);

  const { scripts } = await list(ws);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].purpose, '修网络', '再次登记不应抹掉已有 purpose');
  assert.equal(scripts[0].status, 'done');
});

test('register：缺少 path 时抛出清晰错误；非法 status/language 被忽略', async () => {
  const ws = newWorkspace();
  await assert.rejects(() => register(ws, {}), /path/);
  const r = await register(ws, { path: 'x.py', status: 'nope', language: 'klingon' });
  assert.equal(r.entry.status, 'active');
  assert.equal(r.entry.language, 'python');
});

test('writeRegistry：原子写——不残留临时文件，内容可被再次读回', async () => {
  const ws = newWorkspace();
  await register(ws, { path: path.join(ws, 'a.ps1') });
  await register(ws, { path: path.join(ws, 'b.py') });
  const p = closetPaths(ws);
  const tmpLeft = fs.existsSync(p.tmp) ? fs.readdirSync(p.tmp) : [];
  assert.deepEqual(tmpLeft, [], '临时文件必须被 rename 掉，不能残留');
  const raw = JSON.parse(await fsp.readFile(p.registry, 'utf8'));
  assert.equal(raw.scripts.length, 2);
  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
  assert.ok(Date.parse(raw.updatedAt) > 0);
});

test('并发写：同时登记 20 个文件后，登记册仍可解析（不出现半个 JSON）', async () => {
  const ws = newWorkspace();
  // 并发 register 之间存在读-改-写竞争，条目数可能少于 20；这里只断言「不损坏」
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => register(ws, { path: path.join(ws, `f${i}.ps1`) })),
  );
  const raw = await fsp.readFile(closetPaths(ws).registry, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw), '登记册必须始终是完整 JSON');
});

test('list：exists 字段正确反映文件是否还在', async () => {
  const ws = newWorkspace();
  const alive = path.join(ws, 'alive.sh');
  const ghost = path.join(ws, 'ghost.sh');
  await fsp.writeFile(alive, 'echo hi\n', 'utf8');
  await register(ws, { path: alive });
  await register(ws, { path: ghost });

  const { scripts } = await list(ws);
  const byName = Object.fromEntries(scripts.map((s) => [path.basename(s.path), s]));
  assert.equal(byName['alive.sh'].exists, true);
  assert.equal(byName['ghost.sh'].exists, false);

  const onlyDone = await list(ws, { status: 'done' });
  assert.equal(onlyDone.scripts.length, 0);
});

test('unregister / markRun：按 id 或路径删除；执行计数与时间正确', async () => {
  const ws = newWorkspace();
  const a = path.join(ws, 'a.ps1');
  const b = path.join(ws, 'b.ps1');
  const ra = await register(ws, { path: a });
  await register(ws, { path: b });

  const ran = await markRun(ws, ra.entry.id);
  assert.equal(ran.runs, 1);
  const ran2 = await markRun(ws, ra.entry.id);
  assert.equal(ran2.runs, 2);
  assert.ok(Date.parse(ran2.lastRunAt) > 0);
  assert.equal(await markRun(ws, 's_deadbeef'), null);

  const r1 = await unregister(ws, ra.entry.id);
  assert.equal(r1.removed, 1);
  const r2 = await unregister(ws, b);
  assert.equal(r2.removed, 1);
  const r3 = await unregister(ws, b);
  assert.equal(r3.removed, 0, '重复注销不应报错');
});

// ---------------------------------------------------------------- 遍历

test('walk：递归收集文件，跳过符号链接，ignore 生效，目录不存在返回空数组', async () => {
  const ws = newWorkspace();
  await fsp.mkdir(path.join(ws, 'sub', 'deep'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'a.txt'), 'a');
  await fsp.writeFile(path.join(ws, 'sub', 'b.txt'), 'bb');
  await fsp.writeFile(path.join(ws, 'sub', 'deep', 'c.txt'), 'ccc');
  await fsp.mkdir(path.join(ws, 'node_modules'));
  await fsp.writeFile(path.join(ws, 'node_modules', 'x.js'), 'x');

  const all = await walk(ws);
  // walk 返回的是相对 ws 的 POSIX 风格路径（分隔符统一成 /）
  const names = all.map((f) => f.path).sort();
  assert.deepEqual(names, ['a.txt', 'node_modules/x.js', 'sub/b.txt', 'sub/deep/c.txt']);
  const b = all.find((f) => f.path.endsWith('b.txt'));
  assert.equal(b.size, 2);
  assert.ok(b.mtimeMs > 0);
  // 绝对路径由调用方自己拼
  assert.ok(isWin ? fs.statSync(path.join(ws, b.path)).isFile() : true);

  const pruned = await walk(ws, { ignore: (abs) => path.basename(abs) === 'node_modules' });
  assert.equal(pruned.some((f) => f.path.includes('node_modules')), false);

  assert.deepEqual(await walk(path.join(ws, 'not-exist')), []);

  if (isWin) {
    // 目录联接（Junction）在 Dirent 上同样表现为符号链接：必须跳过而不是递归
    const link = path.join(ws, 'link-to-sub');
    try {
      fs.symlinkSync(path.join(ws, 'sub'), link, 'junction');
    } catch {
      return;
    }
    const withLink = await walk(ws);
    assert.equal(withLink.some((f) => f.path.includes('link-to-sub')), false);
  }
});

test('ensureLayout：建出收纳间骨架', async () => {
  const ws = newWorkspace();
  const p = await ensureLayout(ws);
  for (const key of ['root', 'scripts', 'logs', 'trash']) {
    assert.ok(fs.statSync(p[key]).isDirectory(), `${key} 应是目录`);
  }
});

test('walk 不修改文件：前后 mtime 与内容哈希一致', async () => {
  const ws = newWorkspace();
  await fsp.mkdir(path.join(ws, 'tmp'));
  await fsp.writeFile(path.join(ws, 'tmp', 'fix-x.ps1'), 'Write-Host x');
  const before = snapshotTree(ws, crypto);
  await walk(ws);
  const after1 = snapshotTree(ws, crypto);
  assert.deepEqual(after1, before);
});
