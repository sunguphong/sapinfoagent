// sapinfoagent 관리 웹 — 에이전트별 수동 실행 / 실행 기록 / 발송 메일 조회, 공통 환경설정 · 장애 기록
// 의존성 없이 node 내장 http 만 사용. 기본 포트 5174 (PORT 환경변수로 변경).
// 에이전트별 API 는 ?agent=<id> (POST 는 body.agent) 로 대상을 고른다. 생략하면 기본(sap). 에이전트 정의: agents/<id>.json
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { sendMail } from "./mail.js";
import { ROOT, DEFAULT_AGENT, loadAgent, listAgents, agentPaths } from "./agents.js";

const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT || 5174);
const PUBLIC = path.join(ROOT, "public");
const LOG_DIR = path.join(ROOT, "logs");   // 공통(터널) 로그. 에이전트별 기록은 logs/<id>/

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const readRuns = (agent) => { try { return JSON.parse(readFileSync(agentPaths(agent.id).runsFile, "utf8")); } catch { return []; } };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });
// 화면에 내려보내는 에이전트 요약 (프롬프트·피드 URL 등 상세는 제외)
const pubAgent = (a) => ({ id: a.id, name: a.name, description: a.description || "", schedule: a.schedule, task: a.task, subjectPrefix: a.subjectPrefix, mailTitle: a.mailTitle, feeds: a.feeds.map((f) => ({ name: f.name, keep: f.keep || 0 })), mailTo: a.mailTo || process.env.MAIL_TO || "" });

// 실행 중 판정: 최근 20분 내 status=running 인 기록이 있으면 실행 중
function runningRun(agent) {
  const now = Date.now();
  return readRuns(agent).find((r) => r.status === "running" && now - new Date(r.startedAt).getTime() < 20 * 60 * 1000);
}

const children = new Map();   // agent id → 웹에서 띄운 자식 프로세스
let lastId = "";
function startRun(agent, { dryRun = false } = {}) {
  if (children.has(agent.id)) return { ok: false, error: `이미 실행 중입니다 (${agent.name}: 웹에서 시작한 작업이 끝나지 않았습니다)` };
  const cur = runningRun(agent);
  if (cur) return { ok: false, error: "이미 실행 중입니다", run: cur };
  let id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  if (id <= lastId) id = String(Number(lastId) + 1);   // 같은 초에 두 번 눌러도 id 충돌 방지
  lastId = id;
  const args = [path.join(ROOT, "src", "index.js"), `--agent=${agent.id}`, `--run-id=${id}`, "--source=web"];
  if (dryRun) args.push("--dry-run");
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore", detached: false, windowsHide: true });
  children.set(agent.id, child);
  child.on("exit", () => children.delete(agent.id));
  return { ok: true, id, agent: agent.id };
}

