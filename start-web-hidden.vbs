' SAP Info Agent 관리 웹서버(http://localhost:5174)를 콘솔 창 없이 실행한다.
' 시작프로그램 폴더(shell:startup)에 복사해 두면 PC 로그인 시 자동 실행된다.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\ANTI\sapinfoagent"
sh.Run """C:\Program Files\nodejs\node.exe"" ""D:\ANTI\sapinfoagent\src\server.js""", 0, False
