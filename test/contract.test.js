/**
 * 契约自检：把「DSH 宿主会怎么校验我们的包」和「前端怎么加载我们的 client.js」
 * 这两件最容易装上去才炸的事，提前在纯 Node 里跑一遍。
 *
 * 为什么值得单独写：
 *  - tools 注册的 JSON Schema 只支持子集，`pattern` / `minLength` / `anyOf` 这类
 *    一律**注册期抛错**。装到 profile 里才发现，就要反复重启 DSH 才能定位。
 *  - client.js 是 CJS factory，不是 ESM；写成 import/export 或 require 到不存在的
 *    模块，只有浏览器里才会白屏，Node 里 `node --check` 看不出来。
 *
 * 这两条都只在 tests 里断言「形状对不对」，不启动任何服务。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { registerHostStubs } from './host-stubs.js';

// 必须在 import lib/index.js 之前生效：它要 import 宿主的 @deepseek-ai/dsh-llm。
registerHostStubs();

const { toolDefs: tools } = await import('../lib/index.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * tools 的 JSON Schema 子集
 * ------------------------------------------------------------------ */

/** 内核支持的注解键，出现在别处一律视为非法。 */
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples']);
/** 内核支持的组合/结构键。 */
const STRUCTURAL = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf']);

const ALLOWED_TYPES = new Set(['string', 'number', 'boolean', 'integer', 'object', 'array', 'null']);

/**
 * 递归检查一个 schema 节点，收集所有问题。
 * 故意把每条都收集完再报，而不是遇错就抛 —— 一次看到全部问题比修一处跑一次快得多。
 */
function checkSchema(schema, trail, issues) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    issues.push(`${trail}: 不是对象`);
    return;
  }

  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!STRUCTURAL.has(key)) {
      issues.push(`${trail}.${key}: 不受支持的键（只允许 type/oneOf/properties/required/additionalProperties/items/enum/const 与注解）`);
    }
  }

  if ('type' in schema) {
    if (Array.isArray(schema.type)) {
      // 数组形式（可空类型）内核不支持，要用 oneOf
      issues.push(`${trail}.type: 不支持数组形式，可空请用 oneOf`);
    } else if (!ALLOWED_TYPES.has(schema.type)) {
      issues.push(`${trail}.type: 非法取值 ${JSON.stringify(schema.type)}`);
    }
  }

  if ('oneOf' in schema) {
    if ('type' in schema) issues.push(`${trail}: type 与 oneOf 互斥`);
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      issues.push(`${trail}.oneOf: 必须是非空数组`);
    } else {
      schema.oneOf.forEach((sub, i) => checkSchema(sub, `${trail}.oneOf[${i}]`, issues));
    }
  }

  if ('properties' in schema) {
    if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      issues.push(`${trail}.properties: 必须是对象`);
    } else {
      for (const name of Object.keys(schema.properties)) {
        checkSchema(schema.properties[name], `${trail}.properties.${name}`, issues);
      }
    }
  }

  if ('required' in schema && !Array.isArray(schema.required)) {
    issues.push(`${trail}.required: 必须是数组`);
  }

  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean') {
    issues.push(`${trail}.additionalProperties: 必须是 boolean`);
  }

  if ('items' in schema) checkSchema(schema.items, `${trail}.items`, issues);

  // enum / const 只用于标量
  for (const key of ['enum', 'const']) {
    if (!(key in schema)) continue;
    const values = key === 'enum' ? schema.enum : [schema.const];
    if (key === 'enum' && (!Array.isArray(values) || values.length === 0)) {
      issues.push(`${trail}.enum: 必须是非空数组`);
      continue;
    }
    values.forEach((value, i) => {
      const kind = typeof value;
      if (!['string', 'number', 'boolean'].includes(kind)) {
        issues.push(`${trail}.${key}[${i}]: 只允许标量（字符串/数字/布尔）`);
      }
      // -0 在序列化后与 0 无法区分，内核视为非法
      if (kind === 'number' && Object.is(value, -0)) {
        issues.push(`${trail}.${key}[${i}]: 不允许 -0`);
      }
    });
  }
}

test('tools 注册的 parameters 只用了内核支持的 JSON Schema 子集', () => {
  assert.ok(Array.isArray(tools) && tools.length > 0, 'tools 应该是一个非空数组');

  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string', '工具缺少 name');
    assert.ok(tool.name.length > 0, '工具 name 不能为空');
    assert.equal(typeof tool.description, 'string', `${tool.name}: 缺少 description`);
    assert.equal(typeof tool.execute, 'function', `${tool.name}: 缺少 execute`);

    const issues = [];
    const params = tool.parameters;
    assert.equal(params && params.type, 'object', `${tool.name}: parameters 顶层必须是 object`);
    checkSchema(params, `${tool.name}.parameters`, issues);

    // required 里的每个键都必须在 properties 里真实存在
    for (const key of params.required || []) {
      if (!params.properties || !(key in params.properties)) {
        issues.push(`${tool.name}.parameters.required: "${key}" 不在 properties 里`);
      }
    }

    assert.deepEqual(issues, [], `${tool.name} 的 schema 不合规：\n  ${issues.join('\n  ')}`);
  }
});

