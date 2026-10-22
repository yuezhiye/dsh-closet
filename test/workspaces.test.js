/**
 * 回归测试：工作区清单（lib/workspaces.js）。
 *
 * 背景：面板旧版只有「手打路径」一个入口，用户得自己记住工作区的完整路径怎么拼。
 * 0.1.7 加了工作区下拉，数据源是 DSH 自己的登记表。这里守四件事：
 *  1. 三种登记表形状（v2 tables / 数组 / 映射）都能解析出来；
 *  2. 官方服务拿得到就用服务，拿不到才读文件，两者形状一致；
 *  3. 目录被删的工作区必须标 exists:false（否则面板显示成「没有脚本」，像数据丢了）；
 *  4. 任何异常都降级成 `{ok:false, workspaces:[]}` 而不抛错 —— 这个功能是「省事」，
 *     不该成为新的失败点，用户仍能手打路径。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  dshHome,
  workspaceFile,
  extractWorkspaces,
  sortWorkspaces,
  listWorkspaces,
  MAX_WORKSPACES,
} from '../lib/workspaces.js';
import { makeTempDir } from './helpers.js';

/** 造一份登记表文件，返回路径 */
async function writeRegistry(dir, data) {
  const file = path.join(dir, 'workspace.json');
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

test('dshHome / workspaceFile：优先 DSH_HOME，否则 ~/.dsh', () => {
  const withEnv = dshHome({ DSH_HOME: 'D:\\custom-home' });
  assert.equal(path.resolve(withEnv), path.resolve('D:\\custom-home'));
  assert.equal(workspaceFile({ DSH_HOME: 'D:\\custom-home' }), path.join(path.resolve('D:\\custom-home'), 'storages', 'workspace.json'));

  const noEnv = dshHome({});
  assert.ok(noEnv.endsWith('.dsh'), `缺 DSH_HOME 时应回退到 ~/.dsh，实际 ${noEnv}`);
  // 空字符串不该被当成有效值（否则会 resolve 成当前目录）
  assert.ok(dshHome({ DSH_HOME: '   ' }).endsWith('.dsh'));
});

test('extractWorkspaces：v2 tables / 数组 / 映射三种形状都能解析', () => {
  const v2 = extractWorkspaces({
    unit: 'desktop',
    global: { defaultWorkspaceId: 'a' },
    tables: { workspaces: { a: { path: 'E:\\a', title: 'A' }, b: { path: 'E:\\b' } } },
  });
  assert.equal(v2.length, 2);
  assert.deepEqual(
    v2.map((x) => x.id).sort(),
    ['a', 'b'],
    '映射形状必须把 key 补成 id',
  );

  const arr = extractWorkspaces({ workspaces: [{ id: 'x', path: 'E:\\x' }] });
  assert.equal(arr.length, 1);
  assert.equal(arr[0].id, 'x');

  const map = extractWorkspaces({ workspaces: { y: { path: 'E:\\y' } } });
  assert.equal(map.length, 1);
  assert.equal(map[0].id, 'y');

  // 乱七八糟的输入一律返回空数组，不抛
  assert.deepEqual(extractWorkspaces(null), []);
  assert.deepEqual(extractWorkspaces({}), []);
  assert.deepEqual(extractWorkspaces({ workspaces: 'oops' }), []);
});

test('sortWorkspaces：最近更新的在前，同时间按标题', () => {
  const list = [
    { title: 'old', updatedAt: '2026-01-01T00:00:00.000Z' },
    { title: 'new', updatedAt: '2026-10-01T00:00:00.000Z' },
    { title: 'bbb', updatedAt: null },
    { title: 'aaa', updatedAt: null },
  ];
  const sorted = sortWorkspaces(list);
  assert.deepEqual(
    sorted.map((x) => x.title),
    ['new', 'old', 'aaa', 'bbb'],
  );
});

test('listWorkspaces：读文件模式返回形状正确的清单，且目录存在性被标注', async () => {
  const dir = await makeTempDir('closet-ws-');
  const live = path.join(dir, 'live-project');
  await fsp.mkdir(live, { recursive: true });
  const gone = path.join(dir, 'gone-project'); // 不创建 —— 模拟目录被删

  const file = await writeRegistry(dir, {
    unit: 'desktop',
    global: { defaultWorkspaceId: 'ws-1' },
    tables: {
      workspaces: {
        'ws-1': { path: live, title: '活着', sessionIds: ['s1', 's2'], updatedAt: '2026-10-22T01:00:00.000Z' },
        'ws-2': { path: gone, title: '没了', sessionIds: [], updatedAt: '2026-10-21T01:00:00.000Z' },
        'ws-3': { title: '没有 path 的脏数据' },
      },
    },
  });

  const r = await listWorkspaces(null, { file });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'file');
  assert.equal(r.error, null);
  assert.equal(r.workspaces.length, 2, '没有 path 的脏条目应被丢掉');

  const live0 = r.workspaces[0];
  assert.equal(live0.title, '活着', '最近更新的应排第一');
  assert.equal(live0.path, live);
  assert.equal(live0.sessions, 2);
  assert.equal(live0.isDefault, true);
  assert.equal(live0.exists, true);

  const gone0 = r.workspaces[1];
  assert.equal(gone0.exists, false, '目录被删必须标 exists:false');
  assert.equal(gone0.isDefault, false);
});

