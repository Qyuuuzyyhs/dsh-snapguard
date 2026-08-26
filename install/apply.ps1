# dsh-snapguard 安装脚本（幂等：可重复执行）
# 用法：powershell -ExecutionPolicy Bypass -File apply.ps1 [-Profile web]
#
# 做的事情：
#   1. 备份 profile/package.json 到 .snapguard-backup/package.json.before-<时间戳>.json
#   2. 复制插件本体到 <profile>/dsh-snapguard/
#   3. 在 node_modules/dsh-snapguard 建立指向实体的 Junction（win32）/Symlink（POSIX），
#      使 loader 能按包名解析（无需 pnpm install）
#   4. 更新 package.json：dependencies["dsh-snapguard"]="file:./dsh-snapguard"，
#      bundles 插入到所有社区插件之前（官方 @deepseek-ai/* 之后）
#   5. 自检语法并输出「重启 DSH 后生效」指引
#
# 注意：本脚本不会重启 DSH。请在你的外部终端/启动器里重启 DSH 后使用。

param(
  [string]$Profile = "web",
  [string]$SourceDir = (Join-Path $PSScriptRoot ".."),
  [switch]$SkipRestoreHint
)

$ErrorActionPreference = "Stop"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$pkgFile = Join-Path $profileDir "package.json"
$pluginDir = Join-Path $profileDir "dsh-snapguard"
$nodeModulesDir = Join-Path $profileDir "node_modules"
$linkDir = Join-Path $nodeModulesDir "dsh-snapguard"
$backupRoot = Join-Path $profileDir ".snapguard-backup"

function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2([string]$msg){ Write-Host "    $msg" -ForegroundColor Yellow }

if (-not (Test-Path $pkgFile)) { throw "profile package.json 不存在：$pkgFile （请确认 -Profile 参数）" }
if (-not (Test-Path (Join-Path $SourceDir "package.json"))) { throw "插件源码目录无效：$SourceDir" }

# ── 1. 备份 package.json ──────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFile = Join-Path $backupRoot ("package.json.before-" + $stamp + ".json")
Copy-Item -Force $pkgFile $backupFile
Write-Ok "已备份 package.json -> $backupFile （回滚前的重要后悔药）"

# ── 2. 复制插件本体 ──────────────────────────────────────────────────
Write-Step "复制插件本体到 $pluginDir"
if (Test-Path $pluginDir) {
  Write-Warn2 "目录已存在，覆盖旧版本（package.json 备份在 .snapguard-backup\）"
  Remove-Item -Recurse -Force $pluginDir
}
# 注意 Copy-Item -Recurse <目录> <目标> 会把目录内容平铺到目标（PowerShell 行为），
# lib/ 与 client/ 必须显式指定目标子目录，保持包结构（package.json main=lib/index.js）。
Copy-Item -Recurse -Force (Join-Path $SourceDir "lib") (Join-Path $pluginDir "lib")
Copy-Item -Recurse -Force (Join-Path $SourceDir "client") (Join-Path $pluginDir "client")
New-Item -ItemType Directory -Force -Path (Join-Path $pluginDir "install") | Out-Null
Copy-Item -Force (Join-Path $SourceDir "install\guard-cli.mjs") (Join-Path $pluginDir "install\guard-cli.mjs")
Copy-Item -Force (Join-Path $SourceDir "package.json") (Join-Path $pluginDir "package.json")
Copy-Item -Force (Join-Path $SourceDir "cordis.patch.yml") (Join-Path $pluginDir "cordis.patch.yml")
Copy-Item -Force (Join-Path $SourceDir "LICENSE") (Join-Path $pluginDir "LICENSE") -ErrorAction SilentlyContinue

# ── 3. node_modules 链接（loader 按包名解析用）────────────────────────
Write-Step "建立 node_modules/dsh-snapguard 链接"
if (Test-Path $linkDir) {
  # 删除 junction/symlink 本身：rmdir 不跟随链接、不删除目标内容，
  # 并回避 PowerShell 5.1 的 Remove-Item 对 Junction 的 NullReferenceException。
  if ($env:OS -eq "Windows_NT") { cmd /c rmdir /s /q "$linkDir" 2>$null }
  else { Remove-Item -Recurse -Force $linkDir }
}
New-Item -ItemType Directory -Force -Path $nodeModulesDir | Out-Null
if ($env:OS -eq "Windows_NT") {
  # Junction 不需要管理员权限，且不复制内容
  cmd /c mklink /J "$linkDir" "$pluginDir" | Out-Null
  if (-not (Test-Path $linkDir)) { throw "Junction 创建失败：$linkDir -> $pluginDir" }
} else {
  New-Item -ItemType SymbolicLink -Path $linkDir -Target $pluginDir | Out-Null
}
Write-Ok "node_modules/dsh-snapguard 已链接到 $pluginDir"

