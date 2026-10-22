/**
 * closet_clean 的 git 保护闸门（方案 B 的清理侧）。
 *
 * 断言三件事：
 *  1. 只给被跟踪的文件 -> 直接抛 CLOSET_TRACKED_FILE，一个字节都不动；
 *  2. 混合清单 -> 只搬未跟踪的那些，被跟踪的进 failed 并说明原因；
 *  3. 带 force:true -> 放行（用户明确要求时不再拦）。
 *
 * 通过真实工具装配层调用（collectTools + apply 里的假 ctx），确保走的是内核会走的那条路径。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { registerHostStubs } from './host-stubs.js';
registerHostStubs();

import { makeTempDir, removeDir } from './helpers.js';
import { clearGitCache } from '../lib/git.js';

const { apply, toolDefs } = await import('../lib/index.js');

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const GIT = hasGit();

/** 造一个尽量小的假 ctx：只实现 apply() 真正会碰到的接口 */
function makeCtx(workspace) {
  const tools = new Map();
  const disposers = [];
  return {
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    get(name) {
      if (name === 'workingDirectory') return workspace;
      return undefined;
    },
    effect(fn) {
      const off = fn();
      if (typeof off === 'function') disposers.push(off);
      return () => {};
    },
    inject(_names, cb) {
      void _names;
      try {
        return cb({ effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); }, webServer: { register: () => () => {} } });
      } catch {
        return undefined;
      }
    },
    on() {},
    async start() {},
    _tool(name) {
      assert.ok(tools.has(name), `工具 ${name} 未注册`);
      return tools.get(name);
    },
    _dispose() {
      for (const off of disposers.reverse()) {
        try { off(); } catch { /* 忽略 */ }
      }
    },
  };
}

/** 建真仓库 */
function makeRepo(dir, files) {
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', windowsHide: true });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'test');
  run('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  run('add', '-A');
  run('commit', '-q', '-m', 'init');
}

test('closet_clean：全是 git 跟踪文件时整批拒收，文件原地不动', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeTempDir('clean-git');
  makeRepo(dir, { 'fix-a.ps1': 'a', 'fix-b.ps1': 'b' });
  const ctx = makeCtx(dir);
  try {
    await apply(ctx, {});
    clearGitCache();
    const clean = ctx._tool('closet_clean');

    await assert.rejects(
      () => clean.execute({ paths: ['fix-a.ps1', 'fix-b.ps1'], reason: '测试' }, {}),
      (err) => {
        assert.equal(err.code, 'CLOSET_TRACKED_FILE');
        assert.match(err.message, /git 跟踪/);
        return true;
      },
    );

    // 一个都没被搬走
    assert.ok(fs.existsSync(path.join(dir, 'fix-a.ps1')));
    assert.ok(fs.existsSync(path.join(dir, 'fix-b.ps1')));
    const trash = path.join(dir, '.dsh-fix', 'trash');
    const batches = fs.existsSync(trash) ? fs.readdirSync(trash) : [];
    assert.equal(batches.length, 0, '不该产生任何回收站批次');
  } finally {
    ctx._dispose();
    clearGitCache();
    removeDir(dir);
  }
});

test('closet_clean：混合清单只搬未跟踪的，被跟踪的进 failed', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeTempDir('clean-git2');
  makeRepo(dir, { 'fix-tracked.ps1': 'a' });
  fs.writeFileSync(path.join(dir, 'fix-loose.ps1'), 'b');
  const ctx = makeCtx(dir);
  try {
    await apply(ctx, {});
    clearGitCache();
    const clean = ctx._tool('closet_clean');
    const r = await clean.execute({ paths: ['fix-tracked.ps1', 'fix-loose.ps1'], reason: '测试' }, {});

    assert.equal(r.moved, 1);
    assert.equal(r.failed, 1);
    assert.match(r.text, /已被 git 跟踪/);
    // 未跟踪的被搬走，被跟踪的还在原地
    assert.equal(fs.existsSync(path.join(dir, 'fix-loose.ps1')), false);
    assert.equal(fs.existsSync(path.join(dir, 'fix-tracked.ps1')), true);
  } finally {
    ctx._dispose();
    clearGitCache();
    removeDir(dir);
  }
});

test('closet_clean：force=true 时放行被跟踪的文件', { skip: GIT ? false : '本机没有 git' }, async () => {
  const dir = makeTempDir('clean-git3');
  makeRepo(dir, { 'fix-tracked.ps1': 'a' });
  const ctx = makeCtx(dir);
  try {
    await apply(ctx, {});
    clearGitCache();
    const clean = ctx._tool('closet_clean');
    const r = await clean.execute({ paths: ['fix-tracked.ps1'], reason: '确实要清', force: true }, {});
    assert.equal(r.moved, 1);
    assert.equal(fs.existsSync(path.join(dir, 'fix-tracked.ps1')), false);
  } finally {
    ctx._dispose();
    clearGitCache();
    removeDir(dir);
  }
});

test('closet_clean：非 git 仓库照常工作（保护降级不影响正常清运）', async () => {
  const dir = makeTempDir('clean-nogit');
  fs.writeFileSync(path.join(dir, 'fix-loose.ps1'), 'b');
  const ctx = makeCtx(dir);
  try {
    await apply(ctx, {});
    clearGitCache();
    const clean = ctx._tool('closet_clean');
    const r = await clean.execute({ paths: ['fix-loose.ps1'], reason: '测试' }, {});
    assert.equal(r.moved, 1);
  } finally {
    ctx._dispose();
    clearGitCache();
    removeDir(dir);
  }
});

test('工具定义数量与名字符合发布契约', () => {
  const names = toolDefs.map((d) => d.name).sort();
  assert.deepEqual(names, [
    'closet_clean',
    'closet_list',
    'closet_logs',
    'closet_register',
    'closet_run',
    'closet_scan',
    'closet_trash',
    'closet_workspaces',
  ]);
});
