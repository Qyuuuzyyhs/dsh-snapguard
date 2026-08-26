# 更新日志

## 0.2.0（2026-08-26）

- **安全模式**（新增）：温和停用全部用户插件（备份 patch + package.json → 剪枝 bundles →
  最小 patch → 一键还原），DSH 起不来时的首选自救手段
- **离线 CLI**（新增）：`install/guard-cli.mjs` 零依赖；DSH 面板打不开时可用
  `status / snapshot / rollback / safe-mode on|off / factory / incident`
- **快照增强**：组合文件纳入 `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `cordis.yml` / `.npmrc`
- **回滚自愈**：回滚前自动创建 pre-rollback 后悔药快照；自动回滚只选 last-good
  （跳过 pre-rollback / pre-boot / pre-factory 标签）
- **版本溯源**：每份快照记录 DSH 版本（升级不兼容一眼可辨）
- **孤儿链接清理**：回滚后删除 pnpm 残留的失效 bundle 链接
- **事故记录**：崩溃/回滚/安全模式/出厂动作落盘（`incidents/`，最多保留 30 条）

## 0.1.0（2026-08-25）

- 初始版本：自动快照（组合文件 + 第三方插件本体）、崩溃自愈（boot-start/ok/shutdown 标记 +
  防循环）、一键回滚、恢复出厂设置（动态官方基线）、Web 面板、重启助手
