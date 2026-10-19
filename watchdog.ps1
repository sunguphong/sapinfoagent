# 관리 웹(5174) + ngrok 터널 감시. 작업 스케줄러가 5분마다 watchdog.vbs 로 창 없이 실행한다.
#  - 웹 서버가 안 떠 있으면 node src\server.js 를 띄운다.
#  - ngrok 터널이 없으면 ngrok 을 다시 띄우고, 그래도 안 뜨면 ngrok update 후 재시도한다.
#  - 조치한 내용만 logs\watchdog.log 에 남긴다.
$ErrorActionPreference = 'Continue'
$Root    = $PSScriptRoot
$Port    = 5174
$NgUrl   = 'https://repaying-showing-gooey.ngrok-free.dev'
$NgLog   = Join-Path $Root 'logs\ngrok.log'
$WdLog   = Join-Path $Root 'logs\watchdog.log'

function Log($msg) {
  if ((Test-Path $WdLog) -and (Get-Item $WdLog).Length -gt 1MB) { Move-Item $WdLog "$WdLog.old" -Force }
  Add-Content -Path $WdLog -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8
}

function Find-Exe($name, $candidates) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in $candidates) {
    $hit = Get-ChildItem $p -Filter "$name.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return $null
}

function Test-Port($port) {
  try { $t = New-Object Net.Sockets.TcpClient; $t.Connect('127.0.0.1', $port); $t.Close(); return $true } catch { return $false }
}

function Test-Tunnel {
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 5
    return [bool]($r.tunnels | Where-Object { $_.public_url -eq $NgUrl })
  } catch { return $false }
}

function Start-Ngrok($ng) {
  Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path $NgLog) { Clear-Content $NgLog -ErrorAction SilentlyContinue }
  Start-Process -WindowStyle Hidden -FilePath $ng -ArgumentList 'http', "--url=$NgUrl", "$Port", "--log=$NgLog"
  Start-Sleep 10
  return (Test-Tunnel)
}

# 1) 웹 서버
if (-not (Test-Port $Port)) {
  $node = Find-Exe 'node' @("$env:ProgramFiles\nodejs")
  if (-not $node) { Log '웹 서버 꺼짐 - node.exe 를 찾지 못해 띄우지 못함'; exit 1 }
  Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList "`"$Root\src\server.js`"" -WorkingDirectory $Root
  Start-Sleep 5
  if (Test-Port $Port) { Log '웹 서버 꺼져 있어 다시 띄움' } else { Log '웹 서버 재기동 실패' }
}

# 2) ngrok 터널
if (-not (Test-Tunnel)) {
  $ng = Find-Exe 'ngrok' @("$env:LOCALAPPDATA\Microsoft\WinGet\Packages", "$env:APPDATA\npm", "$env:ProgramFiles")
  if (-not $ng) { Log 'ngrok 터널 끊김 - ngrok.exe 를 찾지 못함'; exit 1 }
  if (Start-Ngrok $ng) { Log "ngrok 터널 끊겨 있어 다시 띄움 ($ng)"; exit 0 }

  # 버전 거부(ERR_NGROK_121)는 로그에 남지만, winget 구버전의 'unknown flag: --url' 은 로그 없이 바로 종료되므로
  # 실패하면 원인과 상관없이 ngrok update 를 한 번 시도한다.
  $tail = if (Test-Path $NgLog) { Get-Content $NgLog -Raw } else { '' }
  Log 'ngrok 터널 기동 실패 - ngrok update 후 재시도'
  & $ng update 2>&1 | Out-Null
  if (Start-Ngrok $ng) { Log 'ngrok 업데이트 후 터널 복구'; exit 0 }
  $tail = if (Test-Path $NgLog) { Get-Content $NgLog -Raw } else { $tail }
  $last = if ($tail) { ($tail -split "`n" | Where-Object { $_ -match 'lvl=(eror|crit)|ERR_' } | Select-Object -Last 2) -join ' / ' } else { '' }
  Log "ngrok 터널 재기동 실패 $last"
  exit 1
}
