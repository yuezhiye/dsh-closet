/**
 * trash.js — 回收站层
 *
 * 铁律：**任何清理动作只做「移动」，不做「删除」**。
 * 真正删文件只发生在 expire()，且必须由用户显式触发、且超过保留天数。
 *
 * 目录布局：
 *   <工作区>/.dsh-fix/trash/<YYYYMMDD-HHmmss>-<批次名>/
 *       manifest.json     —— 本次清运清单（原路径、大小、时间、理由）
 *       <保持原目录结构>   —— 被移动的文件
 *
 * 安全闸门（本节是全模块唯一的「可能把用户文件搬错地方」的入口，任何一处松了都是事故）：
 *  1. 工作区边界永远以函数参数 `workspace` 为准，**不看调用方传的 root**；
 *     传了 root 也必须落在 workspace 之内，否则视为「调用方搞错了」直接整批拒绝。
 *  2. 边界判断用**真实路径**（realPath）而不是字面路径：目录联接 / 符号链接
 *     能把 `ws\link-out\secret.txt` 伪装成「在工作区内」。
 *  3. 回收站自身、以及「工作区根目录本身」永远不进回收站。
 *  4. 还原时原位置若已被占用，**绝不覆盖**，只报告冲突。
 *  5. 目标文件名再兜一层：绝不落到批次目录之外。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { closetPaths, pathKey, realPath, isInside } from './store.js';

/** 生成一次清运的批次目录名（秒级时间戳，批次名本身不参与过期判断，见 expireTrash） */
function batchDirName(label) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = String(label || 'batch')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^[.]+$/, '')
    .slice(0, 40);
  return `${stamp}-${safe || 'batch'}`;
}

/**
 * 判断 `child` 是否落在 `parent` 之内——字面与真实路径**两道都要过**。
 * @param {string} parent
 * @param {string} child
 */
function insideBoth(parent, child) {
  return isInside(parent, child) && isInside(realPath(parent), realPath(child));
}

/** 文件是否存在（lstat，不跟随链接） */
async function lexists(p) {
  return fsp.lstat(p).then(() => true, () => false);
}

/**
 * 把一批文件移进回收站。
 *
 * @param {string} workspace 工作区根目录（也是安全边界）
 * @param {Array<{path:string, reason?:string, size?:number}>} items
 * @param {{label?:string, root?:string}} [options] root 用于把原路径转成相对结构；必须在 workspace 之内
 * @returns {Promise<{batch:string, batchDir:string, moved:Array, failed:Array}>}
 */