test('tools 的 output 同时提供 schema 与 render，且 render 返回可序列化数组', () => {
  for (const tool of tools) {
    assert.ok(tool.output && typeof tool.output === 'object', `${tool.name}: 缺少 output`);
    assert.equal(typeof tool.output.schema, 'object', `${tool.name}: output.schema 缺失或不是对象`);
    assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render 必须是函数`);

    // 拿最小可行参数跑一次 render，确认它稳定返回 [{type:'text',text}] 形状。
    // 传空参数即可：render 只读 value，不执行副作用。
    const blocks = tool.output.render({}, { text: 'ok' });
    assert.ok(Array.isArray(blocks), `${tool.name}: render 必须返回数组`);
    assert.ok(blocks.length > 0, `${tool.name}: render 不能返回空数组`);
    for (const block of blocks) {
      assert.equal(typeof block, 'object');
      assert.equal(typeof block.text, 'string', `${tool.name}: render 只推荐 {type:'text',text} 块`);
      assert.doesNotThrow(() => JSON.stringify(block), `${tool.name}: render 结果必须可 JSON 序列化`);
    }
  }
});

test('工具名唯一且不与内核保留名 run_code 冲突', () => {
  const seen = new Set();
  for (const tool of tools) {
    assert.notEqual(tool.name, 'run_code', 'run_code 是内核保留名');
    assert.ok(!seen.has(tool.name), `工具名重复：${tool.name}`);
    seen.add(tool.name);
  }
});

/* ------------------------------------------------------------------ *
 * 客户端插件入口
 * ------------------------------------------------------------------ */

test('package.json 的客户端入口与 dsh.client 声明自洽', () => {
  assert.equal(pkg.exports['./client'], './lib/client.js', 'exports["./client"] 是客户端入口的唯一来源');

  const client = pkg.dsh && pkg.dsh.client;
  assert.ok(client, 'package.json 缺少 dsh.client');
  assert.equal(client.platform, 'web', 'platform 必须是 "web"');

  // 只允许这四个键；写了别的会被静默忽略，等于白写
  const allowed = new Set(['platform', 'inject', 'external', 'immediately']);
  const unknown = Object.keys(client).filter((key) => !allowed.has(key));
  assert.deepEqual(unknown, [], `dsh.client 里有内核不认识的键：${unknown.join(', ')}`);

  assert.ok(Array.isArray(client.inject), 'dsh.client.inject 必须是数组');
  for (const name of client.inject) {
    assert.equal(typeof name, 'string');
    assert.ok(pkg.peerDependencies && name in pkg.peerDependencies, `${name} 必须在 peerDependencies 里声明，否则模块图会以 optional 物化并跳过`);
  }
});

test('client.js 是 CJS factory 单文件，不是 ESM', () => {
  const source = readFileSync(join(root, 'lib/client.js'), 'utf8');

  // 外层 ESM 语法检查：包是 type:module，但这个文件由 ModuleLoader 当脚本执行
  assert.ok(!/^\s*import\s/m.test(source), 'client.js 里不能有 import 语句');
  assert.ok(!/^\s*export\s/m.test(source), 'client.js 里不能有 export 语句');

  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'client.js 必须调用 window.__ModuleLoader__.load');

  // 在假 Window 里真的执行一遍 factory，确认它是合法的 CJS 工厂且导出名/依赖对
  const sandbox = { window: {}, setTimeout, clearTimeout, AbortController, fetch: async () => ({ ok: true, json: async () => ({}) }) };
  let captured;
  sandbox.window.__ModuleLoader__ = { load: (spec) => { captured = spec; } };

  const fakeRequire = (name) => {
    if (name === 'react') return { createElement: () => null, useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn) => fn };
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
    if (name === 'react-dom') return {};
    throw new Error(`客户端 require 了外壳基座模块表里没有的模块：${name}`);
  };

  const fn = new Function('window', 'require', 'setTimeout', 'clearTimeout', 'AbortController', 'fetch', source);
  fn(sandbox.window, fakeRequire, setTimeout, clearTimeout, AbortController, sandbox.fetch);

  assert.ok(captured, 'load() 没有被调用');
  assert.equal(typeof captured.id, 'string');
  assert.equal(typeof captured.factory, 'function');

  const exported = captured.factory(fakeRequire);
  assert.equal(typeof exported.apply, 'function', 'client 插件必须导出 apply');
  assert.ok(Array.isArray(exported.inject), 'client 插件必须导出 inject 数组');
  for (const need of ['slots', 'locale']) {
    assert.ok(exported.inject.includes(need), `client 插件 inject 里缺少 "${need}"`);
  }
});
