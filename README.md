# dsh-snapguard · 保卫DSH的神秘大肥鱼

曾经的我沉迷于神秘的dsh皮肤与宠物甚至于梁子恶搞插件，直到有一天我的dsh嘎的一下就死去，我才幡然悔悟，没有备份的机生不是合格的机生······这一世我重携神秘大肥鱼归来，誓要夺回曾经那属于我的一切

面向**非专业用户**的 DSH 插件保险：装插件装崩了？不需要命令行、不需要和 Agent 对话，
打开 DSH 设置页里的 **「快照守卫 🐋」** 面板，点一下就能倒带。DSH 完全起不来？
还有**离线 CLI** 救生艇。

- **自动快照**：检测到插件组合（`package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` /
  `.dsh-market/` 等）变化时自动创建快照——配置层字节 + 第三方插件本体，**离线可恢复**。
- **崩溃自愈**：上次启动「有 start 无 ok 无 shutdown」判定为崩溃 → 自动回滚 **last-good**
  快照并重启（连续失败 2 次后转为保守模式，绝不无限循环）。
- **安全模式**：DSH 起不来的**温和**自救——临时停用除本插件外全部用户插件
  （不删任何文件，备份后还原），重启保证能启动，退出时一键还原。
- **恢复出厂设置**：动态官方基线（保留 `@deepseek-ai/*` 官方组件 + 自身，可选保留
  dshmarket），执行前自动留「出厂前快照」当后悔药。
- **离线 CLI**：`guard-cli.mjs` 零依赖，面板打不开时也能 status / rollback / safe-mode / factory。

## 与同类插件的关系（本项目借鉴来源）

本插件的设计对齐并吸收了 GitHub 上三个成熟同类项目的可取之处，同时保留自身定位
（零依赖、纯 profile 层、不改启动方式、插件本体离线备份）：

