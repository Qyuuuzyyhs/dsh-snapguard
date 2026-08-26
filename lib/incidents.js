/**
 * dsh-snapguard 事故记录（incident）：崩溃自愈、回滚、安全模式等关键
 * 事件落一份可读 JSON，供面板与离线 CLI 查看（借鉴 dsh-plugin-guard 的
 * incident report 思路，但保持零依赖、纯本地文件）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const KEEP_INCIDENTS = 30;

export function incidentsDirOf(storeDir) {
  return join(storeDir, 'incidents');
}

/** 记录一条事故/事件。失败的日志写操作绝不抛出。 */
export function writeIncident(storeDir, { kind, detail, snapshotId = null, dshVersion = '' }) {
  try {
    const dir = incidentsDirOf(storeDir);
    mkdirSync(dir, { recursive: true });
    const at = Date.now();
    const file = join(dir, `incident-${at}-${Math.random().toString(36).slice(2, 6)}.json`);
    const temp = join(dir, `.tmp-${process.pid}-${at.toString(36)}`);
    writeFileSync(temp, `${JSON.stringify({
      kind: String(kind ?? 'unknown'),
      at,
      snapshotId,
      dshVersion,
      detail: typeof detail === 'string' ? detail : null,
    }, null, 2)}\n`);
    renameSync(temp, file);
    pruneIncidents(storeDir);
    return file;
  } catch {
    return null;
  }
}

/** 读取全部事故记录（新→旧）。 */
export function listIncidents(storeDir) {
  const dir = incidentsDirOf(storeDir);
  let entries = [];
  try {
    entries = readdirSync(dir).filter((name) => name.startsWith('incident-') && name.endsWith('.json'));
  } catch {
    return [];
  }
  const list = [];
  for (const name of entries) {
    try {
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (value !== null && typeof value === 'object') list.push(value);
    } catch {
      // 跳过损坏条目
    }
  }
  list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return list;
}

/** 修剪到最近 KEEP_INCIDENTS 条。 */
export function pruneIncidents(storeDir) {
  const list = listIncidents(storeDir);
  const overflow = list.length - KEEP_INCIDENTS;
  if (overflow <= 0) return;
  const removeAt = new Set(list.slice(0, overflow).map((item) => String(item.at)));
  const dir = incidentsDirOf(storeDir);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('incident-') || !name.endsWith('.json')) continue;
      const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (value !== null && typeof value === 'object' && removeAt.has(String(value.at))) {
        rmSync(join(dir, name), { force: true });
      }
    }
  } catch {
    // 修剪失败无碍
  }
}

export function incidentDirExists(storeDir) {
  return existsSync(incidentsDirOf(storeDir));
}
