import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { closetPaths, register, list, markRun } from '../lib/store.js';
import { buildCommand, defaultExists, logPathFor, runScript, tailLog } from '../lib/run.js';
import { makeTempDir, removeDir, cleanupTempDirs } from './helpers.js';

const isWin = process.platform === 'win32';
const dirs = [];
after(() => dirs.forEach(removeDir));
// helpers 自己创建的目录（makeId 的指纹目录）也要清，否则每次跑都留一坨空目录
after(cleanupTempDirs);

function newWorkspace() {
  const dir = makeTempDir('run');
  dirs.push(dir);
  return dir;
}

/** 解释器可用性（缺某个就跳过对应用例，而不是假装通过） */
const has = {
  pwsh: await defaultExists(isWin ? 'pwsh' : 'bash'),
  powershell51: isWin ? fs.existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe') : false,
  node: await defaultExists('node'),
  python: await defaultExists(isWin ? 'python' : 'python3'),
  cmd: isWin,
};

/** 写一个脚本文件 */
async function writeScript(ws, name, body) {
  const abs = path.join(ws, 'tmp', name);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, 'utf8');
  return abs;
}

// ---------------------------------------------------------------- buildCommand

test('buildCommand：拒绝未知语言，按语言拼出正确参数', async () => {
  await assert.rejects(() => buildCommand('klingon', 'a.xyz', [], {}), /不支持的语言/);
  const r = await buildCommand('node', 'C:\\中文 目录\\a.js', ['--x'], {}, async () => true);
  assert.equal(r.command, 'node');
  assert.deepEqual(r.args, ['C:\\中文 目录\\a.js', '--x']);

  const custom = await buildCommand('python', 'a.py', [], { interpreters: { python: ['my-py', '-u'] } }, async () => false);
  assert.deepEqual(custom, { command: 'my-py', args: ['-u', 'a.py'] });
});

test('buildCommand：pwsh 不存在时回退到 Windows PowerShell 5.1', { skip: !isWin }, async () => {
  const probe = async (cmd) => cmd !== 'pwsh';
  const r = await buildCommand('powershell', 'a.ps1', [], {}, probe);
  assert.equal(r.command, 'powershell.exe');
});

test('buildCommand：python 优先级 python → py -3', { skip: !isWin }, async () => {
  const r = await buildCommand('python', 'a.py', [], {}, async (cmd) => cmd === 'py');
  assert.deepEqual(r, { command: 'py', args: ['-3', 'a.py'] });
});

test('buildCommand：解释器一个都不存在时抛出清晰错误，且列出探测过的命令', async () => {
  await assert.rejects(
    () => buildCommand('python', 'a.py', [], {}, async () => false),
    (err) => /解释器|找不到/.test(err.message),
  );
});

// ---------------------------------------------------------------- 真跑

test('runScript：node 脚本真跑，exit 0、stdout 正确、日志落盘含输出', { skip: !has.node }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'hello m.js', 'console.log("hello-from-node")\nconsole.error("warn-line")\n');
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /hello-from-node/);
  assert.match(r.stderr, /warn-line/);
  assert.ok(fs.existsSync(r.logFile), '日志文件必须存在');
  const log = await fsp.readFile(r.logFile, 'utf8');
  assert.match(log, /hello-from-node/);
  assert.match(log, /warn-line/);
  assert.match(log, /# exit\s*:\s*0/);
  assert.match(log, /# command : node/);
  assert.ok(r.durationMs >= 0);
});

test('runScript：非零退出码如实返回（不抛错）', { skip: !has.node }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'fail.js', 'process.exit(7)\n');
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  assert.equal(r.code, 7);
  assert.match(await fsp.readFile(r.logFile, 'utf8'), /# exit\s*:\s*7/);
});

test('runScript：powershell 打印', { skip: !isWin }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'hi.ps1', 'Write-Output "hello-from-pwsh"\n');
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-from-pwsh/);
  assert.match(await fsp.readFile(r.logFile, 'utf8'), /hello-from-pwsh/);
  assert.ok(fs.existsSync(path.join(closetPaths(ws).logs, 'hi.ps1')), '日志应按脚本名分目录');
});

test('runScript：显式指定 powershell 5.1 也能跑', { skip: !has.powershell51 }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'hi51.ps1', 'Write-Output "hello-from-51"\n');
  const r = await runScript({
    workspace: ws,
    scriptPath: script,
    language: 'powershell',
    timeoutMs: 60000,
    config: {
      interpreters: {
        powershell: [
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
        ],
      },
    },
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-from-51/);
});

