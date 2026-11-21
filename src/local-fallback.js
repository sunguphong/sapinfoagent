// GitHub 발송이 실패했을 때 PC 가 대신 보낸다 (watchdog.ps1 이 07:00~14:00 사이 5분마다 창 없이 실행).
// 계기: 2026-11-21 GitHub 에 넣어 둔 Claude 토큰 계정의 주간 한도가 끝나 모든 브리핑이 실패함. GitHub 장애·사이트 차단 등 다른 실패도 같이 막는다.
//
// 대상: 발송 시각 + 15분이 지났는데 ci-state 의 오늘 발송 표시(last-sent.txt)가 없고, PC 에서도 오늘 보내지 않았고,
//       GitHub 에서 지금 그 에이전트를 실행 중이지 않은 에이전트. 에이전트당 하루 최대 2번 시도.
// 보내기 전에 ci-state 의 seen.json·job-history.json 을 받아 오고(새 글 표시·공고 이력 유지), 보낸 뒤에는 그 파일들과
// last-sent.txt, 실행 기록(runs.json)을 ci-state 에 올린다. 그래서 늦게 도착한 GitHub 예약 실행은 건너뛰고, 총괄 에이전트도 발송으로 본다.
// watchdog 가 기다리지 않고 띄우므로, 결과는 직접 logs/watchdog.log 에 (같은 형식으로) 덧붙인다.
//   node src/local-fallback.js [--dry]   (--dry: 대상만 출력)
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, listAgents, agentPaths } from "./agents.js";
import { localYmd, isOffDay, dueAt } from "./status.js";
import { githubToken, upload, activeAgents } from "./github.js";

const GRACE_MIN = 15, MAX_TRIES = 2, LAST_HOUR = 14;
const DRY = process.argv.includes("--dry");
const REF = "refs/remotes/origin/ci-state";
const GIT = process.env.GIT_EXE || "git";
const run = promisify(execFile);
const git = async (...a) => (await run(GIT, ["-C", ROOT, ...a], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;
const show = async (p) => { try { return await git("show", `${REF}:${p}`); } catch { return null; } };
const LOCK = path.join(ROOT, "logs", "fallback.lock"), STATE = path.join(ROOT, "logs", "fallback.json");
const pad = (n) => String(n).padStart(2, "0");
function log(msg) {
  const d = new Date();
  console.log(msg);
  if (DRY) return;
  try { appendFileSync(path.join(ROOT, "logs", "watchdog.log"), `[${localYmd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] PC 대신 발송 - ${msg}\r\n`); } catch {}
}

// 이전 실행이 아직 돌고 있으면 그대로 둔다 (watchdog 는 5분마다 부르지만 7개를 다 보내면 15분 넘게 걸릴 수 있다)
function takeLock() {
  try {
    const pid = Number(readFileSync(LOCK, "utf8"));
    if (pid && Date.now() - statSync(LOCK).mtimeMs < 90 * 60000) { process.kill(pid, 0); return false; }   // 90분 넘은 잠금은 버려진 것으로 본다
  } catch {}
  writeFileSync(LOCK, String(process.pid));
  return true;
}

async function main() {
  const now = new Date(), today = localYmd(now);
  if (now.getHours() >= LAST_HOUR) return;
  let state = { date: today, tries: {} };
  try { const s = JSON.parse(readFileSync(STATE, "utf8")); if (s.date === today) state = s; } catch {}

  await git("fetch", "-q", "origin", `+ci-state:${REF}`);
  const due = [];
  // 총괄 에이전트는 다른 에이전트를 보낸 뒤에 돌도록 맨 뒤로
  for (const a of listAgents().sort((x, y) => (x.kind === "supervisor") - (y.kind === "supervisor") || String(x.schedule).localeCompare(y.schedule))) {
    if (isOffDay(a, now) || now - dueAt(a, now) < GRACE_MIN * 60000) continue;
    if (((await show(`logs/${a.id}/last-sent.txt`)) || "").trim() === today) continue;
    let local = [];
    try { local = JSON.parse(readFileSync(agentPaths(a.id).runsFile, "utf8")); } catch {}
    if (local.some((r) => r.date === today && r.mode === "send" && r.status === "success")) continue;
    if ((state.tries[a.id] || 0) >= MAX_TRIES) continue;
    due.push(a);
  }
  if (DRY) console.log(`dry: candidates=${due.map((a) => a.id).join(",") || "none"}`);
  if (!due.length) return;

  const token = githubToken();
  const active = await activeAgents(token);   // 실패하면 예외 → 이번 회차는 건너뜀 (GitHub 와 겹쳐 두 번 보내지 않도록)
  if (active.has("*")) { log("GitHub 실행이 막 시작되어 다음 회차에 다시 확인"); return; }
  const todo = due.filter((a) => !active.has(a.id));
  if (DRY) { console.log(`dry: todo=${todo.map((a) => a.id).join(",") || "none"} active=${[...active].join(",") || "none"}`); return; }

  for (const a of todo) {
    state.tries[a.id] = (state.tries[a.id] || 0) + 1;
    writeFileSync(STATE, JSON.stringify(state));
    const { logDir, runsFile } = agentPaths(a.id, { create: true });
    for (const f of ["seen.json", "job-history.json"]) {
      const t = await show(`logs/${a.id}/${f}`);
      if (t) writeFileSync(path.join(logDir, f), t);
    }
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const r = spawnSync(process.execPath, [path.join(ROOT, "src", "index.js"), `--agent=${a.id}`, "--source=pc-fallback", `--run-id=${runId}`],
      { cwd: ROOT, encoding: "utf8", timeout: 25 * 60 * 1000, windowsHide: true });
    let rec = null;
    try { rec = JSON.parse(readFileSync(runsFile, "utf8")).find((x) => x.id === runId) || null; } catch {}
    if (r.status !== 0 || rec?.status !== "success" || !rec.mailId) {
      log(`${a.id} 실패 (${state.tries[a.id]}/${MAX_TRIES}회): ${String(rec?.error || r.stderr || "").slice(0, 200).replace(/\s+/g, " ")}`);
      continue;
    }
    // ci-state 에 발송 기록 올리기
    try {
      let remote = [];
      try { remote = JSON.parse((await show(`logs/${a.id}/runs.json`)) || "[]"); } catch {}
      const runs = [...remote.filter((x) => x.id !== runId), rec].slice(-500);
      const msg = `state: ${a.id} ${today} (pc-fallback)`;
      await upload(token, `logs/${a.id}/last-sent.txt`, `${today}\n`, msg);
      await upload(token, `logs/${a.id}/runs.json`, JSON.stringify(runs, null, 2), msg);
      for (const f of ["seen.json", "job-history.json"]) {
        const p = path.join(logDir, f);
        if (existsSync(p)) await upload(token, `logs/${a.id}/${f}`, readFileSync(p, "utf8"), msg);
      }
      log(`${a.id} 발송 완료 (${rec.picked ?? "?"}건 선별, GitHub 대신 PC 가 보냄)`);
    } catch (e) {
      log(`${a.id} 발송 완료, 그러나 ci-state 기록 실패: ${e.message}`);
    }
  }
}

if (takeLock()) {
  try { await main(); }
  catch (e) { log(`오류: ${e.message}`); process.exitCode = 1; }
  finally { try { unlinkSync(LOCK); } catch {} }
}
