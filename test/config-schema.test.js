/**
 * 回归测试：Config 必须是「内核能认」的原生 schema 形状。
 *
 * 背景：0.1.1 及以前，lib/config.js 在拿不到 @deepseek-ai/schemastery 时把 Config
 * 退化成 `(value) => normalizeConfig(value)` —— 一个纯函数。内核加载时用
 * isNativeConfigSchema 判定，四条一条都不满足，于是启动即报：
 *   dsh: error: [/96] Config is not a native Schemastery schema
 * 这个 bug 单测和冒烟都测不出来（它们不经过 Loader），只有真装进 profile 才暴露。
 * 所以这里把内核那段判定原样抄过来，钉死在测试里。
 *
 * 判定源码位于 H:\ai\dsh\resources\app.asar（isNativeConfigSchema，1.x 版本 411670 行）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Config, CONFIG_FIELDS, DEFAULTS, normalizeConfig } from '../lib/config.js';

/**
 * 与内核 isNativeConfigSchema 逐字等价的判定。
 * 任何一条不满足，DSH 启动就会把该插件标成 unsupported 并报错。
 */
function isNativeConfigSchema(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const meta = Reflect.get(value, 'meta');
  return (
    Reflect.get(value, Symbol.for('schemastery')) === true &&
    typeof Reflect.get(value, 'type') === 'string' &&
    meta !== null &&
    typeof meta === 'object'
  );
}

test('Config 通过内核四条判定，不会被判 unsupported', () => {
  assert.equal(isNativeConfigSchema(Config), true, 'Config 必须满足 isNativeConfigSchema');
});

test('Config 携带 schemastery 标记与类型名', () => {
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true);
  assert.equal(typeof Reflect.get(Config, 'type'), 'string');
  assert.equal(Reflect.get(Config, 'type'), 'object');
});

test('Config.meta 是对象且带默认值', () => {
  const meta = Reflect.get(Config, 'meta');
  assert.ok(meta && typeof meta === 'object');
  assert.ok(meta.default && typeof meta.default === 'object', 'meta.default 应是完整默认配置');
  assert.deepEqual(meta.default, normalizeConfig({}));
});

test('Config.validate 收任意输入并归一化，不抛错', () => {
  const out = Config.validate({ maxScanFiles: 'abc', dataDir: '../etc', ignore: 'not-an-array' });
  assert.equal(out.maxScanFiles, DEFAULTS.maxScanFiles, '非法数字应退回默认值');
  assert.equal(out.dataDir, DEFAULTS.dataDir, '带 .. 的 dataDir 必须退回默认值');
  assert.deepEqual(out.ignore, DEFAULTS.ignore, '非数组的 ignore 必须退回默认值');
  assert.deepEqual(Config.validate(undefined), normalizeConfig({}), 'undefined 也应有完整配置');
});

test('Config 的 Standard Schema 接口可用', () => {
  const std = Reflect.get(Config, '~standard');
  assert.ok(std && typeof std === 'object', '应暴露 ~standard');
  assert.equal(typeof std.validate, 'function');
  const result = std.validate({ maxScanDepth: 3 });
  assert.equal(result.value.maxScanDepth, 3);
});

test('CONFIG_FIELDS 覆盖 DEFAULTS 的每个键', () => {
  const keys = CONFIG_FIELDS.map((f) => f.key).sort();
  assert.deepEqual(keys, Object.keys(DEFAULTS).sort(), '字段清单必须与 DEFAULTS 一一对应');
  for (const field of CONFIG_FIELDS) {
    assert.equal(typeof field.description, 'string');
    assert.ok(field.description.length > 4, `${field.key} 应有可读说明`);
    assert.ok(['boolean', 'string', 'number', 'array', 'object'].includes(field.type));
  }
});

test('反面用例：纯函数式 Config 会被判定拒绝（钉住这个错误写法）', () => {
  const broken = (value) => normalizeConfig(value);
  assert.equal(isNativeConfigSchema(broken), false, '纯函数不是原生 schema —— 这就是 0.1.1 的 bug');
  assert.equal(isNativeConfigSchema(undefined), false);
  assert.equal(isNativeConfigSchema({ type: 'object' }), false, '缺 schemastery 标记不行');
});
