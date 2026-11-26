# music_mentor: общие функции для install.ps1, change_key.ps1 и update.ps1.
# UTF-8 с BOM, PowerShell 5.1+. Без `exit`: функции возвращают значения или бросают исключение,
# сообщения об ошибках показывает вызывающий (см. Invoke-Step в install.ps1).

Set-StrictMode -Version 2.0

# --- пути -------------------------------------------------------------------------------------

function Join-Rel {
	# Join-Path для относительного пути с обратными слэшами (работает и на Linux в тестах).
	param([string]$Base, [string]$Rel)
	foreach ($part in ($Rel -split '[\\/]')) { if ($part) { $Base = [IO.Path]::Combine($Base, $part) } }
	return $Base
}

function Get-MmRoot {
	if ($env:MM_ROOT) { return $env:MM_ROOT }
	return (Join-Path $env:LOCALAPPDATA 'music_mentor')
}

function Get-MmPaths {
	$root = Get-MmRoot
	$docs = if ($env:MM_DOCUMENTS) { $env:MM_DOCUMENTS } else { [Environment]::GetFolderPath('MyDocuments') }
	$desk = if ($env:MM_DESKTOP) { $env:MM_DESKTOP } else { [Environment]::GetFolderPath('Desktop') }
	$home1 = if ($env:MM_HOME) { $env:MM_HOME } else { $env:USERPROFILE }
	$agent = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Rel $home1 '.pi\agent' }
	return @{
		Root      = $root
		App       = Join-Path $root 'app'
		Node      = Join-Path $root 'node'
		Npm       = Join-Path $root 'npm'
		Launcher  = Join-Path $root 'start_mentor.cmd'
		Workspace = Join-Path $docs 'music_mentor'
		Documents = $docs
		Desktop   = $desk
		AgentDir  = $agent
		Auth      = Join-Path $agent 'auth.json'
		Settings  = Join-Path $agent 'settings.json'
		Logs      = Join-Path $root 'logs'
	}
}

function Update-SessionPath {
	# Подтянуть PATH из реестра (после установки git/node в этой же сессии) и добавить наши папки.
	$p = Get-MmPaths
	$parts = @()
	foreach ($scope in 'Machine', 'User') {
		try {
			$v = [Environment]::GetEnvironmentVariable('Path', $scope)
			if ($v) { $parts += ($v -split ';') }
		} catch { }
	}
	$parts += ($env:Path -split ';')
	$parts = @($p.Node, $p.Npm) + $parts
	$seen = @{}
	$out = @()
	foreach ($x in $parts) {
		if (-not $x) { continue }
		$k = $x.TrimEnd('\').ToLowerInvariant()
		if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $out += $x }
	}
	$env:Path = ($out -join ';')
}

