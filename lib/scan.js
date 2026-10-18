/**
 * scan.js — 遗留物扫描层
 *
 * 职责：找出工作区里「像临时产物」的文件，给出分类、理由和清理建议。
 * 铁律：**只读扫描，永不删除**。是否清理永远由用户拍板（clean 会再问一次）。
 *
 * 判定思路：不靠「猜内容」，而是靠三类确定性证据——
 *  1. 位置证据：位于 .dsh-fix、tmp、.tmp、scratch、scratchpad 等约定俗成的临时目录。
 *  2. 命名证据：fix-*.ps1、*-backup-*、*.bak、*.tmp、*.log 等。
 *  3. 登记册证据：已被登记且状态为 done/obsolete 的脚本，其日志可归档。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { closetPaths, walk, pathKey, isInside, LANGUAGES, detectLanguage, sanitizeName as storeSanitizeName } from './store.js';
import { trackedFileSet, _keyOf } from './git.js';

/** 命中即视为临时目录的目录名（小写比较） */
const TEMP_DIR_NAMES = new Set([
  '.dsh-fix',
  'tmp',
  'temp',
  '.tmp',
  'scratch',
  'scratchpad',
  '.scratch',
  'dist-tmp',
  '.cache',
]);

/** 文件名模式：命中即给「临时脚本」理由 */
const SCRIPT_NAME_PATTERNS = [
  { re: /^(fix|patch|repair|hotfix)[-_]/i, reason: '文件名以 fix/patch 开头，像是临时修复脚本' },
  { re: /^upgrade[-_]/i, reason: '文件名以 upgrade 开头，像是临时升级脚本' },
  { re: /^test[-_]/i, reason: '文件名以 test 开头（注意：也可能是正式测试，请人工确认）' },
  { re: /^restart[-_]/i, reason: '文件名以 restart 开头，像是临时重启脚本' },
  { re: /^cleanup[-_]/i, reason: '文件名以 cleanup 开头，像是临时清理脚本' },
];

/** 文件名模式：命中即给「备份/临时文件」理由 */
const ARTIFACT_NAME_PATTERNS = [
  { re: /\.bak$/i, reason: '备份文件（.bak）' },
  { re: /\.bak[-._]/i, reason: '带时间戳的备份文件' },
  { re: /\.(tmp|temp)$/i, reason: '临时文件' },
  { re: /\.orig$/i, reason: '合并遗留的 .orig 文件' },
  { re: /\.rej$/i, reason: '打补丁失败的 .rej 残留' },
  { re: /\.corrupt-\d+$/i, reason: '损坏数据的现场备份（确认无用后可删）' },
  { re: /~(?:\.\w+)?$/i, reason: '编辑器自动备份（~ 结尾）' },
];

/**
 * 把绝对路径拆成 { dir, name } 并给出所在目录名（小写）。
 * @param {string} abs
 */
function splitPath(abs) {
  return {
    dir: path.dirname(abs),
    name: path.basename(abs),
    dirName: path.basename(path.dirname(abs)).toLowerCase(),
  };
}

/**
 * 判断单个文件是否属于遗留物，返回分类与理由；不属于则返回 null。
 * @param {{path:string,size:number,mtimeMs:number}} file
 * @param {Set<string>} registeredKeys 已登记文件的路径键集合
 * @param {{workspace?:string}} [options] 传了 workspace 时，位于收纳间（.dsh-fix）内的文件一律不算遗留物
 */
export function classify(file, registeredKeys, options = {}) {
  const { name, dirName } = splitPath(file.path);
  const lang = detectLanguage(file.path);
  // 收纳间是插件自己的家：里面的东西由登记册/回收站管，扫描器不去碰（只登记没登记过的也无所谓，绝不能把自己列成待清理）
  if (options.workspace && isInside(closetPaths(options.workspace).root, file.path)) {
    return null;
  }

  // 1) 备份/临时文件：优先级最高，几乎总是可清
  for (const { re, reason } of ARTIFACT_NAME_PATTERNS) {
    if (re.test(name)) {
      return { category: 'artifact', reason, script: false };
    }
  }

  // 2) 日志文件
  if (/\.log(\.\d+)?$/i.test(name)) {
    return { category: 'log', reason: '日志文件', script: false };
  }

  // 3) 临时目录里的脚本
  if (lang && TEMP_DIR_NAMES.has(dirName)) {
    const hit = SCRIPT_NAME_PATTERNS.find((p) => p.re.test(name));
    const extra = hit ? `；${hit.reason}` : '';
    const registered = Boolean(registeredKeys && registeredKeys.has(pathKey(file.path)));
    return {
      category: 'script',
      reason: `位于临时目录 ${dirName}/ 下的脚本${extra}${registered ? '' : '（未登记）'}`,
      script: true,
      registered,
    };
  }

  // 4) 工作区里名字很像一次性脚本的
  //    历史 bug：这一支只对「根目录」生效，子目录里的 fix-*.ps1 永远扫不到；
  //    现在根目录与子目录一视同仁，只靠「是否登记」区分。
  //    注意：已登记的也要照常分类返回（带 registered:true），由 scan 结合登记状态给 keep/archive，
  //    否则「已登记」与「不存在」在结果里分不出来，用户也就看不到自己登记过的脚本。
  if (lang) {
    const hit = SCRIPT_NAME_PATTERNS.find((p) => p.re.test(name));
    if (hit) {
      const registered = Boolean(registeredKeys && registeredKeys.has(pathKey(file.path)));
      return {
        category: 'script',
        reason: registered ? hit.reason : `${hit.reason}（未登记）`,
        script: true,
        registered,
      };
    }
  }

  return null;
}