export async function moveToTrash(workspace, items, options = {}) {
  const p = closetPaths(workspace);
  const ws = p.root ? path.dirname(p.root) : '';

  // root 只是「相对结构的基准」，绝不能拿来当安全边界：
  // 调用方传 root 为空/传错，就等于把整个磁盘都开放给回收站，这是历史上最危险的一类 bug。
  let baseRoot = ws;
  if (options.root) {
    const r = path.resolve(options.root);
    if (!insideBoth(ws, r)) {
      throw new Error(`moveToTrash 的 root「${r}」不在工作区「${ws}」之内，拒绝执行`);
    }
    baseRoot = r;
  }
  if (!ws || !baseRoot) throw new Error('moveToTrash 需要一个有效的工作区路径');

  const batch = batchDirName(options.label);
  const batchDir = path.join(p.trash, batch);
  await fsp.mkdir(batchDir, { recursive: true });

  const moved = [];
  const failed = [];
  const trashKey = pathKey(realPath(p.trash));
  const wsKey = pathKey(realPath(ws));

  for (const item of items || []) {
    const given = item && item.path ? String(item.path) : '';
    if (!given) {
      failed.push({ path: '', error: '空路径，跳过' });
      continue;
    }
    const abs = path.resolve(given);

    // 1) 工作区边界：字面 + 真实路径（防 ..、防目录联接/符号链接逃逸、防盘符大小写变体）
    if (!insideBoth(ws, abs)) {
      failed.push({ path: abs, error: '不在工作区内，已跳过' });
      continue;
    }
    const realAbs = realPath(abs);
    const absKey = pathKey(realAbs);

    // 2) 工作区根目录本身不是文件，但仍显式挡一道
    if (absKey === wsKey) {
      failed.push({ path: abs, error: '不能把工作区本身移进回收站' });
      continue;
    }
    // 3) 回收站内 / 收纳间内的东西不再搬
    if (isInside(trashKey, absKey) || pathKey(realPath(p.root)) === absKey) {
      failed.push({ path: abs, error: '已在回收站内，跳过' });
      continue;
    }

    let st;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      failed.push({ path: abs, error: `无法读取：${err && err.code}` });
      continue;
    }
    // 符号链接/目录联接一律不搬：搬走的只是链接，真实文件还在原处，等于什么都没清理；
    // 更糟的是「链接指向工作区外」时，用户会以为外部的文件已经进了回收站。
    if (st.isSymbolicLink()) {
      failed.push({ path: abs, error: '是符号链接/目录联接，跳过（不跟随链接）' });
      continue;
    }
    if (!st.isFile()) {
      failed.push({ path: abs, error: '不是普通文件，跳过' });
      continue;
    }

    // 4) 目标路径：相对结构 + 绝不越出批次目录
    const rel = path.relative(baseRoot, abs);
    if (!rel || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
      failed.push({ path: abs, error: '无法计算相对路径，跳过' });
      continue;
    }
    let dest = path.join(batchDir, rel);
    if (!isInside(batchDir, dest)) {
      failed.push({ path: abs, error: '目标路径越界，跳过' });
      continue;
    }
    // 同批次内重名（不同目录同名文件）时加序号
    let n = 1;
    while (await lexists(dest)) {
      dest = path.join(batchDir, `${rel}.${n++}`);
    }

    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(abs, dest);
      moved.push({ from: abs, to: dest, size: st.size, reason: (item && item.reason) || '', mtime: st.mtimeMs });
    } catch (err) {
      // 跨盘符 rename 会 EXDEV；被占用/被拒（EBUSY/EPERM/EACCES）时退回 copy + unlink，
      // 但只有 copy 成功之后才碰原文件——顺序反了就是「删了没搬走」。
      if (err && (err.code === 'EXDEV' || err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
        try {
          await fsp.copyFile(abs, dest, fs_COPYFILE_EXCL());
          await fsp.unlink(abs);
          moved.push({ from: abs, to: dest, size: st.size, reason: (item && item.reason) || '', mtime: st.mtimeMs });
        } catch (e2) {
          await fsp.rm(dest, { force: true }).catch(() => {});
          failed.push({ path: abs, error: String(e2 && e2.message) });
        }
      } else {
        failed.push({ path: abs, error: String(err && err.message) });
      }
    }
  }

  const manifest = {
    batch,
    createdAt: new Date().toISOString(),
    root: baseRoot,
    label: options.label || '',
    moved,
    failed,
  };
  await fsp.writeFile(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return { batch, batchDir, moved, failed };
}

/** copyFile 的复制选项：目标已存在时必须失败，绝不覆盖（EXCL = exclusive） */
function fs_COPYFILE_EXCL() {
  // 单独抽出来只是为了可读：Node 的常量名太长，写在调用处会把逻辑淹掉
  return { COPYFILE_EXCL: 1 };
}

/**
 * 列出回收站批次（含总大小、文件数）。
 * @param {string} workspace
 */
export async function listTrash(workspace) {
  const p = closetPaths(workspace);
  let names;
  try {
    names = await fsp.readdir(p.trash, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(p.trash, ent.name);
    let manifest = null;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      /* 没有清单的批次（手工丢进去的）也算 */
    }
    const valid = manifest && Array.isArray(manifest.moved);
    const stat = await dirStats(dir);
    out.push({
      batch: ent.name,
      dir,
      createdAt: valid && manifest.createdAt ? manifest.createdAt : stat.mtime,
      count: valid ? manifest.moved.length : stat.files,
      bytes: valid ? manifest.moved.reduce((a, b) => a + (Number(b && b.size) || 0), 0) : stat.bytes,
      label: valid ? String(manifest.label || '') : '',
    });
  }
  out.sort((a, b) => (a.batch < b.batch ? 1 : -1));
  return out;
}

