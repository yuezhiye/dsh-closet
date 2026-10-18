/**
 * killtree.test.js — 验证超时能杀掉整棵进程树
 *
 * 背景：Windows 下 child.kill() 只结束直接子进程。脚本若自己起进程（python 调 ffmpeg、
 * pwsh 里 Start-Process），孙进程会成孤儿继续跑、占住文件句柄。这里用一个「父脚本等待
 * 一个标记文件、子脚本负责创建该文件」的结构证明：超时后子进程确实被杀，不会继续执行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runScript } from '../lib/run.js';
import { makeTempDir, removeDir } from './helpers.js';

test('超时会杀掉整棵进程树（孙进程不会继续执行）', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅在 Windows 上验证 taskkill 进程树行为');
    return;
  }

  const root = await makeTempDir('killtree');
  const workspace = path.join(root, 'ws');
  const marker = path.join(root, 'grandchild-ran.txt');
  await fsp.mkdir(workspace, { recursive: true });

  // 父脚本：先启动一个「等 3 秒后写标记文件」的孙进程，然后父脚本自己睡 30 秒。
  // 超时设为 1500ms：若只杀父进程，孙进程会在 3 秒后写出标记文件；若杀整棵树，则不会。
  const script = path.join(workspace, 'spawner.ps1');
  await fsp.writeFile(
    script,
    [
      `$child = Start-Process -FilePath "powershell.exe" -ArgumentList @(`,
      `  '-NoProfile','-Command','Start-Sleep -Seconds 3; Set-Content -Path "${marker}" -Value ran'`,
      `) -PassThru -WindowStyle Hidden`,
      `Start-Sleep -Seconds 30`,
      ``,
    ].join('\n'),
    'utf8',
  );

  const started = Date.now();
  const result = await runScript({
    workspace,
    scriptPath: script,
    timeoutMs: 1500,
  });
  const elapsed = Date.now() - started;

  // 1) 确实超时并返回，没有被拖到 30 秒
  assert.equal(result.timedOut, true, '应标记为超时');
  assert.ok(elapsed < 15000, `应在超时后很快返回，实际耗时 ${elapsed}ms`);

  // 2) 关键断言：等过孙进程本该执行的时刻，标记文件不应出现
  await new Promise((r) => setTimeout(r, 3500));
  const exists = await fsp.access(marker).then(() => true, () => false);
  assert.equal(exists, false, '孙进程已被一起杀掉，不应写出标记文件');

  await removeDir(root);
});