# ── 4. 更新 package.json（dependencies + bundles）────────────────────
Write-Step "更新 profile package.json（dependencies + bundles 顺序）"
$manifest = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $manifest.dependencies) { $manifest | Add-Member -NotePropertyName "dependencies" -NotePropertyValue @{} }
if ($null -eq $manifest.dsh) { $manifest | Add-Member -NotePropertyName "dsh" -NotePropertyValue @{} }
if ($null -eq $manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName "profile" -NotePropertyValue @{} }
if ($null -eq $manifest.dsh.profile.bundles) { $manifest.dsh.profile | Add-Member -NotePropertyName "bundles" -NotePropertyValue @() }

$manifest.dependencies | Add-Member -NotePropertyName "dsh-snapguard" -NotePropertyValue "file:./dsh-snapguard" -Force

# bundles：找到第一个非官方（非 @deepseek-ai/）bundle 的索引，把 dsh-snapguard 插到它前面
$bundles = @($manifest.dsh.profile.bundles)
$pos = $bundles.Count
for ($i = 0; $i -lt $bundles.Count; $i++) {
  $b = [string]$bundles[$i]
  if (-not $b.StartsWith("@deepseek-ai/")) { $pos = $i; break }
}
$newBundles = @(); $inserted = $false
for ($i = 0; $i -lt $bundles.Count; $i++) {
  if ($i -eq $pos) {
    if (-not ($newBundles -contains "dsh-snapguard")) { $newBundles += "dsh-snapguard" }
    $inserted = $true
  }
  $b = [string]$bundles[$i]
  if ($b -ne "dsh-snapguard") { $newBundles += $b }
}
if (-not ($newBundles -contains "dsh-snapguard")) { $newBundles += "dsh-snapguard" }
$manifest.dsh.profile.bundles = $newBundles

$json = $manifest | ConvertTo-Json -Depth 100
# PowerShell 5.1 的 Out-File UTF8 带 BOM，JSON 必须无 BOM（loader 解析可能报错）
[System.IO.File]::WriteAllText($pkgFile, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "package.json 已更新（bundles 顺序：$($newBundles -join ', ')）"

# ── 5. 自检 ─────────────────────────────────────────────────────────
Write-Step "自检（node 语法检查 / 读回 package.json）"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $fail = $false
  foreach ($f in @("lib\index.js","lib\core.js","lib\guard.js","lib\factory.js","lib\restart.js","lib\safemode.js","lib\incidents.js")) {
    $target = Join-Path $pluginDir $f
    if (-not (Test-Path $target)) { Write-Warn2 "缺少文件：$f"; $fail = $true; continue }
    & $node.Source --check $target 2>&1 | ForEach-Object { Write-Warn2 $_ }
  }
  if ($fail) { Write-Warn2 "部分文件缺失，请检查复制结果" }
  else { Write-Ok "lib/*.js 语法检查通过" }
} else {
  Write-Warn2 "未找到 node，跳过语法检查"
}
$readBack = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($readBack.dependencies."dsh-snapguard" -ne "file:./dsh-snapguard") { throw "package.json 读回校验失败" }
Write-Ok "package.json 读回校验通过"

Write-Host ""
Write-Host "✅ 安装完成！" -ForegroundColor Green
Write-Host "下一步（由你执行）：" -ForegroundColor Yellow
Write-Host "   重启 DSH（关闭当前 DSH 进程后重新启动），插件即生效。" -ForegroundColor Yellow
Write-Host "   - 生效后可打开 设置 -> 「快照守卫 🐋」面板：立即快照 / 回滚 / 安全模式 / 恢复出厂。" -ForegroundColor Yellow
Write-Host "   - 默认自动快照会在检测到插件组合变化（如市场安装/卸载/排序）后自动创建。" -ForegroundColor Yellow
Write-Host "   - DSH 完全起不来时：node <profile>\dsh-snapguard\install\guard-cli.mjs help" -ForegroundColor Yellow
Write-Host "     可用 status / rollback / safe-mode on-off / factory 离线自救。" -ForegroundColor Yellow
Write-Host "   - 卸载：运行 install\rollback.ps1。" -ForegroundColor Yellow