test('listWorkspaces：服务优先于文件，服务形状与文件一致', async () => {
  const dir = await makeTempDir('closet-ws-svc-');
  const svcPath = path.join(dir, 'svc-project');
  await fsp.mkdir(svcPath, { recursive: true });
  // 文件里放一个**不该被用到**的工作区
  const file = await writeRegistry(dir, { workspaces: [{ id: 'from-file', path: dir }] });

  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined;
      return {
        list: () => [
          {
            get id() {
              return 'svc-1';
            },
            get path() {
              return svcPath;
            },
            get title() {
              return '来自服务';
            },
            get sessionIds() {
              return ['a'];
            },
            get updatedAt() {
              return '2026-10-22T02:00:00.000Z';
            },
          },
        ],
      };
    },
  };

  const r = await listWorkspaces(ctx, { file });
  assert.equal(r.source, 'service');
  assert.equal(r.workspaces.length, 1);
  assert.equal(r.workspaces[0].id, 'svc-1');
  assert.equal(r.workspaces[0].title, '来自服务');
  assert.equal(r.workspaces[0].sessions, 1);
  assert.equal(r.workspaces[0].exists, true);

  // 服务抛错 ⇒ 自动降级到文件
  const broken = {
    get: () => ({
      list() {
        throw new Error('registry exploded');
      },
    }),
  };
  const fallback = await listWorkspaces(broken, { file });
  assert.equal(fallback.source, 'file');
  assert.equal(fallback.workspaces[0].id, 'from-file');

  // 服务返回空数组 ⇒ 也算「没拿到」，继续读文件
  const empty = { get: () => ({ list: () => [] }) };
  assert.equal((await listWorkspaces(empty, { file })).source, 'file');

  // 显式 service:false ⇒ 不碰服务
  assert.equal((await listWorkspaces(ctx, { file, service: false })).source, 'file');
});

test('listWorkspaces：文件缺失 / JSON 损坏 / 带 BOM 都不抛错', async () => {
  const dir = await makeTempDir('closet-ws-bad-');

  const missing = await listWorkspaces(null, { file: path.join(dir, 'nope.json') });
  assert.equal(missing.ok, false);
  assert.equal(missing.source, 'none');
  assert.deepEqual(missing.workspaces, []);
  assert.match(missing.error, /没找到/);

  const badFile = path.join(dir, 'bad.json');
  await fsp.writeFile(badFile, '{ not json', 'utf8');
  const bad = await listWorkspaces(null, { file: badFile });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不是合法 JSON/);

  // 真实文件带 BOM（DSH 自己写的时候会带）
  const bomFile = path.join(dir, 'bom.json');
  const body = JSON.stringify({ workspaces: [{ id: 'b', path: dir }] });
  await fsp.writeFile(bomFile, '\uFEFF' + body, 'utf8');
  const bom = await listWorkspaces(null, { file: bomFile });
  assert.equal(bom.ok, true);
  assert.equal(bom.workspaces.length, 1);
  assert.equal(bom.workspaces[0].id, 'b');
});

test('listWorkspaces：超过上限会被截断，不会把面板撑爆', async () => {
  const dir = await makeTempDir('closet-ws-cap-');
  const workspaces = {};
  for (let i = 0; i < MAX_WORKSPACES + 20; i += 1) {
    workspaces[`w${i}`] = { path: dir, title: `t${i}`, updatedAt: '2026-10-01T00:00:00.000Z' };
  }
  const file = await writeRegistry(dir, { tables: { workspaces } });
  const r = await listWorkspaces(null, { file });
  assert.equal(r.workspaces.length, MAX_WORKSPACES);
});
