/**
 * dsh-snapguard 核心逻辑模拟测试（不触碰真实 DSH 环境）。
 * 运行：node test/run-mocks.mjs
 * 在 test/sandbox/ 下搭建假 profile（@deepseek-ai 官方 + 第三方插件目录），
 * 依次验证：快照（含锁文件/dshVersion）→ 组合改动 → 回滚（pre-rollback
 * 后悔药 + 保活注入 + 孤儿链接清理）→ last-good 语义 → 崩溃状态机 →
 * 事故记录 → 安全模式 roundtrip → 恢复出厂 → 恶意 id 拒绝。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = join(root, 'test', 'sandbox');
const profileDir = join(sandbox, 'profiles', 'web');
const storeDir = join(sandbox, '.snapguard');

const core = await import('../lib/core.js');
const guard = await import('../lib/guard.js');
const { factoryReset } = await import('../lib/factory.js');
const { safeModeOn, safeModeOff, safeModeStatus } = await import('../lib/safemode.js');
const { writeIncident, listIncidents } = await import('../lib/incidents.js');

let passed = 0;
let failed = 0;
const check = (label, cond) => {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
};

// ── 搭建假 profile ────────────────────────────────────────────────────
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(profileDir, '.dsh-market'), { recursive: true });
mkdirSync(join(profileDir, 'node_modules', 'dshmarket', 'lib'), { recursive: true });
mkdirSync(join(profileDir, 'node_modules', '@linxin666', 'dsh-client-ui-skin-center'), { recursive: true });
mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-whale-fake'), { recursive: true });

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  dependencies: {
    dshmarket: '^1.26.0',
    '@linxin666/dsh-client-ui-skin-center': '^0.3.4',
    'dsh-orphan-link': 'link:./dsh-orphan-link',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', '@linxin666/dsh-client-ui-skin-center'] } },
}, null, 2));
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# dummy patch\n- id: rollback-fork\n  disabled: true\n');
writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
writeFileSync(join(profileDir, '.dsh-market', 'state.json'), JSON.stringify({ disabled: [], groups: {} }));
writeFileSync(join(profileDir, 'node_modules', 'dshmarket', 'package.json'), JSON.stringify({ name: 'dshmarket', version: '1.26.0', main: 'lib/index.js', dependencies: { 'js-yaml': '^4.1.0', undici: '^7.29.0' } }));
writeFileSync(join(profileDir, 'node_modules', 'dshmarket', 'lib', 'index.js'), 'export const name="dsh-market"\n');
writeFileSync(join(profileDir, 'node_modules', '@linxin666', 'dsh-client-ui-skin-center', 'package.json'), JSON.stringify({ name: '@linxin666/dsh-client-ui-skin-center', version: '0.3.4' }));
writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-whale-fake', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-whale-fake', version: '1.0.0' }));
// 孤儿链接：manifest 声明的 link: 依赖（模拟 pnpm stale link 残留）
try { symlinkSync(join(sandbox, 'orphan-target'), join(profileDir, 'node_modules', 'dsh-orphan-link'), 'junction'); } catch { /* 无权限则跳过 */ }

console.log('== 1. 组合文件与第三方包识别（含锁文件）==');
const cfgFiles = core.compositionFiles(profileDir);
check('组合关键文件捕获 4 个（package.json/patch/lock/state）', cfgFiles.length === 4);
const third = core.thirdPartyPackages(profileDir);
check('第三方包识别（不含官方）', third.length === 2 && third.every((p) => !p.name.startsWith('@deepseek-ai')));

console.log('== 2. 手动快照（含 dshVersion）==');
const snap1 = core.createSnapshot({ profileDir, storeDir, reason: 'manual', maxSnapshots: 5 });
check('快照创建成功', snap1.ok === true);
check('快照含 lockfile 捕获（files=4）', snap1.snapshot.files === 4);
check('manifest 记录 dshVersion 字段', typeof snap1.snapshot.dshVersion === 'string');
const snapDir = join(storeDir, 'snapshots', snap1.snapshot.id);
check('快照目录含锁文件内容', existsSync(join(snapDir, 'files', 'pnpm-lock.yaml')));

console.log('== 3. last-good 语义（pre-rollback 不可被自动选中）==');
core.createSnapshot({ profileDir, storeDir, reason: 'pre-rollback', maxSnapshots: 100 });
const good = core.lastGoodSnapshot(storeDir);
check('last-good 跳过 pre-rollback（选中 manual）', good !== null && good.id === snap1.snapshot.id);

