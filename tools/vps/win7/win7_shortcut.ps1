# Desktop shortcut for music_mentor on Windows 7 (PowerShell 2.0): an internet shortcut (.url) that opens the mentor's
# web terminal in the default browser. ASCII only: the Russian name is built from code points.
param([string]$Root = (Join-Path $env:LOCALAPPDATA 'music_mentor'))
$codes = 1052,1091,1079,1099,1082,1072,1083,1100,1085,1099,1081,32,1085,1072,1089,1090,1072,1074,1085,1080,1082
$name = -join ($codes | ForEach-Object { [char]$_ })
$desktop = [Environment]::GetFolderPath('Desktop')
$url = (Get-Content -LiteralPath (Join-Path $Root 'mentor_url.txt') | Select-Object -First 1).Trim()
if ($url -notmatch '^https://') { throw 'mentor_url.txt: no https address' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mm_' + [guid]::NewGuid().ToString('N') + '.url')
# .url is an ini file; the address is ASCII, so the ANSI code page does not matter
[IO.File]::WriteAllText($tmp, "[InternetShortcut]`r`nURL=$url`r`n", [Text.Encoding]::ASCII)
# save under an ASCII name, then rename (Move-Item is Unicode-safe)
Move-Item -LiteralPath $tmp -Destination (Join-Path $desktop ($name + '.url')) -Force
Write-Host ('    -> ' + $desktop)
