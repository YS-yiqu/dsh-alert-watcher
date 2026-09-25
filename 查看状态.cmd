@echo off
chcp 936 >nul
echo DSH 断网提醒：当前状态
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0过程文件\status.ps1"
echo.
pause
