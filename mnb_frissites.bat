@echo off
pushd "%~dp0"

:: PowerShell indítása, az útvonalat idézőjelek közé tesszük a biztonság kedvéért
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\mnb.ps1"

popd
pause
