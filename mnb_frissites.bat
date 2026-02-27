@echo off
pushd "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "mnb.ps1"
pause