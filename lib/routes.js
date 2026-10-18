/**
 * 面板 HTTP 路由。
 *
 * 设计约束（踩过的坑，改之前先读）：
 *  1. 面板是**可选能力**。没有 webServer 服务（headless / CLI 形态）时必须静默跳过，
 *     绝不能因为拿不到服务而让整个插件拒绝加载 —— 那样工具也跟着没了。
 *  2. 所有写操作都要经过**同一套闸门**：同源校验 + 方法白名单 + 体积上限 + 工作区边界。
 *     面板跑在浏览器里，同一台机器上的任意网页都可能往 localhost 发请求，不校验 Origin
 *     等于给全网开了个「往你工作区搬文件」的接口。
 *  3. 路由注册必须包在 host.effect() 里，插件被禁用/卸载时自动注销；否则运行期关掉插件，
 *     路由还活着，指向一堆已销毁的闭包。
 *  4. 本文件不直接碰磁盘，全部委托 lib/{store,scan,trash,run}.js，保持可脱机单测。
 */

import fsp from 'node:fs/promises';

import { list as listEntries, closetPaths, readRegistry } from './store.js';
import { scan as scanWorkspace, listLogs } from './scan.js';
import { listTrash, restoreBatch, expireTrash, moveToTrash } from './trash.js';
import { tailLog } from './run.js';

/** 面板接口前缀。改这里要同步改 lib/ui/client.js 里的 API_BASE。 */
export const API_BASE = '/dsh-closet/api';

/** 请求体上限：面板只传路径清单与选项，1MB 足够，超过基本是恶意或写错了。 */
const MAX_BODY_BYTES = 1024 * 1024;

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */

function headerOf(request, name) {
  const headers = request?.headers;
  if (!headers) return '';
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || '');
  return String(value || '');
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

function denyCrossOrigin(response) {
  response.writeHead(403, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify({ ok: false, error: 'cross-origin blocked' }));
}

/**
 * 同源校验。
 *
 * 浏览器跨站请求会带 sec-fetch-site: cross-site，或者带一个 host 对不上的 Origin
 *（DNS rebinding 的典型特征）。两种情况都拒掉。没有 Origin 的请求（curl、本机脚本）
 * 放行 —— 它们不构成浏览器侧的 CSRF 面，而且本地排查时要用。
 */
function allowPluginRequest(request, response) {
  const site = headerOf(request, 'sec-fetch-site').toLowerCase();
  if (site === 'cross-site') {
    denyCrossOrigin(response);
    return false;
  }
  const origin = headerOf(request, 'origin').trim();
  if (origin === 'null') {
    denyCrossOrigin(response);
    return false;
  }
  if (!origin) return true;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  const host = headerOf(request, 'host').trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    denyCrossOrigin(response);
    return false;
  }
  return true;
}

/** 方法不在白名单时直接 405，返回 true 表示已处理完毕。 */
function methodNotAllowed(request, response, allow) {
  if (allow.includes(request.method)) return false;
  response.writeHead(405, { allow: allow.join(', ') });
  response.end();
  return true;
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

/* ------------------------------------------------------------------ *
 * 参数解析与校验
 * ------------------------------------------------------------------ */

/** 从 URL 查询串里取单值参数（不依赖 URL 对象，避免与宿主 polyfill 打架）。 */
function queryOf(request) {
  const url = String(request?.url || '');
  const q = url.indexOf('?');
  const out = {};
  if (q < 0) return out;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const [k, v] of params) out[k] = v;
  return out;
}

function requireWorkspace(given) {
  const ws = typeof given === 'string' ? given.trim() : '';
  if (!ws) throw new BodyError('缺少 workspace 参数（面板需要知道操作哪个工作区）');
  if (ws.includes('\u0000')) throw new BodyError('workspace 含非法字符');
  return ws;
}

function requirePaths(body) {
  const raw = body?.paths;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const paths = list.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (!paths.length) throw new BodyError('paths 不能为空：清理必须明确列出要搬走的文件');
  return paths;
}

/** 请求参数不合法。路由层统一转成 400，不往上冒成 500。 */
class BodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyError';
  }
}

/* ------------------------------------------------------------------ *
 * 各接口处理
 * ------------------------------------------------------------------ */

async function handleStatus(workspace, config) {
  const paths = closetPaths(workspace);
  let layoutReady = false;
  try {
    await fsp.access(paths.root);
    layoutReady = true;
  } catch {
    layoutReady = false;
  }
  const { scripts, recovered, error } = await listEntries(workspace, {});
  return {
    ok: true,
    workspace,
    dataDir: config.dataDir,
    root: paths.root,
    layoutReady,
    recovered: Boolean(recovered),
    registryError: error ? String(error.message || error) : '',
    counts: {
      total: scripts.length,
      active: scripts.filter((s) => s.status === 'active').length,
      done: scripts.filter((s) => s.status === 'done').length,
      obsolete: scripts.filter((s) => s.status === 'obsolete').length,
    },
    config: {
      enabled: config.enabled,
      trashRetentionDays: config.trashRetentionDays,
      maxScanFiles: config.maxScanFiles,
      ignore: config.ignore,
      runTimeoutMs: config.runTimeoutMs,
    },
  };
}

async function handleScripts(workspace, config, query) {
  const status = query.status;
  const { scripts, recovered, error } = await listEntries(workspace, status ? { status } : {});
  return {
    ok: true,
    scripts,
    recovered: Boolean(recovered),
    registryError: error ? String(error.message || error) : '',
  };
}

