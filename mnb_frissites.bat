@echo off
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "src/mnb.ps1"

pause