| 项目 | 借鉴的点 | 与我们的差异 |
|---|---|---|
| [lire1131/dsh-undo-savepoint](https://github.com/lire1131/dsh-undo-savepoint) | 安全模式（备份 patch+pkg → 剪枝 bundles → 最小 patch → 一键还原）；局外工具思路 | 它的局外 WebUI/GUI 很全但重；我们只做零依赖 CLI。它的消息级撤销/时间线 diff 超出「插件保险」范围，未采用 |
| [lxzy-7/dsh-plugin-guard](https://github.com/lxzy-7/dsh-plugin-guard) | 快照含锁文件；每份快照记录 dshVersion；回滚前 pre-rollback 快照；last-good 语义；事故记录；清理 pnpm 孤儿链接 | 它用外部 boot-guard 脚本包装启动（要改启动方式）+ pnpm --frozen-lockfile 重建依赖；我们保持进程内 Boot Guard + 插件本体离线备份（网络不可用也能恢复） |
| [Taler97/dsh-rollback](https://github.com/Taler97/dsh-rollback) | checkpoint 文件回滚的最小实现思路 | 已完全覆盖，无新增点 |

> 你的 `cordis.patch.yml` 里那串 `rollback-fork / rollback-archive / client-rollback-*`
> 的 `disabled: true` 残留正是 dsh-undo-savepoint（或其前身）的旧痕迹——安装时自动
> 快照、安全模式下会连 patch 一起备份还原，无需手动清理。

## 目录结构

```
dsh-snapguard/
├── package.json          # 包元数据 + dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # bundle patch：insert 组件 snapguard
├── lib/
│   ├── index.js          # 宿主入口：Boot Guard、/snapguard/* 路由、文件变更监控
│   ├── core.js           # 快照引擎（配置层+锁文件+插件包备份 / 恢复 / last-good / 孤儿链接清理）
│   ├── guard.js          # 崩溃自愈状态机（boot-start/ok/shutdown 标记）
│   ├── safemode.js       # 安全模式（备份还原式温和停用）
│   ├── factory.js        # 动态官方基线恢复出厂
│   ├── incidents.js      # 事故记录
│   └── restart.js        # 重启助手（detached helper，等端口释放再拉起）
├── client/
│   └── client.js         # 浏览器面板（手工产物 bundle，设置页「快照守卫」section）
├── install/
│   ├── apply.ps1         # 幂等安装（备份 manifest、复制、建链接、插 bundle 顺序）
│   ├── rollback.ps1      # 幂等卸载（-RestoreBackup 可整份还原）
│   └── guard-cli.mjs     # 离线 CLI（零依赖，DSH 起不来也能用）
└── test/
    └── run-mocks.mjs     # 核心逻辑模拟测试（32 用例）
```

## 安装

### 方式 A：GitHub 直装（推荐，发布后）

```bat
dsh plugin --profile web add github:Qyuuuzyyhs/dsh-snapguard
```

安装完成后**重启 DSH** 即生效。

### 方式 B：本地源码 / 免发布

```powershell
# 在 dsh-snapguard 项目根目录运行
powershell -ExecutionPolicy Bypass -File install\apply.ps1
```

脚本做的事（全部可逆）：

| 动作 | 位置 | 说明 |
| --- | --- | --- |
| 备份 manifest | `<profile>\.snapguard-backup\package.json.before-<时间戳>.json` | 每次安装前留档 |
| 复制插件本体 | `<profile>\dsh-snapguard\` | 源码可审计，含离线 CLI |
| 建解析链接 | `<profile>\node_modules\dsh-snapguard` → 本体 | 无需 pnpm install |
| bundles 插入 | `package.json` 的 `dsh.profile.bundles` | **插在所有社区插件之前**，保证 Boot Guard 先跑 |
| dependencies | `"dsh-snapguard": "file:./dsh-snapguard"` | 未来 pnpm 一致性 |

> ⚠️ **脚本不会重启 DSH**。安装完成后请自行重启 DSH（关闭进程重新启动），
> 插件才会加载。

## 使用（面板）

DSH 重启后：**设置（Settings）→ 快照守卫 🐋**（左侧导航与「插件市场」同级）。

- **立即快照**：随时手动拍一份。
- **自动快照 / 崩溃自动回滚**：两个开关。
- **快照列表**：每行显示时间、原因（自动/手动/崩溃自愈/出厂前备份/回滚后悔药）、
  「✓ 良好」标记（可被自动回滚选中的快照）、配置项数、插件数、DSH 版本，以及
  「↩ 回滚」「删」按钮。
- **安全模式**：温和停用全部用户插件（不删文件），退出一键还原。
- **恢复出厂设置**：先确认一次 → 再点一次执行；完成后自动重启 DSH。

## 离线 CLI（DSH 完全起不来时）

```powershell
node <profile>\dsh-snapguard\install\guard-cli.mjs status
node <profile>\dsh-snapguard\install\guard-cli.mjs safe-mode on     # 进入安全模式后重启 DSH
node <profile>\dsh-snapguard\install\guard-cli.mjs rollback        # 回滚 last-good
node <profile>\dsh-snapguard\install\guard-cli.mjs factory         # 恢复出厂
```

CLI 不负责重启 DSH——命令执行后自行重启即可。零依赖，Node ≥ 20 直接可跑。

## 崩溃自愈原理（Boot Guard）

```
启动时（本插件第一个被加载）
 └─ 读 DSH_HOME/.snapguard/state.json
     ├─ 上次有 boot-start 且无 boot-ok 且无 shutdown-at？
     │   └─ 是 → 自动回滚 last-good 快照（跳过 pre-rollback/pre-boot/pre-factory
     │         等自愈标签）→ 重启；写事故记录；连续 2 次后停手等人工
     ├─ 否则 → 写本次 boot-start
 ├─ webServer 就绪后 20s（或客户端渲染心跳）→ 写 boot-ok（失败计数归零）
 └─ 宿主退出/重启前 → 尽力写 shutdown-at
```

- **正常关闭/手动重启**：有 shutdown-at，不触发回滚。
- **插件崩溃干掉宿主**：没有 shutdown-at，下次启动直接倒带。
- **回滚本身失败/循环**：计数达上限后停止自动循环，事故记录留档，等待人工。

## 设计取舍（B 方案 + 借鉴增强）

- 快照内容 = **组合关键文件（KB 级，含锁文件）+ 第三方插件本体（MB 级）**；
  官方 `@deepseek-ai/*` 核心包从不备份（它们永远在 DSH 安装里）。
- 恢复插件本体时若顶层是 pnpm 链接，会**写回链接指向的真实目录**（`.pnpm` 存储），
  pnpm 布局不被破坏；链接目标丢失则退化为中心目录形式兜底。
- **回滚前自动拍 pre-rollback 快照**——回滚本身可逆；pre-* 标签永远不被自动选择。
- **每份快照记录 DSH 版本**——升级后不兼容造成的崩溃一眼可辨。
- **清理 pnpm 孤儿 bundle 链接**——pnpm 不会自己删 stale link（「Already up to date」）。
- 快照/状态/事故存在 `DSH_HOME\.snapguard\`（profile 之外）：回滚、恢复出厂、卸载
  都不会波及快照；快照写入也不会触发监控自循环。
- 本插件无任何 npm 运行时依赖；客户端为手工产物 bundle，无需构建工具。

## 已知边界

- 自动快照监控的是**组合关键文件与第三方插件 manifest** 的变化。
- 恢复出厂/安全模式会**尽力**操作第三方包；运行中的宿主持有文件句柄时
  （Windows 常见）删除可能失败——残留包不会被 loader 加载，重启后在插件市场
  跑一次安装/更新即可清理 `.pnpm` 残留。
- 自动回滚只针对**启动失败**；插件启动成功但运行中搞事（白屏、功能异常）的场景
  请用面板手动回滚或安全模式。
- 本插件自身在回滚/出厂/安全模式后**强制保活**（`ensureKept` / keep 列表），
  不会出现「救完自己消失」。
- 密钥安全：快照只包含 profile 组合文件与插件代码，**不含** `.env`/凭据文件，
  无需脱敏处理（这是与 dsh-undo-savepoint 的范围差异，也是本插件更轻的直接原因）。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File install\rollback.ps1                        # 行级移除
powershell -ExecutionPolicy Bypass -File install\rollback.ps1 -RestoreBackup        # 整份还原 manifest
```

## 开发与发布

```sh
node test/run-mocks.mjs   # 核心逻辑模拟测试（32 用例，CI 同样执行）
```

- CI：`.github/workflows/test.yml` 在 ubuntu/windows × Node 20/22 矩阵自动跑测试。
- 发布前检查：`npm pack --dry-run` 查看实际发布文件集（`files` 字段已收窄为
  `lib / client / install / cordis.patch.yml / CHANGELOG.md`）。
- 发布到 GitHub 前置：`package.json` 的 `repository.url` 已指向
  `git+https://github.com/Qyuuuzyyhs/dsh-snapguard.git`；在 GitHub 创建仓库后执行：
  `git remote add origin git@github.com:Qyuuuzyyhs/dsh-snapguard.git` → `git push -u origin main`。
- 安装端验证：`dsh plugin --profile web add github:Qyuuuzyyhs/dsh-snapguard` → 重启 DSH
  → 设置页出现「快照守卫 🐋」。

## 技术参考

- 宿主组件：`export const name = 'snapguard'` + `apply(ctx, config)`，
  `ctx.inject(['webServer'])` 后 `webServer.register({ kind:'exact', path, handler })` 挂路由。
- 客户端：手工 `window.__ModuleLoader__.load({ id, factory })` 产物，
  通过 `ctx.slots.inject('settings.section')` 注册面板（对齐 dshmarket 的做法）。
- 安全：所有 POST 走同源 + 回环 + 无转发头校验；快照 id 白名单正则；
  文件写回原子化（temp + rename）；事故记录、状态、快照 id 全部白名单校验。

`本项目由Deepseek Harness+Deepseek-V4-flash-Vision-Exp参与制作`
