@echo off
REM convert-drop.cmd - Chronosplat drag-and-drop entry point.
REM
REM Drop a FOLDER of .ply frames onto this file in Explorer. It converts the
REM sequence to per-frame SOG in <repo>\data using sensible defaults, then
REM leaves the window open so the summary stays readable.
REM
REM For anything beyond the defaults (decimation, SH reduction, quality,
REM dry-run) use the full CLI:  py tools\convert.py --help

setlocal

set "HERE=%~dp0"
set "REPO=%HERE%.."

if "%~1"=="" (
  echo.
  echo   Chronosplat sequence converter
  echo   -----------------------------
  echo   Drag a FOLDER containing .ply frames onto this file.
  echo.
  echo   Or run the full CLI for all options:
  echo       py "%HERE%convert.py" --help
  echo.
  pause
  exit /b 1
)

if not exist "%~1\" (
  echo.
  echo   ERROR: "%~1" is not a folder.
  echo   Drop the FOLDER that contains the .ply frames, not a single file.
  echo.
  pause
  exit /b 1
)

REM Locate a Python interpreter: the py launcher first, then python on PATH.
set "PY="
where py >nul 2>&1 && set "PY=py"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo.
  echo   ERROR: Python was not found on PATH.
  echo   Install Python 3.10+ from https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo.
echo   Converting: %~1
echo   Output:     %REPO%\data
echo.
echo   Using defaults: --source-fps 24, --sh-degree auto, --quality high, GPU encode.
echo   Press Ctrl+C now to cancel.
echo.

%PY% "%HERE%convert.py" --input "%~1" --output "%REPO%\data" --source-fps 24 --gpu 0 --force --project "%~n1"

echo.
echo   Done. Review the summary above before committing data\ to git.
echo.
pause
endlocal
