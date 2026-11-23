@echo off
rem Claude Code Discord Presence - Windows installer.
rem Double-click this file (Windows may ask "More info" - "Run anyway" for downloaded files).
rem Needs Node.js 18+ (https://nodejs.org). Installs into %USERPROFILE%\.claude\discord-presence.
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
echo Claude Code Discord Presence - installer for Windows
echo.

set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and run this installer again.
  if not defined CDP_NO_PAUSE start "" "https://nodejs.org/en/download"
  goto :fail
)
"%NODE%" -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 18 or newer is needed - https://nodejs.org
  goto :fail
)
rem "call" keeps cmd from stripping the quotes of a quoted program path inside for /f
for /f "delims=" %%V in ('call "%NODE%" -v') do echo Node.js: %NODE% (%%V)

set "CFGDIR=%CDP_INSTALL_DIR%"
if not defined CFGDIR set "CFGDIR=%USERPROFILE%\.claude\discord-presence"
set "SAVED="
for /f "delims=" %%A in ('call "%NODE%" -e "try{process.stdout.write(String(require(process.argv[1]).applicationId||''))}catch{}" "%CFGDIR%\config.json" 2^>nul') do set "SAVED=%%A"
echo.
echo Discord Application ID - Developer Portal, your application, General Information.
if defined SAVED echo Press Enter to keep the saved one (%SAVED%).

set /a TRIES=0
:ask
set /a TRIES+=1
set "APPID="
set /p "APPID=Application ID: "
if not defined APPID if defined SAVED set "APPID=%SAVED%"
if not defined APPID goto :bad
"%NODE%" -e "process.exit(/^\d{15,22}$/.test(process.argv[1].trim()) ? 0 : 1)" "%APPID%"
if not errorlevel 1 goto :install
:bad
echo That does not look like an Application ID (a 17-20 digit number).
if %TRIES% lss 3 goto :ask
echo No valid Application ID - nothing was installed.
goto :fail

:install
echo.
"%NODE%" install.js --app-id "%APPID%"
if errorlevel 1 (
  echo.
  echo Installation failed - see the messages above.
  goto :fail
)
echo.
set "AUTO="
set /p "AUTO=Start automatically at sign-in? [y/N] "
if /i "%AUTO:~0,1%"=="y" "%NODE%" "%CFGDIR%\cli.js" autostart on
if /i "%AUTO:~0,1%"=="t" "%NODE%" "%CFGDIR%\cli.js" autostart on
echo.
echo Done. Restart Claude Code - the activity appears on Discord.
echo Diagnostics: node "%CFGDIR%\cli.js" status
if not defined CDP_NO_PAUSE pause
exit /b 0

:fail
if not defined CDP_NO_PAUSE pause
exit /b 1