console.log('== 4. 模拟坏插件改动 + 崩溃回滚（pre-rollback 后悔药 + 保活）==');
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  dependencies: { dshmarket: '^1.26.0', 'dsh-bad-plugin': '^9.9.9' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-bad-plugin'] } },
}, null, 2));
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# broken patch\n- id: snapguard\n  disabled: true\n');
const before = core.listSnapshots(storeDir).length;
const restored = core.restoreSnapshot({ profileDir, storeDir, snapshotId: snap1.snapshot.id, keep: ['dsh-snapguard'] });
check('回滚成功', restored.ok === true);
check('回滚前自动创建了 pre-rollback 后悔药', core.listSnapshots(storeDir).length === before + 1);
const manifestAfter = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('package.json 恢复为旧组合（坏插件消失）', manifestAfter.dependencies['dsh-bad-plugin'] === undefined);
check('保活注入：dsh-snapguard 回到 dependencies+bundles', manifestAfter.dependencies['dsh-snapguard'] === 'file:./dsh-snapguard' && manifestAfter.dsh.profile.bundles.includes('dsh-snapguard'));
check('锁文件随回滚恢复', readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8').includes('lockfileVersion'));

console.log('== 5. 崩溃判定状态机 + 事故记录 ==');
check('初始未判崩', guard.lastBootCrashed(storeDir) === false);
guard.beginBoot(storeDir, 'boot-test-1');
check('boot-start 后判崩', guard.lastBootCrashed(storeDir) === true);
guard.registerRollback(storeDir, snap1.snapshot.id);
guard.registerRollback(storeDir, snap1.snapshot.id);
check('两次回滚后防循环触发', guard.autoRollbackAllowed(storeDir, 2) === false);
guard.markBootOk(storeDir);
check('markBootOk 后归零', guard.readState(storeDir).failCount === 0 && guard.lastBootCrashed(storeDir) === false);
const incidentFile = writeIncident(storeDir, { kind: 'boot-crash', snapshotId: snap1.snapshot.id, dshVersion: 'x', detail: '测试事故' });
check('事故落盘可读回', incidentFile !== null && listIncidents(storeDir).some((e) => e.kind === 'boot-crash'));

console.log('== 6. 安全模式 roundtrip ==');
const smOn = safeModeOn({ profileDir, storeDir });
check('安全模式开启成功', smOn.ok === true && smOn.active === true);
check('安全模式停用了社区插件', (smOn.prunedBundles ?? []).length >= 2);
const manifestSm = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('剪枝后的 bundles 只含官方+自身', manifestSm.dsh.profile.bundles.filter((n) => !n.startsWith('@deepseek-ai/')).join(',') === 'dsh-snapguard');
check('剪枝不删 dependencies（温和）', manifestSm.dependencies.dshmarket !== undefined);
const patchSm = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
check('patch 换成最小版（只插自身）', patchSm.includes('dsh-snapguard') && !patchSm.includes('rollback-fork'));
check('状态激活', safeModeStatus(storeDir).active === true);
const smOff = safeModeOff({ profileDir, storeDir });
check('安全模式退出成功', smOff.ok === true);
check('退出后 patch 还原', readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('rollback-fork'));
check('退出后 bundles 还原（含社区插件）', JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles.includes('dshmarket'));
check('状态清除', safeModeStatus(storeDir).active === false);

console.log('== 7. 恢复出厂（动态官方基线）==');
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  dependencies: { dshmarket: '^1.26.0', 'dsh-bad-plugin': '^9.9.9', '@linxin666/dsh-client-ui-skin-center': '^0.3.4' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-bad-plugin', '@linxin666/dsh-client-ui-skin-center'] } },
}, null, 2));
const reset = factoryReset({ profileDir, storeDir, keepMarket: true, keep: [] });
check('出厂重置成功', reset.ok === true);
const manifestReset = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
check('出厂：官方保留/坏插件移除/市场默认保留/自身必保留',
  manifestReset.dsh.profile.bundles.includes('@deepseek-ai/dsh-base')
  && !manifestReset.dsh.profile.bundles.includes('dsh-bad-plugin')
  && manifestReset.dsh.profile.bundles.includes('dshmarket')
  && manifestReset.dsh.profile.bundles.includes('dsh-snapguard'));
check('出厂：market 传输依赖并入', manifestReset.dependencies['js-yaml'] !== undefined);
const resetNoMarket = factoryReset({ profileDir, storeDir, keepMarket: false, keep: [] });
check('出厂（不保留市场）', resetNoMarket.ok && !JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles.includes('dshmarket'));

console.log('== 8. 恶意 id 拒绝 ==');
const evil = core.restoreSnapshot({ profileDir, storeDir, snapshotId: '../../etc/passwd', keep: [] });
check('路径穿越 id 被拒绝', evil.ok === false && evil.error !== undefined);

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
