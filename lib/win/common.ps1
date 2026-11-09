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
	#   иначе -> <User Library>\Remote Scripts: путь из Library.cfg, если он локальный и существует,
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
	Write-Host '  Нужно разрешение администратора: сейчас появится окно Windows («Разрешить ли этому приложению внести изменения»). Нажми «Да».' -ForegroundColor Yellow
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
		if ($t.Why) { Write-Host "  ${label}: $($t.Why)." }
		if ($t.NeedsAdmin) {
			if ($NoElevate) { $lines += "${label}: нужен администратор (не запрашивал), мост не поставлен в $($t.Path)."; continue }
			$state = 'уже'
			$destDir = Join-Path $t.Path 'MentorBridge'
			if ((Test-Path -LiteralPath $destDir) -and ((Get-DirHash $BridgeSource) -eq (Get-DirHash $destDir))) {
				$state = 'уже'
			} else {
				Write-Host "  ${label}: $($t.Why)."
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

function Copy-WorkspaceTemplate {
	# Шаг 7: рабочая папка ученика. Уже есть — не трогаем. Возвращает 'уже' или 'создана'.
	param([string]$Template, [string]$Workspace)
	if (Test-Path -LiteralPath $Workspace) {
		$any = Get-ChildItem -LiteralPath $Workspace -Force -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($any) { return 'уже' }
	}
	if (-not (Test-Path -LiteralPath $Template)) { throw "нет шаблона рабочей папки: $Template" }
	New-Item -ItemType Directory -Path $Workspace -Force | Out-Null
	Copy-Item -Path (Join-Path $Template '*') -Destination $Workspace -Recurse -Force
	return 'создана'
}

function Write-Launcher {
	# start_mentor.cmd: PATH с нашим node/npm и запуск pi. Только ASCII: пути берутся из переменных окружения.
	param([string]$Path)
	$p = Get-MmPaths
	$root = $p.Root
	$def = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'music_mentor' } else { '' }
	$envRoot = if ($root -ieq $def) { '%LOCALAPPDATA%\music_mentor' } else { $root }
	$text = "@echo off`r`nset `"PATH=$envRoot\node;$envRoot\npm;%PATH%`"`r`n`"$envRoot\npm\pi.cmd`" %*`r`n"
	[IO.File]::WriteAllText($Path, $text, (New-Object Text.ASCIIEncoding))
}

function New-MmShortcut {
	param([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Description, [string]$Icon)
	$sh = New-Object -ComObject WScript.Shell
	$lnk = $sh.CreateShortcut($Path)
	$lnk.TargetPath = $Target
	if ($Arguments) { $lnk.Arguments = $Arguments }
	if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
	if ($Description) { $lnk.Description = $Description }
	if ($Icon) { $lnk.IconLocation = $Icon }
	$lnk.Save()
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
		@{ Name = 'Музыкальный наставник'; Target = $main.Target; Arguments = $main.Arguments; WorkDir = $Paths.Workspace; Description = 'Открыть наставника по музыке' }
		@{ Name = 'Сменить ключ DeepSeek'; Target = $ps; Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Paths.App 'change_key.ps1')); WorkDir = $Paths.Root; Description = 'Заменить ключ DeepSeek' }
		@{ Name = 'Обновить наставника'; Target = $ps; Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Paths.App 'update.ps1')); WorkDir = $Paths.Root; Description = 'Обновить наставника до последней версии' }
	)
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
	if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.git'))) { throw "в $AppDir нет репозитория наставника" }
	$from = Get-CurrentTag $AppDir
	$null = Invoke-Git $AppDir @('fetch', '--tags', '--force', 'origin')
	$latest = Get-LatestStableTag $AppDir
	if (-not $latest) { return @{ Changed = $false; From = $from; To = $from; Note = 'на сервере нет стабильных версий' } }
	if ($from -eq $latest) { return @{ Changed = $false; From = $from; To = $latest; Note = 'уже последняя версия' } }
	$null = Invoke-Git $AppDir @('-c', 'advice.detachedHead=false', 'checkout', '--force', $latest)
	return @{ Changed = $true; From = $from; To = $latest; Note = '' }
}