// output/<agent>/<date>_<runId>.html (신규) 또는 <date>.html (구버전) 을 목록화
const MAIL_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:_(\d{14,}))?\.html$/;
function listMails(agent) {
  const { outDir } = agentPaths(agent.id);
  if (!existsSync(outDir)) return [];
  const runs = readRuns(agent);
  return readdirSync(outDir)
    .filter((f) => MAIL_FILE_RE.test(f))
    .map((f) => {
      const [, date, runId] = f.match(MAIL_FILE_RE);
      const base = f.slice(0, -5);
      const st = statSync(path.join(outDir, f));
      const run = runs.find((r) => r.html === f) || runs.find((r) => runId && r.id === runId)
        || (!runId ? runs.filter((r) => r.date === date && r.mailId).slice(-1)[0] : null) || null;
      let digest = null;
      try { digest = JSON.parse(readFileSync(path.join(outDir, `${base}-digest.json`), "utf8")); } catch {}
      return {
        date, file: f, base, runId: run?.id || runId || null, size: st.size,
        generatedAt: run?.startedAt || st.mtime.toISOString(),
        mode: run?.mode || (run?.mailId ? "send" : "unknown"), source: run?.source || null,
        sent: !!run?.mailId, mailSentAt: run?.mailSentAt || null, mailTo: run?.mailTo || null,
        overview: digest?.overview || null,
        picked: digest ? (digest.categories || []).reduce((n, c) => n + c.items.length, 0) : (run?.picked ?? null),
        categories: digest ? (digest.categories || []).map((c) => ({ name: c.name, count: c.items.length })) : [],
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.generatedAt.localeCompare(a.generatedAt));
}

// ---------- 환경설정 (.env 읽기/쓰기, 주석·순서 유지) — 모든 에이전트 공통 ----------
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
function readEnvFile() {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const vals = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=(.*)$/); if (m) vals[m[1]] = m[2].trim(); }
  return { text, vals };
}
function writeEnvFile(updates) {
  const { text } = readEnvFile();
  const lines = text ? text.split(/\r?\n/) : [];
  const done = new Set();
  const out = lines.map((line) => { const m = line.match(/^\s*([A-Z_]+)\s*=/); if (m && m[1] in updates) { done.add(m[1]); return `${m[1]}=${updates[m[1]]}`; } return line; });
  for (const k of Object.keys(updates)) if (!done.has(k)) out.push(`${k}=${updates[k]}`);
  writeFileSync(envPath, out.join("\n").replace(/\n*$/, "\n"));
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;   // 서버·자식 프로세스에 즉시 반영
}
function getSettings() {
  const { vals } = readEnvFile();
  const v = (k) => process.env[k] ?? vals[k] ?? "";
  return {
    mailTo: v("MAIL_TO").split(",").map((s) => s.trim()).filter(Boolean),
    smtpUser: v("SMTP_USER"), smtpPassSet: !!v("SMTP_PASS").replace(/\s+/g, ""),
    lookbackHours: Number(v("LOOKBACK_HOURS") || 24), maxArticles: Number(v("MAX_ARTICLES") || 40),
    webUser: v("WEB_USER"), webPassSet: !!v("WEB_PASS"), subdomain: v("LT_SUBDOMAIN") || "sap-info-agent",
    tunnel: tunnelInfo(),
    agents: listAgents().map(pubAgent),
    envPath,
  };
}
function saveSettings(body) {
  const updates = {};
  if (Array.isArray(body.mailTo)) {
    const list = body.mailTo.map((s) => String(s).trim()).filter(Boolean);
    const bad = list.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) throw new Error(`이메일 형식이 올바르지 않습니다: ${bad.join(", ")}`);
    if (!list.length) throw new Error("수신자는 최소 1명 필요합니다");
    updates.MAIL_TO = Array.from(new Set(list)).join(",");
  }
  if (body.smtpUser !== undefined) { const u = String(body.smtpUser).trim(); if (!EMAIL_RE.test(u)) throw new Error("발신 계정 이메일 형식이 올바르지 않습니다"); updates.SMTP_USER = u; }
  if (body.smtpPass !== undefined && String(body.smtpPass).trim()) { const p = String(body.smtpPass).replace(/\s+/g, ""); if (p.length !== 16) throw new Error("Gmail 앱 비밀번호는 16자리여야 합니다"); updates.SMTP_PASS = p; }
  if (body.lookbackHours !== undefined) { const n = Number(body.lookbackHours); if (!(n >= 1 && n <= 168)) throw new Error("수집 기간은 1~168시간"); updates.LOOKBACK_HOURS = String(n); }
  if (body.maxArticles !== undefined) { const n = Number(body.maxArticles); if (!(n >= 5 && n <= 200)) throw new Error("최대 기사 수는 5~200"); updates.MAX_ARTICLES = String(n); }
  if (body.webUser !== undefined) { const u = String(body.webUser).trim(); if (!/^[\w.-]{2,32}$/.test(u)) throw new Error("접속 아이디는 영문·숫자 2~32자"); updates.WEB_USER = u; }
  if (body.webPass !== undefined && String(body.webPass)) { const p = String(body.webPass); if (p.length < 8 || /\s/.test(p)) throw new Error("접속 비밀번호는 공백 없이 8자 이상"); updates.WEB_PASS = p; }
  if (body.subdomain !== undefined) { const s = String(body.subdomain).trim().toLowerCase(); if (!/^[a-z0-9-]{4,63}$/.test(s)) throw new Error("공개 주소 이름은 영문 소문자·숫자·하이픈 4~63자"); updates.LT_SUBDOMAIN = s; }
  if (!Object.keys(updates).length) throw new Error("변경할 항목이 없습니다");
  writeEnvFile(updates);
  return getSettings();
}
async function sendTestMail(agent, to) {
  const { outDir } = agentPaths(agent.id);
  const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => MAIL_FILE_RE.test(f)).sort() : [];
  const latest = files.pop();
  if (!latest) throw new Error(`${agent.name}의 브리핑 HTML이 없습니다. 먼저 드라이런을 실행하세요`);
  const html = readFileSync(path.join(outDir, latest), "utf8");
  const target = to || agent.mailTo || process.env.MAIL_TO || "";
  const id = await sendMail({ subject: `${agent.subjectPrefix} 테스트 메일 (${latest.slice(0, 10)})`, html, fromName: agent.fromName, to: target });
  return { id, to: target.split(",").map((s) => s.trim()).filter(Boolean), file: latest, agent: agent.id };
}

