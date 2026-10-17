' watchdog.ps1 을 콘솔 창 없이 실행한다. 작업 스케줄러 "SAP Info Agent Watchdog" 이 5분마다 호출.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\ANTI\sapinfoagent\watchdog.ps1""", 0, False
