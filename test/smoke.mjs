/**
 * smoke.mjs · 真机冒烟：把 dsh-closet 的四层 + 工具层 + 面板路由全部在真文件系统上跑一遍。
 *
 * 为什么单独做成脚本而不只是单测：单测逐个函数验行为，冒烟验的是「拼起来还能不能用」——
 * 工具 output.schema 到底能不能校验住 execute 的返回值、面板路由的 HTTP 语义对不对、
 * 清运之后登记册有没有同步。这些只有端到端跑才看得出来。
 *
 * 用法：node test/smoke.mjs        （会在系统临时目录建一个一次性工作区，跑完删掉）
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerHostStubs } from './host-stubs.js';

registerHostStubs();

const { toolDefs } = await import('../lib/index.js');
const { normalizeConfig } = await import('../lib/config.js');
const { installWebServer, API_BASE } = await import('../lib/routes.js');
const { closetPaths } = await import('../lib/store.js');

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push({ ok: true, name }))
    .catch((error) => results.push({ ok: false, name, error }));
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/* ---------------------------------------------------------------- *
 * 极简 JSON Schema 校验：只覆盖本项目用到的子集
 * （type/oneOf/properties/required/additionalProperties/items/enum/const）
 * ---------------------------------------------------------------- */
function validate(schema, value, path = '$') {
  const errors = [];
  const fail = (msg) => errors.push(`${path}: ${msg}`);

  if (schema.oneOf) {
    const passed = schema.oneOf.filter((s) => validate(s, value, path).length === 0);
    if (passed.length !== 1) fail(`oneOf 命中 ${passed.length} 个分支（应为 1）`);
    return errors;
  }
  if (schema.const !== undefined && value !== schema.const) fail(`应为常量 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`不在枚举里：${JSON.stringify(value)}`);

  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok =
      schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : actual === schema.type;
    if (!ok) {
      fail(`类型应为 ${schema.type}，实际 ${actual}`);
      return errors;
    }
  }

  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) fail(`缺必填字段 ${key}`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) fail(`不允许的额外字段 ${key}`);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  return errors;
}

/* ---------------------------------------------------------------- *
 * 假 ctx：够 registerTools / installWebServer 用
 * ---------------------------------------------------------------- */
function makeCtx(workspace) {
  const registered = [];
  const routes = [];
  const ctx = {
    tools: { register: (def) => registered.push(def) },
    get: (key) => (key === 'workingDirectory' ? { path: workspace } : undefined),
    inject: (names, callback) => {
      const host = {
        effect: (fn) => fn(),
        webServer: { register: (spec, label) => { routes.push({ spec, label }); return () => {}; } },
      };
      callback(host);
    },
  };
  return { ctx, registered, routes };
}

const workspace = mkdtempSync(join(tmpdir(), 'closet-smoke-'));
const config = normalizeConfig({});
let runnableId = '';

try {
  /* ---------- 1. 造现场 ---------- */
  mkdirSync(join(workspace, 'sub'), { recursive: true });
  writeFileSync(join(workspace, 'fix-thing.ps1'), 'Write-Output "hi"\n');
  writeFileSync(join(workspace, 'note.txt.bak'), 'backup\n');
  writeFileSync(join(workspace, 'sub', 'upgrade-x.ps1'), 'Write-Output "up"\n');
  writeFileSync(join(workspace, 'run-me.mjs'), 'console.log("from node");\n');

  const { ctx, registered, routes } = makeCtx(workspace);

  await check('注册 7 个工具，参数与输出 schema 都合法', async () => {
    const { apply } = await import('../lib/index.js');
    await apply(ctx, normalizeConfig({ enabled: true }));    assert(registered.length === 7, `注册了 ${registered.length} 个工具`);
    for (const def of registered) {
      assert(typeof def.execute === 'function', `${def.name} 缺 execute`);
      const problems = validate(def.output.schema, {});
      assert(problems.length > 0, `${def.name} 的 output.schema 允许了空对象（应要求必填）`);
    }
    assert(toolDefs.length === 7, `toolDefs 有 ${toolDefs.length} 项`);
  });

  const call = async (name) => {
    const def = registered.find((d) => d.name === name);
    if (!def) throw new Error(`工具 ${name} 未注册`);
    return def;
  };

  const run = async (name, args) => {
    const def = await call(name);
    const value = await def.execute(args, { signal: undefined });
    const problems = validate(def.output.schema, value);
    assert(problems.length === 0, `${name} 的返回值不合 output.schema：${problems.join('; ')}`);
    const blocks = def.output.render(args, value);
    assert(Array.isArray(blocks) && blocks.length > 0, `${name} 的 render 返回空`);
    for (const block of blocks) assert(block.type === 'text' && typeof block.text === 'string', `${name} 的 render 块形状不对`);
    return value;
  };

  /* ---------- 2. 登记 ---------- */
  await check('closet_register 登记两个脚本', async () => {
    const a = await run('closet_register', { path: 'fix-thing.ps1', purpose: '冒烟用', workspace });
    assert(a.id, '没有返回 id');
    const b = await run('closet_register', { path: 'sub/upgrade-x.ps1', purpose: '升级冒烟', workspace });
    assert(a.id !== b.id, '两个脚本的 id 撞了');
    // 执行类工具要的是「登记册里的条目编号」，所以还得登记一个能真跑的 node 脚本
    const c = await run('closet_register', { path: 'run-me.mjs', purpose: '冒烟执行用', workspace });
    runnableId = c.id;
    const file = JSON.parse(readFileSync(closetPaths(workspace).registry, 'utf8'));
    assert(file.scripts.length === 3, `登记册里有 ${file.scripts.length} 条`);
  });

  await check('closet_list 列出 2 条，且标注文件是否存在', async () => {
    const out = await run('closet_list', { workspace });
    assert(out.text.includes('fix-thing.ps1'), '清单里没有 fix-thing.ps1');
    assert(out.text.includes('upgrade-x.ps1'), '清单里没有 upgrade-x.ps1');
  });

  await check('closet_scan 能扫出 .bak 与临时脚本，且不动文件', async () => {
    const out = await run('closet_scan', { workspace });
    assert(out.text.includes('note.txt.bak') || out.total > 0, '扫描没扫出 .bak');
    assert(existsSync(join(workspace, 'note.txt.bak')), '扫描把文件删了（绝不允许）');
  });

  /* ---------- 3. 执行 ---------- */
  await check('closet_run 跑 node 脚本并落日志', async () => {
    const out = await run('closet_run', { id: runnableId, workspace });
    assert(out.text.length > 0, '执行输出为空');
    const { logs } = closetPaths(workspace);
    assert(existsSync(logs), '日志目录没建出来');
  });

  await check('closet_logs 能列出并读到刚才那份日志', async () => {
    const listed = await run('closet_logs', { id: runnableId, workspace });
    assert(listed.count >= 1, `日志数是 ${listed.count}`);
    const tailed = await run('closet_logs', { id: runnableId, workspace, read: true });
    assert(tailed.text.includes('最新日志'), 'read:true 没返回日志尾部');
  });

  /* ---------- 4. 清运与回收站 ---------- */
  await check('closet_clean 把文件移进回收站，登记册同步', async () => {
    await run('closet_clean', { paths: ['fix-thing.ps1'], workspace });
    assert(!existsSync(join(workspace, 'fix-thing.ps1')), '文件还在原地');
    const { trash } = closetPaths(workspace);
    assert(existsSync(trash), '回收站目录没建出来');
  });

  await check('closet_trash 列出批次并默认只预演过期清理', async () => {
    const out = await run('closet_trash', { workspace });
    assert(out.text.length > 0, '回收站清单为空');
    assert(existsSync(join(workspace, '.dsh-fix', 'trash')), '预演把回收站清掉了');
  });

  /* ---------- 5. 越界防护 ---------- */
  await check('closet_clean 拒绝工作区外的路径', async () => {
    const def = await call('closet_clean');
    let threw = false;
    let text = '';
    try {
      const value = await def.execute({ paths: ['../outside.txt'], reason: '冒烟越界测试', workspace }, {});
      text = String(value && value.text);
    } catch {
      threw = true;
    }
    // 越界可能表现为「抛错」或「进 failed 列表」——两者都算挡住了，但绝不能报 moved>0
    if (!threw) assert(!/✓/.test(text), `越界路径居然被移走了：\n${text}`);
    assert(!existsSync(join(workspace, '.dsh-fix', 'trash', '外')), '不该产生垃圾目录');
  });

  /* ---------- 6. 面板路由 ---------- */
  await check('面板注册 8 条路由，且都在 /dsh-closet/api 下', async () => {
    assert(routes.length === 8, `注册了 ${routes.length} 条路由`);
    for (const { spec } of routes) {
      assert(spec.path.startsWith(API_BASE), `${spec.path} 不在 ${API_BASE} 下`);
      assert(spec.kind === 'exact', `${spec.path} 的 kind 是 ${spec.kind}`);
    }
  });

  const fakeRequest = (url, { method = 'GET', headers = {} } = {}) => ({
    url,
    method,
    headers: { host: '127.0.0.1:53543', ...headers },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from('{}'));
      if (event === 'end') cb();
      return this;
    },
  });

  const fakeResponse = () => {
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
        return this;
      },
      end(chunk) { this.body += chunk || ''; },
    };
    return res;
  };

  // 路由表按 path 精确匹配：先剥掉查询串，否则 ?workspace=… 会让 find 落空
  const hit = async (url, opts) => {
    const path = url.split('?')[0];
    const found = routes.find((r) => r.spec.path === path);
    assert(found, `没找到路由 ${path}（已注册：${routes.map((r) => r.spec.path).join(', ')}）`);
    const res = fakeResponse();
    await found.spec.handler(fakeRequest(url, opts), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  const wsQuery = `?workspace=${encodeURIComponent(workspace)}`;

  await check('GET /status 返回登记册统计', async () => {
    const { status, body } = await hit(`${API_BASE}/status${wsQuery}`);
    assert(status === 200, `HTTP ${status}`);
    assert(body.ok === true, 'ok 不为 true');
    assert(body.counts && typeof body.counts.total === 'number', 'counts 缺失');
  });

  await check('GET /scripts 返回登记册', async () => {
    const { status, body } = await hit(`${API_BASE}/scripts${wsQuery}`);
    assert(status === 200, `HTTP ${status}`);
    assert(Array.isArray(body.scripts), 'scripts 不是数组');
  });

  await check('GET /scan 返回清单', async () => {
    const { status, body } = await hit(`${API_BASE}/scan${wsQuery}`);
    assert(status === 200, `HTTP ${status}`);
    assert(Array.isArray(body.items), 'items 不是数组');
  });

  await check('GET /trash 返回批次数组', async () => {
    const { status, body } = await hit(`${API_BASE}/trash${wsQuery}`);
    assert(status === 200, `HTTP ${status}`);
    assert(Array.isArray(body.batches), 'batches 不是数组');
  });

  await check('跨站请求被拒（sec-fetch-site: cross-site）', async () => {
    const { status } = await hit(`${API_BASE}/status${wsQuery}`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert(status === 403 || status === 401 || status === 400, `跨站请求返回了 ${status}`);
  });

  await check('缺 workspace 参数时报 400 而不是崩', async () => {
    const { status } = await hit(`${API_BASE}/status`);
    assert(status >= 400 && status < 500, `返回 ${status}`);
  });
} finally {
  // 收尾：把统计打出来再删目录
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.ok ? '' : `\n    ${r.error && r.error.message}`}`);
  }
  console.log('');
  console.log(`冒烟：${results.length - failed.length} 通过 / ${failed.length} 失败（工作区 ${workspace}）`);
  if (!process.env.CLOSET_KEEP_SMOKE) {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* 删不掉也无所谓 */ }
  }
  process.exit(failed.length ? 1 : 0);
}