function nextScheduled(time = "06:55") {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// ---------- Basic Auth (.env 의 WEB_USER / WEB_PASS 가 있으면 모든 요청에 인증 요구) ----------
function checkAuth(req) {
  const user = process.env.WEB_USER, pass = process.env.WEB_PASS;
  if (!user || !pass) return true;   // 미설정 시 인증 없음 (로컬 전용 사용)
  const m = (req.headers.authorization || "").match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  const dec = Buffer.from(m[1], "base64").toString("utf8");
  const i = dec.indexOf(":");
  return i > 0 && dec.slice(0, i) === user && dec.slice(i + 1) === pass;
}
function tunnelState() { try { return JSON.parse(readFileSync(path.join(LOG_DIR, "tunnel.json"), "utf8")); } catch { return null; } }
function tunnelAlive(st) { if (!st?.pid) return null; try { process.kill(st.pid, 0); return true; } catch { return false; } }   // null = 알 수 없음(구버전 상태 파일)
function tunnelInfo() { const t = tunnelState(); return t ? { ...t, alive: tunnelAlive(t) } : null; }

// ---------- 장애 기록: logs/tunnel.log 를 해석해 공개 주소가 불통이던 구간을 뽑는다 ----------
// tunnel.js 의 로그 문구에 의존한다. 문구를 바꾸면 여기도 같이 고칠 것.
// 유형: down(접속 불가) · temp(임시 주소만 열림) · restart(프로세스 중단 후 재시작, 시작 시각은 추정) · dead(프로세스 꺼짐, 진행 중) · warn(일시 경고, 자동 복구)
const TUNNEL_LOG = path.join(LOG_DIR, "tunnel.log");
const TLINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (.*)$/;
const INC_LABEL = { down: "접속 불가", temp: "임시 주소", restart: "프로세스 재시작", dead: "프로세스 꺼짐", warn: "일시 경고" };
function parseIncidents() {
  const wanted = `https://${process.env.LT_SUBDOMAIN || "sap-info-agent"}.loca.lt`;
  let text = ""; try { text = readFileSync(TUNNEL_LOG, "utf8"); } catch {}
  const list = [];
  let cur = null, phase = "init", lastTs = null, upSince = null, warn = null;
  const open = (start, type, cause, estimated = false) => { cur = { start, startEstimated: estimated, end: null, type, cause, tempUrls: [], checkFails: [], registerTries: 0, restarts: 0, notes: [], events: [] }; return cur; };
  const close = (end) => { const c = cur; c.end = end; list.push(c); cur = null; return c; };
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(TLINE_RE); if (!m) continue;
    const ts = new Date(m[1].replace(" ", "T")).toISOString(), msg = m[2];
    let closed = null;
    if (msg.startsWith("tunnel.js 시작")) {
      // 새 코드는 직전 프로세스의 마지막 생존 시각(상태 파일 갱신 시각, 45초 간격)을 함께 남긴다 → 그 시각을 중단 시작으로 본다
      const prev = msg.match(/이전 프로세스 마지막 기록: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const prevTs = prev ? new Date(prev[1].replace(" ", "T")).toISOString() : null;
      if (phase === "up") open(prevTs && (!lastTs || prevTs > lastTs) ? prevTs : (lastTs || ts), "restart", "터널 프로세스가 중단됐다가 다시 시작됨 (PC 종료·로그오프·수동 재시작 등)", true);
      if (cur) cur.restarts++;
      phase = "down";
    } else if (msg.startsWith("터널 연결됨 → ")) {
      const url = msg.slice("터널 연결됨 → ".length).trim();
      if (url === wanted) { phase = "up"; upSince = ts; if (cur) closed = close(ts); }
      else { phase = "temp"; if (!cur) open(ts, "temp", "고정 주소를 못 받아 임시 주소로만 열림 (loca.lt 가 기존 등록을 아직 유지)"); cur.tempUrls.push(url); }
    } else if (msg.startsWith("상태 점검 실패")) {
      const d = (msg.match(/\(([^)]*)\)\s*$/)?.[1] || "").replace(/, 서버에 터널 등록 없음$/, "");
      if (cur) cur.checkFails.push(d); else { warn ??= { start: ts, details: [], events: [] }; warn.details.push(d); }
    } else if (msg.startsWith("상태 점검 정상 복귀")) {
      if (warn && !cur) list.push({ start: warn.start, startEstimated: false, end: ts, type: "warn", cause: `상태 점검 일시 실패 ${warn.details.length}회 후 자동 복구 (loca.lt 일시 오류로 추정)`, tempUrls: [], checkFails: warn.details, registerTries: 0, restarts: 0, notes: [], events: [...warn.events, raw] });
      warn = null;
    } else if (msg.startsWith("공개 주소가")) {   // "응답하지 않아 터널을 다시 연결합니다" / "계속 응답하지 않아 터널을 끊고 다시 연결합니다"
      if (!cur) { open(warn?.start || ts, "down", `공개 주소 무응답 (상태 점검 실패: ${(warn?.details || []).join(", ") || "-"}) → 끊고 재연결`); if (warn) { cur.checkFails.push(...warn.details); cur.events.push(...warn.events); } }
      else cur.notes.push("끊고 재연결");
      warn = null; phase = "down";
    } else if (msg.startsWith("터널 종료됨")) {
      if (phase === "up" && !cur) open(ts, "down", "터널 연결이 끊김");
      phase = "down";
    } else if (msg.startsWith("터널 오류")) {
      if (!cur) open(ts, "down", msg); else cur.notes.push(msg);
      phase = "down";
    } else if (msg.startsWith("연결 실패")) {
      if (!cur) open(ts, "down", msg); else cur.notes.push(msg);
      phase = "down";
    } else if (/^고정 주소 (되찾기 \d|요청)/.test(msg)) {
      if (cur) cur.registerTries++;
    } else if (msg.startsWith("⚠ .env")) {
      if (!cur) open(ts, "down", "WEB_USER/WEB_PASS 미설정으로 외부 공개 중단"); phase = "down";
    } else if (/^(uncaughtException|unhandledRejection)/.test(msg)) {
      if (cur) cur.notes.push(msg.slice(0, 160));
    }
    if (warn && !cur) warn.events.push(raw);
    if (cur) cur.events.push(raw); else if (closed) closed.events.push(raw);
    lastTs = ts;
  }
  const st = tunnelState(), alive = tunnelAlive(st), now = new Date().toISOString();
  if (!cur && alive === false && phase !== "init") open(lastTs || now, "dead", "터널 프로세스가 실행되고 있지 않음 (시작프로그램 'SAP Info Agent 관리웹.vbs' 또는 npm run tunnel 로 켜야 함)", true);
  else if (cur && alive === false) cur.notes.push("터널 프로세스 꺼짐");
  if (cur) { cur.ongoing = true; list.push(cur); }
  for (const i of list) {
    i.label = i.type === "down" && i.tempUrls.length ? "접속 불가 → 임시 주소" : INC_LABEL[i.type];
    i.severity = i.type === "warn" ? "warn" : "outage";
    const parts = [];
    if (i.checkFails.length) parts.push(`상태 점검 실패 ${i.checkFails.length}회 (${[...new Set(i.checkFails)].join(", ")})`);
    if (i.restarts) parts.push(`프로세스 재시작 ${i.restarts}회`);
    if (i.tempUrls.length) parts.push(`임시 주소 ${i.tempUrls.length}회 발급`);
    if (i.registerTries) parts.push(`고정 주소 재요청 ${i.registerTries}회`);
    const cnt = new Map(); for (const n of i.notes) cnt.set(n, (cnt.get(n) || 0) + 1);
    for (const [n, c] of cnt) parts.push(c > 1 ? `${n} ×${c}` : n);
    parts.push(i.end ? "고정 주소 복구" : "진행 중");
    i.summary = parts.join(" → ");
    i.durationSec = Math.max(0, Math.round((new Date(i.end || now) - new Date(i.start)) / 1000));
    i.id = i.start.replace(/\D/g, "") + i.type;
  }
  list.reverse();
  const outages = list.filter((i) => i.severity === "outage");
  const stat = (days) => { const since = Date.now() - days * 86400000; const s = outages.filter((i) => new Date(i.end || now) >= since); return { count: s.length, seconds: s.reduce((n, i) => n + i.durationSec, 0) }; };
  return {
    incidents: list,
    current: { ...(st || {}), alive, phase, upSince, wanted, lastLogAt: lastTs },
    stats: { d7: stat(7), d30: stat(30), all: { count: outages.length, seconds: outages.reduce((n, i) => n + i.durationSec, 0) }, warns: list.length - outages.length },
    now,
  };
}

