// localtunnel 로 관리 웹(5174)을 고정 주소로 외부에 공개한다. 끊기면 자동 재연결.
// 주소: https://<LT_SUBDOMAIN>.loca.lt  (기본 sap-info-agent)
// 외부 공개 시에는 .env 의 WEB_USER / WEB_PASS (Basic Auth) 가 반드시 설정되어 있어야 한다.
//
// 동작 원칙 (2026-09-29 장애 이후 정리)
//  - 고정 주소를 못 받으면 임시 주소로 열어 둔 채, 별도 연결로 고정 주소를 계속 요청한다(30초 간격 10회, 이후 2분 간격 무제한).
//  - 상태 점검(45초 간격)이 실패해도 곧바로 끊지 않는다. 끊고 다시 붙으면 loca.lt 가 고정 이름을 한동안 돌려주지 않아
//    접속 불능이 오히려 길어졌고(05:23), 재연결 직후 90초쯤 뒤 다시 실패하는 반복(플래핑)도 관찰됐다(05:47~07:59).
//    대신 현재 터널은 그대로 두고 고정 이름을 병렬로 다시 등록해 보고(서버가 터널을 잊은 404/503 이면 즉시 성공),
//    15초 간격으로 재점검하다가 5분 넘게 계속 실패할 때만 최후 수단으로 끊고 재연결한다.
//  - 이 파일의 로그 문구는 관리 웹 "장애 기록"(src/server.js parseIncidents) 이 해석하므로 바꿀 때 같이 고친다.
import { existsSync, appendFileSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import localtunnel from "localtunnel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT || 5174);
const SUBDOMAIN = process.env.LT_SUBDOMAIN || "sap-info-agent";
const WANTED = `https://${SUBDOMAIN}.loca.lt`;
const LOG_DIR = path.join(ROOT, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "tunnel.log");
const STATE_FILE = path.join(LOG_DIR, "tunnel.json");   // 관리 웹이 읽어 공개 주소·점검 결과·프로세스 생존(pid) 표시

const ts = () => new Date().toLocaleString("sv-SE");
function log(m) { const line = `[${ts()}] ${m}`; try { appendFileSync(LOG_FILE, line + "\n"); } catch {} console.log(line); }
// 직전 프로세스가 남긴 상태 파일(45초마다 갱신) → 로그 없이 죽었을 때 "언제까지 살아 있었는지"를 시작 로그에 남긴다 (장애 기록의 시작 시각 추정에 사용)
let prevState = null; try { prevState = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
let state = {};
function setState(s) { state = { ...s, pid: process.pid, updatedAt: new Date().toISOString() }; try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {} }
const patchState = (p) => setState({ ...state, ...p });

if (!process.env.WEB_USER || !process.env.WEB_PASS) {
  log("⚠ .env 에 WEB_USER / WEB_PASS 가 없어 외부 공개를 중단합니다 (인증 없이 공개되는 것을 막기 위함)");
  setState({ status: "disabled", reason: "WEB_USER/WEB_PASS 미설정" });
  process.exit(1);
}

process.on("uncaughtException", (e) => log("uncaughtException: " + (e?.stack || e)));
process.on("unhandledRejection", (e) => log("unhandledRejection: " + (e?.stack || e)));

let tunnel = null;                                                // 현재 사용 중인 터널
let retry = 0, reconnectTimer = null;                             // 끊긴 뒤 재연결
let reclaimTimer = null, reclaimTries = 0, registering = false;   // 임시 주소일 때 고정 주소 되찾기
let healthFails = 0, failingSince = null, quickTimer = null, checking = false;   // 상태 점검
let publicIp = null;                                              // loca.lt 안내 페이지에서 묻는 "IP" = 이 PC의 공인 IP

async function fetchPublicIp() {
  try { publicIp = (await (await fetch("https://loca.lt/mytunnelpassword", { signal: AbortSignal.timeout(15000) })).text()).trim(); }
  catch (e) { log("공인 IP 조회 실패: " + e.message); }
  return publicIp;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30000, 2000 * 2 ** retry++);
  log(`재연결 예약: ${Math.round(delay / 1000)}초 후`);
  setState({ status: "reconnecting", subdomain: SUBDOMAIN, wanted: WANTED });
  reconnectTimer = setTimeout(() => { reconnectTimer = null; start(); }, delay);
}

// 새 터널을 현재 터널로 채택한다. 이전 터널이 있으면 닫는다.
function adopt(t) {
  const prev = tunnel;
  tunnel = t;
  retry = 0; healthFails = 0; failingSince = null;
  if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; }
  const fixed = t.url === WANTED;
  log(`터널 연결됨 → ${t.url}`);
  if (!fixed) log(`⚠ 원하던 주소(${WANTED})를 못 받아 임시 주소가 발급됨: ${t.url}`);
  t.on("close", () => { if (tunnel !== t) return; log("터널 종료됨"); tunnel = null; scheduleReconnect(); });
  t.on("error", (e) => { if (tunnel !== t) return; log("터널 오류: " + e.message); tunnel = null; try { t.close(); } catch {} scheduleReconnect(); });
  if (prev && prev !== t) { try { prev.close(); } catch {} }
  setState({ status: "connected", url: t.url, wanted: WANTED, fixed, password: publicIp });
  fetchPublicIp().then((ip) => { if (tunnel === t && ip) { patchState({ password: ip }); log(`접속 안내 페이지에 입력할 IP: ${ip}`); } });
  if (fixed) { reclaimTries = 0; if (reclaimTimer) { clearTimeout(reclaimTimer); reclaimTimer = null; } }
  else scheduleReclaim();
}

