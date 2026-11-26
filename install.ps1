# music_mentor: установщик для Windows. Запуск — одна строка в PowerShell (её присылает автор):
#   $env:MM_KEY='<ключ>'; irm https://raw.githubusercontent.com/rthw/music_mentor/<тег>/install.ps1 | iex
# Файл в UTF-8 БЕЗ BOM (BOM ломает `irm | iex`), PowerShell 5.1+. Каждый шаг идемпотентен и обёрнут в try/catch;
# ни одного молчаливого выхода и ни одного `exit` (под `irm | iex` он закрыл бы окно PowerShell).

$MmTag = if ($env:MM_TAG) { $env:MM_TAG } else { 'v0.1.3' }
$MmRepo = if ($env:MM_REPO) { $env:MM_REPO } else { 'https://github.com/rthw/music_mentor.git' }
# Версии pi и Node — не здесь, а в lib/win/versions.json (один источник для установки, обновления
# и выпуска). Тег в строке выше — только bootstrap: он равен tag из versions.json, это проверяет npm test.

$script:MmFailed = @()
$script:MmSteps = 10

function Write-Say { param([string]$Text, [string]$Color) Write-MmHost $Text $Color }

function Invoke-Step {
	# Возвращает $true/$false. Ошибка шага — всегда сообщение «Шаг N (имя) не получился: …».
	# В журнал пишутся номер шага, текст исключения и стек — чтобы автор разобрался без фото окна.
	param([int]$N, [string]$Name, [scriptblock]$Body)
	Write-Say ''
	Write-Say ("Шаг {0} из {1}: {2}" -f $N, $script:MmSteps, $Name) 'Cyan'
	try {
		if ($env:MM_FAIL_STEP -eq "$N") { throw 'искусственная ошибка для проверки (MM_FAIL_STEP)' }
		$null = & $Body
		return $true
	} catch {
		$msg = $_.Exception.Message
		Write-MmLog ("ШАГ {0} ({1}) НЕ ПОЛУЧИЛСЯ: {2}" -f $N, $Name, $msg)
		Write-MmLog ("шаг {0}: исключение: {1}" -f $N, $_.Exception.ToString())
		if ($_.ScriptStackTrace) { Write-MmLog ("шаг {0}: стек: {1}" -f $N, $_.ScriptStackTrace) }
		Write-Say ("Шаг {0} ({1}) не получился: {2}" -f $N, $Name, $msg) 'Red'
		Write-Say (Get-MmLogHint) 'Red'
		$script:MmFailed += ("{0} ({1})" -f $N, $Name)
		return $false
	}
}

function Initialize-Bootstrap {
	# Минимум до того, как скачан код: кодировка, TLS, прогресс.
	try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
	$global:ProgressPreference = 'SilentlyContinue'
	try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
	try { $global:OutputEncoding = [Text.Encoding]::UTF8 } catch { }
}

function Get-BootRoot {
	if ($env:MM_ROOT) { return $env:MM_ROOT }
	return (Join-Path $env:LOCALAPPDATA 'music_mentor')
}

function Refresh-BootPath {
	$parts = @()
	foreach ($scope in 'Machine', 'User') {
		try { $v = [Environment]::GetEnvironmentVariable('Path', $scope); if ($v) { $parts += ($v -split ';') } } catch { }
	}
	$root = Get-BootRoot
	$parts = @((Join-Path $root 'node'), (Join-Path $root 'npm')) + $parts + ($env:Path -split ';')
	$seen = @{}; $out = @()
	foreach ($x in $parts) {
		if (-not $x) { continue }
		$k = $x.TrimEnd('\').ToLowerInvariant()
		if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $out += $x }
	}
	$env:Path = ($out -join ';')
}

