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

# ngrok 은 winget 이 아닌 이 폴더에 공식 zip 으로 설치해 쓴다.
# (2026-10-20: 'ngrok update' 가 제자리 교체 도중 실패해 winget 의 ngrok.exe 를 지우고 .ngrok.exe.old 만 남겨 터널이 반나절 꺼졌다.
#  그래서 update 는 쓰지 않고, 새 zip 을 임시 폴더에 받아 실행 확인이 된 경우에만 바꿔 넣는다.)
$NgDir   = Join-Path $env:LOCALAPPDATA 'ngrok\bin'
$NgExe   = Join-Path $NgDir 'ngrok.exe'
$NgZip   = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip'

function Install-Ngrok {
  $tmp = Join-Path $env:TEMP ("ngrok-new-" + [guid]::NewGuid())
  try {
    New-Item -ItemType Directory -Force $tmp | Out-Null
    Invoke-WebRequest -UseBasicParsing $NgZip -OutFile "$tmp\ngrok.zip" -TimeoutSec 120
    Expand-Archive "$tmp\ngrok.zip" -DestinationPath $tmp -Force
    $ver = & "$tmp\ngrok.exe" version 2>&1
    if ($LASTEXITCODE -ne 0) { Log "새 ngrok 실행 확인 실패: $ver"; return $false }
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force
    New-Item -ItemType Directory -Force $NgDir | Out-Null
    Copy-Item "$tmp\ngrok.exe" $NgExe -Force
    Log "ngrok 재설치 완료 ($ver)"
    return $true
  } catch { Log "ngrok 재설치 실패: $($_.Exception.Message)"; return $false }
  finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}

# 2) ngrok 터널
if (-not (Test-Tunnel)) {
  if (-not (Test-Path $NgExe)) {
    Log "ngrok.exe 없음 ($NgExe) - 새로 설치"
    if (-not (Install-Ngrok)) { exit 1 }
  }
  $ng = $NgExe
  if (Start-Ngrok $ng) { Log "ngrok 터널 끊겨 있어 다시 띄움 ($ng)"; exit 0 }

  # 버전 거부(ERR_NGROK_121) 등으로 실패하면 최신 버전으로 한 번 재설치 후 재시도한다.
  $tail = if (Test-Path $NgLog) { Get-Content $NgLog -Raw } else { '' }
  Log 'ngrok 터널 기동 실패 - 최신 버전 재설치 후 재시도'
  if ((Install-Ngrok) -and (Start-Ngrok $ng)) { Log 'ngrok 재설치 후 터널 복구'; exit 0 }
  $tail = if (Test-Path $NgLog) { Get-Content $NgLog -Raw } else { $tail }
  $last = if ($tail) { ($tail -split "`n" | Where-Object { $_ -match 'lvl=(eror|crit)|ERR_' } | Select-Object -Last 2) -join ' / ' } else { '' }
  Log "ngrok 터널 재기동 실패 $last"
  exit 1
}
