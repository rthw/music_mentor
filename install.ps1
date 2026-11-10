# music_mentor: установщик для Windows. Запуск — одна строка в PowerShell (её присылает автор):
#   $env:MM_KEY='<ключ>'; irm https://raw.githubusercontent.com/rthw/music_mentor/<тег>/install.ps1 | iex
# Файл в UTF-8 БЕЗ BOM (BOM ломает `irm | iex`), PowerShell 5.1+. Каждый шаг идемпотентен и обёрнут в try/catch;
# ни одного молчаливого выхода и ни одного `exit` (под `irm | iex` он закрыл бы окно PowerShell).

$MmTag = if ($env:MM_TAG) { $env:MM_TAG } else { 'v0.1.0-rc.5' }
$MmRepo = if ($env:MM_REPO) { $env:MM_REPO } else { 'https://github.com/rthw/music_mentor.git' }
$MmPiVersion = '1.5.0'
$MmNodeMajorMin = [version]'22.19.0'
$MmAuthor = 'автору'

$script:MmFailed = @()
$script:MmSteps = 10

function Write-Say { param([string]$Text, [string]$Color) if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } }

function Invoke-Step {
	# Возвращает $true/$false. Ошибка шага — всегда сообщение «Шаг N (имя) не получился: …».
	param([int]$N, [string]$Name, [scriptblock]$Body)
	Write-Host ''
	Write-Say ("Шаг {0} из {1}: {2}" -f $N, $script:MmSteps, $Name) 'Cyan'
	try {
		if ($env:MM_FAIL_STEP -eq "$N") { throw 'искусственная ошибка для проверки (MM_FAIL_STEP)' }
		$null = & $Body
		return $true
	} catch {
		$msg = $_.Exception.Message
		Write-Say ("Шаг {0} ({1}) не получился: {2}" -f $N, $Name, $msg) 'Red'
		Write-Say ("Сфотографируй это окно и пришли {0}." -f $MmAuthor) 'Red'
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

function Get-WinArch {
	$a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	if ($a -eq 'ARM64') { return 'arm64' }
	return 'x64'
}

function Get-Web {
	param([string]$Url, [string]$OutFile)
	$h = @{ 'User-Agent' = 'music_mentor-installer' }
	if ($OutFile) { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers $h -TimeoutSec 600 } else { Invoke-RestMethod -Uri $Url -Headers $h -TimeoutSec 60 }
}

# --- шаг 1: проверки ---------------------------------------------------------------------------------

function Step-Checks {
	$ver = [Environment]::OSVersion.Version
	if ($ver.Major -lt 10) { throw "нужна Windows 10 или 11, у тебя версия $ver" }
	Write-Host ("  Windows {0}, PowerShell {1}" -f $ver, $PSVersionTable.PSVersion)
	if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw "нужен PowerShell 5.1 или новее, у тебя $($PSVersionTable.PSVersion)" }
	$root = Get-BootRoot
	$drive = Split-Path -Qualifier $root
	if ($drive) {
		$di = New-Object IO.DriveInfo ($drive.Substring(0, 1))
		$freeGb = [math]::Round($di.AvailableFreeSpace / 1GB, 1)
		Write-Host "  свободно на ${drive}: $freeGb ГБ"
		if ($freeGb -lt 3) { throw "на диске $drive меньше 3 ГБ свободного места ($freeGb ГБ): освободи место и запусти установку снова" }
	}
	$docs = [Environment]::GetFolderPath('MyDocuments')
	Write-Host "  Документы: $docs"
	try { $null = Get-Web 'https://api.github.com/rate_limit' } catch { throw "нет связи с github.com ($($_.Exception.Message)). Проверь интернет" }
	try { $null = Get-Web 'https://nodejs.org/dist/index.json' } catch { throw "нет связи с nodejs.org ($($_.Exception.Message)). Проверь интернет" }
	Write-Host '  сеть есть'
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
	if ($bash -and (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "  уже есть: $bash"; return }
	$done = $false
	if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
		foreach ($scope in @('--scope user', '')) {
			Write-Host "  winget install Git.Git $scope"
			$a = @('install', '--id', 'Git.Git', '-e', '--silent', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity') + @($scope -split ' ' | Where-Object { $_ })
			try { & winget.exe @a | Out-Host } catch { Write-Host "  winget не сработал: $($_.Exception.Message)" }
			Refresh-BootPath
			if (Find-GitBash) { $done = $true; break }
		}
	} else {
		Write-Host '  winget нет, беру установщик с GitHub'
	}
	if (-not $done) {
		# Файл ищем по шаблону и архитектуре, а не по имени (имена в релизах меняются).
		$rel = Get-Web 'https://api.github.com/repos/git-for-windows/git/releases/latest'
		$pat = if ((Get-WinArch) -eq 'arm64') { 'Git-*-arm64.exe' } else { 'Git-*-64-bit.exe' }
		$asset = @($rel.assets | Where-Object { $_.name -like $pat -and $_.name -notlike '*Portable*' -and $_.name -notlike '*busybox*' }) | Select-Object -First 1
		if (-not $asset) { throw "в последнем релизе Git for Windows нет файла по шаблону $pat" }
		$tmp = Join-Path ([IO.Path]::GetTempPath()) $asset.name
		Write-Host "  качаю $($asset.name)"
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
	Write-Host "  готово: $bash"
}

# --- шаг 3: pi -------------------------------------------------------------------------------------------

function Get-NodeVersionOnPath {
	$n = Get-Command node -ErrorAction SilentlyContinue
	if (-not $n) { return $null }
	try { return [version](((& $n.Source --version) -replace '^v', '').Trim()) } catch { return $null }
}

function Install-StandaloneNode {
	$root = Get-BootRoot
	$dest = Join-Path $root 'node'
	$arch = Get-WinArch
	$idx = Get-Web 'https://nodejs.org/dist/index.json'
	$entry = @($idx | Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and ([version]($_.version -replace '^v', '')) -ge $MmNodeMajorMin }) | Select-Object -First 1
	if (-not $entry) { throw "в списке Node.js нет LTS $MmNodeMajorMin или новее для win-$arch" }
	$name = "node-$($entry.version)-win-$arch.zip"
	$base = "https://nodejs.org/dist/$($entry.version)"
	$sums = Get-Web "$base/SHASUMS256.txt"
	$line = @(($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($name) + '\s*$' }) | Select-Object -First 1
	if (-not $line) { throw "в SHASUMS256.txt нет $name" }
	$want = ($line -split '\s+')[0].ToLowerInvariant()
	$zip = Join-Path ([IO.Path]::GetTempPath()) $name
	Write-Host "  качаю Node.js $($entry.version)"
	Get-Web "$base/$name" $zip
	$got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($got -ne $want) { throw "контрольная сумма $name не совпала" }
	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ('mm_node_' + [guid]::NewGuid().ToString('N'))
	[IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpDir)
	if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
	New-Item -ItemType Directory -Path $root -Force | Out-Null
	Move-Item -LiteralPath (Join-Path $tmpDir ([IO.Path]::GetFileNameWithoutExtension($name))) -Destination $dest
	Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}

function Step-Pi {
	Refresh-BootPath
	$root = Get-BootRoot
	$nv = Get-NodeVersionOnPath
	if ($nv -and $nv -ge $MmNodeMajorMin) {
		Write-Host "  Node.js $nv уже есть"
	} else {
		if ($nv) { Write-Host "  Node.js $nv старый (нужен $MmNodeMajorMin+), ставлю свой" }
		Install-StandaloneNode
		Refresh-BootPath
		$nv = Get-NodeVersionOnPath
		if (-not $nv) { throw 'Node.js скачан, но node не запускается' }
		Write-Host "  Node.js $nv поставлен в $root\node"
	}
	$npmPrefix = Join-Path $root 'npm'
	$piCmd = Join-Path $npmPrefix 'pi.cmd'
	$have = $null
	if (Test-Path -LiteralPath $piCmd) { try { $have = (& $piCmd --version | Select-Object -First 1).ToString().Trim() } catch { $have = $null } }
	if ($have -eq $MmPiVersion) {
		Write-Host "  pi $have уже есть"
	} else {
		Write-Host "  ставлю pi $MmPiVersion (npm, без скриптов)"
		New-Item -ItemType Directory -Path $npmPrefix -Force | Out-Null
		$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
		if (-not $npm) { throw 'npm не найден рядом с node' }
		# Через cmd.exe: stderr npm (warn/notice) иначе показывается в PowerShell 5.1 красным «NativeCommandError».
		$cmdline = '"{0}" install -g --ignore-scripts --no-fund --no-audit --no-update-notifier --loglevel=error --prefix "{1}" "@earendil-works/pi-coding-agent@{2}" 2>&1' -f $npm.Source, $npmPrefix, $MmPiVersion
		& cmd.exe /d /s /c "`"$cmdline`"" | Out-Host
		if ($LASTEXITCODE -ne 0) { throw "npm install закончился кодом $LASTEXITCODE" }
		if (-not (Test-Path -LiteralPath $piCmd)) { throw "после установки нет $piCmd" }
		$have = (& $piCmd --version | Select-Object -First 1).ToString().Trim()
		if ($have -ne $MmPiVersion) { throw "pi сообщил версию '$have', ожидалась $MmPiVersion" }
	}
	Write-Host "  pi $have"
}

# --- шаг 4: код music_mentor -------------------------------------------------------------------------------

function Invoke-BootGit {
	param([string[]]$GitArgs)
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	try { $out = & git @GitArgs 2>&1 } finally { $ErrorActionPreference = $old }
	if ($LASTEXITCODE -ne 0) { throw ('git ' + ($GitArgs -join ' ') + " -> код $LASTEXITCODE`: " + (($out | Out-String).Trim())) }
}

function Import-MmCommon {
	# Подгрузить lib\win\common.ps1 из скачанного кода в глобальную область (дот-источник внутри функции
	# остался бы только в ней).
	param([string]$AppDir)
	$file = Join-Path $AppDir 'lib\win\common.ps1'
	if (-not (Test-Path -LiteralPath $file)) { throw "нет файла $file" }
	$text = [IO.File]::ReadAllText($file)
	$text = [regex]::Replace($text, '(?m)^function\s+(?!global:)(\S+)', 'function global:$1')
	Invoke-Expression $text
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
			Write-Host "  код $MmTag уже на месте"
		} else {
			Write-Host "  обновляю код до $MmTag"
			Invoke-BootGit @('-C', $app, 'fetch', '--depth', '1', 'origin', 'tag', $MmTag, '--no-tags')
			Invoke-BootGit @('-C', $app, '-c', 'advice.detachedHead=false', 'checkout', '--force', $MmTag)
		}
	} else {
		if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }
		New-Item -ItemType Directory -Path $root -Force | Out-Null
		Write-Host "  клонирую $MmTag"
		Invoke-BootGit @('-c', 'advice.detachedHead=false', 'clone', '--depth', '1', '--branch', $MmTag, $MmRepo, $app)
	}
	Import-MmCommon $app
	$piCmd = Join-Path (Join-Path $root 'npm') 'pi.cmd'
	Write-Host '  pi install'
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	try { & $piCmd install $app 2>&1 | Out-Host } finally { $ErrorActionPreference = $old }
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
	Write-Host "  $($p.Settings)"
	Write-Host '  Shift+Enter в Windows Terminal pi распознаёт сам, настройки терминала не трогаю.'
}

