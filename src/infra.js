// 개발구성 화면(/api/infra)에 쓰는 PC·앱 상태: 가동 시간, 데이터 크기, 디스크, 메모리, ngrok 프로세스, 작업 스케줄러(watchdog) 실행 시각.
// 파일 크기 합산·프로세스 조회는 느릴 수 있어 60초 동안 결과를 재사용한다.
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync, statfsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./agents.js";

const run = promisify(execFile);
const STARTED = new Date();
const TASK = "SAP Info Agent Watchdog";
let cache = null, cacheAt = 0;

function dirSize(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    let list = [];
    try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { bytes += statSync(p).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { bytes, files };
}

async function ngrokRunning() {
  if (process.platform !== "win32") return null;
  try { const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq ngrok.exe", "/NH"], { windowsHide: true, timeout: 8000 }); return /ngrok\.exe/i.test(stdout); } catch { return null; }
}

// 작업 스케줄러의 watchdog 마지막·다음 실행 (Windows 전용)
async function watchdogTask() {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await run("powershell", ["-NoProfile", "-Command",
      `Get-ScheduledTaskInfo -TaskName '${TASK}' | ForEach-Object { @{ last = $_.LastRunTime.ToString('o'); next = $_.NextRunTime.ToString('o'); result = $_.LastTaskResult } } | ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 15000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

// watchdog.log 마지막 줄 (무엇을 했는지)
function watchdogLast() {
  try {
    const lines = readFileSync(path.join(ROOT, "logs", "watchdog.log"), "utf8").trimEnd().split(/\r?\n/);
    const m = lines.at(-1).match(/^\[(.+?)\] (.*)$/);
    return m ? { at: new Date(m[1].replace(" ", "T")).toISOString(), text: m[2] } : null;
  } catch { return null; }
}

export async function infraStatus() {
  if (!cache || Date.now() - cacheAt > 60000) {
    const logs = dirSize(path.join(ROOT, "logs")), output = dirSize(path.join(ROOT, "output"));
    let disk = null;
    try { const s = statfsSync(ROOT); disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize, drive: path.parse(ROOT).root }; } catch {}
    const [ngrok, task] = await Promise.all([ngrokRunning(), watchdogTask()]);
    cache = { data: { bytes: logs.bytes + output.bytes, files: logs.files + output.files, logs, output }, disk, ngrok, task };
    cacheAt = Date.now();
  }
  const mem = process.memoryUsage();
  return {
    ...cache,
    startedAt: STARTED.toISOString(), uptimeSec: Math.round(process.uptime()),
    memory: { total: os.totalmem(), used: os.totalmem() - os.freemem(), app: mem.rss },
    node: process.version, platform: `${os.type()} ${os.release()}`, host: os.hostname(), root: ROOT,
    port: Number(process.env.PORT || 5174), auth: !!(process.env.WEB_USER && process.env.WEB_PASS),
    watchdogLog: watchdogLast(),
    checkedAt: new Date().toISOString(),
  };
}
