# Ярлык «Обновить наставника» и тул mentor_update: git fetch --tags -> checkout последнего тега -> pi install -> мост.
# UTF-8 с BOM, PowerShell 5.1+. Без `exit`.
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
$common = Join-Path $PSScriptRoot 'lib\win\common.ps1'
. $common
Set-Utf8Console

function Invoke-MentorUpdate {
	$p = Get-MmPaths
	Write-Host ''
	Write-Host 'Обновление наставника' -ForegroundColor Cyan
	$r = Update-MentorApp -AppDir $p.App
	if ($r.Changed) { Write-Host "Версия: $($r.From) -> $($r.To)" } else { Write-Host "Версия $($r.To): $($r.Note)." }
	# checkout мог заменить common.ps1 — перечитываем новую версию.
	. $common
	$piCmd = Join-Path $p.Npm 'pi.cmd'
	if (-not (Test-Path -LiteralPath $piCmd)) { $c = Get-Command pi -ErrorAction SilentlyContinue; if ($c) { $piCmd = $c.Source } else { throw 'не нашёл pi' } }
	Write-Host 'pi install'
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	try { & $piCmd install $p.App 2>&1 | Out-Host } finally { $ErrorActionPreference = $old }
	if ($LASTEXITCODE -ne 0) { throw "pi install закончился кодом $LASTEXITCODE" }
	$lines = Install-Bridge -BridgeSource (Join-Path $p.App 'bridge\MentorBridge') -ProgramData $env:ProgramData -AppData $env:APPDATA -Documents $p.Documents
	foreach ($l in $lines) { Write-Host $l }
	if ($r.Changed) { Write-Host 'Готово. Перезапусти наставника, чтобы изменения заработали.' -ForegroundColor Green } else { Write-Host 'Готово.' -ForegroundColor Green }
}

try {
	Invoke-MentorUpdate
} catch {
	Write-Host ''
	Write-Host "Обновление не получилось: $($_.Exception.Message)" -ForegroundColor Red
	Write-Host 'Сфотографируй это окно и пришли автору.' -ForegroundColor Red
}
if (-not $NoPause) { Write-Host ''; $null = Read-Host 'Нажми Enter, чтобы закрыть окно' }
