/**
 * dsh-snapguard 快照引擎 —— 配置层 + 第三方插件包的双层快照。
 *
 * 一份快照 = 一个目录：<storeDir>/snapshots/snapshot-<ts>-<seq>/
 *   manifest.json  快照清单（id、时间、原因、文件校验、包清单）
 *   files/         组合关键文件的精确字节（package.json、cordis.patch.yml、.dsh-market/*）
 *   packages/      每个第三方插件包的真实内容（离线可恢复，不依赖注册表）
 *
 * 设计纪律（与 dshmarket snapshot.js 同一标准）：
 *   - 快照 id 必须匹配 /^snapshot-[0-9A-Za-z-]+$/，任何路径形输入在触达文件系统前被拒绝；
 *   - 配置文件写回采用原子替换（temp + rename），中途崩溃不会留下半写文件；
 *   - 快照目录放在 DSH_HOME 下（默认 ~/.dsh/.snapguard），与 profile 分离——
 *     回滚/恢复出厂都不会碰快照自身，快照写入也不会触发文件监控的自我循环。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

/** 快照 id 的严格白名单；其余任何形态（路径、..、绝对路径）一律拒绝。 */
export const SNAPSHOT_ID_RE = /^snapshot-[0-9A-Za-z-]+$/;

/** 快照允许捕获的组合关键文件（相对 profile 目录）。.dsh-market 前缀表示整目录。 */
export const SNAPSHOT_FILEROOTS = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.yml',
  '.npmrc',
  '.dsh-market',
];

/** 官方组件 scope：任何 @deepseek-ai/* 包视为原生，不进备份、不被出厂删除。 */
export const OFFICIAL_SCOPES = ['@deepseek-ai'];

/** 本插件自己的包名：回滚/出厂后必须保活（否则会“自杀”）。 */
export const SELF_NAME = 'dsh-snapguard';

/** 快照文档格式版本。 */
const MANIFEST_VERSION = 2;

/** 快照内排除的目录/文件（对每个插件包内容生效）。 */
const PACKAGE_EXCLUDES = new Set(['node_modules', '.bin', '.cache', '.pnpm']);

/**
 * 当前 DSH 版本（provenance，借鉴 dsh-plugin-guard 的做法）：
 * 从本进程入口（或调用方入口）向上爬目录树找 @deepseek-ai/dsh 包的
 * package.json；失败再试 DSH_HOME 父目录的 node_modules；全失败返回 ''。
 */
export function harnessVersion(entry = process.argv[1]) {
  if (typeof entry === 'string' && entry !== '') {
    let dir = dirname(entry);
    while (true) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version;
      } catch {
        // 往上爬
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  try {
    const root = dirname(dshHomePath());
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    if (typeof manifest.version === 'string') return manifest.version;
  } catch {
    // 无法解析
  }
  return '';
}

/**
 * DSH_HOME 解析：环境变量优先，退到用户目录/.dsh。
 */
export function dshHomePath(env = process.env) {
  const value = env.DSH_HOME;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return join(homedir(), '.dsh');
}

/** 快照存储根目录。 */
export function storeDirOf(dshHome = dshHomePath()) {
  return join(dshHome, '.snapguard');
}

export function snapshotsDirOf(storeDir = storeDirOf()) {
  return join(storeDir, 'snapshots');
}

/** 快照 id 校验：路径穿越 / 绝对路径 / 攻击形状全部拒绝。 */
export function validSnapshotId(id) {
  return typeof id === 'string' && SNAPSHOT_ID_RE.test(id);
}

/** 读取并解析 JSON，失败返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子同目录替换（temp + rename）：崩溃永不留下截断文件。 */
function writeFileAtomic(file, content) {
  const dir = dirname(file);
  const temp = join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(temp, content);
  renameSync(temp, file);
}

/** 目录总字节数（遍历，错误目录返回 null）。 */
function dirSize(dir) {
  let total = 0;
  let count = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;   // 链接不计入（避免解析出店深渊）
        if (entry.isDirectory()) {
          if (!walk(full)) return false;
        } else if (entry.isFile()) {
          total += statSync(full).size;
          count += 1;
        }
      } catch {
        return false;
      }
    }
    return true;
  };
  if (!walk(dir)) return null;
  return { total, count };
}

