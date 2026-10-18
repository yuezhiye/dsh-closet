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
 * schemastery 版的 Config。
 *
 * 用动态 import 包一层：这样纯 Node 环境（单测、CLI 自测）import 本文件时不会因为
 * 找不到 @deepseek-ai/schemastery 而整个模块挂掉。内核加载插件时是异步环境，能正常拿到。
 */
let ConfigSchema = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  const z = mod.default || mod;
  ConfigSchema = z.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    dataDir: z.string().default(DEFAULTS.dataDir),
    trashRetentionDays: z.number().default(DEFAULTS.trashRetentionDays),
    ignore: z.array(z.string()).default([]),
    maxScanFiles: z.number().default(DEFAULTS.maxScanFiles),
    maxScanDepth: z.number().default(DEFAULTS.maxScanDepth),
    runTimeoutMs: z.number().default(DEFAULTS.runTimeoutMs),
    maxLogBytes: z.number().default(DEFAULTS.maxLogBytes),
    maxCleanBatch: z.number().default(DEFAULTS.maxCleanBatch),
    maxCleanBytes: z.number().default(DEFAULTS.maxCleanBytes),
    interpreters: z.dict(z.string()).default({}),
  });
} catch {
  // 没有内核依赖时退化为纯 JS 归一化：Config 用一个能被当函数调用的对象顶上，
  // schemastery 兼容的最小接口，至少能被 Loader 调用而不崩。
  // 注意不能写成 `{ (value) { ... } }` —— 那是对象方法简写，不是可调用对象。
  ConfigSchema = (value) => normalizeConfig(value);
}

export const Config = ConfigSchema;
