# Полный цикл: собрать данные -> зашифровать -> выложить на GitHub Pages.
# Запускается Планировщиком задач Windows (см. README.md).
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $root 'data\update.log'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
function Write-Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Write-Log '--- start'
& node collector/collect.mjs 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
& node collector/build.mjs 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) { Write-Log 'build failed'; exit 1 }

git add docs | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git -c user.name=ubst-bot -c user.email=ubst-bot@users.noreply.github.com commit -q -m "data: $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
  git push -q origin main 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
  Write-Log 'pushed'
} else { Write-Log 'no changes' }
