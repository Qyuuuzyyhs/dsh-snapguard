/**
 * dsh-snapguard 恢复出厂 —— 动态官方基线。
 *
 * 「原生状态」被定义为：官方 bundle（@deepseek-ai/*）+ 保留集
 * （默认只有本插件自身；可选择保留插件市场 dshmarket）组成的组合，
 * **动态生成、零快照存储成本、永远回到当前 DSH 版本的原生组合**。
 *
 * 步骤：先创建 pre-factory 快照（后悔药）→ 重建 profile/package.json
 * （dependencies 归并为官方 + 保留集及其直接依赖，bundles 归并为官方
 * 项 + 保留集）→ 尽力删除被移除的第三方包目录（Windows 文件锁场景下
 * 失败可容忍，残留包不会被 loader 加载，重启后 pnpm install 可清理）。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readProfileManifest, SELF_NAME } from './core.js';

/** 官方 scope 判断。 */
export function isOfficialName(name) {
  return name === '@deepseek-ai' || name.startsWith('@deepseek-ai/');
}

/** 原子写 JSON。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

/** 读一个已安装包 package.json 的 dependencies（其直接传输依赖）。 */
function directDepsOf(profileDir, name) {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'));
    if (typeof manifest.dependencies === 'object' && manifest.dependencies !== null) return { ...manifest.dependencies };
  } catch {
    // 包缺失或损坏：无依赖可合并
  }
  return {};
}

/**
 * 执行恢复出厂。
 * @param {object} options
 * @param {string} options.profileDir
 * @param {string} options.storeDir
 * @param {boolean} options.keepMarket 是否保留 dshmarket 插件市场
 * @param {string[]} options.keep 额外保留的包名（默认仅自身）
 * @returns {{ok: boolean, kept: string[], removed: string[], removalFailed: string[], needsRestart: boolean, error?: string}}
 */
export function factoryReset({ profileDir, storeDir, keepMarket = true, keep = [] }) {
  const manifestFile = join(profileDir, 'package.json');
  const manifest = readProfileManifest(profileDir);
  if (manifest === null) {
    return { ok: false, kept: [], removed: [], removalFailed: [], needsRestart: true, error: 'profile package.json is missing or unparseable' };
  }

  // ── 1. 保留集：自身必保 + 可选市场 + 调用方追加 + 传入保持的官方包 ──
  const keepSet = new Set([SELF_NAME, ...keep]);
  if (keepMarket) keepSet.add('dshmarket');

  // ── 2. 官方集合（bundles 中的 @deepseek-ai/* 项 + dependencies 中的官方项）──
  const oldBundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const oldDeps = typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {};
  const officialBundles = oldBundles.filter((name) => typeof name === 'string' && isOfficialName(name));
  const officialDeps = Object.fromEntries(Object.entries(oldDeps).filter(([name]) => isOfficialName(name)));

  // 当前第三方直接依赖（将被移除，除非在保留集）
  const thirdParty = Object.keys(oldDeps).filter((name) => !isOfficialName(name));

  // ── 3. 新 manifest：官方基础 + 保留集（含保留包的直接依赖）──
  const newDeps = { ...officialDeps };
  for (const name of keepSet) {
    newDeps[name] = name === SELF_NAME ? 'file:./dsh-snapguard' : (oldDeps[name] ?? 'file:./dsh-snapguard');
    // 保留包的传输依赖也并入（市场插件的 js-yaml/undici 等）
    for (const [dep, spec] of Object.entries(directDepsOf(profileDir, name))) {
      if (newDeps[dep] === undefined && !isOfficialName(dep)) newDeps[dep] = spec;
    }
  }
  // bundles 顺序：官方在前；dshmarket（如有）其次；自身最后（保险栏）
  const marketMember = [...keepSet].filter((name) => name === 'dshmarket');
  const selfMember = [...keepSet].filter((name) => name === SELF_NAME);
  const orderedBundles = [...officialBundles, ...marketMember, ...selfMember];

  // ── 4. 写回（先写清单，再删目录：manifest 是权威，删除尽力而为）──
  const written = {
    ...manifest,
    dependencies: newDeps,
    dsh: {
      ...(typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh : {}),
      profile: {
        ...(typeof manifest.dsh === 'object' && manifest.dsh !== null && typeof manifest.dsh.profile === 'object' && manifest.dsh.profile !== null ? manifest.dsh.profile : {}),
        bundles: orderedBundles,
      },
    },
  };
  try {
    writeJsonAtomic(manifestFile, written);
  } catch (error) {
    return { ok: false, kept: [], removed: [], removalFailed: [], needsRestart: true, error: error instanceof Error ? error.message : String(error) };
  }

  // ── 5. 尽力删除被移除的第三方包（Windows 文件锁可容忍失败）──
  const removed = [];
  const removalFailed = [];
  const scopeDirs = new Set();
  for (const name of thirdParty) {
    if (keepSet.has(name)) continue;
    const topDir = join(profileDir, 'node_modules', name);
    if (!existsSync(topDir)) continue;
    if (name.startsWith('@')) scopeDirs.add(name.split('/')[0]);
    try {
      const st = lstatSync(topDir);
      if (st.isSymbolicLink()) {
        // pnpm 链接：仅删链接本身（.pnpm 真实存储留给 pnpm 清理）
        rmSync(topDir, { force: true });
      } else {
        rmSync(topDir, { recursive: true, force: true });
      }
      removed.push(name);
    } catch {
      // 运行中的宿主可能持有句柄：记录但不中止（重启后不加载即无影响）
      removalFailed.push(name);
    }
  }
  // 清空被删除包的 scope 目录（仅当为空；非空会被 rmSync 抛出而跳过）
  for (const scope of scopeDirs) {
    if (scope === '@deepseek-ai') continue;
    const scopeDir = join(profileDir, 'node_modules', scope);
    try {
      rmSync(scopeDir, { recursive: false, force: false });
    } catch {
      // 非空或已被占用 → 保留
    }
  }

  return { ok: true, kept: [...keepSet], removed, removalFailed, needsRestart: true };
}