function Step-Key {
	$p = Get-MmPaths
	$key = $env:MM_KEY
	if ($env:MM_KEY) { Remove-Item Env:\MM_KEY -ErrorAction SilentlyContinue }
	if (-not $key) {
		$existing = Get-DeepSeekAuthKey $p.Auth
		if ($existing) {
			$r = Test-DeepSeekKey $existing
			if ($r.Ok) { Write-Host "  ключ уже записан: $($r.Text)"; return }
		}
		Write-Host '  Вставь ключ DeepSeek (при вводе его не видно) и нажми Enter.'
		$sec = Read-Host -AsSecureString 'Ключ'
		$key = ConvertFrom-SecureStringPlain $sec
	}
	$key = $key.Trim()
	$r = Test-DeepSeekKey $key
	if (-not $r.Ok) { throw $r.Text }
	Set-DeepSeekAuth -Path $p.Auth -Key $key
	$key = $null
	Write-Host "  $($r.Text); записан в $($p.Auth)"
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
}

function Step-Workspace {
	$p = Get-MmPaths
	$r = Copy-WorkspaceTemplate -Template (Join-Path $p.App 'template') -Workspace $p.Workspace
	Write-Host "  $($p.Workspace): $r"
}

function Step-Bridge {
	$p = Get-MmPaths
	$lines = Install-Bridge -BridgeSource (Join-Path $p.App 'bridge\MentorBridge') -ProgramData $env:ProgramData -AppData $env:APPDATA -Documents $p.Documents
	foreach ($l in $lines) { Write-Host "  $l" }
}

