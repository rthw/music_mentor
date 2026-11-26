# Ярлык «Сменить ключ DeepSeek»: вставить новый ключ (ввод скрыт) -> проверка балансом -> запись в auth.json.
# UTF-8 с BOM, PowerShell 5.1+. Без `exit`. Ключ в журнал не попадает (маска в ConvertTo-MmLogSafe).
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
. (Join-Path $PSScriptRoot 'lib\win\common.ps1')
Set-Utf8Console
$null = Start-MmLog 'change_key'

function Invoke-ChangeKey {
	$p = Get-MmPaths
	Write-MmHost ''
	Write-MmHost 'Смена ключа DeepSeek' 'Cyan'
	Write-MmHost 'Вставь новый ключ (при вводе его не видно) и нажми Enter. Пустой ввод — отмена.'
	$sec = Read-Host -AsSecureString 'Ключ'
	$key = ConvertFrom-SecureStringPlain $sec
	if (-not $key -or -not $key.Trim()) { Write-MmHost 'Ключ не введён, ничего не изменено.'; return }
	$key = $key.Trim()
	$r = Test-DeepSeekKey $key
	if (-not $r.Ok) { throw "$($r.Text) Ничего не изменено." }
	Set-DeepSeekAuth -Path $p.Auth -Key $key
	$key = $null
	Write-MmHost "Готово: $($r.Text)." 'Green'
	Write-MmHost 'Новый ключ заработает при следующем запуске агента.'
}

try {
	Invoke-ChangeKey
} catch {
	Write-MmHost ''
	Write-MmHost "Смена ключа не получилась: $($_.Exception.Message)" 'Red'
	Write-MmLog ("смена ключа: исключение: " + $_.Exception.ToString())
	Write-MmHost (Get-MmLogHint) 'Red'
}
if (-not $NoPause) { Write-MmHost ''; $null = Read-Host 'Нажми Enter, чтобы закрыть окно' }
