@echo off
setlocal EnableExtensions
rem music_mentor (Win7) installer. Safe to run again. No admin rights needed, except the one-time
rem Windows component (UCRT) which asks for the usual "Yes" window. ASCII only (legacy cmd code page).
set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\music_mentor"

echo.
echo === Music mentor: installation ===
echo.
if not exist "%SRC%putty.exe" goto notunpacked
if not exist "%SRC%Muzykalnyj nastavnik.cmd" goto notunpacked
if not exist "%SRC%MentorBridge\__init__.py" goto notunpacked

echo [1/4] Copying programs to %DEST%
if not exist "%DEST%" mkdir "%DEST%"
copy /y "%SRC%putty.exe" "%DEST%\" >nul || goto fail
copy /y "%SRC%Muzykalnyj nastavnik.cmd" "%DEST%\start_mentor.cmd" >nul || goto fail
copy /y "%SRC%README.txt" "%DEST%\" >nul
copy /y "%SRC%win7_shortcut.ps1" "%DEST%\" >nul
for %%F in ("%SRC%*.ppk") do copy /y "%%F" "%DEST%\" >nul || goto fail

echo [2/4] Copying the Ableton Live bridge (MentorBridge)
set "DOCS="
for /f "usebackq delims=" %%D in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "[Environment]::GetFolderPath('MyDocuments')" 2^>nul`) do set "DOCS=%%D"
if not defined DOCS set "DOCS=%USERPROFILE%\Documents"
set "RS=%DOCS%\Ableton\User Library\Remote Scripts"
if not exist "%RS%" mkdir "%RS%"
if exist "%RS%\MentorBridge" rmdir /s /q "%RS%\MentorBridge"
xcopy "%SRC%MentorBridge" "%RS%\MentorBridge\" /e /i /y /q >nul || goto fail
echo     -> %RS%\MentorBridge

echo [3/4] Checking the Windows component Live 10 needs (UCRT)
if exist "%SystemRoot%\System32\ucrtbase.dll" goto ucrt_ok
if not exist "%SRC%vc_redist.x64.exe" goto ucrt_missing
echo     installing - Windows will ask permission, press Yes
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%SRC%vc_redist.x64.exe' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
set "RC=%ERRORLEVEL%"
if "%RC%"=="3010" goto ucrt_reboot
if not "%RC%"=="0" goto ucrt_failed
echo     installed
goto ucrt_done
:ucrt_ok
echo     already present
goto ucrt_done
:ucrt_reboot
echo     installed. Restart the computer once before starting Ableton Live.
goto ucrt_done
:ucrt_missing
echo     ucrtbase.dll is missing and vc_redist.x64.exe is not in the folder.
goto fail
:ucrt_failed
echo     the component installer returned code %RC%
goto fail
:ucrt_done

echo [4/4] Desktop shortcut
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\win7_shortcut.ps1" -Root "%DEST%" || goto fail

echo.
echo === Done ===
echo.
echo Last step, once, in Ableton Live 10:
echo   Options - Preferences - Link MIDI - Control Surface: choose "MentorBridge"
echo   (Input and Output may stay "None"). Restart Live if MentorBridge is not in the list.
echo Then start the mentor with the "Muzykalnyj nastavnik" shortcut on the Desktop.
echo (Details in Russian: %DEST%\README.txt)
echo.
pause
endlocal
exit /b 0

:notunpacked
echo.
echo Unpack the whole zip into a folder first (right click - Extract all),
echo then run install_win7.cmd from that folder.
echo.
pause
endlocal
exit /b 1

:fail
echo.
echo Installation stopped. Write to the author and say at which step [1/4..4/4] it stopped.
echo.
pause
endlocal
exit /b 1
