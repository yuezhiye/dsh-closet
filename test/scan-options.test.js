/**
 * 回归测试：scan() 的 maxDepth / ignorePatterns 必须真的生效。
 *
 * 背景：这两个选项曾经在 scan() 的签名里写着、在 index.js 里传着，但内部调用 walk() 时
 * 只传了 `{ ignore }`，于是配置项静默失效 —— 用户改了配置毫无反应，也不报错。
 * 这类「写了但没接线」的 bug 只能靠断言行为来防。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { scan } from '../lib/scan.js';
import { makeTempDir, removeDir } from './helpers.js';

const REGISTRY = { schemaVersion: 1, updatedAt: new Date().toISOString(), scripts: [] };

/** 造一棵固定形状的树（全部用「像临时脚本」的名字，确保能进扫描结果） */
async function makeTree() {
  const dir = await makeTempDir('closet-scan-');
  await fsp.mkdir(path.join(dir, 'deep', 'a', 'b', 'c'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'vendored'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'fix-root.ps1'), 'echo root\n');
  await fsp.writeFile(path.join(dir, 'deep', 'a', 'b', 'c', 'fix-deep.ps1'), 'echo deep\n');
  await fsp.writeFile(path.join(dir, 'vendored', 'fix-vendor.ps1'), 'echo vendor\n');
  await fsp.writeFile(path.join(dir, 'src', 'fix-src.ps1'), 'echo src\n');
  await fsp.writeFile(path.join(dir, 'notes.bak'), 'backup\n');
  return dir;
}

test('ignorePatterns：目录名忽略会跳过整棵子树', async () => {
  const dir = await makeTree();
  try {
    const all = await scan(dir, REGISTRY, {});
    assert.ok(
      all.items.some((i) => i.relative.includes('vendored')),
      '前提：不忽略时应该能扫到 vendored 下的文件',
    );

    const filtered = await scan(dir, REGISTRY, { ignorePatterns: ['vendored'] });
    assert.equal(
      filtered.items.filter((i) => i.relative.includes('vendored')).length,
      0,
      'ignorePatterns=["vendored"] 应跳过整棵 vendored 子树',
    );
    // 其它文件仍在，说明不是「把什么都忽略了」
    assert.ok(filtered.items.some((i) => i.relative === 'fix-root.ps1'), '不该误伤根目录文件');
  } finally {
    await removeDir(dir);
  }
});

test('ignorePatterns：通配符按文件名忽略', async () => {
  const dir = await makeTree();
  try {
    const r = await scan(dir, REGISTRY, { ignorePatterns: ['*.bak'] });
    assert.equal(r.items.filter((i) => i.relative === 'notes.bak').length, 0, '*.bak 应被忽略');
    assert.ok(r.items.some((i) => i.relative === 'fix-root.ps1'), '不该误伤脚本');
  } finally {
    await removeDir(dir);
  }
});

test('ignorePatterns：写错的配置不能导致「全部忽略」', async () => {
  const dir = await makeTree();
  try {
    // 传一堆垃圾值，行为应等价于「没有忽略项」
    const r = await scan(dir, REGISTRY, { ignorePatterns: ['', null, 42, {}, undefined] });
    assert.ok(r.items.length > 0, '非法忽略项应被丢弃，而不是让结果变成空清单');
    assert.ok(r.items.some((i) => i.relative === 'fix-root.ps1'));
  } finally {
    await removeDir(dir);
  }
});

test('maxDepth：深层文件应被截断', async () => {
  const dir = await makeTree();
  try {
    const deepRel = 'deep/a/b/c/fix-deep.ps1';
    const shallow = await scan(dir, REGISTRY, { maxDepth: 2 });
    assert.equal(
      shallow.items.filter((i) => i.relative === deepRel).length,
      0,
      `maxDepth=2 时不该扫到 ${deepRel}`,
    );

    const deep = await scan(dir, REGISTRY, { maxDepth: 8 });
    assert.equal(
      deep.items.filter((i) => i.relative === deepRel).length,
      1,
      'maxDepth=8 时应扫到深层文件',
    );
  } finally {
    await removeDir(dir);
  }
});

test('默认参数：不传 maxDepth/ignorePatterns 时行为与旧版一致', async () => {
  const dir = await makeTree();
  try {
    const r = await scan(dir, REGISTRY, {});
    const rels = r.items.map((i) => i.relative).sort();
    assert.deepEqual(rels, [
      'deep/a/b/c/fix-deep.ps1',
      'fix-root.ps1',
      'notes.bak',
      'src/fix-src.ps1',
      'vendored/fix-vendor.ps1',
    ]);
    assert.equal(r.truncated, false);
  } finally {
    await removeDir(dir);
  }
});
