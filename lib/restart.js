/**
 * dsh-snapguard 重启助手 —— 分两半：
 *   1) 当前宿主进程：写 shutdownAt、spawn 一个 detached helper、随后自杀；
 *   2) helper（独立进程）：等旧端口真正释放 → 以完全相同的调用重启宿主 →
 *      校验新实例绑定成功 → 一切不可见失败都写入 tmpdir 日志留证。
 *
 * 自研实现对齐 dshmarket restart.js 的安全模型：Windows 用
 * powershell -WindowStyle Hidden 隐藏继承的控制台；POSIX 用 detached。
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { writeFileSync, appendFileSync } from 'node:fs';
import { markShutdown } from './guard.js';

/** 重新构建 DSH 启动调用（对齐 dshmarket dshArgv 的两种形态）。 */
export function launchArgv() {
  const entry = process.argv[1];
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry);
    return {
      file: process.execPath,
      args: [...process.execArgv, abs, ...process.argv.slice(2)],
      cwd: dirname(abs),
      viaShell: false,
    };
  }
  return {
    file: 'dsh',
    args: [...process.argv.slice(2)],
    cwd: undefined,
    viaShell: process.platform === 'win32',
  };
}

/** 平台正确的重启 spawn 形态（隐藏黑窗/脱离父进程）。 */
export function respawnInvocation(launch, platform = process.platform) {
  if (platform !== 'win32') {
    return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };
  }
  const quote = (part) => `'${part.replace(/'/g, "''")}'`;
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      [`& ${quote(launch.file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  };
}

/** 从请求 Host header 读出端口（无则 null）。 */
export function servingPort(request) {
  const host = request?.headers?.host;
  if (typeof host !== 'string') return null;
  const match = /:(\d{1,5})$/.exec(host);
  if (match === null) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** 同源 + 回环校验（与 dshmarket 同姿态：禁用转发头）。 */
export function trustedRestartRequest(request) {
  const address = request?.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (request?.headers?.forwarded !== undefined
    || request?.headers?.['x-forwarded-for'] !== undefined
    || request?.headers?.['x-real-ip'] !== undefined) return false;
  const origin = request?.headers?.origin;
  const host = request?.headers?.host;
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

/** helper 源码：纯 CommonJS、无外部依赖。 */
export function restartHelperSource(spawned, launch, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise(r => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[dsh-snapguard] ${line}\\n`) } catch {} }',
    'const listening = () => new Promise((resolvePromise) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolvePromise(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note(`port ${port} still in use after 30s; starting anyway`)',
    '    await sleep(300)',
    '  } else {',
    '    await sleep(1500)',
    '  }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    '    child.on("error", (error) => note(`could not start replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    '  if (!port) { await sleep(3000); return }',
    '  const upBy = Date.now() + 20000',
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note(`replacement did not bind port ${port} within 20s — check ${logOut}`)',
    '}',
    'main()',
  ].join('\n');
}

/**
 * 调度重启：写 shutdownAt → 拉起 detached helper → 500ms 后 SIGTERM 自身。
 * @param {number|null} port 当前监听端口（未知传 null）
 * @param {string|null} storeDir 供 markShutdown 写正常退出标记
 * @returns {{pid: number, helperPid: number|null, logOut: string, logErr: string}}
 */
export function scheduleRestart(port = null, storeDir = null) {
  if (storeDir !== null) {
    try {
      markShutdown(storeDir);
    } catch {
      // 尽力而为：写失败不阻止重启
    }
  }
  const launch = launchArgv();
  const spawned = respawnInvocation(launch);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logOut = join(tmpdir(), `dsh-snapguard-restart-${stamp}.out.log`);
  const logErr = join(tmpdir(), `dsh-snapguard-restart-${stamp}.err.log`);
  let helper = null;
  try {
    helper = spawn(process.execPath, ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    helper.unref();
  } catch (error) {
    appendFileSync(logErr, `[dsh-snapguard] helper spawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      // 进程已经在退出
    }
  }, 500);
  return { pid: process.pid, helperPid: helper === null ? null : helper.pid ?? null, logOut, logErr };
}
