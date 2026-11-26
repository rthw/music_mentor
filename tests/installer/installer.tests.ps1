# Проверки установщика на моках (pwsh на Linux/Windows). Печатает "ok: ..." по каждой и в конце "ALL OK n".
# Запуск: pwsh -NoProfile -File tests/installer/installer.tests.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..' -ErrorAction SilentlyContinue)).Path
if (-not $repo -or -not (Test-Path (Join-Path $repo 'install.ps1'))) { $repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$env:MM_NO_RUN = '1'
. (Join-Path $repo 'lib/win/common.ps1')
. (Join-Path $repo 'install.ps1')

$script:n = 0
function Check { param([string]$Name, [bool]$Cond, [string]$Info)
	$script:n++
	if (-not $Cond) { Write-Host "FAIL: $Name $Info"; throw "проверка не прошла: $Name" }
	Write-Host "ok: $Name"
}
function Norm { param([string]$p) return ($p -replace '\\', '/') }
function NewTmp { $d = Join-Path ([IO.Path]::GetTempPath()) ('mmt_' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $d | Out-Null; return $d }

# --- Library.cfg ---------------------------------------------------------------------------------
$cfg1 = '<?xml version="1.0" encoding="UTF-8"?><Ableton><ContentLibrary><UserLibrary><LibraryProject><ProjectPath Value="D:\Музыка\User Library" /></LibraryProject></UserLibrary></ContentLibrary></Ableton>'
Check 'Library.cfg: локальный путь с кириллицей' ((Get-LibraryPathFromText $cfg1) -eq 'D:\Музыка\User Library')
$cfg2 = '<Ableton><UserLibrary><Path Value="\\host.lan\Data\ableton" /></UserLibrary></Ableton>'
Check 'Library.cfg: UNC' ((Get-LibraryPathFromText $cfg2) -eq '\\host.lan\Data\ableton')
$cfg3 = '<Ableton><Something Value="false"/><Other Value="C:\Users\A &amp; B\UL"/></Ableton>'
Check 'Library.cfg: запасной разбор и &amp;' ((Get-LibraryPathFromText $cfg3) -eq 'C:\Users\A & B\UL')
Check 'Library.cfg: пути нет' ($null -eq (Get-LibraryPathFromText '<Ableton><X Value="1"/></Ableton>'))
Check 'Library.cfg: пустая строка' ($null -eq (Get-LibraryPathFromText ''))
$tmp = NewTmp
$cfgFile = Join-Path $tmp 'Library.cfg'
[IO.File]::WriteAllText($cfgFile, $cfg1, (New-Object Text.UTF8Encoding $true))
Check 'Library.cfg: файл с BOM' ((Read-LibraryCfg $cfgFile) -eq 'D:\Музыка\User Library')
Check 'Library.cfg: файла нет' ($null -eq (Read-LibraryCfg (Join-Path $tmp 'нет.cfg')))

# --- выбор пути моста ---------------------------------------------------------------------------------
$exists = { param($p) $true }
$missing = { param($p) $false }
function Inst { param([int]$Major, $Ver, $Pd) [pscustomobject]@{ Major = $Major; Version = $Ver; ProgramDataDir = $Pd; SettingsDir = $null; Name = "Live $Major" } }
$pd12 = 'C:\ProgramData\Ableton\Live 12 Suite'
$t = Resolve-BridgeTarget -Install (Inst 12 ([version]'12.0.1') $pd12) -LibraryPath 'D:\UL' -Documents 'C:\Users\a\Documents' -Exists $exists
Check 'мост: Live 12, локальный User Library из cfg' ($t.Kind -eq 'UserLibrary' -and (Norm $t.Path) -eq 'D:/UL/Remote Scripts' -and -not $t.NeedsAdmin) $t.Path
$t = Resolve-BridgeTarget -Install (Inst 12 ([version]'12.0.1') $pd12) -LibraryPath '\\host.lan\Data\ableton' -Documents 'C:\Users\a\Documents' -Exists $exists
Check 'мост: Live 12, UNC -> Documents' ((Norm $t.Path) -eq 'C:\Users\a\Documents/Ableton/User Library/Remote Scripts'.Replace('\', '/') -and $t.Why -match 'сетевой') $t.Path
$t = Resolve-BridgeTarget -Install (Inst 11 ([version]'11.3.2') $null) -LibraryPath 'D:\UL' -Documents 'C:\Users\a\Documents' -Exists $missing
Check 'мост: Live 11, путь из cfg не существует -> Documents' ((Norm $t.Path) -like '*Documents/Ableton/User Library/Remote Scripts') $t.Path
$t = Resolve-BridgeTarget -Install (Inst 11 ([version]'11.3.2') $null) -LibraryPath $null -Documents 'C:\Users\a\Documents' -Exists $exists
Check 'мост: нет Library.cfg -> Documents' ((Norm $t.Path) -like '*Documents/Ableton/User Library/Remote Scripts' -and -not $t.Why) $t.Path
$t = Resolve-BridgeTarget -Install (Inst 10 ([version]'10.1.13') $null) -LibraryPath $null -Documents 'C:\Users\a\Documents' -Exists $exists
Check 'мост: Live 10.1.13 -> User Library, без админа' ($t.Kind -eq 'UserLibrary' -and -not $t.NeedsAdmin)
$t = Resolve-BridgeTarget -Install (Inst 10 ([version]'10.1.9') 'C:\ProgramData\Ableton\Live 10 Suite') -LibraryPath $null -Documents 'D' -Exists $exists
Check 'мост: Live 10.1.9 -> Resources + UAC' ($t.Kind -eq 'Resources' -and $t.NeedsAdmin -and (Norm $t.Path) -like '*Live 10 Suite/Resources/MIDI Remote Scripts') $t.Path
$t = Resolve-BridgeTarget -Install (Inst 10 $null 'C:\ProgramData\Ableton\Live 10 Lite') -LibraryPath $null -Documents 'D' -Exists $exists
Check 'мост: Live 10 неизвестной версии -> Resources + UAC' ($t.Kind -eq 'Resources' -and $t.NeedsAdmin)
$t = Resolve-BridgeTarget -Install (Inst 10 ([version]'10.0.6') $null) -LibraryPath $null -Documents 'D' -Exists $exists
Check 'мост: старый Live 10 без папки программы -> пропуск с причиной' (-not $t.Supported -and $t.Reason)
$t = Resolve-BridgeTarget -Install (Inst 9 ([version]'9.7.7') $null) -LibraryPath $null -Documents 'D' -Exists $exists
Check 'мост: Live 9 не поддерживается' (-not $t.Supported)
Check 'версия из имени папки' ((ConvertTo-LiveVersion 'Live 10.1.18') -eq [version]'10.1.18' -and (ConvertTo-LiveVersion 'Live 12.0') -eq [version]'12.0.0' -and $null -eq (ConvertTo-LiveVersion 'Crash'))

# --- поиск Live и идемпотентная установка моста -------------------------------------------------------
$pdata = Join-Path $tmp 'ProgramData'
$appd = Join-Path $tmp 'AppData'
$docs = Join-Path $tmp 'Documents'
New-Item -ItemType Directory -Force -Path (Join-Path $pdata 'Ableton/Live 12 Suite'), (Join-Path $pdata 'Ableton/Live 10 Standard'), (Join-Path $appd 'Ableton/Live 12.0.1/Preferences'), (Join-Path $appd 'Ableton/Live 12.0.5/Preferences'), (Join-Path $appd 'Ableton/Live 10.1.18/Preferences'), $docs | Out-Null
$installs = @(Get-LiveInstalls -ProgramData $pdata -AppData $appd)
Check 'поиск Live: две установки, старшая версия настроек' ($installs.Count -eq 2 -and $installs[1].Major -eq 12 -and $installs[1].Version -eq [version]'12.0.5' -and $installs[0].Version -eq [version]'10.1.18')
$src = Join-Path $tmp 'src/MentorBridge'
New-Item -ItemType Directory -Force -Path $src | Out-Null
Set-Content -LiteralPath (Join-Path $src '__init__.py') -Value 'x = 1'
Set-Content -LiteralPath (Join-Path $src 'commands.py') -Value 'y = 2'
$out1 = @(Install-Bridge -BridgeSource $src -ProgramData $pdata -AppData $appd -Documents $docs -NoElevate:$false 6>$null)
$ul = Join-Rel $docs 'Ableton/User Library/Remote Scripts/MentorBridge'
Check 'мост: установлен в User Library (Live 10.1.18 и 12 — одно место)' ((Test-Path (Join-Path $ul '__init__.py')) -and $out1.Count -eq 2 -and ($out1 -join '|') -match 'установлен' -and ($out1 -join '|') -match 'уже поставлен') ($out1 -join '|')
$out2 = @(Install-Bridge -BridgeSource $src -ProgramData $pdata -AppData $appd -Documents $docs 6>$null)
Check 'мост: повтор — «уже»' (($out2 -join '|') -match 'мост уже' -and ($out2 -join '|') -notmatch 'установлен') ($out2 -join '|')
Set-Content -LiteralPath (Join-Path $src 'commands.py') -Value 'y = 3'
$out3 = @(Install-Bridge -BridgeSource $src -ProgramData $pdata -AppData $appd -Documents $docs 6>$null)
Check 'мост: изменённый исходник — «обновлён»' (($out3 -join '|') -match 'обновлён' -and (Get-Content (Join-Path $ul 'commands.py')) -eq 'y = 3') ($out3 -join '|')
$none = @(Install-Bridge -BridgeSource $src -ProgramData (Join-Path $tmp 'нет') -AppData (Join-Path $tmp 'нет') -Documents $docs 6>$null)
Check 'мост: Live не найден — одна строка' ($none.Count -eq 1 -and $none[0] -match 'не найден')

# Live 10 старше 10.1.13 без -NoElevate потребовал бы UAC; здесь проверяем только «не запрашивал».
$pd10 = Join-Path $tmp 'pd10'; $ap10 = Join-Path $tmp 'ap10'
New-Item -ItemType Directory -Force -Path (Join-Path $pd10 'Ableton/Live 10 Suite'), (Join-Path $ap10 'Ableton/Live 10.1.5/Preferences') | Out-Null
$o10 = @(Install-Bridge -BridgeSource $src -ProgramData $pd10 -AppData $ap10 -Documents $docs -NoElevate 6>$null)
Check 'мост: Live 10.1.5 — нужен администратор' (($o10 -join '|') -match 'нужен администратор')

# --- рабочая папка: чьи файлы и что делает обновление -------------------------------------------------------
# Правило в одном месте: learner\ и notes\ — ученика (только создаются), остальное из template\ —
# наставника (перезаписывается). Обновление не должно терять правки ученика и не должно оставлять старую роль.
Check 'шаблон: AGENTS.md — наставника' ((Get-TemplateOwner 'AGENTS.md') -eq 'mentor')
Check 'шаблон: learner/profile.md — ученика' ((Get-TemplateOwner 'learner/profile.md') -eq 'learner')
Check 'шаблон: notes/x.md — ученика' ((Get-TemplateOwner (Join-Path 'notes' 'идея.md')) -eq 'learner')
Check 'шаблон: будущие скиллы — наставника' ((Get-TemplateOwner 'skills/mentor/SKILL.md') -eq 'mentor')
$ws = Join-Path $tmp 'Documents/music_mentor'
$tpl = Join-Path $tmp 'tpl1'
Copy-Item -LiteralPath (Join-Path $repo 'template') -Destination $tpl -Recurse
$r1 = Copy-WorkspaceTemplate -Template $tpl -Workspace $ws
Check 'рабочая папка: создана целиком' ($r1.Status -eq 'создана' -and (Test-Path (Join-Path $ws 'AGENTS.md')) -and (Test-Path (Join-Path $ws 'learner/profile.md')) -and (Test-Path (Join-Path $ws 'notes/README.md')) -and $r1.Created -ge 2) ($r1 | Out-String)
# Ученик правит профиль, пишет свою заметку и заводит свой файл.
Set-Content -LiteralPath (Join-Path $ws 'learner/profile.md') -Value 'мой профиль'
Set-Content -LiteralPath (Join-Path $ws 'notes/идея.md') -Value 'моя идея'
# Вышел новый шаблон: другая роль и новый файл наставника.
$tpl2 = Join-Path $tmp 'tpl2'
Copy-Item -LiteralPath $tpl -Destination $tpl2 -Recurse
Set-Content -LiteralPath (Join-Path $tpl2 'AGENTS.md') -Value 'новый AGENTS.md'
New-Item -ItemType Directory -Path (Join-Path $tpl2 'skills/mentor') -Force | Out-Null
Set-Content -LiteralPath (Join-Path $tpl2 'skills/mentor/SKILL.md') -Value 'роль наставника'
$r2 = Copy-WorkspaceTemplate -Template $tpl2 -Workspace $ws
Check 'обновление: файл наставника перезаписан' (((Get-Content -Raw (Join-Path $ws 'AGENTS.md')).Trim()) -eq 'новый AGENTS.md')
Check 'обновление: новый файл наставника появился' ((Get-Content -Raw (Join-Path $ws 'skills/mentor/SKILL.md')).Trim() -eq 'роль наставника')
Check 'обновление: правка ученика в learner/profile.md цела' (((Get-Content -Raw (Join-Path $ws 'learner/profile.md')).Trim()) -eq 'мой профиль')
Check 'обновление: новый файл ученика не удалён' (((Get-Content -Raw (Join-Path $ws 'notes/идея.md')).Trim()) -eq 'моя идея')
Check 'обновление: статус и счётчики' ($r2.Status -eq 'обновлена' -and $r2.Mentor -ge 2 -and $r2.Kept -ge 2) ($r2 | Out-String)
$r3 = Copy-WorkspaceTemplate -Template $tpl2 -Workspace $ws
Check 'обновление: повтор — «актуальна», правки целы' ($r3.Status -eq 'актуальна' -and ((Get-Content -Raw (Join-Path $ws 'learner/profile.md')).Trim()) -eq 'мой профиль')
Check 'обновление: строка для окна' ((Format-WorkspaceTemplateResult -Result $r3 -Workspace $ws) -match 'актуальна')
$plan = @(Get-WorkspaceTemplatePlan -Template $tpl2 -Workspace $ws)
Check 'план: у файлов наставника write, у ученика keep' ((@($plan | Where-Object { $_.Owner -eq 'mentor' -and $_.Action -ne 'write' }).Count -eq 0) -and (@($plan | Where-Object { $_.Owner -eq 'learner' -and $_.Action -ne 'keep' }).Count -eq 0))

# --- настройки pi и ключ ------------------------------------------------------------------------------------
$st = Join-Path $tmp 'agent/settings.json'
New-Item -ItemType Directory -Force -Path (Split-Path $st) | Out-Null
[IO.File]::WriteAllText($st, '{"packages":["../x/music_mentor"],"theme":"dark"}')
Set-PiSettings -Path $st -ShellPath $null
$j = Get-Content -Raw $st | ConvertFrom-Json
Check 'settings: наши поля и чужие сохранены' ($j.defaultProvider -eq 'deepseek' -and $j.defaultModel -eq 'deepseek-v4-pro' -and $j.quietStartup -eq $true -and $j.theme -eq 'dark' -and @($j.packages).Count -eq 1 -and @($j.enabledModels).Count -eq 2)
$before = Get-Content -Raw $st
Set-PiSettings -Path $st -ShellPath $null
Check 'settings: идемпотентно' ((Get-Content -Raw $st) -eq $before)
Set-PiSettings -Path $st -ShellPath 'C:\Users\a\AppData\Local\Programs\Git\bin\bash.exe'
Check 'settings: shellPath' ((Get-Content -Raw $st | ConvertFrom-Json).shellPath -like '*bash.exe')
$bytes = [IO.File]::ReadAllBytes($st)
Check 'settings: без BOM' (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB))
$au = Join-Path $tmp 'agent/auth.json'
$fake = 'sk-TESTKEY' + 'abcdef0123456789'
[IO.File]::WriteAllText($au, '{"anthropic":{"type":"api' + '_key","key":"zzz"}}')
Set-DeepSeekAuth -Path $au -Key $fake
$a = Get-Content -Raw $au | ConvertFrom-Json
Check 'auth.json: deepseek записан, чужой провайдер цел' ($a.deepseek.type -eq ('api' + '_key') -and $a.deepseek.key -eq $fake -and $a.anthropic.key -eq 'zzz')
Check 'auth.json: чтение ключа' ((Get-DeepSeekAuthKey $au) -eq $fake)
Check 'Test-DeepSeekKey: пустой ключ' (-not (Test-DeepSeekKey '').Ok)

# --- ярлыки ---------------------------------------------------------------------------------------------------
$env:MM_ROOT = Join-Path $tmp 'root'; $env:MM_DOCUMENTS = $docs; $env:MM_DESKTOP = Join-Path $tmp 'Desktop'
$P = Get-MmPaths
$sp = @(Get-ShortcutSpecs -Paths $P -WtPath 'C:\wt.exe')
Check 'ярлыки: три нужных имени' ($sp.Count -eq 3 -and $sp[0].Name -eq 'Музыкальный наставник' -and $sp[1].Name -eq 'Сменить ключ DeepSeek' -and $sp[2].Name -eq 'Обновить наставника')
Check 'ярлыки: wt -d <папка> <лаунчер>' ($sp[0].Target -eq 'C:\wt.exe' -and $sp[0].Arguments -like '-d "*music_mentor" "*start_mentor.cmd"')
Check 'ярлыки: без wt — лаунчер напрямую' ((@(Get-ShortcutSpecs -Paths $P -WtPath $null))[0].Target -like '*start_mentor.cmd')
Check 'ярлыки: change_key и update через -File' ($sp[1].Arguments -like '*change_key.ps1"' -and $sp[2].Arguments -like '*update.ps1"')
Write-Launcher (Join-Path $tmp 'l.cmd')
Check 'лаунчер: ASCII, зовёт pi.cmd' ((Get-Content -Raw (Join-Path $tmp 'l.cmd')) -match 'pi\.cmd' -and -not ((Get-Content -Raw (Join-Path $tmp 'l.cmd')) -match '[^\x00-\x7F]'))

# --- обновление по тегам --------------------------------------------------------------------------------------------
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
	$origin = Join-Path $tmp 'origin'
	New-Item -ItemType Directory -Path $origin | Out-Null
	function G { param([string]$Dir, [string[]]$A) & git -C $Dir -c user.name=t -c user.email=t@t @A 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $A -> $LASTEXITCODE" } }
	G $origin @('init', '-q', '-b', 'main')
	Set-Content (Join-Path $origin 'v.txt') 'one'; G $origin @('add', '-A'); G $origin @('commit', '-q', '-m', 'one'); G $origin @('tag', 'v0.1.0')
	$app = Join-Path $tmp 'app'
	& git -c advice.detachedHead=false clone -q --branch v0.1.0 $origin $app 2>&1 | Out-Null
	Set-Content (Join-Path $origin 'v.txt') 'two'; G $origin @('commit', '-q', '-am', 'two'); G $origin @('tag', 'v0.2.0')
	Set-Content (Join-Path $origin 'v.txt') 'rc'; G $origin @('commit', '-q', '-am', 'rc'); G $origin @('tag', 'v0.10.0-rc.1')
	Check 'обновление: текущий тег' ((Get-CurrentTag $app) -eq 'v0.1.0')
	$r = Update-MentorApp -AppDir $app
	Check 'обновление: v0.1.0 -> v0.2.0, rc игнорируется' ($r.Changed -and $r.To -eq 'v0.2.0' -and (Get-Content (Join-Path $app 'v.txt')) -eq 'two') ($r | Out-String)
	$r = Update-MentorApp -AppDir $app
	Check 'обновление: повтор ничего не меняет' (-not $r.Changed -and $r.Note -match 'последняя')
	Set-Content (Join-Path $origin 'v.txt') 'ten'; G $origin @('commit', '-q', '-am', 'ten'); G $origin @('tag', 'v0.10.0')
	$r = Update-MentorApp -AppDir $app
	Check 'обновление: v0.10.0 новее v0.2.0 (числовое сравнение)' ($r.Changed -and $r.To -eq 'v0.10.0')
	$threw = $false
	try { Update-MentorApp -AppDir (Join-Path $tmp 'нет') | Out-Null } catch { $threw = $true }
	Check 'обновление: нет репозитория — исключение, не молчание' $threw
} else { Write-Host 'skip: git не найден, проверки обновления пропущены' }

# --- журнал -----------------------------------------------------------------------------------------------------------
$logRoot = Join-Path $tmp 'logroot'
$logPath = Start-MmLog -Script 'install' -Root $logRoot
Check 'журнал: файл <скрипт>_<дата-время>.log создан' ((Test-Path -LiteralPath $logPath) -and ((Split-Path -Leaf $logPath) -match '^install_\d{4}-\d{2}-\d{2}_\d{6}\.log$')) $logPath
Write-MmHost 'строка, которую видно в окне'
Check 'журнал: текст из окна попал в файл' ((Get-Content -Raw $logPath) -match 'строка, которую видно в окне')
$fakeKey = 'sk-' + 'LOGTESTfakekey0123456789'
Write-MmLog ('ключ: ' + $fakeKey)
Write-MmHost ('Authorization: Bearer ' + $fakeKey)
$logText = Get-Content -Raw $logPath
Check 'журнал: ключа в файле нет' (-not $logText.Contains($fakeKey) -and $logText -notmatch 'LOGTESTfakekey')
Check 'журнал: маска sk-… и Bearer' ((ConvertTo-MmLogSafe ('sk-' + 'abcdefabcdefabcdef')) -eq 'sk-***')
Check 'журнал: подсказка другому с путём и «пришли этот файл»' ((Get-MmLogHint) -match [regex]::Escape($logPath) -and (Get-MmLogHint) -match 'пришли этот файл' -and (Get-MmLogHint) -match 'буфере обмена')
Check 'журнал: каталог в root\logs' ((Get-MmLogsDir $logRoot) -eq (Join-Path $logRoot 'logs'))
$logDir = Get-MmLogsDir $logRoot
foreach ($i in 1..12) {
	$f = Join-Path $logDir ('old_{0:D2}.log' -f $i)
	Set-Content -LiteralPath $f -Value 'x'
	(Get-Item $f).LastWriteTime = (Get-Date).AddMinutes(-$i)
}
$newLog = Start-MmLog -Script 'update' -Root $logRoot
$left = @(Get-ChildItem -LiteralPath $logDir -File -Filter '*.log')
Check 'журнал: ротация — не больше 10 файлов' ($left.Count -le 10 -and (Test-Path -LiteralPath $newLog)) ("осталось " + $left.Count)

# --- версии из одного файла -------------------------------------------------------------------------------------------
$manifest = Read-MmVersions $repo
Check 'versions.json: читается с диска' ($manifest.Tag -match '^v\d+\.\d+\.\d+$' -and $manifest.Pi -match '^\d+\.\d+\.\d+$' -and $manifest.Node -match '^\d+\.\d+\.\d+$') ($manifest | Out-String)
Check 'versions.json: тег совпадает с bootstrap-тегом install.ps1' ($manifest.Tag -eq $MmTag) ("$($manifest.Tag) vs $MmTag")
Check 'pi: версия совпала — «уже»' ((Get-MmPiPlan -Have $manifest.Pi -Want $manifest.Pi) -eq 'уже')
Check 'pi: версия отличается — «ставить»' ((Get-MmPiPlan -Have '1.4.9' -Want $manifest.Pi) -eq 'ставить')
Check 'pi: не установлен — «ставить»' ((Get-MmPiPlan -Have '' -Want $manifest.Pi) -eq 'ставить')
Check 'node: старше минимума — «ставить»' ((Get-MmNodePlan -Have '22.18.0' -Min $manifest.Node) -eq 'ставить')
Check 'node: новее минимума — «уже»' ((Get-MmNodePlan -Have '24.1.0' -Min $manifest.Node) -eq 'уже' -and (Get-MmNodePlan -Have $manifest.Node -Min $manifest.Node) -eq 'уже')
Check 'node: не установлен — «ставить»' ((Get-MmNodePlan -Have $null -Min $manifest.Node) -eq 'ставить')
$piCmdLine = Get-PiInstallCmdLine -NpmPath 'C:\node\npm.cmd' -Prefix 'C:\root\npm' -Version $manifest.Pi
Check 'команда pi: версия из versions.json, --ignore-scripts, свой prefix' ($piCmdLine -match ('@earendil-works/pi-coding-agent@' + [regex]::Escape($manifest.Pi)) -and $piCmdLine -match '--ignore-scripts' -and $piCmdLine -match 'C:\\root\\npm') $piCmdLine
$badThrew = $false
try { ConvertFrom-MmVersions '{"pi":"1.0.0"}' | Out-Null } catch { $badThrew = $true }
Check 'versions.json: без tag — исключение, не тишина' $badThrew
$envVersions = Join-Path $tmp 'versions.json'
[IO.File]::WriteAllText($envVersions, '{"tag":"v9.9.9","pi":"2.0.0","node":"24.0.0"}')
$script:MmVersions = $null
$env:MM_VERSIONS_FILE = $envVersions
$v2 = Get-BootVersions
Check 'versions.json: bootstrap-чтение по MM_VERSIONS_FILE' ($v2.Tag -eq 'v9.9.9' -and $v2.Pi -eq '2.0.0')
$instSrc = Get-Content -Raw (Join-Path $repo 'install.ps1')
Check 'install.ps1: версия pi не зашита константой, берётся из versions.json' (-not ($instSrc -match 'MmPiVersion\s*=') -and $instSrc -match 'Ensure-MmPiRuntime')
Remove-Item Env:\MM_VERSIONS_FILE -ErrorAction SilentlyContinue
$script:MmVersions = $null

# --- шаги: сообщение при ошибке --------------------------------------------------------------------------------------
$env:MM_FAIL_STEP = '2'
$msg = (& { $null = Invoke-Step 2 'Git' { 'не выполнится' } } *>&1 | Out-String)
Check 'шаг: искусственная ошибка даёт «Шаг 2 (Git) не получился» и путь к журналу' ($msg -match 'Шаг 2 \(Git\) не получился' -and $msg -match 'Журнал:')
Check 'шаг: ошибка записана в список' ($script:MmFailed -contains '2 (Git)')
$env:MM_FAIL_STEP = ''
$script:MmFailed = @()
$res = Invoke-Step 3 'pi' { throw 'настоящая ошибка' } 6>$null
Check 'шаг: исключение внутри шага не вылетает наружу' ($res -eq $false -and $script:MmFailed.Count -eq 1)
$res = Invoke-Step 4 'код' { 'всё хорошо' } 6>$null
Check 'шаг: успешный шаг возвращает true' ($res -eq $true)

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "ALL OK $script:n"
