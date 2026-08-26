/**
 * dsh-snapguard 宿主入口组件。
 *
 * 组件 id: snapguard；包名: dsh-snapguard。
 *
 * 激活流程（apply 的先后是崩溃自愈的关键）：
 *   1. 解析 profile 与存储目录；
 *   2. Boot Guard：若上次启动“有 start 无 ok 无 shutdown” → 判定崩溃 →
 *      自动回滚 **last-good** 快照（跳过 pre-rollback/pre-boot/pre-factory
 *      等自愈标签）并重启（防循环见 guard.js）；此判定在注册任何路由与
 *      服务之前完成，坏插件尚未加载即被拦截；
 *   3. 记录本次 boot-start；
 *   4. 注册 /snapguard/* HTTP 路由（等待 webServer 服务）；
 *   5. 启动组合文件变更监控（fs.watch + 周期轮询兜底 + 防抖）；
 *   6. 宿主就绪（20s 定时器或客户端渲染心跳，双通道）后写 boot-ok；
 *      宿主退出前尽力写 shutdownAt。
 *
 * 所有副作用都挂在 ctx.effect 上：组件停止/更新时自动释放。
 */
import { readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  createSnapshot, listSnapshots, restoreSnapshot, deleteSnapshot,
  lastGoodSnapshot, harnessVersion, dshHomePath, storeDirOf, SELF_NAME,
} from './core.js';
import {
  beginBoot, markBootOk, markShutdown, lastBootCrashed,
  autoRollbackAllowed, registerRollback, setAutoRollback, setAutoSnapshot,
  statusSummary, readState,
} from './guard.js';
import { factoryReset } from './factory.js';
import { safeModeOn, safeModeOff, safeModeStatus } from './safemode.js';
import { writeIncident, listIncidents } from './incidents.js';
import { scheduleRestart, servingPort, trustedRestartRequest } from './restart.js';

export const name = 'snapguard';

const VERSION = '0.2.0';

/** argv --profile 解析（与 dshmarket 同法）。 */
function argvProfile() {
  const argv = process.argv;
  const flag = argv.indexOf('--profile');
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1];
  return undefined;
}

function resolveProfile(config) {
  const home = dshHomePath();
  const profileName = config?.profile ?? argvProfile() ?? 'web';
  const profileDir = config?.profileDirectory ?? join(home, 'profiles', profileName);
  return { profileName, profileDir, home, storeDir: storeDirOf(home) };
}

/** 序列化写操作：一次只执行一个（与 dshmarket withMutationLock 同构）。 */
function createMutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(() => fn());
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** 组合关键文件的内容指纹（空值 = 无可比对内容）。 */
function compositionFingerprint(profileDir) {
  const hash = createHash('sha256');
  const targets = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'cordis.yml'];
  let any = false;
  for (const rel of targets) {
    try {
      hash.update(rel).update(':');
      hash.update(readFileSync(join(profileDir, rel)));
      any = true;
    } catch {
      hash.update(rel).update(':missing');
    }
  }
  try {
    const state = join(profileDir, '.dsh-market', 'state.json');
    hash.update('.dsh-market/state.json:').update(readFileSync(state));
    any = true;
  } catch {
    hash.update('.dsh-market/state.json:missing');
  }
  return any ? hash.digest('hex') : null;
}