function Get-BootWeb {
	# Скачать текст или файл в bootstrap-фазе (своя копия вместо common.ps1: общего кода ещё нет).
	# Через временный файл и ReadAllText — так гарантированно снимается BOM.
	param([string]$Url, [string]$OutFile)
	$h = @{ 'User-Agent' = 'music_mentor-installer' }
	if ($OutFile) { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers $h -TimeoutSec 600 | Out-Null; return }
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mm_get_' + [guid]::NewGuid().ToString('N'))
	try {
		Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -Headers $h -TimeoutSec 60 | Out-Null
		return [IO.File]::ReadAllText($tmp)
	} finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

function Import-MmText {
	# Выполнить текст common.ps1 в глобальной области: дот-источник внутри функции остался бы в ней.
	# Для PS 5.1 файлы с BOM, но текст мог прийти и со ﻿ — снимаем явно.
	param([string]$Text)
	if (-not $Text -or -not $Text.Trim()) { throw 'common.ps1 пришёл пустым' }
	$Text = $Text.TrimStart([char]0xFEFF)
	$Text = [regex]::Replace($Text, '(?m)^function\s+(?!global:)(\S+)', 'function global:$1')
	Invoke-Expression $Text
}

function Import-BootCommon {
	# Общие функции (журнал, версии, Node/pi) нужны до первого шага и до клонирования кода,
	# поэтому common.ps1 качается с того же тега, что и install.ps1. После шага 4 берётся с диска.
	if ($env:MM_COMMON_FILE) { Import-MmText ([IO.File]::ReadAllText($env:MM_COMMON_FILE)); return }
	$url = if ($env:MM_COMMON_URL) { $env:MM_COMMON_URL } else { 'https://raw.githubusercontent.com/rthw/music_mentor/{0}/lib/win/common.ps1' -f $MmTag }
	Import-MmText (Get-BootWeb $url)
}

function Get-BootVersions {
	# versions.json с того же тега: тег, версия pi, минимум Node.
	if ($script:MmVersions) { return $script:MmVersions }
	$json = if ($env:MM_VERSIONS_FILE) {
		[IO.File]::ReadAllText($env:MM_VERSIONS_FILE)
	} elseif ($env:MM_VERSIONS_URL) {
		Get-BootWeb $env:MM_VERSIONS_URL
	} else {
		Get-BootWeb ('https://raw.githubusercontent.com/rthw/music_mentor/{0}/lib/win/versions.json' -f $MmTag)
	}
	$script:MmVersions = ConvertFrom-MmVersions $json
	return $script:MmVersions
}

# --- шаг 1: проверки ---------------------------------------------------------------------------------

function Step-Checks {
	$ver = [Environment]::OSVersion.Version
	if ($ver.Major -lt 10) { throw "нужна Windows 10 или 11, у тебя версия $ver" }
	Write-Say ("  Windows {0}, PowerShell {1}" -f $ver, $PSVersionTable.PSVersion)
	if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw "нужен PowerShell 5.1 или новее, у тебя $($PSVersionTable.PSVersion)" }
	$root = Get-BootRoot
	$drive = Split-Path -Qualifier $root
	if ($drive) {
		$di = New-Object IO.DriveInfo ($drive.Substring(0, 1))
		$freeGb = [math]::Round($di.AvailableFreeSpace / 1GB, 1)
		Write-Say "  свободно на ${drive}: $freeGb ГБ"
		if ($freeGb -lt 3) { throw "на диске $drive меньше 3 ГБ свободного места ($freeGb ГБ): освободи место и запусти установку снова" }
	}
	$docs = [Environment]::GetFolderPath('MyDocuments')
	Write-Say "  Документы: $docs"
	try { $null = Get-Web 'https://api.github.com/rate_limit' } catch { throw "нет связи с github.com ($($_.Exception.Message)). Проверь интернет" }
	try { $null = Get-Web 'https://nodejs.org/dist/index.json' } catch { throw "нет связи с nodejs.org ($($_.Exception.Message)). Проверь интернет" }
	$v = Get-BootVersions
	Write-Say ("  версии из versions.json: тег {0}, pi {1}, Node {2}+" -f $v.Tag, $v.Pi, $v.Node)
	if ($v.Tag -ne $MmTag) { Write-Say "  внимание: установщик запущен с тега $MmTag, а versions.json говорит $($v.Tag)" }
	Write-Say '  сеть есть'
}