function Step-Shortcuts {
	$p = Get-MmPaths
	Write-Launcher $p.Launcher
	$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
	$wtPath = $null
	if ($wt) { $wtPath = $wt.Source } else { Write-Host '  Windows Terminal не найден: наставник откроется в обычном окне' }
	New-Item -ItemType Directory -Path $p.Desktop -Force | Out-Null
	foreach ($s in (Get-ShortcutSpecs -Paths $p -WtPath $wtPath)) {
		$lnk = Join-Path $p.Desktop ($s.Name + '.lnk')
		New-MmShortcut -Path $lnk -Target $s.Target -Arguments $s.Arguments -WorkDir $s.WorkDir -Description $s.Description
		Write-Host "  $($s.Name)"
	}
}

function Step-SelfCheck {
	$p = Get-MmPaths
	Refresh-BootPath
	$bad = @()
	$piCmd = Join-Path $p.Npm 'pi.cmd'
	try { $v = (& $piCmd --version | Select-Object -First 1).ToString().Trim(); Write-Host "  pi --version: $v" } catch { $bad += 'pi --version' }
	try {
		$key = Get-DeepSeekAuthKey $p.Auth
		if (-not $key) { throw 'ключа нет в auth.json' }
		$r = Test-DeepSeekKey $key
		Write-Host "  ключ DeepSeek: $($r.Text)"
		if (-not $r.Ok) { $bad += 'ключ DeepSeek' }
	} catch { $bad += "ключ DeepSeek ($($_.Exception.Message))" }
	try {
		$sc = Join-Path $p.App 'tools\selfcheck.ts'
		$out = (& node $sc 2>&1 | Out-String).Trim()
		if ($LASTEXITCODE -ne 0 -or -not $out) { throw $out }
		Write-Host "  project_summary на встроенном проекте: ок"
		Write-Host ('    ' + (($out -split "`n") | Select-Object -First 1))
	} catch { $bad += "project_summary ($($_.Exception.Message))" }
	$live = 'Live не запущен или мост ещё не включён (так и должно быть до первой настройки)'
	try {
		$c = New-Object Net.Sockets.TcpClient
		$ar = $c.BeginConnect('127.0.0.1', 9878, $null, $null)
		if ($ar.AsyncWaitHandle.WaitOne(1000) -and $c.Connected) { $live = 'мост отвечает' }
		$c.Close()
	} catch { }
	Write-Host "  связь с Live: $live"
	if ($bad.Count -gt 0) { throw ('не прошло: ' + ($bad -join '; ')) }
}

