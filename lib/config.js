/**
 * 插件配置。
 *
 * 两件事：
 *  1. 导出 schemastery 的 Config —— Loader 在激活时用 cordis.patch.yml 里该行的 config
 *     做校验并填默认值，配置写错会在加载期就报错，而不是运行到一半才炸。
 *  2. 提供 normalizeConfig() —— 纯 JS 归一化，脱离 DSH 也能测（单测里不 import schemastery）。
 *
 * 之所以还要 normalizeConfig：Config 只在内核加载时生效，直接 import lib/index.js 做单测
 * 时没有 Loader 帮忙填默认值，缺字段会让工具逻辑拿到 undefined。归一化把这条路径兜住。
 */

/** 全部默认值集中在这里，面板与文档都读它，避免三处各写一遍。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  dataDir: '.dsh-fix',
  trashRetentionDays: 30,
  ignore: [],
  maxScanFiles: 5000,
  maxScanDepth: 64,
  runTimeoutMs: 120000,
  maxLogBytes: 2097152,
  /** 单次 closet_clean 允许清运的最大条目数 —— 防止「一把梭」把整个工作区搬进回收站 */
  maxCleanBatch: 200,
  /** 单次清运允许的最大总体积（字节），默认 200MB */
  maxCleanBytes: 200 * 1024 * 1024,
  /** 解释器绝对路径覆盖 */
  interpreters: {},
});

/**
 * 把任意输入归一化成一份完整、类型正确、边界安全的配置。
 * 非法值一律退回默认值而不是抛错 —— 配置有问题时插件仍应可用，只是用保守参数。
 *
 * @param {any} raw
 * @returns {typeof DEFAULTS & { interpreters: Record<string,string> }}
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const num = (v, fallback, min) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };

  let dataDir = typeof src.dataDir === 'string' && src.dataDir.trim() ? src.dataDir.trim() : DEFAULTS.dataDir;
  // dataDir 必须是相对工作区的单层目录名：绝对路径或带 .. 会逃出工作区，
  // 而回收站的安全边界就锚在工作区上 —— 这里提前挡掉。
  dataDir = dataDir.replace(/^[a-zA-Z]:/, '').replace(/^[\\/]+/, '');
  if (dataDir.split(/[\\/]/).includes('..') || /^[\\/]/.test(dataDir) || !dataDir) {
    dataDir = DEFAULTS.dataDir;
  }
  dataDir = dataDir.replace(/[\\/]+$/, '') || DEFAULTS.dataDir;

  const ignore = Array.isArray(src.ignore)
    ? src.ignore.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : DEFAULTS.ignore;

  const interpreters = {};
  if (src.interpreters && typeof src.interpreters === 'object') {
    for (const [k, v] of Object.entries(src.interpreters)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim()) interpreters[k] = v.trim();
    }
  }

  return {
    enabled: src.enabled === false ? false : true,
    dataDir,
    trashRetentionDays: num(src.trashRetentionDays, DEFAULTS.trashRetentionDays, 0),
    ignore,
    maxScanFiles: num(src.maxScanFiles, DEFAULTS.maxScanFiles, 1),
    maxScanDepth: num(src.maxScanDepth, DEFAULTS.maxScanDepth, 1),
    runTimeoutMs: num(src.runTimeoutMs, DEFAULTS.runTimeoutMs, 1),
    maxLogBytes: num(src.maxLogBytes, DEFAULTS.maxLogBytes, 1024),
    maxCleanBatch: num(src.maxCleanBatch, DEFAULTS.maxCleanBatch, 1),
    maxCleanBytes: num(src.maxCleanBytes, DEFAULTS.maxCleanBytes, 0),
    interpreters,
  };
}

/**
 * 每个配置项的说明与默认值 —— 面板、文档、schema 三处共用同一份真源。
 * 顺序即面板里的展示顺序。
 */
const FIELDS = [
  ['enabled', 'boolean', '总开关。关掉后所有 closet_* 工具直接返回禁用提示，不做任何文件操作。'],
  ['dataDir', 'string', '相对工作区的数据目录名，登记册、日志与回收站都放这里。必须是单层目录名，会挡掉绝对路径与 ..'],
  ['trashRetentionDays', 'number', '回收站保留天数，过期才允许真正删除。0 表示永不自动过期。'],
  ['ignore', 'array', '扫描时忽略的目录名或通配模式，例如 node_modules 或 *.bak。'],
  ['maxScanFiles', 'number', '单次扫描最多列出的文件数，超出即截断。'],
  ['maxScanDepth', 'number', '扫描的最大目录层数。'],
  ['runTimeoutMs', 'number', '运行脚本的超时毫秒数，超时会连同子进程整棵树一起终止。'],
  ['maxLogBytes', 'number', '单个日志文件的大小上限（字节），超出即截断尾部写入。'],
  ['maxCleanBatch', 'number', '单次清运允许的最大条目数，防止一把梭把整个工作区搬进回收站。'],
  ['maxCleanBytes', 'number', '单次清运允许的最大总体积（字节），默认 200MB。'],
  ['interpreters', 'object', '解释器绝对路径覆盖，例如 {"python": "C:/Python312/python.exe"}。'],
];

