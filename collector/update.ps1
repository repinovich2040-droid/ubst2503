# Полный цикл: собрать данные -> зашифровать -> выложить на GitHub Pages.
# Запускается Планировщиком задач Windows (см. README.md).
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$log = Join-Path $root 'data\update.log'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null
function Write-Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }

Write-Log '--- start'
& node collector/collect.mjs *>> $log
& node collector/build.mjs *>> $log
if ($LASTEXITCODE -ne 0) { Write-Log 'build failed'; exit 1 }

git add docs | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  git commit -q -m "data: $(Get-Date -Format 'yyyy-MM-dd HH:mm')" *>> $log
  git push -q origin main *>> $log
  Write-Log 'pushed'
} else { Write-Log 'no changes' }
