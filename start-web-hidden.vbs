' SAP Info Agent 관리 웹서버(http://localhost:5174) + 외부 공개 터널을 콘솔 창 없이 실행한다.
' 시작프로그램 폴더(shell:startup)에 복사해 두면 PC 로그인 시 자동 실행된다.
'  - src\server.js : 관리 웹 (Basic Auth: .env 의 WEB_USER / WEB_PASS)
'  - src\tunnel.js : localtunnel 고정 주소 공개 (https://<LT_SUBDOMAIN>.loca.lt)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\ANTI\sapinfoagent"
node = """C:\Program Files\nodejs\node.exe"""
sh.Run node & " ""D:\ANTI\sapinfoagent\src\server.js""", 0, False
WScript.Sleep 3000  ' 서버가 5174에 먼저 뜨도록 잠깐 대기
sh.Run node & " ""D:\ANTI\sapinfoagent\src\tunnel.js""", 0, False
