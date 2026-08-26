# dsh-snapguard 卸载脚本（幂等）
# 用法：powershell -ExecutionPolicy Bypass -File rollback.ps1 [-Profile web] [-RestoreBackup]
#
# -RestoreBackup: 从 .snapguard-backup/ 里最近一份 package.json 备份恢复（默认：只移除
#                 dsh-snapguard 相关行，保留其它状态）
# 注意：不会重启 DSH；请自行重启后完成卸载生效。

param(
  [string]$Profile = "web",
  [switch]$RestoreBackup
)

$ErrorActionPreference = "Stop"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$profileDir = Join-Path $dshHome ("profiles\" + $Profile)
$pkgFile = Join-Path $profileDir "package.json"
$pluginDir = Join-Path $profileDir "dsh-snapguard"
$linkDir = Join-Path $profileDir ("node_modules\dsh-snapguard")
$backupRoot = Join-Path $profileDir ".snapguard-backup"

if (-not (Test-Path $pkgFile)) { throw "profile package.json 不存在：$pkgFile" }

Write-Host "==> 移除 node_modules/dsh-snapguard 链接" -ForegroundColor Cyan
if (Test-Path $linkDir) {
  $item = Get-Item $linkDir -Force
  if ($item.LinkType) { Remove-Item -Force $linkDir }
  else { Remove-Item -Recurse -Force $linkDir }
  Write-Host "    已移除" -ForegroundColor Green
}

Write-Host "==> 更新 package.json" -ForegroundColor Cyan
if ($RestoreBackup) {
  $latest = Get-ChildItem $backupRoot -Filter "package.json.before-*.json" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($latest) {
    Copy-Item -Force $latest.FullName $pkgFile
    Write-Host "    已从备份恢复：$($latest.Name)" -ForegroundColor Green
  } else {
    Write-Host "    没有可用备份，改用行级移除" -ForegroundColor Yellow
    $RestoreBackup = $false
  }
}
if (-not $RestoreBackup) {
  $manifest = Get-Content $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($manifest.dependencies) {
    $manifest.dependencies.PSObject.Properties.Remove("dsh-snapguard") | Out-Null
  }
  if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
    $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne "dsh-snapguard" })
  }
  $json = $manifest | ConvertTo-Json -Depth 100
  [System.IO.File]::WriteAllText($pkgFile, ($json + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "    已移除 dsh-snapguard 的 dependencies 与 bundles 条目" -ForegroundColor Green
}

Write-Host "==> 删除插件本体目录（保留 node_modules 里的快照数据？不涉及）" -ForegroundColor Cyan
if (Test-Path $pluginDir) {
  Remove-Item -Recurse -Force $pluginDir
  Write-Host "    已移除 $pluginDir" -ForegroundColor Green
}

Write-Host ""
Write-Host "✅ 卸载完成。重启 DSH 后插件彻底失效。" -ForegroundColor Green
Write-Host "   DSH_HOME\.snapguard\ 下的快照数据与状态保留（如需清理可手动删除）。" -ForegroundColor Yellow