function Start-Install {
	Initialize-Bootstrap
	Write-Host ''
	Write-Say "Музыкальный наставник: установка ($MmTag)" 'Green'
	Write-Host 'Это займёт несколько минут. Можно ничего не нажимать.'
	$ok = $true
	if (-not (Invoke-Step 1 'проверки' { Step-Checks })) { Write-Say 'Без шага 1 дальше идти нельзя.' 'Red'; return }
	if (-not (Invoke-Step 2 'Git' { Step-Git })) { $ok = $false }
	if (-not (Invoke-Step 3 'pi' { Step-Pi })) { $ok = $false }
	if ($ok) {
		if (-not (Invoke-Step 4 'код наставника' { Step-App })) { $ok = $false }
	} else {
		Write-Say 'Шаг 4 (код наставника) пропущен: сначала нужны шаги 2 и 3.' 'Red'
		$script:MmFailed += '4 (код наставника)'
	}
	if (-not $ok) {
		Write-Host ''
		Write-Say ("Установка не закончена. Не получилось: {0}. Сфотографируй это окно и пришли {1}; потом запусти ту же строку ещё раз — сделанное пропустится." -f ($script:MmFailed -join ', '), $MmAuthor) 'Red'
		return
	}
	$null = Invoke-Step 5 'настройки pi' { Step-Settings }
	$null = Invoke-Step 6 'ключ DeepSeek' { Step-Key }
	$null = Invoke-Step 7 'рабочая папка' { Step-Workspace }
	$null = Invoke-Step 8 'мост к Ableton Live' { Step-Bridge }
	$null = Invoke-Step 9 'ярлыки' { Step-Shortcuts }
	$null = Invoke-Step 10 'самопроверка' { Step-SelfCheck }
	Write-Host ''
	if ($script:MmFailed.Count -eq 0) {
		Write-Say 'Готово. На рабочем столе три ярлыка: «Музыкальный наставник», «Сменить ключ DeepSeek», «Обновить наставника».' 'Green'
		Write-Host 'Один раз включи мост в Ableton Live: Preferences -> MIDI -> Control Surface -> MentorBridge (Input и Output: None). Наставник сам подскажет, где это в твоей версии.'
	} else {
		Write-Say ("Установка закончена с ошибками. Не получилось: {0}. Сфотографируй это окно и пришли {1}; потом запусти ту же строку ещё раз." -f ($script:MmFailed -join ', '), $MmAuthor) 'Red'
	}
}

if (-not $env:MM_NO_RUN) { Start-Install }