# --- шаг 2: Git ----------------------------------------------------------------------------------------

function Find-GitBash {
	$c = @()
	foreach ($d in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' }))) {
		if ($d) { $c += (Join-Path $d 'Git\bin\bash.exe') }
	}
	foreach ($x in $c) { if (Test-Path -LiteralPath $x) { return $x } }
	$g = Get-Command git -ErrorAction SilentlyContinue
	if ($g) {
		$b = Join-Path (Split-Path -Parent (Split-Path -Parent $g.Source)) 'bin\bash.exe'
		if (Test-Path -LiteralPath $b) { return $b }
	}
	return $null
}

function Step-Git {
	Refresh-BootPath
	$bash = Find-GitBash
	if ($bash -and (Get-Command git -ErrorAction SilentlyContinue)) { Write-Say "  уже есть: $bash"; return }
	$done = $false
	if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
		foreach ($scope in @('--scope user', '')) {
			Write-Say "  winget install Git.Git $scope"
			$a = @('install', '--id', 'Git.Git', '-e', '--silent', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') + @($scope -split ' ' | Where-Object { $_ })
			try { & winget.exe @a | Out-Host } catch { Write-Say "  winget не сработал: $($_.Exception.Message)" }
			Refresh-BootPath
			if (Find-GitBash) { $done = $true; break }
		}
	} else {
		Write-Say '  winget нет, беру установщик с GitHub'
	}
	if (-not $done) {
		# Файл ищем по шаблону и архитектуре, а не по имени (имена в релизах меняются).
		$rel = Get-Web 'https://api.github.com/repos/git-for-windows/git/releases/latest'
		$pat = if ((Get-WinArch) -eq 'arm64') { 'Git-*-arm64.exe' } else { 'Git-*-64-bit.exe' }
		$asset = @($rel.assets | Where-Object { $_.name -like $pat -and $_.name -notlike '*Portable*' -and $_.name -notlike '*busybox*' }) | Select-Object -First 1
		if (-not $asset) { throw "в последнем релизе Git for Windows нет файла по шаблону $pat" }
		$tmp = Join-Path ([IO.Path]::GetTempPath()) $asset.name
		Write-Say "  качаю $($asset.name)"
		Get-Web $asset.browser_download_url $tmp
		$p = Start-Process -FilePath $tmp -ArgumentList '/VERYSILENT', '/NORESTART', '/SP-', '/CURRENTUSER' -Wait -PassThru
		Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
		if ($p.ExitCode -ne 0) { throw "установщик Git закончился кодом $($p.ExitCode)" }
		Refresh-BootPath
	}
	$bash = Find-GitBash
	if (-not $bash -or -not (Get-Command git -ErrorAction SilentlyContinue)) {
		# Git мог встать в Program Files, а PATH в этой сессии не обновился.
		foreach ($d in @("$env:ProgramFiles\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd")) { if (Test-Path -LiteralPath $d) { $env:Path = "$d;$env:Path" } }
		$bash = Find-GitBash
	}
	if (-not $bash -or -not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git поставился, но git или bash.exe не нашлись' }
	Write-Say "  готово: $bash"
}

# --- шаг 3: pi -------------------------------------------------------------------------------------------

function Step-Pi {
	# Node и pi к версиям из versions.json — общая функция с обновлением (см. Ensure-MmPiRuntime).
	Refresh-BootPath
	$root = Get-BootRoot
	$r = Ensure-MmPiRuntime -Root $root -Versions (Get-BootVersions)
	Write-Say "  pi $($r.Pi), Node $($r.Node)"
}

# --- шаг 4: код music_mentor -------------------------------------------------------------------------------

function Invoke-BootGit {
	param([string[]]$GitArgs)
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	try { $out = & git @GitArgs 2>&1 } finally { $ErrorActionPreference = $old }
	if ($LASTEXITCODE -ne 0) { throw ('git ' + ($GitArgs -join ' ') + " -> код $LASTEXITCODE`: " + (($out | Out-String).Trim())) }
}

function Import-MmCommon {
	# Подгрузить lib\win\common.ps1 из скачанного кода в глобальную область. После checkout обновления
	# это единственная версия общей библиотеки — в ней журнал, версии, шаблон и мост.
	param([string]$AppDir)
	$file = Join-Path $AppDir 'lib\win\common.ps1'
	if (-not (Test-Path -LiteralPath $file)) { throw "нет файла $file" }
	Import-MmText ([IO.File]::ReadAllText($file))
}

function Step-App {
	Refresh-BootPath
	$root = Get-BootRoot
	$app = Join-Path $root 'app'
	if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git не найден (шаг 2)' }
	if (Test-Path -LiteralPath (Join-Path $app '.git')) {
		$cur = $null
		try { $cur = (& git -C $app describe --tags --exact-match HEAD 2>$null | Select-Object -First 1) } catch { }
		if ($cur -eq $MmTag) {
			Write-Say "  код $MmTag уже на месте"
		} else {
			Write-Say "  обновляю код до $MmTag"
			Invoke-BootGit @('-C', $app, 'fetch', '--depth', '1', 'origin', 'tag', $MmTag, '--no-tags')
			Invoke-BootGit @('-C', $app, '-c', 'advice.detachedHead=false', 'checkout', '--force', $MmTag)
		}
	} else {
		if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }
		New-Item -ItemType Directory -Path $root -Force | Out-Null
		Write-Say "  клонирую $MmTag"
		Invoke-BootGit @('-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', $MmTag, $MmRepo, $app)
	}
	Import-MmCommon $app
	$piCmd = Join-Path (Join-Path $root 'npm') 'pi.cmd'
	Write-Say '  pi install'
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	try { $piOut = & $piCmd install $app 2>&1 } finally { $ErrorActionPreference = $old }
	foreach ($l in @($piOut)) { Write-MmHost "  $l" }
	if ($LASTEXITCODE -ne 0) { throw "pi install закончился кодом $LASTEXITCODE" }
}

