/**
 * git.js + 扫描/清运的「git 已跟踪保护」回归测试。
 *
 * 方案 B（用户 2026-10-18 拍板）：
 *  - 扫描照常列出被跟踪的文件，但标 tracked:true、建议固定 review；
 *  - closet_clean 默认拒收被跟踪的文件，必须显式 force:true 才放行；
 *  - git 不可用（非仓库 / 没装 git）时降级：保护不生效，但扫描照常跑完。
 *
 * 这些用例需要真 git 才能跑；没有 git 的机器上自动 skip，不算失败。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { makeTempDir, removeDir } from './helpers.js';
import { gitTrackedFiles, trackedFileSet, partitionTracked, isTracked, clearGitCache, _keyOf } from '../lib/git.js';
import { scan } from '../lib/scan.js';

/** git 是否可用 */
function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const GIT = hasGit();

/** 在一个临时目录里建一个真 git 仓库并提交若干文件 */
function makeRepo(files) {
  const dir = makeTempDir('gitcase');
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  // 关掉本机可能存在的全局 ignore / 签名，保证用例行为稳定
  run('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
  return dir;
}

test('git：非仓库目录返回 null（降级而不是抛错）', async () => {
  const dir = makeTempDir('nogit');
  try {
    assert.equal(await gitTrackedFiles(dir), null);
    assert.equal(await trackedFileSet(dir, { noCache: true }), null);
    assert.equal(await isTracked(dir, path.join(dir, 'a.txt'), { noCache: true }), false);
  } finally {
    removeDir(dir);
  }
});

test('git：能列出被跟踪的文件（POSIX 相对路径、小写比较键）', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeRepo({ 'a.txt': 'a', 'src/fix-imports.ps1': 'x', 'docs/note.log': 'n' });
  try {
    const info = await gitTrackedFiles(dir);
    assert.ok(info, '应该识别出仓库根');
    assert.ok(info.files.has('a.txt'));
    // 统一成 POSIX 分隔 + 小写
    assert.ok(info.files.has('src/fix-imports.ps1'));
    assert.ok(info.files.has('docs/note.log'));
    // 反斜杠写法不该出现在集合里
    assert.ok(![...info.files].some((f) => f.includes('\\')));
  } finally {
    removeDir(dir);
  }
});

test('git：仓库子目录也能问对（keyOf 会剥掉仓库根前缀）', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeRepo({ 'sub/a.txt': 'a' });
  try {
    const sub = path.join(dir, 'sub');
    const info = await gitTrackedFiles(sub);
    assert.ok(info);
    assert.equal(_keyOf(info.repoRoot, path.join(sub, 'a.txt')), 'sub/a.txt');
    assert.equal(await isTracked(sub, path.join(sub, 'a.txt'), { noCache: true }), true);
    assert.equal(await isTracked(sub, path.join(sub, 'missing.txt'), { noCache: true }), false);
  } finally {
    removeDir(dir);
  }
});

test('git：partitionTracked 分拣 tracked/untracked，且保留原始绝对路径', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeRepo({ 'kept.txt': 'k' });
  const loose = path.join(dir, 'fix-loose.ps1');
  fs.writeFileSync(loose, 'x');
  try {
    const trackedPath = path.join(dir, 'kept.txt');
    const r = await partitionTracked(dir, [trackedPath, loose], { noCache: true });
    assert.equal(r.available, true);
    assert.equal(r.tracked.size, 1);
    assert.ok(r.tracked.has(trackedPath));
    assert.equal(r.untracked.size, 1);
    assert.ok(r.untracked.has(loose));
  } finally {
    removeDir(dir);
  }
});

test('git：非仓库时 partitionTracked 把全部路径归入 untracked 并标 available=false', async () => {
  const dir = makeTempDir('nogit2');
  const p = path.join(dir, 'x.txt');
  fs.writeFileSync(p, 'x');
  try {
    const r = await partitionTracked(dir, [p], { noCache: true });
    assert.equal(r.available, false);
    assert.equal(r.tracked.size, 0);
    assert.equal(r.untracked.size, 1);
  } finally {
    removeDir(dir);
  }
});

test('scan：已跟踪的临时脚本照样列出，但标 tracked + 建议 review', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeRepo({ 'fix-tracked.ps1': 'x' });
  fs.writeFileSync(path.join(dir, 'fix-loose.ps1'), 'y');
  try {
    clearGitCache();
    const { items, summary, git } = await scan(dir, { scripts: [] });
    assert.equal(git.available, true);
    assert.equal(summary.tracked, 1);

    const tracked = items.find((i) => i.relative === 'fix-tracked.ps1');
    assert.ok(tracked, '被跟踪的文件也要出现在清单里（方案 B）');
    assert.equal(tracked.tracked, true);
    assert.equal(tracked.suggestion, 'review');
    assert.match(tracked.reason, /已被 git 跟踪/);

    const loose = items.find((i) => i.relative === 'fix-loose.ps1');
    assert.ok(loose);
    assert.equal(loose.tracked, false);
  } finally {
    removeDir(dir);
  }
});

test('scan：skipTracked=true 时被跟踪的文件完全不出现在清单里', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeRepo({ 'fix-tracked.ps1': 'x' });
  fs.writeFileSync(path.join(dir, 'fix-loose.ps1'), 'y');
  try {
    clearGitCache();
    const { items, summary } = await scan(dir, { scripts: [] }, { skipTracked: true });
    assert.equal(items.some((i) => i.relative === 'fix-tracked.ps1'), false);
    assert.equal(items.some((i) => i.relative === 'fix-loose.ps1'), true);
    assert.equal(summary.tracked, 0);
  } finally {
    removeDir(dir);
  }
});

test('scan：非 git 仓库时给出 trackedNotice，扫描照常返回结果', async () => {
  const dir = makeTempDir('nogit3');
  fs.writeFileSync(path.join(dir, 'fix-loose.ps1'), 'y');
  try {
    clearGitCache();
    const { items, git } = await scan(dir, { scripts: [] });
    assert.equal(git.available, false);
    assert.ok(git.trackedNotice, '应该告诉用户保护没生效');
    assert.ok(items.some((i) => i.relative === 'fix-loose.ps1'));
    assert.ok(items.every((i) => i.tracked === false));
  } finally {
    removeDir(dir);
  }
});

test('git 缓存：同一工作区第二次调用不再起进程（noCache 时才重新问）', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeRepo({ 'a.txt': 'a' });
  try {
    clearGitCache();
    const first = await trackedFileSet(dir);
    assert.ok(first);
    // 提交一个新文件后、缓存未过期：仍读旧快照
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    const cached = await trackedFileSet(dir, { ttlMs: 60000 });
    assert.equal(cached.files.has('b.txt'), false);
    // 绕开缓存就能看到新状态
    const fresh = await trackedFileSet(dir, { noCache: true });
    assert.equal(fresh.files.has('b.txt'), true);
  } finally {
    removeDir(dir);
    clearGitCache();
  }
});