const server = http.createServer(async (req, res) => {
  // 터널 상태 점검용 (인증 없음, 내용 없음)
  if (req.url === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); return res.end("ok"); }
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="sapinfoagent", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
    return res.end("인증이 필요합니다.");
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // 대상 에이전트 (?agent=<id>, 기본 sap). 잘못된 이름이면 400
    let agent;
    if (p.startsWith("/api/") || p.startsWith("/mail/")) {
      try { agent = loadAgent(url.searchParams.get("agent") || DEFAULT_AGENT); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    // ---------- API ----------
    if (p === "/api/agents") return json(res, 200, listAgents().map(pubAgent));
    if (p === "/api/status") {
      const runs = readRuns(agent);
      const mailTo = (agent.mailTo || process.env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
      return json(res, 200, {
        agent: pubAgent(agent),
        agents: listAgents().map(pubAgent),
        running: runningRun(agent) || null,
        lastRun: runs.filter((r) => r.status !== "running").slice(-1)[0] || null,
        lastSent: runs.filter((r) => r.mailId).slice(-1)[0] || null,
        schedule: { time: agent.schedule, next: nextScheduled(agent.schedule), task: agent.task },
        tunnel: tunnelInfo(), authEnabled: !!(process.env.WEB_USER && process.env.WEB_PASS),
        mailTo, smtpUser: process.env.SMTP_USER || null, smtpReady: !!(process.env.SMTP_USER && process.env.SMTP_PASS && mailTo.length),
        totals: { runs: runs.length, success: runs.filter((r) => r.status === "success").length, error: runs.filter((r) => r.status === "error").length, mails: listMails(agent).length },
        now: new Date().toISOString(),
      });
    }
    if (p === "/api/runs") return json(res, 200, readRuns(agent).slice().reverse());
    if (p === "/api/incidents") return json(res, 200, parseIncidents());
    if (p === "/api/tunnel-log") {
      const n = Math.min(2000, Math.max(20, Number(url.searchParams.get("lines")) || 300));
      let text = ""; try { text = readFileSync(TUNNEL_LOG, "utf8"); } catch {}
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(text.split(/\r?\n/).filter(Boolean).slice(-n).join("\n"));
    }
    let m;
    if ((m = p.match(/^\/api\/runs\/([\w-]+)\/log$/))) {
      const f = path.join(agentPaths(agent.id).logDir, `run-${m[1]}.log`);
      if (!existsSync(f)) return json(res, 404, { error: "no log" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(f, "utf8"));
    }
    if (p === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      try { if (body.agent) agent = loadAgent(String(body.agent)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const r = startRun(agent, { dryRun: !!body.dryRun });
      return json(res, r.ok ? 202 : 409, r);
    }
    if (p === "/api/mails") return json(res, 200, listMails(agent));
    if (p === "/api/settings" && req.method === "GET") return json(res, 200, getSettings());
    if (p === "/api/settings" && (req.method === "PUT" || req.method === "POST")) {
      try { return json(res, 200, { ok: true, settings: saveSettings(await readBody(req)) }); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (p === "/api/mail-test" && req.method === "POST") {
      const body = await readBody(req);
      try { if (body.agent) agent = loadAgent(String(body.agent)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      try { return json(res, 200, { ok: true, ...(await sendTestMail(agent, body.to ? String(body.to).trim() : "")) }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if ((m = p.match(/^\/mail\/([^/]+\.html)$/)) && MAIL_FILE_RE.test(m[1])) {
      const f = path.join(agentPaths(agent.id).outDir, m[1]);
      if (!existsSync(f)) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      return createReadStream(f).pipe(res);
    }
    if ((m = p.match(/^\/api\/mails\/([^/]+)\/(digest|articles)$/)) && MAIL_FILE_RE.test(m[1] + ".html")) {
      const f = path.join(agentPaths(agent.id).outDir, `${m[1]}-${m[2]}.json`);
      if (!existsSync(f)) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
      return createReadStream(f).pipe(res);
    }

    // ---------- 정적 파일 ----------
    let file = path.normalize(path.join(PUBLIC, p === "/" ? "index.html" : p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`sapinfoagent web: http://localhost:${PORT}`));