/** schemastery 用它标记「这是我的 schema」——原生 schema 一定带这个符号属性。 */
const SCHEMAY_SYMBOL = Symbol.for('schemastery');

/**
 * 朴素版 schema 对象。
 *
 * 为什么要自己造：内核判定一个插件的 Config 是否可用，只看四个特征——
 *   ① 是对象或函数
 *   ② Reflect.get(value, Symbol.for("schemastery")) === true
 *   ③ typeof Reflect.get(value, "type") === "string"
 *   ④ Reflect.get(value, "meta") 是非 null 的对象
 * （判定函数 isNativeConfigSchema 在 app.asar 里，见 lib/config.js 上方注释）
 * 一条不满足，启动即 `dsh: error: Config is not a native Schemastery schema`。
 *
 * 而 @deepseek-ai/schemastery 在 profile 的 node_modules 里并不存在（它被打包在
 * app.asar 内），插件不能指望运行期 import 到它。所以这里直接按上述四个特征手写
 * 一个兼容对象，validate 走 normalizeConfig —— 内核校验得过，行为也完全可控。
 */
function makeFallbackSchema() {
  const schema = {
    /** schemastery 的「这是原生 schema」标记，内核靠它认人 */
    [SCHEMAY_SYMBOL]: true,
    type: 'object',
    meta: {
      default: normalizeConfig({}),
      description: '收纳间的配置：数据目录、保留天数、扫描与清运上限、解释器覆盖。',
    },
    /** 本 schema 直接接受任意输入并归一化，因此从不拒绝写错的配置（只纠正它）。 */
    validate(value) {
      return normalizeConfig(value);
    },
    /** Standard Schema 接口（schemastery 也实现了它），保留给别的校验器调用。 */
    '~standard': {
      version: 1,
      vendor: 'dsh-closet',
      validate: (value) => ({ value: normalizeConfig(value) }),
    },
    toString: () => 'dsh-closet:config',
  };
  return schema;
}

/**
 * schemastery 版的 Config。
 *
 * 优先用内核自带的 schemastery 构造真 schema（有类型、有面板表单）；拿不到就退回
 * 上面手写的兼容对象 —— 两条路产出的东西都满足 isNativeConfigSchema，不会让插件
 * 在启动期被判 unsupported。
 */
async function buildConfigSchema() {
  try {
    const mod = await import('@deepseek-ai/schemastery');
    const z = mod.default || mod;
    if (z && typeof z.object === 'function') {
      const shape = {};
      for (const [key, kind] of FIELDS.map(([k, t]) => [k, t])) {
        const def = DEFAULTS[key];
        if (kind === 'boolean') shape[key] = z.boolean().default(def);
        else if (kind === 'number') shape[key] = z.number().default(def);
        else if (kind === 'array') shape[key] = z.array(z.string()).default(def);
        else if (kind === 'object' && typeof z.dict === 'function') shape[key] = z.dict(z.string()).default(def);
        else shape[key] = z.any?.().default?.(def) ?? z.any();
      }
      const built = z.object(shape);
      // 极少数版本可能在解构后丢了标记，补上，保证四条件齐全。
      if (Reflect.get(built, SCHEMAY_SYMBOL) !== true) {
        try {
          Reflect.set(built, SCHEMAY_SYMBOL, true);
        } catch {
          return makeFallbackSchema();
        }
      }
      return built;
    }
  } catch {
    // 纯 Node 环境（单测、CLI 自测）拿不到内核依赖，走下面的兜底。
  }
  return makeFallbackSchema();
}

const ConfigSchema = await buildConfigSchema();

export const Config = ConfigSchema;

/** 供测试与面板读取字段清单（键名 + 类型 + 说明）。 */
export const CONFIG_FIELDS = Object.freeze(
  FIELDS.map(([key, type, description]) => Object.freeze({ key, type, description, default: DEFAULTS[key] })),
);