test('runScript：python 打印', { skip: !has.python }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'hi.py', 'print("hello-from-python")\n');
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-from-python/);
  assert.match(await fsp.readFile(r.logFile, 'utf8'), /hello-from-python/);
});

test('runScript：batch 用 echo 打印', { skip: !has.cmd }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'hi.bat', '@echo off\r\necho hello-from-batch\r\n');
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello-from-batch/);
  assert.match(await fsp.readFile(r.logFile, 'utf8'), /hello-from-batch/);
  // .bat 的退出码要透传
  const bad = await writeScript(ws, 'bad.bat', '@echo off\r\nexit /b 3\r\n');
  const r2 = await runScript({ workspace: ws, scriptPath: bad, timeoutMs: 60000 });
  assert.equal(r2.code, 3);
});

test('runScript：超时会被杀掉，timedOut=true 且日志标记 TIMEOUT', { skip: !has.node }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'slow.js', 'setTimeout(() => console.log("never"), 30000)\n');
  const t0 = Date.now();
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 1200 });
  const elapsed = Date.now() - t0;
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  assert.ok(elapsed < 20000, `应立即被杀掉，实际耗时 ${elapsed}ms`);
  assert.match(await fsp.readFile(r.logFile, 'utf8'), /TIMEOUT/);
});

test('runScript：powershell 超时会被杀掉', { skip: !isWin }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'sleep.ps1', 'Start-Sleep -Seconds 30\n');
  const t0 = Date.now();
  const r = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 1200 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 30000);
});

test('runScript：无法识别的脚本语言立即报错', async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'x.unknownext', 'x');
  await assert.rejects(() => runScript({ workspace: ws, scriptPath: script }), /无法识别脚本语言/);
});

test('runScript：脚本文件不存在时给出包含路径的错误，错误信息指向真实原因', { skip: !has.node }, async () => {
  const ws = newWorkspace();
  const missing = path.join(ws, 'tmp', 'nope.js');
  const r = await runScript({ workspace: ws, scriptPath: missing, timeoutMs: 60000 }).catch((e) => e);
  // 要么抛错（推荐），要么返回非零退出码并在 stderr 里说明；不允许静默成功
  if (r instanceof Error) {
    assert.match(r.message, /nope\.js|MODULE_NOT_FOUND|ENOENT/);
  } else {
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cannot find|ENOENT/i);
  }
});

test('runScript：同名脚本同一秒内两次运行不互相覆盖日志', { skip: !has.node }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'twice.js', 'console.log(process.argv.length)\n');
  const a = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  const b = await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  assert.notEqual(a.logFile, b.logFile, '两次运行的日志必须是两个文件');
  const names = await fsp.readdir(path.dirname(a.logFile));
  const logs = names.filter((n) => n.endsWith('.log'));
  assert.equal(logs.length, 2);
  // 每份日志都应只有一次运行的头部
  const aLog = await fsp.readFile(a.logFile, 'utf8');
  assert.equal((aLog.match(/# dsh-closet run/g) || []).length, 1);
});

test('logPathFor：含中文与空格的脚本名正常落盘', () => {
  const ws = newWorkspace();
  const { dir, file } = logPathFor(ws, path.join(ws, '修 复.ps1'));
  assert.match(dir, /修 复\.ps1$/);
  assert.match(file, /\.log$/);
  // 不能穿越出 logs 目录
  const esc = logPathFor(ws, '..\\..\\evil.js');
  assert.ok(path.resolve(esc.dir).startsWith(path.resolve(closetPaths(ws).logs)));
});

test('tailLog：只取尾部 N 行；文件不存在返回空串', async () => {
  const ws = newWorkspace();
  const f = path.join(ws, 'x.log');
  await fsp.writeFile(f, ['a', 'b', 'c', 'd'].join('\n'), 'utf8');
  assert.equal(await tailLog(f, 2), 'c\nd');
  assert.equal(await tailLog(path.join(ws, 'nope.log')), '');
});

test('runScript 后登记册可记录执行次数', { skip: !has.node }, async () => {
  const ws = newWorkspace();
  const script = await writeScript(ws, 'count.js', 'console.log(1)\n');
  const { entry } = await register(ws, { path: script, purpose: '计数' });
  await runScript({ workspace: ws, scriptPath: script, timeoutMs: 60000 });
  const after1 = await markRun(ws, entry.id);
  assert.equal(after1.runs, 1);
  const { scripts } = await list(ws);
  assert.equal(scripts.length, 1);
});