# --- шаги 5-10 ------------------------------------------------------------------------------------------------

function Step-Settings {
	$p = Get-MmPaths
	foreach ($d in @($p.Node, $p.Npm)) { if (Test-Path -LiteralPath $d) { $null = Add-UserPathEntry $d } }
	$shell = $null
	$bash = Find-GitBash
	# pi сам ищет Git Bash только в Program Files; если git стоит в профиле пользователя, говорим ему путь.
	if ($bash -and ($bash -notlike "$env:ProgramFiles*") -and ($bash -notlike "${env:ProgramFiles(x86)}*")) { $shell = $bash }
	Set-PiSettings -Path $p.Settings -ShellPath $shell
	Write-Say "  $($p.Settings)"
	Write-Say '  Shift+Enter в Windows Terminal pi распознаёт сам, настройки терминала не трогаю.'
}

function Step-Key {
	$p = Get-MmPaths
	$key = $env:MM_KEY
	if ($env:MM_KEY) { Remove-Item Env:\MM_KEY -ErrorAction SilentlyContinue }
	if (-not $key) {
		$existing = Get-DeepSeekAuthKey $p.Auth
		if ($existing) {
			$r = Test-DeepSeekKey $existing
			if ($r.Ok) { Write-Say "  ключ уже записан: $($r.Text)"; return }
		}
		Write-Say '  Вставь ключ DeepSeek (при вводе его не видно) и нажми Enter.'
		$sec = Read-Host -AsSecureString 'Ключ'
		$key = ConvertFrom-SecureStringPlain $sec
	}
	$key = $key.Trim()
	$r = Test-DeepSeekKey $key
	if (-not $r.Ok) { throw $r.Text }
	Set-DeepSeekAuth -Path $p.Auth -Key $key
	$key = $null
	Write-Say "  $($r.Text); записан в $($p.Auth)"
	Clear-KeyFromHistory
}