/**
 * 还原一个批次：把文件搬回原路径。原位置已被占用的一律不覆盖，记入 failed。
 * @param {string} workspace
 * @param {string} batch 批次目录名
 */
export async function restoreBatch(workspace, batch) {
  const p = closetPaths(workspace);
  const dir = path.join(p.trash, batch);
  // 批次名来自外部输入：`..\..` 之类必须先挡住，否则能读到回收站之外的 manifest
  if (!batch || !isInside(p.trash, dir) || pathKey(dir) === pathKey(p.trash)) {
    throw new Error(`批次名「${batch}」非法，只允许回收站内的目录名`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error(`批次 ${batch} 缺少可用的 manifest.json，无法自动还原`);
  }
  const ws = path.dirname(p.root);
  const restored = [];
  const failed = [];
  for (const item of Array.isArray(manifest.moved) ? manifest.moved : []) {
    try {
      // 清单是文件，可能被手改过：还原目标必须在工作区内、来源必须在批次目录内
      if (!isInside(ws, item.from) || !isInside(dir, item.to)) {
        failed.push({ path: String(item.from), error: '清单里的路径越界，跳过' });
        continue;
      }
      if (!(await lexists(item.to))) {
        failed.push({ path: item.from, error: '回收站里的文件已不存在' });
        continue;
      }
      // 关键：原位置已有文件时绝不覆盖——用户可能在这段时间里新建了同名文件
      if (await lexists(item.from)) {
        failed.push({ path: item.from, error: '原位置已有同名文件，未覆盖' });
        continue;
      }
      await fsp.mkdir(path.dirname(item.from), { recursive: true });
      try {
        await fsp.rename(item.to, item.from);
      } catch (err) {
        if (!err || (err.code !== 'EXDEV' && err.code !== 'EEXIST' && err.code !== 'EPERM')) throw err;
        // 跨盘符只能复制：COPYFILE_EXCL 保证最后一道「不覆盖」
        await fsp.copyFile(item.to, item.from, 1);
        await fsp.unlink(item.to);
      }
      restored.push(item.from);
    } catch (err) {
      failed.push({ path: item.from, error: String(err && err.message) });
    }
  }
  // 还原干净后删掉空的批次目录（此时里面除了 manifest 什么都没有）
  if (failed.length === 0) await fsp.rm(dir, { recursive: true, force: true });
  return { restored, failed };
}

/**
 * 清理过期批次（唯一真正的删除动作）。必须显式调用，且默认 30 天。
 * @param {string} workspace
 * @param {{days?:number, dryRun?:boolean, now?:number}} [options]
 */
export async function expireTrash(workspace, options = {}) {
  const days = Number.isFinite(options.days) ? options.days : 30;
  const dryRun = Boolean(options.dryRun);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  const batches = await listTrash(workspace);
  const expired = [];
  for (const b of batches) {
    const t = Date.parse(b.createdAt || '') || 0;
    // 时间解析不出来（t=0）时一律不删：宁可留着，也不能因为读不懂时间就清空用户的东西
    if (t && t <= cutoff) expired.push(b);
  }
  if (dryRun) return { days, cutoff: new Date(cutoff).toISOString(), expired, removed: [] };

  const removed = [];
  const failed = [];
  for (const b of expired) {
    try {
      await fsp.rm(b.dir, { recursive: true, force: true });
      removed.push(b.batch);
    } catch (err) {
      failed.push({ batch: b.batch, error: String(err && err.message) });
    }
  }
  return { days, cutoff: new Date(cutoff).toISOString(), expired, removed, failed };
}

/** 目录大小与文件数 */
async function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) {
        try {
          const st = await fsp.stat(abs);
          bytes += st.size;
          files += 1;
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch {
          /* skip */
        }
      }
    }
  }
  return { bytes, files, mtime: new Date(newest || Date.now()).toISOString() };
}