async function handleScan(workspace, config, query) {
  const { registry } = await readRegistry(workspace);
  const result = await scanWorkspace(workspace, registry, {
    maxFiles: config.maxScanFiles,
    maxDepth: config.maxScanDepth,
    ignorePatterns: config.ignore,
    skipTracked: String(query.skipTracked || '') === 'true',
  });
  // 面板只回前 500 条：全会话一次几百条已经够用，剩下的靠 AI 工具侧拿完整清单。
  const LIMIT = 500;
  return {
    ok: true,
    summary: result.summary,
    git: result.git ? { available: result.git.available, repoRoot: result.git.repoRoot } : null,
    truncated: result.truncated,
    shown: Math.min(result.items.length, LIMIT),
    total: result.items.length,
    items: result.items.slice(0, LIMIT),
  };
}

async function handleLogs(workspace, config, query) {
  const script = String(query.script || '').trim();
  if (!script) throw new BodyError('缺少 script 参数（脚本文件名）');
  const logs = await listLogs(workspace, script);
  const last = String(query.log || '').trim();
  let tail = null;
  if (last) {
    // tailLog 收的是**文件绝对路径**，不是脚本名：先按名字在上面的清单里定位，
    // 找不到就拒绝 —— 绝不能让外部传进来的字符串直接拼成路径去读文件。
    const hit = logs.find((l) => l.name === last);
    if (!hit) throw new BodyError(`找不到日志文件 ${last}（脚本 ${script}）`);
    tail = await tailLog(hit.path, 200);
  }
  return { ok: true, script, logs, tail };
}

async function handleTrash(workspace, config) {
  const batches = await listTrash(workspace);
  return { ok: true, batches, retentionDays: config.trashRetentionDays };
}

async function handleTrashRestore(body, config) {
  const workspace = requireWorkspace(body.workspace);
  const batch = typeof body.batch === 'string' ? body.batch.trim() : '';
  if (!batch) throw new BodyError('缺少 batch 参数');
  const result = await restoreBatch(workspace, batch);
  return { ok: true, ...result };
}

async function handleClean(body, config) {
  const workspace = requireWorkspace(body.workspace);
  const paths = requirePaths(body);
  if (paths.length > config.maxCleanBatch) {
    throw new BodyError(`一次最多清运 ${config.maxCleanBatch} 项，当前 ${paths.length} 项`);
  }
  const result = await moveToTrash(workspace, paths, {
    root: workspace,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'panel',
    reason: 'panel clean',
  });
  return { ok: true, ...result };
}

async function handleExpire(body, config) {
  const workspace = requireWorkspace(body.workspace);
  const dryRun = body.dryRun !== false; // 默认干跑：不显式传 false 绝不真删
  const days = Number.isFinite(Number(body.days)) ? Number(body.days) : config.trashRetentionDays;
  const result = await expireTrash(workspace, { days, dryRun });
  return { ok: true, ...result };
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

/**
 * 把面板接口挂到宿主 webServer 上。
 *
 * @param {any} ctx cordis 上下文
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 */
export function installWebServer(ctx, config) {
  if (!ctx || typeof ctx.inject !== 'function') return;

  // ctx.inject 的第二个回调只在 webServer 就绪时才跑；headless 场景下这里永远不会执行，
  // 插件其余部分（工具）照常可用 —— 这就是面板必须是可选能力的写法。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const registered = [];
      const register = (spec, label) => {
        try {
          const disposer = host.webServer.register(
            {
              ...spec,
              handler: async (request, response) => {
                if (!allowPluginRequest(request, response)) return;
                return spec.handler(request, response);
              },
            },
            label,
          );
          if (typeof disposer === 'function') registered.push(disposer);
        } catch (err) {
          // 单个路由注册失败不能连累其它路由，更不能连累插件本体
          console.warn(`[dsh-closet] 路由注册失败 ${spec?.path}:`, err?.message || err);
        }
      };

      /** 统一包一层：异常转成 JSON 错误，别让面板收到一个空连接 */
      const route = (path, methods, handler) => {
        register(
          {
            kind: 'exact',
            path: `${API_BASE}${path}`,
            handler: async (request, response) => {
              if (methodNotAllowed(request, response, methods)) return;
              try {
                const payload = request.method === 'POST' ? await readJsonBody(request) : {};
                const result = await handler(payload, queryOf(request));
                sendJson(response, 200, result);
              } catch (err) {
                const status = err instanceof BodyError || err?.name === 'BodyError' ? 400 : 500;
                sendJson(response, status, {
                  ok: false,
                  error: String(err?.message || err),
                  code: err?.code || '',
                });
              }
            },
          },
          `dsh-closet: ${methods.join('/')} ${path}`,
        );
      };

      route('/status', ['GET'], (_body, query) => handleStatus(requireWorkspace(query.workspace), config));
      route('/scripts', ['GET'], (_body, query) =>
        handleScripts(requireWorkspace(query.workspace), config, query),
      );
      route('/scan', ['GET'], (_body, query) => handleScan(requireWorkspace(query.workspace), config, query));
      route('/logs', ['GET'], (_body, query) =>
        handleLogs(requireWorkspace(query.workspace), config, query),
      );
      route('/trash', ['GET'], (_body, query) => handleTrash(requireWorkspace(query.workspace), config));
      route('/clean', ['POST'], (body) => handleClean(body, config));
      route('/trash/restore', ['POST'], (body) => handleTrashRestore(body, config));
      route('/trash/expire', ['POST'], (body) => handleExpire(body, config));

      return () => {
        for (const dispose of registered) {
          try {
            dispose();
          } catch {
            /* 注销失败不影响后续清理 */
          }
        }
      };
    });
  });
}
