// sapinfoagent 관리 웹 — 수동 실행 / 실행 기록 / 발송 메일 조회
// 의존성 없이 node 내장 http 만 사용. 기본 포트 5174 (PORT 환경변수로 변경).
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendMail } from "./mail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT || 5174);
const PUBLIC = path.join(ROOT, "public");
const LOG_DIR = path.join(ROOT, "logs");
const OUT_DIR = path.join(ROOT, "output");
const RUNS_FILE = path.join(LOG_DIR, "runs.json");
const SCHEDULE_TIME = "06:55";

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const readRuns = () => { try { return JSON.parse(readFileSync(RUNS_FILE, "utf8")); } catch { return []; } };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } }); });

// 실행 중 판정: 최근 20분 내 status=running 인 기록이 있으면 실행 중
function runningRun() {
  const now = Date.now();
  return readRuns().find((r) => r.status === "running" && now - new Date(r.startedAt).getTime() < 20 * 60 * 1000);
}

let child = null;
let lastId = "";
function startRun({ dryRun = false } = {}) {
  if (child) return { ok: false, error: "이미 실행 중입니다 (웹에서 시작한 작업이 끝나지 않았습니다)" };
  const cur = runningRun();
  if (cur) return { ok: false, error: "이미 실행 중입니다", run: cur };
  let id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  if (id <= lastId) id = String(Number(lastId) + 1);   // 같은 초에 두 번 눌러도 id 충돌 방지
  lastId = id;
  const args = [path.join(ROOT, "src", "index.js"), `--run-id=${id}`, "--source=web"];
  if (dryRun) args.push("--dry-run");
  child = spawn(process.execPath, args, { cwd: ROOT, stdio: "ignore", detached: false, windowsHide: true });
  child.on("exit", () => { child = null; });
  return { ok: true, id };
}

// output/<date>_<runId>.html (신규) 또는 output/<date>.html (구버전) 을 목록화
const MAIL_FILE_RE = /^(\d{4}-\d{2}-\d{2})(?:_(\d{14,}))?\.html$/;
function listMails() {
  if (!existsSync(OUT_DIR)) return [];
  const runs = readRuns();
  return readdirSync(OUT_DIR)
    .filter((f) => MAIL_FILE_RE.test(f))
    .map((f) => {
      const [, date, runId] = f.match(MAIL_FILE_RE);
      const base = f.slice(0, -5);
      const st = statSync(path.join(OUT_DIR, f));
      const run = runs.find((r) => r.html === f) || runs.find((r) => runId && r.id === runId)
        || (!runId ? runs.filter((r) => r.date === date && r.mailId).slice(-1)[0] : null) || null;
      let digest = null;
      try { digest = JSON.parse(readFileSync(path.join(OUT_DIR, `${base}-digest.json`), "utf8")); } catch {}
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

// ---------- 환경설정 (.env 읽기/쓰기, 주석·순서 유지) ----------
const ENV_KEYS = ["SMTP_USER", "SMTP_PASS", "MAIL_TO", "LOOKBACK_HOURS", "MAX_ARTICLES", "WEB_USER", "WEB_PASS", "LT_SUBDOMAIN"];
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
    tunnel: tunnelState(),
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
async function sendTestMail(to) {
  const files = existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => MAIL_FILE_RE.test(f)).sort() : [];
  const latest = files.pop();
  if (!latest) throw new Error("보낼 브리핑 HTML이 없습니다. 먼저 드라이런을 실행하세요");
  const html = readFileSync(path.join(OUT_DIR, latest), "utf8");
  const saved = process.env.MAIL_TO;
  if (to) process.env.MAIL_TO = to;          // 특정 주소로만 테스트
  try {
    const id = await sendMail({ subject: `[SAP 브리핑] 테스트 메일 (${latest.slice(0, 10)})`, html });
    return { id, to: (to || saved || "").split(",").map((s) => s.trim()).filter(Boolean), file: latest };
  } finally { process.env.MAIL_TO = saved; }
}

function nextScheduled() {
  const [h, m] = SCHEDULE_TIME.split(":").map(Number);
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

const server = http.createServer(async (req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="sapinfoagent", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
    return res.end("인증이 필요합니다.");
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---------- API ----------
    if (p === "/api/status") {
      const runs = readRuns();
      const mailTo = (process.env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
      return json(res, 200, {
        running: runningRun() || null,
        lastRun: runs.filter((r) => r.status !== "running").slice(-1)[0] || null,
        lastSent: runs.filter((r) => r.mailId).slice(-1)[0] || null,
        schedule: { time: SCHEDULE_TIME, next: nextScheduled(), task: "SAP Info Agent" },
        tunnel: tunnelState(), authEnabled: !!(process.env.WEB_USER && process.env.WEB_PASS),
        mailTo, smtpUser: process.env.SMTP_USER || null, smtpReady: !!(process.env.SMTP_USER && process.env.SMTP_PASS && mailTo.length),
        totals: { runs: runs.length, success: runs.filter((r) => r.status === "success").length, error: runs.filter((r) => r.status === "error").length, mails: listMails().length },
        now: new Date().toISOString(),
      });
    }
    if (p === "/api/runs") return json(res, 200, readRuns().slice().reverse());
    let m;
    if ((m = p.match(/^\/api\/runs\/([\w-]+)\/log$/))) {
      const f = path.join(LOG_DIR, `run-${m[1]}.log`);
      if (!existsSync(f)) return json(res, 404, { error: "no log" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(f, "utf8"));
    }
    if (p === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      const r = startRun({ dryRun: !!body.dryRun });
      return json(res, r.ok ? 202 : 409, r);
    }
    if (p === "/api/mails") return json(res, 200, listMails());
    if (p === "/api/settings" && req.method === "GET") return json(res, 200, getSettings());
    if (p === "/api/settings" && (req.method === "PUT" || req.method === "POST")) {
      try { return json(res, 200, { ok: true, settings: saveSettings(await readBody(req)) }); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    }
    if (p === "/api/mail-test" && req.method === "POST") {
      const body = await readBody(req);
      try { return json(res, 200, { ok: true, ...(await sendTestMail(body.to ? String(body.to).trim() : "")) }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if ((m = p.match(/^\/mail\/([^/]+\.html)$/)) && MAIL_FILE_RE.test(m[1])) {
      const f = path.join(OUT_DIR, m[1]);
      if (!existsSync(f)) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      return createReadStream(f).pipe(res);
    }
    if ((m = p.match(/^\/api\/mails\/([^/]+)\/(digest|articles)$/)) && MAIL_FILE_RE.test(m[1] + ".html")) {
      const f = path.join(OUT_DIR, `${m[1]}-${m[2]}.json`);
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
