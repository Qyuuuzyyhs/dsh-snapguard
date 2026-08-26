/**
 * dsh-snapguard Boot Guard —— 启动失败自愈。
 *
 * 原理：宿主启动时本插件（被安装脚本排在所有社区插件之前）先执行，
 * 在 state.json 里写下本次启动的 boot-start；宿主真正就绪（webServer
 * 注入并稳定）后再写 boot-ok；宿主退出前尽力写 shutdownAt。
 *
 * 判定：下次启动时若发现「上次有 boot-start 但既无 boot-ok 也无
 * shutdownAt」，说明宿主没有走到就绪、也没有正常退出 —— 也就是崩溃
 * 或被强制杀死 —— 此时自动回滚到最新一份快照并重启（防循环：连续
 * 失败达到 maxAutoRollbacks 次后转为保守模式，等待用户手工处理）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATE_VERSION = 1;

export function defaultState() {
  return {
    version: STATE_VERSION,
    boot: { startId: null, startedAt: null, okAt: null, shutdownAt: null },
    failCount: 0,
    lastRollback: null,
    autoRollbackEnabled: true,
    autoSnapshotEnabled: true,
  };
}

export function stateFileOf(storeDir) {
  return join(storeDir, 'state.json');
}

/** 读取 state.json（缺失/损坏时返回默认值，绝不抛出）。 */
export function readState(storeDir) {
  const file = stateFileOf(storeDir);
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return defaultState();
  }
  if (raw === null || typeof raw !== 'object') return defaultState();
  const base = defaultState();
  return {
    version: STATE_VERSION,
    boot: typeof raw.boot === 'object' && raw.boot !== null ? { ...base.boot, ...raw.boot } : base.boot,
    failCount: Number.isFinite(raw.failCount) ? raw.failCount : 0,
    lastRollback: typeof raw.lastRollback === 'object' && raw.lastRollback !== null ? raw.lastRollback : null,
    autoRollbackEnabled: raw.autoRollbackEnabled !== false,
    autoSnapshotEnabled: raw.autoSnapshotEnabled !== false,
  };
}

/** 原子写 state.json（temp + rename）。 */
export function writeState(storeDir, state) {
  const file = stateFileOf(storeDir);
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.state-${process.pid}-${Date.now().toString(36)}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

/** 上一次启动是否“失败”（有 start、无 ok、无 shutdown）。 */
export function lastBootCrashed(storeDir) {
  const state = readState(storeDir);
  const boot = state.boot ?? {};
  if (boot.startId === null || boot.startedAt === null || boot.okAt !== null) return false;
  if (boot.shutdownAt !== null) return false;
  return true;
}

/** 记录本次启动开始（保留上一个周期的 failCount 供判定）。 */
export function beginBoot(storeDir, sessionId = null) {
  const state = readState(storeDir);
  const now = Date.now();
  state.boot = {
    startId: sessionId ?? `boot-${now.toString(36)}`,
    startedAt: now,
    okAt: null,
    shutdownAt: null,
  };
  writeState(storeDir, state);
  return state;
}

/** 宿主就绪：写 okAt 并把连续失败计数归零。 */
export function markBootOk(storeDir) {
  const state = readState(storeDir);
  state.boot = { ...state.boot, okAt: Date.now() };
  state.failCount = 0;
  writeState(storeDir, state);
}

/** 宿主准备退出（尽力而为）：写 shutdownAt。 */
export function markShutdown(storeDir) {
  const state = readState(storeDir);
  state.boot = { ...state.boot, shutdownAt: Date.now() };
  writeState(storeDir, state);
}

/** 记录一次自动回滚（防循环计数）。 */
export function registerRollback(storeDir, snapshotId) {
  const state = readState(storeDir);
  state.failCount = (state.failCount ?? 0) + 1;
  state.lastRollback = { snapshotId, at: Date.now() };
  writeState(storeDir, state);
  return state.failCount;
}

/** 当前是否允许再执行一次自动回滚。 */
export function autoRollbackAllowed(storeDir, maxAutoRollbacks = 2) {
  const state = readState(storeDir);
  if (state.autoRollbackEnabled === false) return false;
  return (state.failCount ?? 0) < maxAutoRollbacks;
}

/** 开关：自动回滚 / 自动快照。 */
export function setAutoRollback(storeDir, enabled) {
  const state = readState(storeDir);
  state.autoRollbackEnabled = enabled === true;
  writeState(storeDir, state);
}
export function setAutoSnapshot(storeDir, enabled) {
  const state = readState(storeDir);
  state.autoSnapshotEnabled = enabled === true;
  writeState(storeDir, state);
}

/**
 * 状态摘要（路由 /status 输出）：只含标量，不暴露内部对象。
 */
export function statusSummary(storeDir) {
  const state = readState(storeDir);
  return {
    boot: {
      startId: state.boot.startId,
      startedAt: state.boot.startedAt,
      okAt: state.boot.okAt,
      shutdownAt: state.boot.shutdownAt,
    },
    failCount: state.failCount,
    lastRollback: state.lastRollback,
    autoRollbackEnabled: state.autoRollbackEnabled,
    autoSnapshotEnabled: state.autoSnapshotEnabled,
    storeDir,
  };
}
