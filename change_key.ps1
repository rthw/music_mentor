# Ярлык «Сменить ключ DeepSeek»: вставить новый ключ (ввод скрыт) -> проверка балансом -> запись в auth.json.
# UTF-8 с BOM, PowerShell 5.1+. Без `exit`.
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$global:ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
. (Join-Path $PSScriptRoot 'lib\win\common.ps1')
Set-Utf8Console

function Invoke-ChangeKey {
	$p = Get-MmPaths
	Write-Host ''
	Write-Host 'Смена ключа DeepSeek' -ForegroundColor Cyan
	Write-Host 'Вставь новый ключ (при вводе его не видно) и нажми Enter. Пустой ввод — отмена.'
	$sec = Read-Host -AsSecureString 'Ключ'
	$key = ConvertFrom-SecureStringPlain $sec
	if (-not $key -or -not $key.Trim()) { Write-Host 'Ключ не введён, ничего не изменено.'; return }
	$key = $key.Trim()
	$r = Test-DeepSeekKey $key
	if (-not $r.Ok) { throw "$($r.Text) Ничего не изменено." }
	Set-DeepSeekAuth -Path $p.Auth -Key $key
	$key = $null
	Write-Host "Готово: $($r.Text)." -ForegroundColor Green
	Write-Host 'Новый ключ заработает при следующем запуске наставника.'
}

try {
	Invoke-ChangeKey
} catch {
	Write-Host ''
	Write-Host "Смена ключа не получилась: $($_.Exception.Message)" -ForegroundColor Red
	Write-Host 'Сфотографируй это окно и пришли автору.' -ForegroundColor Red
}
if (-not $NoPause) { Write-Host ''; $null = Read-Host 'Нажми Enter, чтобы закрыть окно' }