/** 路径是否落在白名单根下（防穿越，slashes 归一化后比较）。 */
function allowedSnapshotPath(relativePath) {
  if (typeof relativePath !== 'string') return false;
  if (relativePath.includes('..')) return false;
  if (relativePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relativePath)) return false;
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return false;
  const head = parts[0];
  if (!SNAPSHOT_FILEROOTS.includes(head)) return false;
  // .dsh-market/... 允许任意子路径；其它仅文件名本身。
  if (head === '.dsh-market') return parts.length >= 1;
  return parts.length === 1;
}

/**
 * 读 profile 的 package.json：null 表示缺失/损坏（调用方决定报错方式）。
 */
export function readProfileManifest(profileDir) {
  return readJson(join(profileDir, 'package.json'));
}

/**
 * 收集「应被快照的组合关键文件」：存在性的绝对路径列表。
 */
export function compositionFiles(profileDir) {
  const found = [];
  for (const root of SNAPSHOT_FILEROOTS) {
    const abs = join(profileDir, root);
    if (!existsSync(abs)) continue;
    if (root.startsWith('.dsh-market')) {
      // 目录：逐个收集子文件（拒绝深层递归，一层即可）
      let entries = [];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const full = join(abs, entry.name);
        if (entry.isFile() && allowedSnapshotPath(relative(profileDir, full).split(sep).join('/'))) {
          found.push(full);
        }
      }
    } else if (statSync(abs).isFile() && allowedSnapshotPath(relative(profileDir, abs).split(sep).join('/'))) {
      found.push(abs);
    }
  }
  return found.sort();
}

/**
 * 第三方插件包清单：从 manifest.dependencies 里挑出非官方、非自身的名字，
 * 并解析其在 node_modules 下的实际目录（兼容 pnpm 符号链接布局）。
 *
 * @returns {Array<{ name, topDir, realDir, isLink }>}
 */
export function thirdPartyPackages(profileDir) {
  const manifest = readProfileManifest(profileDir);
  if (manifest === null || typeof manifest.dependencies !== 'object' || manifest.dependencies === null) return [];
  const names = Object.keys(manifest.dependencies).filter((name) => {
    if (OFFICIAL_SCOPES.some((scope) => name === scope || name.startsWith(`${scope}/`))) return false;
    return name !== SELF_NAME;
  });
  const result = [];
  for (const name of names) {
    const topDir = join(profileDir, 'node_modules', name);
    if (!existsSync(topDir)) continue;
    let isLink = false;
    let realDir = topDir;
    try {
      const st = lstatSync(topDir);
      if (st.isSymbolicLink()) {
        isLink = true;
        const target = readlinkSync(topDir);
        realDir = resolve(dirname(topDir), target);
        if (!existsSync(realDir)) realDir = realpathSync(topDir);
        else realDir = realpathSync(topDir);
      } else if (st.isDirectory()) {
        realDir = topDir;
      } else {
        continue;
      }
    } catch {
      continue;
    }
    result.push({ name, topDir, realDir, isLink });
  }
  return result;
}