function Clear-KeyFromHistory {
	# Строка запуска с ключом остаётся в истории PSReadLine; убираем её, если получится.
	try {
		$h = (Get-PSReadLineOption).HistorySavePath
		if ($h -and (Test-Path -LiteralPath $h)) {
			$lines = Get-Content -LiteralPath $h -Encoding UTF8
			$keep = @($lines | Where-Object { $_ -notmatch 'MM_KEY' })
			if ($keep.Count -ne @($lines).Count) { Set-Content -LiteralPath $h -Value $keep -Encoding UTF8 }
		}
		Clear-History -ErrorAction SilentlyContinue
	} catch { }
	# Открытка запускает установку через Win+R: строка с ключом остаётся в RunMRU (история «Выполнить»).
	try {
		$mru = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\RunMRU'
		if (Test-Path -LiteralPath $mru) {
			$props = Get-ItemProperty -LiteralPath $mru
			$order = [string]$props.MRUList
			foreach ($pr in $props.PSObject.Properties) {
				if ($pr.Name -match '^[a-z]$' -and ([string]$pr.Value) -match 'MM_KEY') {
					Remove-ItemProperty -LiteralPath $mru -Name $pr.Name -ErrorAction SilentlyContinue
					$order = $order.Replace($pr.Name, '')
				}
			}
			Set-ItemProperty -LiteralPath $mru -Name MRUList -Value $order -ErrorAction SilentlyContinue
		}
	} catch { }
}

function Step-Workspace {
	# Файлы агента (AGENTS.md, будущие скиллы) — перезаписываются, файлы ученика — только
	# досоздаются: правило в Get-MmLearnerDirs (lib\win\common.ps1).
	$p = Get-MmPaths
	$r = Copy-WorkspaceTemplate -Template (Join-Path $p.App 'template') -Workspace $p.Workspace
	Write-Say ("  " + (Format-WorkspaceTemplateResult -Result $r -Workspace $p.Workspace))
}

function Step-Bridge {
	$p = Get-MmPaths
	$lines = Install-Bridge -BridgeSource (Join-Path $p.App 'bridge\MentorBridge') -ProgramData $env:ProgramData -AppData $env:APPDATA -Documents $p.Documents
	foreach ($l in $lines) { Write-Say "  $l" }
}

function Step-Shortcuts {
	$p = Get-MmPaths
	$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
	$wtPath = $null
	if ($wt) { $wtPath = $wt.Source } else { Write-Say '  Windows Terminal не найден: агент откроется в обычном окне' }
	foreach ($l in (Write-MmShortcuts -Paths $p -WtPath $wtPath)) { Write-Say "  $l" }
}

function Step-SelfCheck {
	$p = Get-MmPaths
	Refresh-BootPath
	$bad = @()
	$piCmd = Join-Path $p.Npm 'pi.cmd'
	try { $v = (& $piCmd --version | Select-Object -First 1).ToString().Trim(); Write-Say "  pi --version: $v" } catch { $bad += 'pi --version' }
	try {
		$key = Get-DeepSeekAuthKey $p.Auth
		if (-not $key) { throw 'ключа нет в auth.json' }
		$r = Test-DeepSeekKey $key
		Write-Say "  ключ DeepSeek: $($r.Text)"
		if (-not $r.Ok) { $bad += 'ключ DeepSeek' }
	} catch { $bad += "ключ DeepSeek ($($_.Exception.Message))" }
	try {
		$sc = Join-Path $p.App 'tools\selfcheck.ts'
		$out = (& node $sc 2>&1 | Out-String).Trim()
		if ($LASTEXITCODE -ne 0 -or -not $out) { throw $out }
		Write-Say "  project_summary на встроенном проекте: ок"
		Write-Say ('    ' + (($out -split "`n") | Select-Object -First 1))
	} catch { $bad += "project_summary ($($_.Exception.Message))" }
	$live = 'Live не запущен или мост ещё не включён (так и должно быть до первой настройки)'
	try {
		$c = New-Object Net.Sockets.TcpClient
		$ar = $c.BeginConnect('127.0.0.1', 9878, $null, $null)
		if ($ar.AsyncWaitHandle.WaitOne(1000) -and $c.Connected) { $live = 'мост отвечает' }
		$c.Close()
	} catch { }
	Write-Say "  связь с Live: $live"
	if ($bad.Count -gt 0) { throw ('не прошло: ' + ($bad -join '; ')) }
}

