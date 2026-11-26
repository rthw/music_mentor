# Ярлык «Обновить агента» и тул mentor_update: git fetch --tags -> checkout последнего тега ->
# Node и pi к версиям из versions.json -> pi install -> шаблон рабочей папки -> мост.
# UTF-8 с BOM, PowerShell 5.1+. Без `exit`.
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
$common = Join-Path $PSScriptRoot 'lib\win\common.ps1'
. $common
Set-Utf8Console
$null = Start-MmLog 'update'

function Invoke-MentorUpdate {
	$p = Get-MmPaths
	Write-MmHost ''
	Write-MmHost 'Обновление агента' 'Cyan'
	$r = Update-MentorApp -AppDir $p.App
	if ($r.Changed) { Write-MmHost "Версия: $($r.From) -> $($r.To)" } else { Write-MmHost "Версия $($r.To): $($r.Note)." }
	# checkout мог заменить common.ps1 и versions.json — перечитываем новую версию.
	. $common
	$versions = Read-MmVersions $p.App
	Write-MmHost ("Версии из versions.json: pi {0}, Node {1}+" -f $versions.Pi, $versions.Node)
	$null = Ensure-MmPiRuntime -Root $p.Root -Versions $versions
	Update-SessionPath
	$piCmd = Join-Path $p.Npm 'pi.cmd'
	if (-not (Test-Path -LiteralPath $piCmd)) { $c = Get-Command pi -ErrorAction SilentlyContinue; if ($c) { $piCmd = $c.Source } else { throw 'не нашёл pi' } }
	Write-MmHost 'pi install'
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	try { $piOut = & $piCmd install $p.App 2>&1 } finally { $ErrorActionPreference = $old }
	foreach ($l in @($piOut)) { Write-MmHost "  $l" }
	if ($LASTEXITCODE -ne 0) { throw "pi install закончился кодом $LASTEXITCODE" }
	# Шаблон рабочей папки: файлы агента (AGENTS.md, скиллы) заменяются, файлы ученика
	# (learner/, notes/) только досоздаются — правки ученика не теряются.
	$ws = Copy-WorkspaceTemplate -Template (Join-Path $p.App 'template') -Workspace $p.Workspace
	Write-MmHost ('  ' + (Format-WorkspaceTemplateResult -Result $ws -Workspace $p.Workspace))
	$lines = Install-Bridge -BridgeSource (Join-Path $p.App 'bridge\MentorBridge') -ProgramData $env:ProgramData -AppData $env:APPDATA -Documents $p.Documents
	foreach ($l in $lines) { Write-MmHost "  $l" }
	# Ярлыки: обновление само приводит их к текущим именам (T1909: «наставник» -> «агент»).
	$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
	foreach ($l in (Write-MmShortcuts -Paths $p -WtPath $(if ($wt) { $wt.Source } else { $null }))) { Write-MmHost "  $l" }
	if ($r.Changed) { Write-MmHost 'Готово. Перезапусти агента, чтобы изменения заработали.' 'Green' } else { Write-MmHost 'Готово.' 'Green' }
	Write-MmHost ("Журнал обновления: {0}" -f (Get-MmLogPath))
}

try {
	Invoke-MentorUpdate
} catch {
	Write-MmHost ''
	Write-MmHost "Обновление не получилось: $($_.Exception.Message)" 'Red'
	Write-MmLog ("обновление: исключение: " + $_.Exception.ToString())
	if ($_.ScriptStackTrace) { Write-MmLog ("обновление: стек: " + $_.ScriptStackTrace) }
	Write-MmHost (Get-MmLogHint) 'Red'
}
if (-not $NoPause) { Write-MmHost ''; $null = Read-Host 'Нажми Enter, чтобы закрыть окно' }
