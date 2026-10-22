@echo off
pwsh.exe -NoProfile -NonInteractive -File "%~dp0agent-wake.ps1" %*
exit /b %errorlevel%
