/**
 * DSH 工作区清单。
 *
 * 面板不用再让用户手打路径：DSH 自己就有一份工作区登记表，这里把它读出来。
 *
 * 两条数据源，优先官方服务：
 *  1. `ctx.workspaceRegistry.list()` —— 内核的 WorkspaceRegistry 服务，返回实体上带
 *     path/title/sessionIds/updatedAt。这是官方 API，形状与服务端一致，能拿到就跑它。
 *  2. 直接读 `$DSH_HOME/storages/workspace.json` —— 上面那个服务的持久化文件，
 *     形状是 v2 的 `{unit, global, tables:{workspaces:{<id>: {...}}}}`。
 *
 * 为什么要兜底：`workspaceRegistry` 是**可选**服务（内核 README 明说缺少必需依赖时
 * workspace 功能会一直不可用），插件不能假设它一定在。拿不到服务时读文件同样能得到
 * 清单，代价是要自己容错文件形状。
 *
 * 只读，不写、不建、不改任何工作区记录。
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 相对 DSH home 的登记表位置。 */
export const WORKSPACE_FILE_REL = path.join('storages', 'workspace.json');

/** 列表里最多返回多少条 —— 下拉框不需要无限长，也防止异常文件把面板撑爆。 */
export const MAX_WORKSPACES = 200;

/**
 * 取 DSH home 目录。
 *
 * 优先环境变量（DSH 自己启动子进程时一定会设），否则回退到 `~/.dsh`。
 * 环境变量是唯一的「真源」，因为 home 可以被 `--home` 之类改到别处。
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/**
 * 登记表文件的绝对路径。
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function workspaceFile(env = process.env) {
  return path.join(dshHome(env), WORKSPACE_FILE_REL);
}

/** 安全取一个可能缺失/可能抛错的 getter。 */
function readProp(obj, key) {
  try {
    const v = obj[key];
    return v === undefined ? undefined : v;
  } catch {
    return undefined;
  }
}

/** 时间统一成 ISO 字符串；取不到就是 null（面板负责显示占位）。 */
function isoOf(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'number') {
    const t = Number.isFinite(value) ? value : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

/**
 * 从登记表 JSON 里抽出工作区数组。
 *
 * 容忍三种形状，因为这是别人写的文件，版本升级会改结构：
 *  · v2：`{ tables: { workspaces: { <id>: { path, title, ... } } } }`（当前实际形状）
 *  · 数组：`{ workspaces: [ { id, path, ... } ] }`
 *  · 映射：`{ workspaces: { <id>: { path, ... } } }`
 *
 * @param {any} data 解析后的 JSON
 * @returns {Array<object>} 未排序的原始条目（带 id）
 */
export function extractWorkspaces(data) {
  if (!data || typeof data !== 'object') return [];

  const raw =
    data.tables && typeof data.tables === 'object' && data.tables.workspaces
      ? data.tables.workspaces
      : data.workspaces && typeof data.workspaces === 'object'
        ? data.workspaces
        : null;

  if (!raw) return [];

  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') out.push(item);
    }
  } else {
    for (const [id, item] of Object.entries(raw)) {
      if (item && typeof item === 'object') out.push({ id, ...item });
    }
  }
  return out;
}

/** 登记表里的默认工作区 id（用来在面板上标「默认」）。 */
function defaultWorkspaceId(data) {
  const g = data && typeof data === 'object' ? data.global : null;
  if (!g || typeof g !== 'object') return null;
  return typeof g.defaultWorkspaceId === 'string' ? g.defaultWorkspaceId : null;
}

/**
 * 把一个原始条目整理成面板要的形状。
 * @param {any} raw
 * @param {string|null} defaultId
 */
function shapeOne(raw, defaultId) {
  const p = readProp(raw, 'path') ?? readProp(raw, 'directory') ?? readProp(raw, 'cwd');
  const id = readProp(raw, 'id') ?? null;
  const sessionIds = readProp(raw, 'sessionIds');
  return {
    id: typeof id === 'string' ? id : null,
    path: typeof p === 'string' ? p : '',
    title: typeof readProp(raw, 'title') === 'string' ? readProp(raw, 'title') : '',
    sessions: Array.isArray(sessionIds) ? sessionIds.length : 0,
    createdAt: isoOf(readProp(raw, 'createdAt')),
    updatedAt: isoOf(readProp(raw, 'updatedAt')),
    isDefault: !!id && id === defaultId,
    /** 目录是否还在 —— 由调用方 stat 后填 */
    exists: null,
  };
}

