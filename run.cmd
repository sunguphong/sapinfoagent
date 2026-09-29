@echo off
rem 작업 스케줄러가 호출하는 실행 스크립트. 첫 번째 인자가 에이전트 id (없으면 sap).
rem   run.cmd              -> SAP 브리핑 (작업 "SAP Info Agent", 06:55)
rem   run.cmd realestate   -> 부동산 브리핑 (작업 "SAP Info Agent - RealEstate", 07:00)
chcp 65001 >nul
cd /d D:\ANTI\sapinfoagent
set "PATH=%PATH%;C:\Program Files\nodejs;C:\Users\DKSYSTEMS\AppData\Roaming\npm"
set "AGENT=%~1"
if "%AGENT%"=="" set "AGENT=sap"
if not exist logs\%AGENT% mkdir logs\%AGENT%
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set D=%%i
echo ==== %DATE% %TIME% start (%AGENT%) ==== >> logs\%AGENT%\%D%.log
node src\index.js --source=scheduler --agent=%AGENT% >> logs\%AGENT%\%D%.log 2>&1
echo ==== exit %ERRORLEVEL% ==== >> logs\%AGENT%\%D%.log
