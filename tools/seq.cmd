@echo off
REM seq.cmd - Chronosplat short wrapper for the common conversion.
REM
REM   tools\seq.cmd capyFall                  convert raw_data\capyFall -> data\capyFall
REM   tools\seq.cmd capyFall --dry-run        plan only, convert nothing
REM   tools\seq.cmd capyFall --frame-step 2   any convert.py flag passes through
REM
REM Defaults applied: --source-fps 24 --gpu 0 --force, and --project set from
REM the folder name. Override any of them by passing the flag yourself; the
REM later value wins, so `tools\seq.cmd x --source-fps 30` works.
REM
REM Everything this does by hand:
REM   py tools\convert.py --input raw_data\<name> --output data\<name> ^
REM       --source-fps 24 --gpu 0 --force --project "<name>"

setlocal

if "%~1"=="" (
  echo.
  echo   usage: tools\seq.cmd ^<name^> [extra convert.py flags]
  echo.
  echo   ^<name^> is a folder under raw_data\, converted into data\^<name^>.
  echo.
  echo   examples:
  echo       tools\seq.cmd capyFall
  echo       tools\seq.cmd capyFall --dry-run
  echo       tools\seq.cmd capyFall --frame-step 2
  echo.
  echo   available in raw_data\:
  for /d %%D in ("%~dp0..\raw_data\*") do echo       %%~nxD
  echo.
  exit /b 1
)

set "NAME=%~1"
set "HERE=%~dp0"
set "REPO=%HERE%.."

if not exist "%REPO%\raw_data\%NAME%\" (
  echo.
  echo   ERROR: raw_data\%NAME% does not exist.
  echo.
  echo   available in raw_data\:
  for /d %%D in ("%REPO%\raw_data\*") do echo       %%~nxD
  echo.
  exit /b 1
)

set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY (
  echo   ERROR: Python not found on PATH.
  exit /b 1
)

REM Shift past the name so the rest forwards to convert.py verbatim.
shift
set "EXTRA="
:collect
if "%~1"=="" goto run
set "EXTRA=%EXTRA% %1"
shift
goto collect

:run
%PY% "%HERE%convert.py" --input "%REPO%\raw_data\%NAME%" --output "%REPO%\data\%NAME%" --source-fps 24 --gpu 0 --force --project "%NAME%"%EXTRA%
exit /b %ERRORLEVEL%