/** 复制某包内容到快照包目录（排除依赖/缓存/链接），返回是否成功。 */
function copyPackageToSnapshot(pkg, destDir) {
  try {
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    cpSync(pkg.realDir, destDir, {
      recursive: true,
      dereference: false,
      filter: (src) => {
        const rel = relative(pkg.realDir, src);
        if (rel === '') return true;
        const first = rel.split(sep)[0];
        if (PACKAGE_EXCLUDES.has(first)) return false;
        if (first.startsWith('.')) return false;
        return true;
      },
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 创建一份快照。
 * @param {object} options
 * @param {string} options.profileDir  绝对 profile 目录
 * @param {string} options.storeDir    绝对存储根（.snapguard）
 * @param {string} options.reason      'auto' | 'manual' | 'boot-crash' | 'pre-factory'
 * @param {number} options.maxSnapshots 保留上限
 * @returns {{ok: boolean, snapshot?: object, error?: string}}
 */
export function createSnapshot({ profileDir, storeDir, reason = 'manual', maxSnapshots = 20 }) {
  if (!existsSync(join(profileDir, 'package.json'))) {
    return { ok: false, error: 'profile package.json is missing or unparseable' };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let seq = 0;
  let id = `snapshot-${stamp}-${seq}`;
  let snapDir = join(snapshotsDirOf(storeDir), id);
  while (existsSync(snapDir)) {
    seq += 1;
    id = `snapshot-${stamp}-${seq}`;
    snapDir = join(snapshotsDirOf(storeDir), id);
  }

  // ── 1. 组合关键文件 ──────────────────────────────────────────────
  const files = [];
  const fileAbsList = compositionFiles(profileDir);
  for (const abs of fileAbsList) {
    const rel = relative(profileDir, abs).split(sep).join('/');
    if (!allowedSnapshotPath(rel)) continue;
    files.push({ path: rel });
  }

  // ── 2. 第三方插件包 ──────────────────────────────────────────────
  const packages = thirdPartyPackages(profileDir).map((pkg) => ({
    name: pkg.name,
    isLink: pkg.isLink,
    size: dirSize(pkg.realDir) ?? null,
  }));

  // ── 3. 落盘：先写临时目录，全部成功后再改名（快照目录原子出现）──
  const tmpDir = `${snapDir}.tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  const filesDir = join(tmpDir, 'files');
  const packagesDir = join(tmpDir, 'packages');
  mkdirSync(join(tmpDir, 'files'), { recursive: true });

  const manifest = {
    version: MANIFEST_VERSION,
    id,
    createdAt: Date.now(),
    reason,
    tag: reason,
    dshVersion: harnessVersion(),
    profileName: 'web',
    files: [],
    packages: [],
    summary: {},
  };

  try {
    // 3a. 组合关键文件字节 + 校验和
    for (const file of fileAbsList) {
      const rel = relative(profileDir, file).split(sep).join('/');
      if (!allowedSnapshotPath(rel)) continue;
      const dest = join(filesDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(file, dest);
      manifest.files.push({ path: rel, sha256: sha256Sync(dest) });
    }

    // 3b. 第三方插件包内容（每个包一个子目录，复制失败仅跳过并记录）
    mkdirSync(packagesDir, { recursive: true });
    for (const pkg of packages) {
      const source = thirdPartyPackages(profileDir).find((p) => p.name === pkg.name);
      if (source === undefined) continue;
      const dest = join(packagesDir, pkg.name);
      if (copyPackageToSnapshot(source, dest)) {
        manifest.packages.push({ name: pkg.name, isLink: pkg.isLink, size: pkg.size });
      }
    }

    manifest.summary = {
      files: manifest.files.length,
      packages: manifest.packages.map((p) => p.name),
      packageCount: manifest.packages.length,
    };
    writeFileAtomic(join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    rmSync(snapDir, { recursive: true, force: true });
    renameSync(tmpDir, snapDir);

    pruneSnapshots(storeDir, maxSnapshots);

    return {
      ok: true,
      snapshot: {
        id: manifest.id,
        createdAt: manifest.createdAt,
        reason: manifest.reason,
        dshVersion: manifest.dshVersion,
        files: manifest.summary.files,
        packages: manifest.summary.packages,
        packageCount: manifest.summary.packageCount,
      },
    };
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 小文件同步 sha256（快照阶段的性能足够）。 */
function sha256Sync(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

/** 修剪到 maxSnapshots 份（保留最新）。 */
export function pruneSnapshots(storeDir, maxSnapshots = 20) {
  const dir = snapshotsDirOf(storeDir);
  let entries = [];
  try {
    entries = readdirSync(dir).filter((name) => validSnapshotId(name) && existsSync(join(dir, name, 'manifest.json')));
  } catch {
    return;
  }
  entries.sort();
  const overflow = entries.length - Math.max(1, maxSnapshots);
  for (const name of entries.slice(0, Math.max(0, overflow))) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * 列出全部快照摘要（按时间倒序）。
 */
export function listSnapshots(storeDir) {
  const dir = snapshotsDirOf(storeDir);
  let entries = [];
  try {
    entries = readdirSync(dir).filter((name) => validSnapshotId(name));
  } catch {
    return [];
  }
  const result = [];
  for (const name of entries) {
    const manifestFile = join(dir, name, 'manifest.json');
    const manifest = readJson(manifestFile);
    if (manifest === null) continue;
    result.push({
      id: manifest.id,
      createdAt: manifest.createdAt ?? 0,
      reason: manifest.reason ?? 'unknown',
      dshVersion: typeof manifest.dshVersion === 'string' ? manifest.dshVersion : '',
      files: Array.isArray(manifest.files) ? manifest.files.length : 0,
      packages: Array.isArray(manifest.packages) ? manifest.packages.map((p) => p.name) : [],
      packageCount: Array.isArray(manifest.packages) ? manifest.packages.length : 0,
    });
  }
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result;
}

/** 自动回滚候选不应选中的原因 tag（pre-rollback / pre-boot 只用于自愈）。 */
const NON_GOOD_REASONS = new Set(['pre-rollback', 'pre-boot', 'pre-factory']);

/** 最近一份「良好」快照（非 pre-* 标签），借鉴 dsh-plugin-guard 的 last-good 语义。 */
export function lastGoodSnapshot(storeDir) {
  const list = listSnapshots(storeDir);
  for (const snap of list) {
    if (!NON_GOOD_REASONS.has(snap.reason)) return snap;
  }
  return null;
}

/** 校验一份快照文档的形状；损坏快照永远不能被恢复（防半坏恢复）。 */
function isUsableSnapshot(storeDir, id) {
  if (!validSnapshotId(id)) return false;
  const manifestFile = join(snapshotsDirOf(storeDir), id, 'manifest.json');
  const manifest = readJson(manifestFile);
  if (manifest === null) return false;
  if (manifest.version !== MANIFEST_VERSION || manifest.id !== id) return false;
  if (!Array.isArray(manifest.files)) return false;
  if (!Array.isArray(manifest.packages)) return false;
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !allowedSnapshotPath(file.path)) return false;
  }
  for (const pkg of manifest.packages) {
    if (typeof pkg.name !== 'string' || pkg.name === '' || pkg.name.includes('..')) return false;
  }
  return true;
}

/**
 * 把 keep 列表（默认本插件自身）合并进 package.json：
 * dependencies + dsh.profile.bundles 同时保证存在，且不重复。
 */
function ensureKept(profileDir, keepNames) {
  const manifestFile = join(profileDir, 'package.json');
  const manifest = readJson(manifestFile);
  if (manifest === null) return false;
  let changed = false;
  if (typeof manifest.dependencies !== 'object' || manifest.dependencies === null) manifest.dependencies = {};
  const dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh : {};
  const profile = typeof dsh.profile === 'object' && dsh.profile !== null ? dsh.profile : {};
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
  for (const name of keepNames) {
    if (manifest.dependencies[name] === undefined) {
      manifest.dependencies[name] = 'file:./dsh-snapguard';
      changed = true;
    }
    if (!bundles.includes(name)) {
      bundles.push(name);
      changed = true;
    }
  }
  profile.bundles = bundles;
  dsh.profile = profile;
  manifest.dsh = dsh;
  if (!changed) return true;
  writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

/**
 * 恢复快照到 profile：先写回组合文件（原子），再恢复插件包内容。
 * @param {object} options
 * @param {string} options.profileDir
 * @param {string} options.storeDir
 * @param {string} options.snapshotId
 * @param {string[]} options.keep  恢复后必须保留的包名（防止快照反噬自身）
 * @returns {{ok: boolean, restoredFiles: string[], restoredPackages: string[], error?: string, needsRestart: boolean}}
 */
export function restoreSnapshot({ profileDir, storeDir, snapshotId, keep = [SELF_NAME], allowPreRollback = true }) {
  if (!isUsableSnapshot(storeDir, snapshotId)) {
    return { ok: false, restoredFiles: [], restoredPackages: [], error: 'invalid or corrupt snapshot id' };
  }
  // 自愈前置：先把「当前状态」存一份 pre-rollback 快照 —— 回滚本身可逆
  // （借鉴 dsh-plugin-guard；pre-rollback 标签永远不会被自动回滚选中）。
  if (allowPreRollback) {
    try {
      createSnapshot({ profileDir, storeDir, reason: 'pre-rollback', maxSnapshots: 100 });
    } catch {
      // 拍不出后悔药不阻断回滚
    }
  }
  const snapDir = join(snapshotsDirOf(storeDir), snapshotId);
  const manifest = readJson(join(snapDir, 'manifest.json'));
  const restoredFiles = [];
  const restoredPackages = [];

  // ── 1. 组合关键文件：校验内容后再原子写回 ─────────────────────
  try {
    for (const file of manifest.files) {
      const src = join(snapDir, 'files', file.path);
      const dest = join(profileDir, file.path);
      if (!existsSync(src)) continue;
      if (sha256Sync(src) !== file.sha256) continue; // 快照损坏 → 跳过，绝不写半坏内容
      mkdirSync(dirname(dest), { recursive: true });
      const content = readFileSync(src);
      writeFileAtomic(dest, content);
      restoredFiles.push(file.path);
    }
  } catch (error) {
    return { ok: false, restoredFiles, restoredPackages, error: error instanceof Error ? error.message : String(error) };
  }

  // ── 2. 保活注入：自身与保留项必须回到 manifest（快照里没有它们）──
  if (keep.length > 0) ensureKept(profileDir, keep);

  // ── 3. 插件包内容恢复（离线兜底）──────────────────────────────
  for (const pkg of manifest.packages) {
    const src = join(snapDir, 'packages', pkg.name);
    const topDir = join(profileDir, 'node_modules', pkg.name);
    if (!existsSync(src)) continue;
    let target = topDir;
    try {
      const st = lstatSync(topDir);
      if (st.isSymbolicLink()) {
        target = realpathSync(topDir);
        if (!existsSync(target)) {
          // 链接目标丢失：退化为目录形式，保证包体可用
          rmSync(topDir, { recursive: true, force: true });
          target = topDir;
        }
      }
    } catch {
      // 不存在 → 新建目录
    }
    try {
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(src, target, { recursive: true, dereference: false });
      restoredPackages.push(pkg.name);
    } catch (error) {
      // 单个包失败不中断整体，由 UI/日志呈现
    }
  }

  // ── 4. 清理孤儿 bundle 链接（pnpm 不会自己删 stale link）────────────
  let removedLinks = [];
  try {
    removedLinks = cleanupStaleBundleLinks(profileDir);
  } catch {
    removedLinks = [];
  }

  return { ok: true, restoredFiles, restoredPackages, removedLinks, needsRestart: true };
}

/**
 * 清理 pnpm 布局中的孤儿 bundle 链接：packagem.json 恢复后不再被引用的
 * 顶层符号链接（pnpm 不会自己删除 stale link 条目——「Already up to date」），
 * 直接对着恢复后的 manifest 移除。仅删链接，绝不碰真实目录。
 * @returns 被删除的链接名列表
 */
export function cleanupStaleBundleLinks(profileDir) {
  const manifest = readProfileManifest(profileDir);
  if (manifest === null) return [];
  const valid = new Set();
  for (const name of Object.keys(manifest.dependencies ?? {})) valid.add(name);
  for (const name of Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []) {
    if (typeof name === 'string') valid.add(name);
  }
  const nm = join(profileDir, 'node_modules');
  const removed = [];
  const scan = (dir, prefix) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      let isLink = false;
      try {
        isLink = lstatSync(full).isSymbolicLink();
      } catch {
        continue;
      }
      if (isLink) {
        const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (!valid.has(name)) {
          try {
            rmSync(full, { force: true });
            removed.push(name);
          } catch {
            // 被占用则跳过
          }
        }
      } else if (entry.isDirectory() && entry.name.startsWith('@') && prefix === '') {
        scan(full, entry.name);
      }
    }
  };
  scan(nm, '');
  return removed;
}

/**
 * 删除一份快照。
 */
export function deleteSnapshot(storeDir, snapshotId) {
  if (!validSnapshotId(snapshotId)) return { ok: false, error: 'invalid snapshot id' };
  const dir = join(snapshotsDirOf(storeDir), snapshotId);
  if (!existsSync(dir)) return { ok: false, error: 'snapshot not found' };
  rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/** 校验快照是否可用（UI 灰显损坏项用）。 */
export function validSnapshot(storeDir, snapshotId) {
  return isUsableSnapshot(storeDir, snapshotId);
}