async function start() {
  try {
    log(`연결 시도 (subdomain=${SUBDOMAIN}, port=${PORT})`);
    adopt(await localtunnel({ port: PORT, subdomain: SUBDOMAIN }));
  } catch (e) {
    log("연결 실패: " + e.message);
    scheduleReconnect();
  }
}

// ---------- 고정 주소 등록 시도(병렬): 현재 터널은 그대로 둔 채 별도 연결로 고정 이름을 요청. 받으면 갈아탄다 ----------
// reason 이 있으면(상태 점검 경로) 결과를 로그에 남기고, 없으면(되찾기 반복) 성공할 때만 남긴다.
async function tryRegisterFixed(reason = "") {
  if (registering) return false;
  registering = true;
  try {
    const t = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
    if (t.url === WANTED) { log(reason ? `고정 주소 확보 (${reason})` : "고정 주소 되찾음"); adopt(t); return true; }
    if (reason) log(`고정 주소 요청 결과 임시 이름만 받아 폐기 (${reason}) — 서버가 기존 등록을 아직 유지 중`);
    try { t.close(); } catch {}
    return false;
  } catch (e) {
    log(`고정 주소 요청 실패: ${e.message}`);
    return false;
  } finally { registering = false; }
}

function scheduleReclaim() {
  if (reclaimTimer) return;
  reclaimTries++;
  const delay = reclaimTries <= 10 ? 30000 : 120000;
  log(`고정 주소 되찾기 ${reclaimTries}회째: ${Math.round(delay / 1000)}초 후 시도`);
  reclaimTimer = setTimeout(async () => {
    reclaimTimer = null;
    if (!tunnel || tunnel.url === WANTED || reconnectTimer) return;
    const ok = await tryRegisterFixed();
    if (!ok && tunnel && tunnel.url !== WANTED) scheduleReclaim();
  }, delay);
}

// ---------- 상태 점검: 공개 주소가 실제로 응답하는지 확인 ----------
const HEALTH_INTERVAL = 45000;             // 평상시 점검 간격
const QUICK_INTERVAL = 15000;              // 실패 중 재점검 간격
const REGISTER_AFTER_FAILS = 3;            // 이만큼 연속 실패하면 고정 이름 재등록 시도
const HARD_RECONNECT_AFTER = 5 * 60000;    // 이 시간 넘게 계속 실패하면 끊고 재연결(최후 수단)
const GONE_CODES = new Set([404, 503]);    // 서버가 이 이름의 터널을 모름 → 즉시 재등록

async function probe(url) {
  try {
    const r = await fetch(`${url}/healthz`, { headers: { "Bypass-Tunnel-Reminder": "1" }, signal: AbortSignal.timeout(15000), redirect: "manual" });
    return { status: r.status, detail: `HTTP ${r.status}` };
  } catch (e) { return { status: 0, detail: e.message }; }
}

async function healthCheck() {
  if (!tunnel || reconnectTimer || checking) return;
  checking = true;
  try {
    const t = tunnel;
    const r = await probe(t.url);
    if (tunnel !== t) return;                       // 점검 중에 터널이 바뀜
    const now = new Date().toISOString();
    if (r.status === 200) {
      if (healthFails) log(`상태 점검 정상 복귀 (${healthFails}회 실패 후)`);
      healthFails = 0; failingSince = null;
      patchState({ lastCheckAt: now, lastCheckOk: true, lastCheckDetail: r.detail });
      return;
    }
    healthFails++; failingSince ??= Date.now();
    const gone = GONE_CODES.has(r.status);
    log(`상태 점검 실패 ${healthFails}회 (${r.detail}${gone ? ", 서버에 터널 등록 없음" : ""})`);
    patchState({ lastCheckAt: now, lastCheckOk: false, lastCheckDetail: r.detail });
    // 1) 서버가 터널을 잊었거나 실패가 쌓이면: 현재 터널은 두고 고정 이름을 다시 등록해 본다
    if (gone || healthFails >= REGISTER_AFTER_FAILS) {
      if (await tryRegisterFixed(gone ? "서버에 터널 등록 없음" : `상태 점검 ${healthFails}회 연속 실패`)) return;
      if (tunnel !== t) return;
    }
    // 2) 오래 계속 실패하면 최후 수단: 끊고 재연결
    if (Date.now() - failingSince >= HARD_RECONNECT_AFTER) {
      log("공개 주소가 계속 응답하지 않아 터널을 끊고 다시 연결합니다");
      healthFails = 0; failingSince = null;
      tunnel = null; try { t.close(); } catch {}
      scheduleReconnect();
      return;
    }
    // 3) 짧은 간격으로 다시 점검
    if (quickTimer) clearTimeout(quickTimer);
    quickTimer = setTimeout(() => { quickTimer = null; healthCheck(); }, QUICK_INTERVAL);
  } finally { checking = false; }
}
setInterval(healthCheck, HEALTH_INTERVAL);

log(`tunnel.js 시작${prevState?.updatedAt ? ` (이전 프로세스 마지막 기록: ${new Date(prevState.updatedAt).toLocaleString("sv-SE")}, 상태 ${prevState.status}${prevState.url ? " " + prevState.url : ""})` : ""}`);
start();
setInterval(() => {}, 1 << 30);   // 재연결 대기 중에도 프로세스 유지