/**
 * 扫描工作区，返回遗留物清单。不写盘、不删除。
 *
 * @param {string} workspace 工作区根目录
 * @param {object} registry 登记册（用于识别已登记/已结项）
 * @param {{maxDepth?:number, maxFiles?:number, includeRegistered?:boolean, ignorePatterns?:string[], skipTracked?:boolean}} [options]
 *        skipTracked: true 时，被 git 跟踪的文件**直接不进清单**（最保守，适合「绝对不想误清运」的场景）。
 *                     默认 false —— 照常列出但标 tracked:true，由 clean 与面板把勾选框锁住。
 * @returns {Promise<{items:Array, summary:object, truncated:boolean, git:object}>}
 *          git: { available, repoRoot, trackedNotice } —— 让调用方知道「git 保护到底有没有生效」
 */
export async function scan(workspace, registry, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 4000;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 64;
  const includeRegistered = options.includeRegistered === false ? false : true;
  // 用户自定义忽略项：支持目录名（整棵跳过）与简单通配（`*.snap`）。非法正则一律丢弃，
  // 不能让一条写错的配置把整个扫描搞崩。
  const userIgnores = [];
  for (const raw of Array.isArray(options.ignorePatterns) ? options.ignorePatterns : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const pat = raw.trim().replace(/\\/g, '/');
    const isGlob = pat.includes('*') || pat.includes('?');
    const source = isGlob
      ? `^${pat.split('*').map((s) => s.split('?').map((q) => q.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`
      : null;
    try {
      userIgnores.push({
        glob: source ? new RegExp(source, 'i') : null,
        plain: isGlob ? null : pat.toLowerCase().replace(/^\.\//, '').replace(/\/+$/, ''),
      });
    } catch {
      /* 写错就忽略这一条 */
    }
  }

  const root = path.resolve(workspace);
  const closet = closetPaths(root);
  const closetKey = pathKey(closet.root);

  const scripts = (registry && registry.scripts) || [];
  // 登记册里存的是绝对路径；walk 返回的却是相对路径，两边必须先转成绝对路径再比
  const registeredKeys = new Set(scripts.map((s) => pathKey(s.path)));
  const byKey = new Map(scripts.map((s) => [pathKey(s.path), s]));
  const itemKey = (file) => pathKey(path.join(root, file.path));

  const ignore = (abs) => {
    const key = pathKey(abs);
    // 收纳间是插件自己的家：trash 是整个跳过，其余（registry/.tmp/logs）由 classify 统一排除，
    // 这里不再做特例，免得「扫到自己的数据」这种自伤 bug 反复出现。
    const base = path.basename(abs).toLowerCase();
    // 注意 && 的优先级高于 ||：`a || b || c && false` 等价于 `a || b || (c && false)`，
    // 历史 bug 就出在这里——dist 曾被误写进常量表却永远不生效，干脆不列。
    if (base === 'node_modules' || base === '.git' || base === '.next') {
      return key !== closetKey;
    }
    // 回收站自身不重复扫（否则会把上次清运的结果再列一遍）
    if (isInside(closet.root, abs) && base === 'trash') return true;

    // 用户自定义忽略项：目录名按「相对工作区的路径」比较，通配按 basename 比较。
    // 两者都不匹配时返回 false（= 不忽略），绝不能在配置写错时默认「全部忽略」——
    // 那会让扫描永远返回空清单，看起来像工作区很干净。
    if (userIgnores.length) {
      const rel = path.relative(root, abs).split(path.sep).join('/').toLowerCase();
      for (const u of userIgnores) {
        if (u.glob) {
          if (u.glob.test(base) || u.glob.test(rel)) return true;
        } else if (u.plain) {
          // 前缀匹配：`node_modules` 既忽略它本身，也忽略其下所有内容
          if (rel === u.plain || rel.startsWith(`${u.plain}/`)) return true;
          if (u.plain.endsWith(`/${base}`)) return true;
        }
      }
    }
    return false;
  };

  const files = await walk(root, { ignore, maxDepth });
  const truncated = files.length > maxFiles;
  const pool = truncated ? files.slice(0, maxFiles) : files;

  // git 保护：一次问清楚「哪些是被跟踪的文件」，避免逐文件起进程。
  // 拿不到信息（非仓库 / 没装 git / 超时）时 available=false，扫描照常进行，
  // 只是这一层保护不存在 —— 绝不让它把整次扫描拖死。
  const gitInfo = await trackedFileSet(root).catch(() => null);
  const gitPaths = {
    available: Boolean(gitInfo && gitInfo.repoRoot),
    repoRoot: gitInfo ? gitInfo.repoRoot : null,
    trackedNotice: gitInfo && gitInfo.repoRoot ? '' : '（当前工作区不是 git 仓库或 git 不可用，已跟踪文件保护未生效）',
    keyOf: (abs) => (gitInfo ? _keyOf(gitInfo.repoRoot, abs) : ''),
    files: gitInfo ? gitInfo.files : null,
  };

  const items = [];
  for (const file of pool) {
    const absolute = path.join(root, file.path);
    const cls = classify({ path: absolute, size: file.size, mtimeMs: file.mtimeMs }, registeredKeys, {
      workspace: root,
    });
    if (!cls) continue;
    const entry = byKey.get(itemKey(file));
    if (entry && !includeRegistered) continue;

    const isTracked = Boolean(gitPaths.files && gitPaths.files.has(gitPaths.keyOf(absolute)));
    if (isTracked && options.skipTracked === true) continue;
    // 建议动作：已被 git 跟踪 -> 永远 review（人工确认），不给 archive 这种「照着做就行」的暗示；
    //           已登记且已结项 -> archive；其余 -> review。
    const suggestion = isTracked ? 'review' : entry ? (entry.status === 'active' ? 'keep' : 'archive') : 'review';

    items.push({
      path: absolute,
      relative: file.path,
      size: file.size,
      mtime: new Date(file.mtimeMs).toISOString(),
      category: cls.category,
      reason: isTracked ? `${cls.reason}（⚠ 已被 git 跟踪）` : cls.reason,
      registered: Boolean(entry),
      status: entry ? entry.status : null,
      tracked: isTracked,
      suggestion,
    });
  }

  // 大文件优先、新文件优先，方便用户先看重要的
  items.sort((a, b) => b.size - a.size || a.relative.localeCompare(b.relative));

  const summary = { total: items.length, bytes: 0, byCategory: {}, bySuggestion: {}, tracked: 0 };
  for (const it of items) {
    summary.bytes += it.size;
    summary.byCategory[it.category] = (summary.byCategory[it.category] || 0) + 1;
    summary.bySuggestion[it.suggestion] = (summary.bySuggestion[it.suggestion] || 0) + 1;
    if (it.tracked) summary.tracked += 1;
  }

  return {
    items,
    summary,
    truncated,
    git: { available: gitPaths.available, repoRoot: gitPaths.repoRoot, trackedNotice: gitPaths.trackedNotice },
  };
}

/**
 * 列出某个脚本的日志文件（按时间倒序）。
 * @param {string} workspace
 * @param {string} scriptName 脚本文件名（不含路径）
 */
export async function listLogs(workspace, scriptName) {
  const p = closetPaths(workspace);
  const dir = path.join(p.logs, sanitizeName(scriptName));
  // 目录名即使是 sanitize 过的，也再确认一次落在 logs/ 里：万一将来 sanitize 被改坏，
  // 这里还有第二道闸门，不会去列工作区外的目录。
  if (!isInside(p.logs, dir)) return [];
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/\.log$/.test(n)) continue;
    const abs = path.join(dir, n);
    try {
      const st = await fsp.stat(abs);
      out.push({ name: n, path: abs, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    } catch {
      /* 并发删除，跳过 */
    }
  }
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

/**
 * 把任意脚本名/路径变成安全的目录名（去掉盘符、路径分隔符、保留中文）。
 *
 * 实现已下沉到 store.sanitizeName（run 也要用，不该为了一个纯字符串函数
 * 让 run → scan → store 绕一圈）；这里保留同名导出，兼容既有调用方。
 *
 * 除了 Windows 非法字符，还要挡住三类可能逃逸出 logs/ 的写法：
 *  - 全由点组成（`.` / `..` / `...`）会被当成上级目录；
 *  - 以点或空格结尾在 Windows 上会被系统静默截掉，和别的目录撞名；
 *  - NUL 等控制字符会直接让 fs 抛错。
 *
 * @param {string} name
 */
export function sanitizeName(name) {
  return storeSanitizeName(name);
}

export { LANGUAGES };
