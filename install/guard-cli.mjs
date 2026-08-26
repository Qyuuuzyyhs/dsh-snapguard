#!/usr/bin/env node
/**
 * dsh-snapguard 离线 CLI —— DSH 完全起不来时的救生艇。
 *
 * 零依赖（只使用 Node 内置模块与插件自身 lib/），因此在 DSH 崩溃、
 * Web 面板打不开时仍可直接运行：
 *
 *   node install/guard-cli.mjs status                 # 快照/状态/事故一览
 *   node install/guard-cli.mjs snapshot               # 手动拍一份快照
 *   node install/guard-cli.mjs rollback [--id X]      # 回滚（默认 last-good）
 *   node install/guard-cli.mjs safe-mode on|off|status
 *   node install/guard-cli.mjs factory [--no-market]
 *   node install/guard-cli.mjs incident               # 事故记录
 *
 * 注意：CLI 不会也不能重启 DSH —— 回滚/安全模式/出厂后请自行重启 DSH。
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(join(here, '..', 'lib', name)).href;

const core = await import(lib('core.js'));
const guard = await import(lib('guard.js'));
const { factoryReset } = await import(lib('factory.js'));
const { safeModeOn, safeModeOff, safeModeStatus } = await import(lib('safemode.js'));
const incidents = await import(lib('incidents.js'));

function parseArgs(argv) {
  const out = { flags: {}, args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      out.flags[key] = value === undefined ? true : value;
    } else if (arg.startsWith('-')) {
      out.flags[arg.slice(1)] = true;
    } else {
      out.args.push(arg);
    }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const command = argv.args[0] ?? 'help';

const dshHome = core.dshHomePath();
const profileName = typeof argv.flags.profile === 'string' ? argv.flags.profile : 'web';
const profileDir = join(dshHome, 'profiles', profileName);
const storeDir = core.storeDirOf(dshHome);

function out(label, value) {
  console.log(`${label}: ${value}`);
}

function humanTime(ms) {
  return ms ? new Date(ms).toLocaleString() : '(无)';
}

function printStatus() {
  const state = guard.readState(storeDir);
  const snapshots = core.listSnapshots(storeDir);
  const good = core.lastGoodSnapshot(storeDir);
  const safe = safeModeStatus(storeDir);
  const events = incidents.listIncidents(storeDir);
  out('DSH_HOME', dshHome);
  out('profile', `${profileName} -> ${profileDir}`);
  out('DSH 版本', core.harnessVersion() || '(未知)');
  out('自动快照', state.autoSnapshotEnabled ? '开' : '关');
  out('崩溃自动回滚', state.autoRollbackEnabled ? '开' : '关');
  out('安全模式', safe.active ? `激活中（${safe.enteredAt ?? ''}）` : '未激活');
  out('连续回滚次数', state.failCount);
  out('上次回滚', state.lastRollback ? `${state.lastRollback.snapshotId} @ ${humanTime(state.lastRollback.at)}` : '(无)');
  out('last-good 快照', good ? `${good.id} @ ${humanTime(good.createdAt)}` : '(无)');
  console.log('');
  console.log(`快照（${snapshots.length}）:`);
  for (const snap of snapshots) {
    console.log(`  ${snap.id}  ${snap.reason}  ${humanTime(snap.createdAt)}  cfg=${snap.files} pkg=${snap.packageCount}  dsh=${snap.dshVersion || '?'}`);
  }
  if (events.length > 0) {
    console.log('');
    console.log(`事故记录（最新 ${Math.min(events.length, 5)}）:`);
    for (const event of events.slice(-5).reverse()) {
      console.log(`  ${humanTime(event.at)} [${event.kind}] ${event.detail ?? ''}`);
    }
  }
}

async function main() {
  switch (command) {
    case 'status': {
      printStatus();
      return;
    }
    case 'snapshot': {
      const result = core.createSnapshot({ profileDir, storeDir, reason: 'manual', maxSnapshots: 20 });
      if (result.ok) {
        console.log(`快照创建成功: ${result.snapshot.id}`);
      } else {
        console.error(`快照失败: ${result.error ?? 'unknown error'}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'rollback': {
      const snapshots = core.listSnapshots(storeDir);
      if (snapshots.length === 0) {
        console.error('没有可用快照');
        process.exitCode = 1;
        return;
      }
      const targetId = typeof argv.flags.id === 'string'
        ? argv.flags.id
        : core.lastGoodSnapshot(storeDir)?.id ?? snapshots[0].id;
      console.log(`回滚到: ${targetId}`);
      const result = core.restoreSnapshot({ profileDir, storeDir, snapshotId: targetId, keep: [core.SELF_NAME] });
      if (result.ok) {
        console.log(`回滚成功；恢复配置 ${result.restoredFiles.length} 项、插件 ${result.restoredPackages.length} 个`);
        if (result.removedLinks?.length > 0) console.log(`清理孤儿链接: ${result.removedLinks.join(', ')}`);
        console.log('请重启 DSH 以生效。');
      } else {
        console.error(`回滚失败: ${result.error ?? 'unknown error'}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'safe-mode': {
      const action = argv.args[1] ?? 'status';
      if (action === 'status') {
        const safe = safeModeStatus(storeDir);
        console.log(safe.active ? `安全模式激活中${safe.enteredAt ? `（${safe.enteredAt}）` : ''}` : '安全模式未激活');
        return;
      }
      if (action === 'on') {
        const result = safeModeOn({ profileDir, storeDir });
        if (result.ok) {
          console.log(`安全模式已开启（快照 ${result.snapshotId ?? '-'}）; 停用插件: ${(result.prunedBundles ?? []).join(', ') || '无'}`);
          console.log('请重启 DSH 以生效。');
        } else {
          console.error(`失败: ${result.error ?? 'unknown error'}`);
          process.exitCode = 1;
        }
        return;
      }
      if (action === 'off') {
        const result = safeModeOff({ profileDir, storeDir });
        if (result.ok) {
          console.log(result.message ?? '安全模式已退出');
          console.log('请重启 DSH 以生效。');
        } else {
          console.error(`失败: ${result.error ?? 'unknown error'}`);
          process.exitCode = 1;
        }
        return;
      }
      console.error(`unknown safe-mode action: ${action}`);
      process.exitCode = 1;
      return;
    }
    case 'factory': {
      const keepMarket = !(argv.flags['no-market'] === true);
      core.createSnapshot({ profileDir, storeDir, reason: 'pre-factory', maxSnapshots: 100 });
      const result = factoryReset({ profileDir, storeDir, keepMarket });
      if (result.ok) {
        console.log('恢复出厂完成（动态官方基线）');
        console.log(`  保留: ${result.kept.join(', ')}`);
        if (result.removed.length > 0) console.log(`  移除: ${result.removed.join(', ')}`);
        if (result.removalFailed.length > 0) console.log(`  未能删除（重启后可随 pnpm 清理）: ${result.removalFailed.join(', ')}`);
        console.log('请重启 DSH 以生效。');
      } else {
        console.error(`失败: ${result.error ?? 'unknown error'}`);
        process.exitCode = 1;
      }
      return;
    }
    case 'incident': {
      const events = incidents.listIncidents(storeDir);
      if (events.length === 0) {
        console.log('暂无事故记录');
        return;
      }
      for (const event of events) {
        console.log(`[${event.kind}] ${humanTime(event.at)}  snapshot=${event.snapshotId ?? '-'}  dsh=${event.dshVersion || '?'}`);
        if (event.detail) console.log(`   ${event.detail}`);
      }
      return;
    }
    case 'help':
    case '-h':
    default:
      console.log(`dsh-snapguard CLI — DSH 起不来时的救生艇
用法: node guard-cli.mjs <command> [选项]

命令:
  status                       快照/状态/事故一览
  snapshot                     手动拍一份快照
  rollback [--id <id>]         回滚（默认先生成 pre-rollback 后悔药，再回滚 last-good）
  safe-mode on|off|status      安全模式（温和停用全部用户插件，可一键还原）
  factory [--no-market]        恢复出厂（动态官方基线；默认保留插件市场）
  incident                     查看事故记录

通用选项:
  --profile <name>             profile 名（默认 web）

注意: CLI 不负责重启 DSH，操作完成后请自行重启。`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`[dsh-snapguard CLI] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