function Add-UserPathEntry {
	param([string]$Dir)
	$cur = [Environment]::GetEnvironmentVariable('Path', 'User')
	if (-not $cur) { $cur = '' }
	$items = @($cur -split ';' | Where-Object { $_ })
	foreach ($i in $items) { if ($i.TrimEnd('\') -ieq $Dir.TrimEnd('\')) { return $false } }
	[Environment]::SetEnvironmentVariable('Path', (($items + $Dir) -join ';'), 'User')
	return $true
}

function Set-Utf8Console {
	try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
	try { $OutputEncoding = [Text.Encoding]::UTF8 } catch { }
}

function Write-Utf8NoBom {
	param([string]$Path, [string]$Text)
	$dir = Split-Path -Parent $Path
	if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
	[IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# --- журнал ------------------------------------------------------------------------------------
# Друг не может «сфотографировать окно»: модель картинок не видит. Поэтому каждый скрипт пишет журнал
# в %LOCALAPPDATA%\music_mentor\logs\<скрипт>_<дата-время>.log — туда идёт всё, что видно в окне, плюс
# тексты исключений и номера шагов. Ключ DeepSeek в журнал не попадает никогда: перед записью строка
# проходит ConvertTo-MmLogSafe. Хранятся последние 10 журналов.

function Get-MmLogsDir {
	param([string]$Root)
	if (-not $Root) { $Root = Get-MmRoot }
	return (Join-Path $Root 'logs')
}

function Get-MmLogFileName {
	# <скрипт>_<дата-время>.log. Секунды в имени: два запуска подряд не затирают друг друга.
	param([string]$Script, [datetime]$Now)
	if (-not $Now) { $Now = Get-Date }
	return ('{0}_{1}.log' -f ($Script -replace '[^\w.\-]', '_'), $Now.ToString('yyyy-MM-dd_HHmmss'))
}

function ConvertTo-MmLogSafe {
	# Маска для всего, что похоже на секрет. Пишется в журнал только результат.
	param([string]$Text)
	if (-not $Text) { return '' }
	$t = [regex]::Replace($Text, 'sk-[A-Za-z0-9_\-]{8,}', 'sk-***')
	$t = [regex]::Replace($t, '(?i)(authorization\s*[:=]\s*)?bearer\s+\S+', 'Bearer ***')
	return $t
}

function Get-MmLogPath {
	if (Get-Variable -Name MmLogPath -Scope Global -ErrorAction SilentlyContinue) { return $global:MmLogPath }
	return $null
}

function Remove-OldMmLogs {
	# Оставить последние $Keep журналов (по времени изменения). $Current не трогаем никогда.
	param([string]$Dir, [int]$Keep = 10, [string]$Current)
	if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return }
	$files = @(Get-ChildItem -LiteralPath $Dir -File -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
	if ($files.Count -le $Keep) { return }
	$drop = @($files[$Keep..($files.Count - 1)])
	foreach ($f in $drop) {
		if ($Current -and $f.FullName -eq $Current) { continue }
		Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
	}
}

function Start-MmLog {
	# Начать журнал. Возвращает путь к файлу; дальнейшая запись — через Write-MmLog / Write-MmHost.
	param([string]$Script, [string]$Root)
	$dir = Get-MmLogsDir $Root
	New-Item -ItemType Directory -Path $dir -Force | Out-Null
	$path = Join-Path $dir (Get-MmLogFileName -Script $Script)
	$global:MmLogPath = $path
	$enc = New-Object Text.UTF8Encoding $false
	[IO.File]::AppendAllText($path, ((ConvertTo-MmLogSafe ('=== music_mentor: {0}, {1} ===' -f $Script, (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))) + "`r`n"), $enc)
	Remove-OldMmLogs -Dir $dir -Keep 10 -Current $path
	return $path
}

function Write-MmLog {
	# Строка только в журнал (текст исключения, подробности). Ошибка журнала не ломает работу.
	param([string]$Text)
	$path = Get-MmLogPath
	if (-not $path) { return }
	try {
		[IO.File]::AppendAllText($path, ((ConvertTo-MmLogSafe "$Text") + "`r`n"), (New-Object Text.UTF8Encoding $false))
	} catch { }
}

function Write-MmHost {
	# В окно и в журнал одновременно (Write-Host в PowerShell 5.1 сам в журнал не попадает).
	param([string]$Text, [string]$Color)
	Write-MmLog $Text
	if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text }
}

function Copy-MmLogToClipboard {
	# Положить сам файл журнала в буфер обмена (Windows: Set-Clipboard -Path). Не вышло — $false.
	param([string]$Path)
	if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
	try { Set-Clipboard -Path $Path; return $true } catch { }
	try { $null = [IO.File]::ReadAllText($Path) | Set-Clipboard; return $true } catch { }
	return $false
}

function Get-MmLogHint {
	# Текст для друга вместо «сфотографируй окно»: путь к журналу и он же в буфере обмена.
	param([string]$Path)
	if (-not $Path) { $Path = Get-MmLogPath }
	if (-not $Path) { return 'Журнала нет: запиши, что написано в окне, и пришли автору.' }
	if (Copy-MmLogToClipboard $Path) { return ("Журнал: {0}. Он уже в буфере обмена — пришли этот файл автору." -f $Path) }
	return ("Журнал: {0}. Пришли этот файл автору." -f $Path)
}

# --- JSON (ключ и настройки pi) ------------------------------------------------------------------

function Read-JsonFile {
	# Возвращает PSCustomObject; нет файла или он пустой -> пустой объект. Битый JSON -> исключение.
	param([string]$Path)
	if (-not (Test-Path -LiteralPath $Path)) { return (New-Object PSObject) }
	$raw = [IO.File]::ReadAllText($Path)
	if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
	if (-not $raw.Trim()) { return (New-Object PSObject) }
	try { return ($raw | ConvertFrom-Json) } catch { throw "файл $Path не разобрался как JSON: $($_.Exception.Message)" }
}

function Set-JsonProp {
	param($Obj, [string]$Name, $Value)
	if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name = $Value } else { Add-Member -InputObject $Obj -NotePropertyName $Name -NotePropertyValue $Value }
}

function Write-JsonFile {
	param([string]$Path, $Obj)
	Write-Utf8NoBom $Path ((ConvertTo-Json -InputObject $Obj -Depth 10) + "`n")
}

function Set-PiSettings {
	# Слить наши настройки в settings.json pi, не трогая чужие поля (например packages от `pi install`).
	param([string]$Path, [string]$ShellPath)
	$s = Read-JsonFile $Path
	Set-JsonProp $s 'defaultProvider' 'deepseek'
	Set-JsonProp $s 'defaultModel' 'deepseek-v4-pro'
	Set-JsonProp $s 'quietStartup' $true
	Set-JsonProp $s 'enabledModels' @('deepseek/deepseek-v4-pro', 'deepseek/deepseek-flash')
	# Ученику нужен ответ, а не рассуждения модели: блоки мыслей скрыты (Ctrl+T их вернёт). T1909.
	Set-JsonProp $s 'hideThinkingBlock' $true
	if ($ShellPath) { Set-JsonProp $s 'shellPath' $ShellPath }
	Write-JsonFile $Path $s
}

function Set-DeepSeekAuth {
	# Записать ключ в auth.json, сохранив остальных провайдеров. Значение ключа нигде не печатается.
	param([string]$Path, [string]$Key)
	$a = Read-JsonFile $Path
	Set-JsonProp $a 'deepseek' ([pscustomobject]@{ type = ('api' + '_key'); key = $Key })
	Write-JsonFile $Path $a
}

function Get-DeepSeekAuthKey {
	param([string]$Path)
	$a = Read-JsonFile $Path
	if ($a.PSObject.Properties['deepseek'] -and $a.deepseek.PSObject.Properties['key']) { return [string]$a.deepseek.key }
	return $null
}

function ConvertFrom-SecureStringPlain {
	param([Security.SecureString]$Secure)
	$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
	try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Get-DeepSeekApiBase {
	if ($env:MM_DEEPSEEK_API) { return $env:MM_DEEPSEEK_API.TrimEnd('/') }
	return 'https://api.deepseek.com'
}

function Test-DeepSeekKey {
	# GET /user/balance. Возвращает @{ Ok; Text }. 401 -> Ok=$false; нет сети -> исключение.
	# Текст никогда не содержит ключ.
	param([string]$Key)
	if (-not $Key -or $Key.Trim().Length -lt 8) { return @{ Ok = $false; Text = 'ключ пустой или слишком короткий' } }
	$Key = $Key.Trim()
	try {
		$r = Invoke-RestMethod -Uri ((Get-DeepSeekApiBase) + '/user/balance') -Headers @{ Authorization = "Bearer $Key" } -Method Get -TimeoutSec 30
	} catch {
		$code = 0
		try { $code = [int]$_.Exception.Response.StatusCode } catch { }
		if ($code -eq 401) { return @{ Ok = $false; Text = 'DeepSeek не принял ключ (401). Проверь, что скопирован весь ключ целиком.' } }
		if ($code -eq 402) { return @{ Ok = $true; Text = 'ключ рабочий, но деньги на нём закончились' } }
		if ($code -gt 0) { throw "DeepSeek ответил ошибкой $code" }
		throw "не удалось связаться с api.deepseek.com: $($_.Exception.Message)"
	}
	$avail = $true
	try { $avail = [bool]$r.is_available } catch { }
	$bal = ''
	try {
		$infos = @($r.balance_infos)
		if ($infos.Count -gt 0) { $bal = ", баланс: $($infos[0].total_balance) $($infos[0].currency)" }
	} catch { }
	if (-not $avail) { return @{ Ok = $true; Text = "ключ рабочий, но денег на балансе нет$bal" } }
	return @{ Ok = $true; Text = "ключ принят$bal" }
}

# --- версии: versions.json, Node, pi -----------------------------------------------------------
# Версии живут в одном файле — lib/win/versions.json: tag (тег релиза), pi (версия pi), node
# (минимальная версия Node). install.ps1 читает его по сети с того же тега, update.ps1 — с диска
# после checkout, tools/release.sh — пишет. Тег в install.ps1 (default $MmTag) — только bootstrap
# fallback: равен tag из versions.json, это проверяет npm test.

function ConvertFrom-MmVersions {
	# Разбор versions.json в @{ Tag; Pi; Node }. Битый или неполный файл — исключение, не тишина.
	param([string]$Json)
	if (-not $Json -or -not $Json.Trim()) { throw 'versions.json пуст' }
	$o = $null
	try { $o = $Json | ConvertFrom-Json } catch { throw "versions.json не разобрался как JSON: $($_.Exception.Message)" }
	$res = @{}
	foreach ($k in @('tag', 'pi', 'node')) {
		$v = $null
		if ($o.PSObject.Properties[$k]) { $v = [string]$o.$k }
		if (-not $v -or -not $v.Trim()) { throw "в versions.json нет поля $k" }
		$res[$k] = $v.Trim()
	}
	if ($res.tag -notmatch '^v\d+\.\d+\.\d+') { throw "versions.json: tag '$($res.tag)' не похож на vX.Y.Z" }
	if ($res.pi -notmatch '^\d+\.\d+\.\d+') { throw "versions.json: pi '$($res.pi)' не похож на X.Y.Z" }
	if ($res.node -notmatch '^\d+\.\d+\.\d+') { throw "versions.json: node '$($res.node)' не похож на X.Y.Z" }
	return @{ Tag = $res.tag; Pi = $res.pi; Node = $res.node }
}

function Read-MmVersions {
	# versions.json из скачанного кода (после checkout обновления).
	param([string]$AppDir)
	$file = Join-Path (Join-Path $AppDir 'lib\win') 'versions.json'
	if (-not (Test-Path -LiteralPath $file)) { throw "нет файла $file" }
	return (ConvertFrom-MmVersions ([IO.File]::ReadAllText($file)))
}

function Get-WinArch {
	$a = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	if ($a -eq 'ARM64') { return 'arm64' }
	return 'x64'
}

function Get-Web {
	# Скачать текст (без OutFile) или файл. Одна на все запросы к сети.
	param([string]$Url, [string]$OutFile)
	$h = @{ 'User-Agent' = 'music_mentor-installer' }
	if ($OutFile) { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -Headers $h -TimeoutSec 600 } else { Invoke-RestMethod -Uri $Url -Headers $h -TimeoutSec 60 }
}

function Get-NodeVersionOnPath {
	$n = Get-Command node -ErrorAction SilentlyContinue
	if (-not $n) { return $null }
	try { return [version](((& $n.Source --version) -replace '^v', '').Trim()) } catch { return $null }
}

function Get-MmNodePlan {
	# Чистая функция: 'уже' или 'ставить'. Нет node или он старше минимального — ставим свой LTS.
	param([string]$Have, [string]$Min)
	if (-not $Have) { return 'ставить' }
	try { if ([version]$Have -ge [version]$Min) { return 'уже' } } catch { }
	return 'ставить'
}

function Get-MmPiPlan {
	# Чистая функция: 'уже' (версия совпала) или 'ставить' (в т.ч. pi нет вовсе).
	param([string]$Have, [string]$Want)
	if ($Have -and $Have.Trim() -eq $Want.Trim()) { return 'уже' }
	return 'ставить'
}

function Get-PiInstallCmdLine {
	# Строка `npm install` pi — одна на установщик и на обновление (шаг 3 установщика).
	param([string]$NpmPath, [string]$Prefix, [string]$Version)
	return ('"{0}" install -g --ignore-scripts --no-fund --no-audit --no-update-notifier --loglevel=error --prefix "{1}" "@earendil-works/pi-coding-agent@{2}" 2>&1' -f $NpmPath, $Prefix, $Version)
}

function Install-StandaloneNode {
	# Node LTS с nodejs.org в <Root>\node (без админа, с проверкой SHA256).
	param([string]$Root, [string]$MinVersion)
	$dest = Join-Path $Root 'node'
	$arch = Get-WinArch
	$idx = Get-Web 'https://nodejs.org/dist/index.json'
	$min = [version]$MinVersion
	$entry = @($idx | Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and ([version]($_.version -replace '^v', '')) -ge $min }) | Select-Object -First 1
	if (-not $entry) { throw "в списке Node.js нет LTS $MinVersion или новее для win-$arch" }
	$name = "node-$($entry.version)-win-$arch.zip"
	$base = "https://nodejs.org/dist/$($entry.version)"
	$sums = Get-Web "$base/SHASUMS256.txt"
	$line = @(($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($name) + '\s*$' }) | Select-Object -First 1
	if (-not $line) { throw "в SHASUMS256.txt нет $name" }
	$want = ($line -split '\s+')[0].ToLowerInvariant()
	$zip = Join-Path ([IO.Path]::GetTempPath()) $name
	Write-MmHost "  качаю Node.js $($entry.version)"
	Get-Web "$base/$name" $zip
	$got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($got -ne $want) { throw "контрольная сумма $name не совпала" }
	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ('mm_node_' + [guid]::NewGuid().ToString('N'))
	[IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpDir)
	if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
	New-Item -ItemType Directory -Path $Root -Force | Out-Null
	Move-Item -LiteralPath (Join-Path $tmpDir ([IO.Path]::GetFileNameWithoutExtension($name))) -Destination $dest
	Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
	Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}

function Ensure-MmPiRuntime {
	# Привести Node и pi к версиям из versions.json. Идемпотентно: совпало — ничего не делает.
	# Возвращает @{ Node; Pi; ChangedPi; ChangedNode }.
	# Вызывают оба: install.ps1 (шаг 3) и update.ps1 (после checkout).
	param([string]$Root, $Versions)
	$changedNode = $false
	$nv = Get-NodeVersionOnPath
	if ((Get-MmNodePlan -Have $nv -Min $Versions.Node) -eq 'ставить') {
		if ($nv) { Write-MmHost "  Node.js $nv старый (нужен $($Versions.Node)+), ставлю свой LTS" } else { Write-MmHost "  Node.js не найден, ставлю LTS $($Versions.Node)+" }
		Install-StandaloneNode -Root $Root -MinVersion $Versions.Node
		$changedNode = $true
		$nv = Get-NodeVersionOnPath
		if (-not $nv) { throw 'Node.js скачан, но node не запускается' }
		Write-MmHost "  Node.js $nv поставлен в $Root\node"
	} else {
		Write-MmHost "  Node.js $nv уже есть"
	}
	$npmPrefix = Join-Path $Root 'npm'
	$piCmd = Join-Path $npmPrefix 'pi.cmd'
	$have = $null
	if (Test-Path -LiteralPath $piCmd) { try { $have = (& $piCmd --version | Select-Object -First 1).ToString().Trim() } catch { $have = $null } }
	$changedPi = $false
	if ((Get-MmPiPlan -Have $have -Want $Versions.Pi) -eq 'уже') {
		Write-MmHost "  pi $have уже есть"
		return @{ Node = "$nv"; Pi = $have; ChangedPi = $false; ChangedNode = $changedNode }
	}
	Write-MmHost "  ставлю pi $($Versions.Pi) (npm, без скриптов)"
	New-Item -ItemType Directory -Path $npmPrefix -Force | Out-Null
	$npmPath = $env:MM_NPM
	if (-not $npmPath) { $c = Get-Command npm.cmd -ErrorAction SilentlyContinue; if ($c) { $npmPath = $c.Source } }
	if (-not $npmPath) { throw 'npm не найден рядом с node' }
	$line = Get-PiInstallCmdLine -NpmPath $npmPath -Prefix $npmPrefix -Version $Versions.Pi
	# Через cmd.exe: stderr npm (warn/notice) иначе показывается в PowerShell 5.1 красным «NativeCommandError».
	$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
	$cmdLine = "`"$line`""
	try { $npmOut = & cmd.exe /d /s /c $cmdLine 2>&1 } finally { $ErrorActionPreference = $old }
	foreach ($l in @($npmOut)) { Write-MmLog "$l" }
	if ($LASTEXITCODE -ne 0) { throw "npm install закончился кодом $LASTEXITCODE" }
	if (-not (Test-Path -LiteralPath $piCmd)) { throw "после установки нет $piCmd" }
	$have = (& $piCmd --version | Select-Object -First 1).ToString().Trim()
	if ($have -ne $Versions.Pi) { throw "pi сообщил версию '$have', ожидалась $($Versions.Pi)" }
	$changedPi = $true
	Write-MmHost "  pi $have"
	return @{ Node = "$nv"; Pi = $have; ChangedPi = $changedPi; ChangedNode = $changedNode }
}

# --- Ableton Live и мост --------------------------------------------------------------------------

function Get-LibraryPathFromText {
	# Library.cfg — XML, где путь User Library лежит в атрибуте Value. Имя тега не фиксируем жёстко:
	# сначала <UserLibrary>…</UserLibrary>, затем любой Value, похожий на путь (диск, UNC или абсолютный).
	param([string]$Text)
	if (-not $Text) { return $null }
	$block = $Text
	$m = [regex]::Match($Text, '(?s)<UserLibrary\b[^>]*>(.*?)</UserLibrary>')
	if ($m.Success) { $block = $m.Groups[1].Value }
	$pathLike = '^(?:[A-Za-z]:[\\/]|\\\\|/)'
	foreach ($tag in @('ProjectPath', 'Path', '')) {
		$re = if ($tag) { '<' + $tag + '\s[^>]*Value="([^"]*)"' } else { '\bValue="([^"]*)"' }
		foreach ($mm in [regex]::Matches($block, $re)) {
			$v = [Net.WebUtility]::HtmlDecode($mm.Groups[1].Value).Trim()
			if ($v -match $pathLike) { return $v }
		}
	}
	return $null
}

function Read-LibraryCfg {
	param([string]$Path)
	if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
	try { return (Get-LibraryPathFromText ([IO.File]::ReadAllText($Path))) } catch { return $null }
}

function Test-LocalDrivePath {
	# Локальный путь на диске (C:\…), а не UNC-шара. Сетевое отображение диска (Z:) отсекает вызывающий через -IsFixed.
	param([string]$Path, [scriptblock]$IsFixed)
	if (-not $Path -or $Path -notmatch '^[A-Za-z]:[\\/]') { return $false }
	if ($IsFixed) { return [bool](& $IsFixed $Path) }
	return $true
}

function ConvertTo-LiveVersion {
	# "Live 10.1.18" -> [version]10.1.18; "Live 12.0" -> 12.0; нет версии -> $null
	param([string]$Name)
	$m = [regex]::Match($Name, '(?i)Live\s+(\d+)\.(\d+)(?:\.(\d+))?')
	if (-not $m.Success) { return $null }
	$patch = if ($m.Groups[3].Success) { $m.Groups[3].Value } else { '0' }
	return [version]("{0}.{1}.{2}" -f $m.Groups[1].Value, $m.Groups[2].Value, $patch)
}

function Get-LiveInstalls {
	# Найти установки Live по ProgramData\Ableton\Live * и %APPDATA%\Ableton\Live x.y.z (настройки).
	# Возвращает список: Major, Version ([version] или $null), ProgramDataDir, SettingsDir, Name.
	param([string]$ProgramData, [string]$AppData)
	$byMajor = @{}
	function Get-Entry($major) {
		if (-not $byMajor.ContainsKey($major)) {
			$byMajor[$major] = [pscustomobject]@{ Major = $major; Version = $null; ProgramDataDir = $null; SettingsDir = $null; Name = "Live $major" }
		}
		return $byMajor[$major]
	}
	if ($ProgramData) {
		$ab = Join-Path $ProgramData 'Ableton'
		if (Test-Path -LiteralPath $ab) {
			foreach ($d in (Get-ChildItem -LiteralPath $ab -Directory -ErrorAction SilentlyContinue)) {
				$m = [regex]::Match($d.Name, '^Live\s+(\d+)')
				if (-not $m.Success) { continue }
				$e = Get-Entry ([int]$m.Groups[1].Value)
				$e.ProgramDataDir = $d.FullName
				$e.Name = $d.Name
			}
		}
	}
	if ($AppData) {
		$ab = Join-Path $AppData 'Ableton'
		if (Test-Path -LiteralPath $ab) {
			foreach ($d in (Get-ChildItem -LiteralPath $ab -Directory -ErrorAction SilentlyContinue)) {
				$v = ConvertTo-LiveVersion $d.Name
				if (-not $v) { continue }
				$e = Get-Entry $v.Major
				if (-not $e.Version -or $v -gt $e.Version) { $e.Version = $v; $e.SettingsDir = $d.FullName }
			}
		}
	}
	return @($byMajor.Values | Sort-Object Major)
}

function Resolve-BridgeTarget {
	# Чистая функция: куда ставить MentorBridge для одной установки Live.
	#   Live 10 старше 10.1.13 (или версия неизвестна) -> <Live>\Resources\MIDI Remote Scripts, нужен UAC;
	#   иначе -> <User Library>\Remote Scripts: путь из Library.cfg, если он локальный и существует;
	#            путь в cfg есть, но сетевой/недоступен -> Resources (UAC), если Live в ProgramData;
	#            иначе Documents\Ableton\User Library.
	param($Install, [string]$LibraryPath, [string]$Documents, [scriptblock]$Exists, [scriptblock]$IsFixed)
	if (-not $Exists) { $Exists = { param($p) Test-Path -LiteralPath $p } }
	$major = $Install.Major
	if ($major -lt 10) {
		return @{ Supported = $false; Reason = "Live $major слишком старый (нужен 10 или новее)" }
	}
	$needsResources = $false
	if ($major -eq 10) {
		$v = $Install.Version
		if (-not $v -or $v -lt [version]'10.1.13') { $needsResources = $true }
	}
	if ($needsResources) {
		if (-not $Install.ProgramDataDir) {
			return @{ Supported = $false; Reason = 'Live 10 старше 10.1.13 стоит не в ProgramData: не нашёл папку Resources' }
		}
		return @{
			Supported  = $true
			Kind       = 'Resources'
			Path       = (Join-Rel $Install.ProgramDataDir 'Resources\MIDI Remote Scripts')
			NeedsAdmin = $true
			Why        = 'Live 10 старше 10.1.13 читает скрипты только из папки программы'
		}
	}
	$ul = $null
	$note = ''
	if ($LibraryPath -and (Test-LocalDrivePath $LibraryPath $IsFixed) -and (& $Exists $LibraryPath)) {
		$ul = $LibraryPath
	} elseif ($LibraryPath -and $Install.ProgramDataDir) {
		# Live берёт Remote Scripts из своей User Library (из Library.cfg), а не из Documents: проверено на VM
		# с User Library на UNC-шаре (12.4.16, 26.11) — копия в Documents не видна. Папку программы Live читает всегда.
		return @{
			Supported  = $true
			Kind       = 'Resources'
			Path       = (Join-Rel $Install.ProgramDataDir 'Resources\MIDI Remote Scripts')
			NeedsAdmin = $true
			Why        = "User Library из настроек Live ($LibraryPath) сетевой или недоступен, ставлю в папку программы Live (нужно разрешение администратора)"
		}
	} else {
		if ($LibraryPath) { $note = "User Library из настроек Live ($LibraryPath) сетевой или недоступен, беру папку по умолчанию" }
		$ul = Join-Rel $Documents 'Ableton\User Library'
	}
	return @{
		Supported  = $true
		Kind       = 'UserLibrary'
		Path       = (Join-Rel $ul 'Remote Scripts')
		NeedsAdmin = $false
		Why        = $note
	}
}

function Get-DirHash {
	param([string]$Dir)
	if (-not (Test-Path -LiteralPath $Dir)) { return '' }
	$base = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\', '/')
	$sb = New-Object Text.StringBuilder
	foreach ($f in (Get-ChildItem -LiteralPath $Dir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ne '.pyc' -and $_.FullName -notmatch '__pycache__' } | Sort-Object FullName)) {
		$rel = $f.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/')
		$h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
		[void]$sb.Append($rel).Append(':').Append($h).Append(';')
	}
	$bytes = [Text.Encoding]::UTF8.GetBytes($sb.ToString())
	$sha = [Security.Cryptography.SHA256]::Create()
	return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '')
}

function Copy-BridgeTo {
	# Скопировать папку MentorBridge в <ScriptsDir>\MentorBridge. Возвращает 'уже' / 'установлен' / 'обновлён'.
	param([string]$Source, [string]$ScriptsDir)
	$dest = Join-Path $ScriptsDir 'MentorBridge'
	$state = 'установлен'
	if (Test-Path -LiteralPath $dest) {
		if ((Get-DirHash $Source) -eq (Get-DirHash $dest)) { return 'уже' }
		$state = 'обновлён'
		Remove-Item -LiteralPath $dest -Recurse -Force
	}
	New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
	Copy-Item -LiteralPath $Source -Destination $dest -Recurse -Force
	Get-ChildItem -LiteralPath $dest -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
	return $state
}

function Copy-BridgeElevated {
	# Копия в папку программы: UAC. Сообщение пользователю идёт до запроса.
	param([string]$Source, [string]$ScriptsDir)
	Write-MmHost '  Нужно разрешение администратора: сейчас появится окно Windows («Разрешить ли этому приложению внести изменения»). Нажми «Да».' 'Yellow'
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mm_bridge_' + [guid]::NewGuid().ToString('N') + '.ps1')
	$cmd = @"
`$ErrorActionPreference = 'Stop'
`$dest = Join-Path '$($ScriptsDir.Replace("'", "''"))' 'MentorBridge'
if (Test-Path -LiteralPath `$dest) { Remove-Item -LiteralPath `$dest -Recurse -Force }
New-Item -ItemType Directory -Path '$($ScriptsDir.Replace("'", "''"))' -Force | Out-Null
Copy-Item -LiteralPath '$($Source.Replace("'", "''"))' -Destination `$dest -Recurse -Force
"@
	[IO.File]::WriteAllText($tmp, $cmd, (New-Object Text.UTF8Encoding $true))
	try {
		$proc = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tmp)
		if ($proc.ExitCode -ne 0) { throw "копирование с правами администратора закончилось кодом $($proc.ExitCode)" }
	} catch {
		throw "не получилось скопировать с правами администратора ($($_.Exception.Message)). Если окно Windows закрыл или нажал «Нет», запусти установку ещё раз и нажми «Да»."
	} finally {
		Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
	}
	return 'установлен'
}

function Install-Bridge {
	# Шаг 8: поставить MentorBridge в каждую найденную установку Live. Возвращает список строк-итогов.
	param([string]$BridgeSource, [string]$ProgramData, [string]$AppData, [string]$Documents, [switch]$NoElevate)
	$lines = @()
	$installs = @(Get-LiveInstalls -ProgramData $ProgramData -AppData $AppData)
	if ($installs.Count -eq 0) { return @('Ableton Live не найден: мост пропускаю (запусти установку ещё раз после установки Live).') }
	$done = @{}
	foreach ($inst in $installs) {
		$lib = $null
		if ($inst.SettingsDir) { $lib = Read-LibraryCfg (Join-Rel $inst.SettingsDir 'Preferences\Library.cfg') }
		$isFixed = {
			param($p)
			try { return ([IO.DriveInfo]::new($p.Substring(0, 3)).DriveType -eq [IO.DriveType]::Fixed) } catch { return $true }
		}
		$t = Resolve-BridgeTarget -Install $inst -LibraryPath $lib -Documents $Documents -IsFixed $isFixed
		$label = if ($inst.Version) { "Live $($inst.Version)" } else { $inst.Name }
		if (-not $t.Supported) { $lines += "${label}: пропускаю, $($t.Reason)."; continue }
		$key = $t.Path.ToLowerInvariant()
		if ($done.ContainsKey($key)) { $lines += "${label}: мост уже поставлен в $($t.Path)."; continue }
		$done[$key] = $true
		if ($t.Why) { Write-MmHost "  ${label}: $($t.Why)." }
		if ($t.NeedsAdmin) {
			if ($NoElevate) { $lines += "${label}: нужен администратор (не запрашивал), мост не поставлен в $($t.Path)."; continue }
			$state = 'уже'
			$destDir = Join-Path $t.Path 'MentorBridge'
			if ((Test-Path -LiteralPath $destDir) -and ((Get-DirHash $BridgeSource) -eq (Get-DirHash $destDir))) {
				$state = 'уже'
			} else {
				Write-MmHost "  ${label}: $($t.Why)."
				$state = Copy-BridgeElevated -Source $BridgeSource -ScriptsDir $t.Path
			}
		} else {
			$state = Copy-BridgeTo -Source $BridgeSource -ScriptsDir $t.Path
		}
		$lines += "${label}: мост $state -> $($t.Path)"
	}
	return $lines
}

# --- рабочая папка, ярлыки, обновление -------------------------------------------------------------

function Get-MmLearnerDirs {
	# Чьё что в шаблонной рабочей папке — одна таблица, здесь и только здесь.
	#   файлы ученика — всё внутри этих папок (профиль, журнал, снимки, заметки, упражнения):
	#                    создаются, только если их нет; существующие не перезаписываются НИКОГДА;
	#   файлы агента — всё остальное из template/ (AGENTS.md, будущие скиллы и knowledge):
	#                    при обновлении заменяются новой версией (роль агента меняется от версии к версии).
	# Файлы рабочей папки, которых нет в шаблоне, не удаляются и не трогаются.
	return @('learner', 'notes')
}

function Get-TemplateOwner {
	# 'learner' или 'mentor' по относительному пути внутри шаблона.
	param([string]$Rel)
	$top = (($Rel -split '[\\/]')[0]).ToLowerInvariant()
	if ((Get-MmLearnerDirs) -contains $top) { return 'learner' }
	return 'mentor'
}

function Get-WorkspaceTemplatePlan {
	# Чистая функция: что делать с каждым файлом шаблона в рабочей папке.
	# Возвращает список @{ Rel; Owner; Action }, Action = 'write' (агента) | 'create' | 'keep' (ученика).
	param([string]$Template, [string]$Workspace, [scriptblock]$Exists)
	if (-not $Exists) { $Exists = { param($p) Test-Path -LiteralPath $p } }
	if (-not (Test-Path -LiteralPath $Template)) { throw "нет шаблона рабочей папки: $Template" }
	$base = (Resolve-Path -LiteralPath $Template).Path.TrimEnd('\', '/')
	$plan = @()
	foreach ($f in @(Get-ChildItem -LiteralPath $Template -Recurse -File -Force | Sort-Object FullName)) {
		$rel = $f.FullName.Substring($base.Length).TrimStart('\', '/').Replace('\', '/')
		if (-not $rel) { continue }
		$owner = Get-TemplateOwner $rel
		$action = 'write'
		if ($owner -eq 'learner') { $action = if (& $Exists (Join-Rel $Workspace $rel)) { 'keep' } else { 'create' } }
		$plan += @{ Rel = $rel; Owner = $owner; Action = $action }
	}
	return $plan
}

function Test-SameFileContent {
	param([string]$A, [string]$B)
	try { return ((Get-FileHash -LiteralPath $A -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $B -Algorithm SHA256).Hash) } catch { return $false }
}

function Copy-WorkspaceTemplate {
	# Шаг 7 установщика и обновление. Файлы агента перезаписываются (одинаковые не трогаем,
	# чтобы повторный запуск был «актуальна»), файлы ученика только досоздаются (см. Get-MmLearnerDirs).
	# Возвращает @{ Status; Mentor; Created; Kept }.
	param([string]$Template, [string]$Workspace)
	$fresh = -not (Test-Path -LiteralPath $Workspace)
	$plan = @(Get-WorkspaceTemplatePlan -Template $Template -Workspace $Workspace)
	$mentor = 0; $created = 0; $kept = 0
	New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
	foreach ($e in $plan) {
		$dest = Join-Rel $Workspace $e.Rel
		$src = Join-Rel $Template $e.Rel
		if ($e.Action -eq 'keep') { $kept++; continue }
		if ((Test-Path -LiteralPath $dest) -and (Test-SameFileContent $src $dest)) { continue }
		$dir = Split-Path -Parent $dest
		if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
		Copy-Item -LiteralPath $src -Destination $dest -Force
		if ($e.Action -eq 'create') { $created++ } else { $mentor++ }
	}
	$status = if ($fresh) { 'создана' } elseif ($mentor -gt 0 -or $created -gt 0) { 'обновлена' } else { 'актуальна' }
	return @{ Status = $status; Mentor = $mentor; Created = $created; Kept = $kept }
}

function Format-WorkspaceTemplateResult {
	# Одна строка для окна: что сделали с рабочей папкой.
	param($Result, [string]$Workspace)
	return ('{0}: {1} (файлов агента: {2}, новых файлов ученика: {3}, правок ученика сохранено: {4})' -f $Workspace, $Result.Status, $Result.Mentor, $Result.Created, $Result.Kept)
}

function Write-Launcher {
	# start_mentor.cmd: PATH с нашим node/npm и запуск pi. Только ASCII: пути берутся из переменных окружения.
	param([string]$Path)
	$p = Get-MmPaths
	$root = $p.Root
	$def = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'music_mentor' } else { '' }
	$envRoot = if ($root -ieq $def) { '%LOCALAPPDATA%\music_mentor' } else { $root }
	$text = "@echo off`r`nset `"PATH=$envRoot\node;$envRoot\npm;%PATH%`"`r`nrem pi version is pinned by the installer: no self-update banner`r`nset `"PI_SKIP_VERSION_CHECK=1`"`r`n`"$envRoot\npm\pi.cmd`" %*`r`n"
	[IO.File]::WriteAllText($Path, $text, (New-Object Text.ASCIIEncoding))
}

function New-MmShortcut {
	# WScript.Shell сохраняет файл через ANSI-страницу: в Windows с английской локалью кириллица в имени
	# превращается в «?». Поэтому .lnk сначала пишем под ASCII-именем во временной папке, потом переименовываем
	# (Move-Item работает в Юникоде). Остальные поля (путь, аргументы) — BSTR, Юникод сохраняется.
	param([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Description, [string]$Icon)
	$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mm_' + [guid]::NewGuid().ToString('N') + '.lnk')
	$sh = New-Object -ComObject WScript.Shell
	$lnk = $sh.CreateShortcut($tmp)
	$lnk.TargetPath = $Target
	if ($Arguments) { $lnk.Arguments = $Arguments }
	if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
	if ($Description) { $lnk.Description = $Description }
	if ($Icon) { $lnk.IconLocation = $Icon }
	$lnk.Save()
	Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-ShortcutSpecs {
	# Чистая функция: что за ярлыки и с какими аргументами. Тестируется на Linux.
	param($Paths, [string]$WtPath)
	$ps = 'powershell.exe'
	if ($env:SystemRoot) { $ps = Join-Rel $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
	$main = if ($WtPath) {
		@{ Target = $WtPath; Arguments = ('-d "{0}" "{1}"' -f $Paths.Workspace, $Paths.Launcher) }
	} else {
		@{ Target = $Paths.Launcher; Arguments = '' }
	}
	return @(
		@{ Name = 'Музыкальный агент'; Target = $main.Target; Arguments = $main.Arguments; WorkDir = $Paths.Workspace; Description = 'Открыть музыкального агента' }
		@{ Name = 'Сменить ключ DeepSeek'; Target = $ps; Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Paths.App 'change_key.ps1')); WorkDir = $Paths.Root; Description = 'Заменить ключ DeepSeek' }
		@{ Name = 'Обновить агента'; Target = $ps; Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Paths.App 'update.ps1')); WorkDir = $Paths.Root; Description = 'Обновить агента до последней версии' }
	)
}

function Get-LegacyShortcutNames {
	# Чистая функция: ярлыки, которые остались от прежних версий (T1909: «наставник» -> «агент»).
	# При установке и обновлении убираем их с рабочего стола, чтобы не было двух ярлыков на одно.
	return @('Музыкальный наставник', 'Обновить наставника')
}

function Remove-LegacyShortcuts {
	# Убирает старые ярлыки. Возвращает имена тех, что действительно были и удалились.
	param([string]$Desktop)
	$gone = @()
	foreach ($n in (Get-LegacyShortcutNames)) {
		$lnk = Join-Path $Desktop ($n + '.lnk')
		if (-not (Test-Path -LiteralPath $lnk)) { continue }
		Remove-Item -LiteralPath $lnk -Force
		$gone += $n
	}
	return $gone
}

function Write-MmShortcuts {
	# Установка и обновление: лаунчер, убрать старые имена, положить текущие ярлыки.
	# Возвращает строки для окна.
	param($Paths, [string]$WtPath)
	$lines = @()
	Write-Launcher $Paths.Launcher
	New-Item -ItemType Directory -Path $Paths.Desktop -Force | Out-Null
	foreach ($n in (Remove-LegacyShortcuts -Desktop $Paths.Desktop)) { $lines += "убрал старый ярлык: $n" }
	foreach ($s in (Get-ShortcutSpecs -Paths $Paths -WtPath $WtPath)) {
		$lnk = Join-Path $Paths.Desktop ($s.Name + '.lnk')
		New-MmShortcut -Path $lnk -Target $s.Target -Arguments $s.Arguments -WorkDir $s.WorkDir -Description $s.Description
		$lines += $s.Name
	}
	return $lines
}

function Get-GitExe {
	$c = Get-Command git -ErrorAction SilentlyContinue
	if ($c) { return $c.Source }
	foreach ($d in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' }))) {
		if (-not $d) { continue }
		$g = Join-Path $d 'Git\cmd\git.exe'
		if (Test-Path -LiteralPath $g) { return $g }
	}
	return $null
}

function Invoke-Git {
	# Вызов git с проверкой кода выхода. Вывод возвращается строками.
	param([string]$Dir, [string[]]$GitArgs)
	$git = Get-GitExe
	if (-not $git) { throw 'git не найден' }
	$a = @()
	if ($Dir) { $a += @('-C', $Dir) }
	$a += $GitArgs
	$old = $ErrorActionPreference
	$ErrorActionPreference = 'Continue'
	try { $out = & $git @a 2>&1 } finally { $ErrorActionPreference = $old }
	if ($LASTEXITCODE -ne 0) { throw ("git " + ($GitArgs -join ' ') + " -> код $LASTEXITCODE`: " + (($out | Out-String).Trim())) }
	return @($out | ForEach-Object { "$_" })
}

function Get-LatestStableTag {
	param([string]$Dir)
	$tags = @(Invoke-Git $Dir @('tag', '--list', 'v*'))
	$best = $null
	$bestV = $null
	foreach ($t in $tags) {
		if ($t -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { continue }
		$v = [version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])
		if (-not $bestV -or $v -gt $bestV) { $bestV = $v; $best = $t }
	}
	return $best
}

function Get-CurrentTag {
	param([string]$Dir)
	try { return (@(Invoke-Git $Dir @('describe', '--tags', '--exact-match', 'HEAD'))[0]) } catch { return $null }
}

function Update-MentorApp {
	# Обновление кода: fetch тегов -> checkout последнего стабильного тега. Возвращает @{ Changed; From; To }.
	# `pi install` и мост — на вызывающем (update.ps1).
	param([string]$AppDir)
	if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.git'))) { throw "в $AppDir нет репозитория агента" }
	$from = Get-CurrentTag $AppDir
	$null = Invoke-Git $AppDir @('fetch', '--tags', '--force', 'origin')
	$latest = Get-LatestStableTag $AppDir
	if (-not $latest) { return @{ Changed = $false; From = $from; To = $from; Note = 'на сервере нет стабильных версий' } }
	if ($from -eq $latest) { return @{ Changed = $false; From = $from; To = $latest; Note = 'уже последняя версия' } }
	$null = Invoke-Git $AppDir @('-c', 'advice.detachedHead=false', 'checkout', '--force', $latest)
	return @{ Changed = $true; From = $from; To = $latest; Note = '' }
}
