@echo off
chcp 65001 >nul
cd /d D:\ANTI\sapinfoagent
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Users\DKSYSTEMS\AppData\Roaming\npm"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set D=%%i
echo ==== %DATE% %TIME% start ==== >> logs\%D%.log
node src\index.js --source=scheduler >> logs\%D%.log 2>&1
echo ==== exit %ERRORLEVEL% ==== >> logs\%D%.log