function Start-Install {
	Initialize-Bootstrap
	# Журнал и общие функции с самого начала: всё, что друг видит в окне, должно быть в файле
	# (картинок модель не видит). Ошибка скачивания — до журнала, поэтому отдельное сообщение.
	try { Import-BootCommon } catch {
		Write-Say ''
		Write-Say ("Не получилось скачать общие функции агента: {0}. Проверь интернет и запусти ту же строку ещё раз." -f $_.Exception.Message) 'Red'
		return
	}
	$null = Start-MmLog 'install'
	Write-Say ''
	Write-Say "Музыкальный агент: установка ($MmTag)" 'Green'
	Write-Say 'Это займёт несколько минут. Можно ничего не нажимать.'
	$ok = $true
	if (-not (Invoke-Step 1 'проверки' { Step-Checks })) { Write-Say 'Без шага 1 дальше идти нельзя.' 'Red'; Write-Say (Get-MmLogHint) 'Red'; return }
	if (-not (Invoke-Step 2 'Git' { Step-Git })) { $ok = $false }
	if (-not (Invoke-Step 3 'pi' { Step-Pi })) { $ok = $false }
	if ($ok) {
		if (-not (Invoke-Step 4 'код агента' { Step-App })) { $ok = $false }
	} else {
		Write-Say 'Шаг 4 (код агента) пропущен: сначала нужны шаги 2 и 3.' 'Red'
		$script:MmFailed += '4 (код агента)'
	}
	if (-not $ok) {
		Write-Say ''
		Write-Say ("Установка не закончена. Не получилось: {0}." -f ($script:MmFailed -join ', ')) 'Red'
		Write-Say (Get-MmLogHint) 'Red'
		Write-Say 'Потом запусти ту же строку ещё раз — сделанное пропустится.'
		return
	}
	$null = Invoke-Step 5 'настройки pi' { Step-Settings }
	$null = Invoke-Step 6 'ключ DeepSeek' { Step-Key }
	$null = Invoke-Step 7 'рабочая папка' { Step-Workspace }
	$null = Invoke-Step 8 'мост к Ableton Live' { Step-Bridge }
	$null = Invoke-Step 9 'ярлыки' { Step-Shortcuts }
	$null = Invoke-Step 10 'самопроверка' { Step-SelfCheck }
	Write-Say ''
	if ($script:MmFailed.Count -eq 0) {
		Write-Say 'Готово. На рабочем столе три ярлыка: «Музыкальный агент», «Сменить ключ DeepSeek», «Обновить агента».' 'Green'
		Write-Say 'Один раз включи мост в Ableton Live: Options -> Settings… (в старых версиях Preferences) -> вкладка MIDI -> Control Surface -> MentorBridge (Input и Output: None). Агент сам подскажет, где это в твоей версии.'
		Write-Say ("Журнал установки: {0}" -f (Get-MmLogPath))
	} else {
		Write-Say ("Установка закончена с ошибками. Не получилось: {0}." -f ($script:MmFailed -join ', ')) 'Red'
		Write-Say (Get-MmLogHint) 'Red'
		Write-Say 'Потом запусти ту же строку ещё раз — сделанное пропустится.'
	}
}

if (-not $env:MM_NO_RUN) { Start-Install }