/**
 * 排序：最近更新的在前；没有时间信息的排后面；同时间按标题。
 * @param {Array<object>} list
 */
export function sortWorkspaces(list) {
  const score = (w) => {
    const t = Date.parse(w.updatedAt || w.createdAt || '');
    return Number.isFinite(t) ? t : 0;
  };
  return list.slice().sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return String(a.title || a.path).localeCompare(String(b.title || b.path));
  });
}

/**
 * 给每项标出目录是否还存在（并发 stat，单项失败不影响其它）。
 *
 * 工作区被别人删掉/挪走很常见，下拉框里得让用户看出来 —— 否则选中一个空目录，
 * 面板会显示成「没有脚本」，让人以为数据丢了。
 *
 * @param {Array<object>} list
 * @returns {Promise<Array<object>>} 原地补 exists 后返回
 */
async function markExists(list) {
  await Promise.all(
    list.map(async (w) => {
      if (!w.path) {
        w.exists = false;
        return;
      }
      try {
        const st = await fsp.stat(w.path);
        w.exists = st.isDirectory();
      } catch {
        w.exists = false;
      }
    }),
  );
  return list;
}

/**
 * 从官方服务读工作区。服务不存在或抛错时返回 null（交给文件兜底）。
 *
 * @param {any} ctx cordis 上下文
 * @returns {Array<object>|null}
 */
export function fromService(ctx) {
  let registry = null;
  try {
    // ctx.get 是 cordis 读服务的标准方式；直接属性访问在部分版本上会被代理拦。
    registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : null;
  } catch {
    registry = null;
  }
  if (!registry && ctx && typeof ctx === 'object') registry = ctx.workspaceRegistry ?? null;
  if (!registry || typeof registry.list !== 'function') return null;

  let raw;
  try {
    raw = registry.list();
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    // 实体是 class 实例，字段是 getter，不能直接展开，逐个读。
    const shaped = shapeOne(
      {
        id: readProp(item, 'id'),
        path: readProp(item, 'path'),
        title: readProp(item, 'title'),
        sessionIds: readProp(item, 'sessionIds'),
        createdAt: readProp(item, 'createdAt'),
        updatedAt: readProp(item, 'updatedAt'),
      },
      null,
    );
    if (shaped.path) out.push(shaped);
  }
  return out;
}

/**
 * 列出工作区清单。
 *
 * 永远不抛错：拿不到就返回 `{ok:false, workspaces:[], error}`，面板据此提示，
 * 用户仍然可以手打路径 —— 这个功能是「省事」，不该成为新的失败点。
 *
 * @param {any} ctx cordis 上下文（可为 null，纯文件模式）
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env] 环境变量（测试注入用）
 * @param {string} [options.file] 直接指定登记表路径（测试注入用）
 * @param {boolean} [options.service=true] 是否先试官方服务
 * @returns {Promise<{ok:boolean, source:'service'|'file'|'none', file:string, workspaces:Array<object>, error:string|null}>}
 */
export async function listWorkspaces(ctx = null, options = {}) {
  const env = options.env || process.env;
  const file = options.file ? path.resolve(options.file) : workspaceFile(env);
  const useService = options.service !== false;

  if (useService && ctx) {
    const fromSvc = fromService(ctx);
    if (fromSvc && fromSvc.length) {
      const shaped = sortWorkspaces(fromSvc).slice(0, MAX_WORKSPACES);
      await markExists(shaped);
      return { ok: true, source: 'service', file, workspaces: shaped, error: null };
    }
  }

  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    const code = err && err.code;
    const error =
      code === 'ENOENT'
        ? `没找到 DSH 的工作区登记表：${file}`
        : `读取工作区登记表失败：${(err && err.message) || err}`;
    return { ok: false, source: 'none', file, workspaces: [], error };
  }

  let data;
  try {
    // DSH 写这个文件时会带 BOM，JSON.parse 不认，先剥掉。
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return {
      ok: false,
      source: 'none',
      file,
      workspaces: [],
      error: `工作区登记表不是合法 JSON：${(err && err.message) || err}`,
    };
  }

  const defaultId = defaultWorkspaceId(data);
  const shaped = extractWorkspaces(data)
    .map((raw) => shapeOne(raw, defaultId))
    .filter((w) => w.path);

  const sorted = sortWorkspaces(shaped).slice(0, MAX_WORKSPACES);
  await markExists(sorted);
  return { ok: true, source: 'file', file, workspaces: sorted, error: null };
}
