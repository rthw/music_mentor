# Desktop shortcut for music_mentor on Windows 7 (PowerShell 2.0). ASCII only: the Russian name is built from code points.
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'music_mentor'))
$codes = 1052,1091,1079,1099,1082,1072,1083,1100,1085,1099,1081,32,1085,1072,1089,1090,1072,1074,1085,1080,1082
$name = -join ($codes | ForEach-Object { [char]$_ })
$desktop = [Environment]::GetFolderPath('Desktop')
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mm_' + [guid]::NewGuid().ToString('N') + '.lnk')
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($tmp)
$lnk.TargetPath = (Join-Path $Root 'start_mentor.cmd')
$lnk.WorkingDirectory = $Root
$lnk.IconLocation = (Join-Path $Root 'putty.exe') + ',0'
$lnk.Save()
# WScript.Shell saves through the ANSI code page: save under an ASCII name, then rename (Move-Item is Unicode-safe).
Move-Item -LiteralPath $tmp -Destination (Join-Path $desktop ($name + '.lnk')) -Force
Write-Host ('    -> ' + $desktop)