export function apply(ctx, config = {}) {
  const resolved = resolveProfile(config);
  const { profileDir, storeDir } = resolved;
  const maxSnapshots = Number.isFinite(config.maxSnapshots) ? config.maxSnapshots : 20;
  const debounceMs = Number.isFinite(config.autoSnapshotDebounceMs) ? config.autoSnapshotDebounceMs : 15000;
  const maxAutoRollbacks = Number.isFinite(config.maxAutoRollbacks) ? config.maxAutoRollbacks : 2;

  // ═══ 1+2. Boot Guard 自愈（坏插件加载前的最后防线）═══════════════════
  if (lastBootCrashed(storeDir)) {
    if (autoRollbackAllowed(storeDir, maxAutoRollbacks)) {
      const targetSnapshot = lastGoodSnapshot(storeDir);
      if (targetSnapshot !== null) {
        const done = restoreSnapshot({ profileDir, storeDir, snapshotId: targetSnapshot.id, keep: [SELF_NAME], allowPreRollback: false });
        if (done.ok) {
          registerRollback(storeDir, targetSnapshot.id);
          writeIncident(storeDir, {
            kind: 'boot-crash',
            snapshotId: targetSnapshot.id,
            dshVersion: harnessVersion(),
            detail: `上次启动未正常结束（无 boot-ok 且无正常退出标记），已自动回滚到 last-good 快照 ${targetSnapshot.id}`,
          });
          console.log(`[dsh-snapguard] 上次启动崩溃，已自动回滚到 ${targetSnapshot.id} 并重启`);
          // 不让宿主继续加载（可能已损坏的）社区插件：直接调度重启后返回。
          scheduleRestart(null, storeDir);
          return;
        }
      }
      writeIncident(storeDir, {
        kind: 'boot-crash-no-snapshot',
        dshVersion: harnessVersion(),
        detail: '上次启动崩溃，但没有可用快照，跳过自动回滚',
      });
      console.log('[dsh-snapguard] 上次启动崩溃，但没有可用快照，跳过自动回滚');
    } else {
      console.log('[dsh-snapguard] 自动回滚次数已达上限，进入保守模式：等待人工处理');
    }
  }
  beginBoot(storeDir);

  // ═══ 3. HTTP 路由（等待 webServer 服务可用）══════════════════════════
  const mutex = createMutex();
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer;
    // 双通道就绪：定时器兜底（无客户端页面场景）+ 客户端渲染心跳优先。
    const okTimer = setTimeout(() => {
      try {
        markBootOk(storeDir);
      } catch {
        // 写失败不致命
      }
    }, 20000);
    okTimer.unref();
    hostCtx.effect(() => clearTimeout(okTimer), 'snapguard: boot-ok timer');

    const json = (response, status, body) => {
      try {
        const text = JSON.stringify(body);
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(text);
      } catch {
        response.writeHead(500);
        response.end();
      }
    };
    const readBody = async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return null;
      }
    };
    const isMutation = (request) => request.method === 'POST' && trustedRestartRequest(request);

    // 状态：快照列表、boot 状态、安全模式、开关、profile 信息、事故记录
    webServer.register({
      kind: 'exact',
      path: '/snapguard/status',
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST' });
          response.end();
          return;
        }
        if (request.method === 'POST' && !trustedRestartRequest(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const state = readState(storeDir);
        json(response, 200, {
          ok: true,
          version: VERSION,
          dshVersion: harnessVersion(),
          profile: { name: resolved.profileName, dir: profileDir },
          state: statusSummary(storeDir),
          snapshots: listSnapshots(storeDir),
          safeMode: safeModeStatus(storeDir),
          incidents: listIncidents(storeDir),
          autoSnapshot: state.autoSnapshotEnabled,
          autoRollback: state.autoRollbackEnabled,
          maxSnapshots,
        });
      },
    });

    // 客户端渲染心跳：面板挂载后周期性汇报（黑屏检测信号，UI 显示用）
    webServer.register({
      kind: 'exact',
      path: '/snapguard/health',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        json(response, 200, { ok: true, at: Date.now() });
      },
    });

    // 手动创建快照
    webServer.register({
      kind: 'exact',
      path: '/snapguard/snapshot',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const result = await mutex(() => createSnapshot({
          profileDir, storeDir, reason: 'manual', maxSnapshots,
        }));
        json(response, result.ok ? 200 : 400, result);
      },
    });

    // 回滚到指定快照（默认随后重启）；自动先拍 pre-rollback 后悔药
    webServer.register({
      kind: 'exact',
      path: '/snapguard/restore',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const body = await readBody(request);
        if (body === null || typeof body.snapshot !== 'string' || body.snapshot === '') {
          json(response, 400, { error: 'snapshot id required' });
          return;
        }
        const result = await mutex(async () => {
          // 回滚前拍当前状态的后悔药（pre-rollback 标签不会参与自动回滚）
          const done = restoreSnapshot({ profileDir, storeDir, snapshotId: body.snapshot, keep: [SELF_NAME] });
          if (done.ok) {
            writeIncident(storeDir, {
              kind: 'manual-rollback',
              snapshotId: body.snapshot,
              dshVersion: harnessVersion(),
              detail: `面板回滚到 ${body.snapshot}${done.removedLinks !== undefined && done.removedLinks.length > 0 ? `，清理孤儿链接: ${done.removedLinks.join(', ')}` : ''}`,
            });
          }
          if (done.ok && body.restart !== false) {
            scheduleRestart(servingPort(request), storeDir);
          }
          return done;
        });
        json(response, result.ok ? 200 : 400, result);
      },
    });

    // 删除快照
    webServer.register({
      kind: 'exact',
      path: '/snapguard/delete-snapshot',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const body = await readBody(request);
        if (body === null || typeof body.snapshot !== 'string') {
          json(response, 400, { error: 'snapshot id required' });
          return;
        }
        const result = await mutex(() => deleteSnapshot(storeDir, body.snapshot));
        json(response, result.ok ? 200 : 400, result);
      },
    });

    // 安全模式：温和停用全部用户插件（备份还原，不删任何包）
    webServer.register({
      kind: 'exact',
      path: '/snapguard/safe-mode',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const body = await readBody(request);
        const action = body?.action ?? 'status';
        if (action === 'status') {
          json(response, 200, { ok: true, safeMode: safeModeStatus(storeDir) });
          return;
        }
        const result = await mutex(async () => {
          if (action === 'on') {
            const done = safeModeOn({ profileDir, storeDir });
            if (done.ok) {
              writeIncident(storeDir, {
                kind: 'safe-mode-on',
                snapshotId: done.snapshotId ?? null,
                dshVersion: harnessVersion(),
                detail: `安全模式开启，停用插件: ${(done.prunedBundles ?? []).join(', ') || '无'}`,
              });
              if (body.restart !== false) scheduleRestart(servingPort(request), storeDir);
            }
            return done;
          }
          if (action === 'off') {
            const done = safeModeOff({ profileDir, storeDir });
            if (done.ok) writeIncident(storeDir, { kind: 'safe-mode-off', dshVersion: harnessVersion(), detail: '安全模式退出' });
            if (done.ok && body.restart !== false) scheduleRestart(servingPort(request), storeDir);
            return done;
          }
          return { ok: false, error: `unknown action: ${action}` };
        });
        json(response, result.ok ? 200 : 400, { ok: result.ok, ...result });
      },
    });

    // 恢复出厂设置（动态官方基线；可选保留插件市场）
    webServer.register({
      kind: 'exact',
      path: '/snapguard/factory-reset',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const body = await readBody(request);
        const keepMarket = body === null || typeof body.keepMarket !== 'boolean' ? true : body.keepMarket;
        const result = await mutex(async () => {
          // 后悔药：出厂前的当前状态先留一份快照
          createSnapshot({ profileDir, storeDir, reason: 'pre-factory', maxSnapshots });
          const reset = factoryReset({ profileDir, storeDir, keepMarket });
          if (reset.ok) {
            writeIncident(storeDir, {
              kind: 'factory-reset',
              dshVersion: harnessVersion(),
              detail: `恢复出厂（保留市场=${keepMarket}）；保留: ${reset.kept.join(', ')}；移除: ${reset.removed.join(', ') || '无'}`,
            });
          }
          if (reset.ok && body?.restart !== false) scheduleRestart(servingPort(request), storeDir);
          return reset;
        });
        json(response, result.ok ? 200 : 400, result);
      },
    });

    // 手动重启宿主（回滚/出厂默认已带重启；此入口供保险）
    webServer.register({
      kind: 'exact',
      path: '/snapguard/restart',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const result = scheduleRestart(servingPort(request), storeDir);
        json(response, 200, { ok: true, ...result });
      },
    });

    // 开关：自动回滚 / 自动快照
    webServer.register({
      kind: 'exact',
      path: '/snapguard/toggles',
      handler: async (request, response) => {
        if (!isMutation(request)) {
          json(response, 403, { error: 'untrusted origin' });
          return;
        }
        const body = await readBody(request);
        if (body === null) {
          json(response, 400, { error: 'invalid body' });
          return;
        }
        if (typeof body.autoRollback === 'boolean') setAutoRollback(storeDir, body.autoRollback);
        if (typeof body.autoSnapshot === 'boolean') setAutoSnapshot(storeDir, body.autoSnapshot);
        json(response, 200, { ok: true, state: statusSummary(storeDir) });
      },
    });
  });

  // ═══ 4. 组合键文件变更监控：fs.watch + 周期轮询兜底 + 防抖合并 ══════
  let watcher = null;
  let pollTimer = null;
  let pendingTimer = null;
  let lastFingerprint = compositionFingerprint(profileDir);
  let enabled = readState(storeDir).autoSnapshotEnabled !== false;

  const takeSnapshotIfChanged = (reason = 'auto') => {
    if (!enabled) return;
    const fingerprint = compositionFingerprint(profileDir);
    if (fingerprint === null || fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    try {
      const result = createSnapshot({ profileDir, storeDir, reason, maxSnapshots });
      if (result.ok) console.log(`[dsh-snapguard] 自动快照完成: ${result.snapshot.id}`);
    } catch (error) {
      console.warn('[dsh-snapguard] 自动快照失败:', error);
    }
  };
  const schedulePending = () => {
    if (!enabled) return;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => takeSnapshotIfChanged('auto'), debounceMs);
  };

  ctx.effect(() => {
    // fs.watch（Windows 支持 recursive；失败降级为轮询）
    try {
      watcher = watch(profileDir, { recursive: true }, (_event, filename) => {
        if (filename === undefined || fileNameInScope(profileDir, filename)) schedulePending();
      });
      watcher.on('error', () => {
        watcher?.close?.();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    // 周期轮询兜底（防 watch 丢事件；同时覆盖 lockfile 等）
    pollTimer = setInterval(() => takeSnapshotIfChanged('auto'), 120000);
    return () => {
      clearTimeout(pendingTimer);
      clearInterval(pollTimer);
      watcher?.close?.();
    };
  }, 'snapguard: composition watcher');

  // ═══ 5. 退出钩子：尽力写 shutdownAt（崩溃路径不写 → 下次启动判崩）═══
  ctx.effect(() => {
    const onExit = () => {
      try {
        markShutdown(storeDir);
      } catch {
        // 尽力而为
      }
    };
    const onSigint = () => {
      onExit();
      try {
        process.exit(0);
      } catch {
        // 忽略
      }
    };
    const onSigterm = () => {
      onExit();
      try {
        process.exit(0);
      } catch {
        // 忽略
      }
    };
    process.on('exit', onExit);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    return () => {
      process.removeListener('exit', onExit);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    };
  }, 'snapguard: shutdown marker');
}

/** 文件名是否落在监控范围（组合关键文件或第三方插件包 manifest）。 */
function fileNameInScope(profileDir, filename) {
  const rel = String(filename).split(sep).join('/');
  const lower = rel.toLowerCase();
  if (lower === 'package.json' || lower === 'cordis.patch.yml' || lower === 'pnpm-lock.yaml'
    || lower === 'pnpm-workspace.yaml' || lower === 'cordis.yml' || lower === '.npmrc') return true;
  if (lower.startsWith('.dsh-market/')) return true;
  // node_modules/<pkg>/package.json 或 node_modules/@scope/<pkg>/package.json
  if (/^node_modules\/[^/]+\/[^/]+\/package\.json$/i.test(rel) || /^node_modules\/@[^/]+\/[^/]+\/package\.json$/i.test(rel)) {
    const parts = rel.split('/');
    const name = parts.length === 3 ? parts[1] : `${parts[1]}/${parts[2]}`;
    if (name.startsWith('@deepseek-ai/')) return false;
    return true;
  }
  return false;
}

export { VERSION as snapguardVersion };
