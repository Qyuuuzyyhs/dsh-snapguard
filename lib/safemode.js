/**
 * dsh-snapguard 安全模式 —— 温和地让 DSH 恢复可启动（借鉴
 * dsh-undo-savepoint 的 SAFE MODE 设计）。
 *
 * 与「恢复出厂」的本质区别：
 *   出厂 = 删依赖、删包目录、重建官方基线（彻底，需从头再来）；
 *   安全模式 = 只「临时停用」全部用户插件 —— 备份 patch + package.json，
 *   把 bundles 剪枝为「官方 + 自身」，patch 换成只插入自身的最小版，
 *   写入 safe-mode.json 状态；退出时两个文件整体还原，秒级恢复。
 *
 * 只动 profile 层（DSH_HOME 层面的全局 patch 不在本插件职责内，文档注明）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSnapshot, SELF_NAME } from './core.js';
import { isOfficialName } from './factory.js';

const STATE_FILE = 'safe-mode.json';

function stateFileOf(storeDir) {
  return join(storeDir, STATE_FILE);
}

function inactive() {
  return { active: false };
}

/** 读安全模式状态（缺失/损坏 → inactive，不抛）。 */
export function readSafeMode(storeDir) {
  try {
    const value = JSON.parse(readFileSync(stateFileOf(storeDir), 'utf8'));
    if (value !== null && typeof value === 'object' && value.active === true) return value;
  } catch {
    // 缺失或损坏
  }
  return inactive();
}

/** 原子写 JSON。 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

/** 原子写文本。 */
function writeTextAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.tmp-${process.pid}-${Date.now().toString(36)}`);
  writeFileSync(temp, content);
  renameSync(temp, file);
}

/** 状态摘要（路由与 CLI 用）。 */
export function safeModeStatus(storeDir) {
  const st = readSafeMode(storeDir);
  if (st.active !== true) return { active: false };
  const missing = [
    ...(typeof st.patchBackup === 'string' ? [st.patchBackup] : []),
    ...(typeof st.pkgBackup === 'string' ? [st.pkgBackup] : []),
  ].filter((file) => !existsSync(file));
  return {
    active: true,
    enteredAt: st.enteredAt ?? null,
    snapshotId: st.snapshotId ?? null,
    prunedBundles: Array.isArray(st.prunedBundles) ? st.prunedBundles : [],
    backupMissing: missing.length > 0,
  };
}

/**
 * 进入安全模式：备份 → 剪枝 bundles → 最小 patch → 写状态。
 * @returns {{ok: boolean, active: boolean, snapshotId?: string, prunedBundles?: string[], error?: string}}
 */
export function safeModeOn({ profileDir, storeDir }) {
  if (readSafeMode(storeDir).active === true) {
    return { ok: true, active: true, already: true };
  }
  const patchFile = join(profileDir, 'cordis.patch.yml');
  const pkgFile = join(profileDir, 'package.json');
  if (!existsSync(pkgFile)) {
    return { ok: false, active: false, error: 'profile package.json is missing' };
  }

  // 1. 前置快照（命名 safe-mode-before：它代表「最后正常状态」，自动回滚可用）
  const snap = createSnapshot({ profileDir, storeDir, reason: 'safe-mode-before', maxSnapshots: 100 });
  const stamp = snap.ok && snap.snapshot !== undefined ? snap.snapshot.id : `sm-${Date.now().toString(36)}`;

  // 2. 备份两个将被改写的文件
  const patchBackup = join(storeDir, `safe-mode-backup-${stamp}.yml`);
  const pkgBackup = join(storeDir, `safe-mode-pkg-${stamp}.json`);
  mkdirSync(storeDir, { recursive: true });
  try {
    if (existsSync(patchFile)) copyFileSync(patchFile, patchBackup);
    else writeTextAtomic(patchBackup, '[]\n');
    copyFileSync(pkgFile, pkgBackup);
  } catch (error) {
    return { ok: false, active: false, error: error instanceof Error ? error.message : String(error) };
  }

  // 3. 剪枝 bundles：只留官方（@deepseek-ai/*）+ 自身
  const manifest = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((name) => typeof name === 'string')
    : [];
  const kept = [];
  const prunedBundles = [];
  for (const name of bundles) {
    if (isOfficialName(name) || name === SELF_NAME) kept.push(name);
    else prunedBundles.push(name);
  }
  if (!kept.includes(SELF_NAME)) kept.push(SELF_NAME);
  manifest.dsh = typeof manifest.dsh === 'object' && manifest.dsh !== null ? manifest.dsh : {};
  manifest.dsh.profile = typeof manifest.dsh.profile === 'object' && manifest.dsh.profile !== null ? manifest.dsh.profile : {};
  manifest.dsh.profile.bundles = kept;

  // 4. 写回剪枝后的 package.json + 最小 patch（只挂自己）
  writeJsonAtomic(pkgFile, manifest);
  const minimal = [
    '# dsh-snapguard SAFE MODE',
    `# entered ${new Date().toISOString()} — 除快照守卫外所有用户插件已临时停用。`,
    '# 退出安全模式（面板/CLI safe-mode off）后，此文件与 package.json 将整体还原。',
    '- insert:',
    '    - id: snapguard',
    "      name: 'dsh-snapguard'",
    '',
  ].join('\n');
  writeTextAtomic(patchFile, minimal);

  // 5. 状态文件
  writeJsonAtomic(stateFileOf(storeDir), {
    active: true,
    enteredAt: new Date().toISOString(),
    snapshotId: snap.ok ? snap.snapshot.id : null,
    patchBackup,
    pkgBackup,
    prunedBundles,
  });

  return { ok: true, active: true, snapshotId: snap.ok ? snap.snapshot.id : null, prunedBundles };
}

/**
 * 退出安全模式：从备份整体还原 patch 与 package.json，删除状态。
 */
export function safeModeOff({ profileDir, storeDir }) {
  const st = readSafeMode(storeDir);
  if (st.active !== true) return { ok: true, active: false, message: '安全模式未激活' };
  if (typeof st.patchBackup !== 'string' || !existsSync(st.patchBackup)
    || typeof st.pkgBackup !== 'string' || !existsSync(st.pkgBackup)) {
    return { ok: false, active: true, error: '安全模式备份缺失，请先回滚到崩溃前的快照' };
  }
  copyFileSync(st.patchBackup, join(profileDir, 'cordis.patch.yml'));
  copyFileSync(st.pkgBackup, join(profileDir, 'package.json'));
  rmSync(stateFileOf(storeDir), { force: true });
  return { ok: true, active: false, message: '安全模式已退出，重启 DSH 后插件全部恢复' };
}
