// localtunnel 로 관리 웹(5174)을 고정 주소로 외부에 공개한다. 끊기면 자동 재연결.
// 주소: https://<LT_SUBDOMAIN>.loca.lt  (기본 sap-info-agent)
// 외부 공개 시에는 .env 의 WEB_USER / WEB_PASS (Basic Auth) 가 반드시 설정되어 있어야 한다.
import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import localtunnel from "localtunnel";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = Number(process.env.PORT || 5174);
const SUBDOMAIN = process.env.LT_SUBDOMAIN || "sap-info-agent";
const LOG_DIR = path.join(ROOT, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "tunnel.log");
const STATE_FILE = path.join(LOG_DIR, "tunnel.json");   // 관리 웹 대시보드가 읽어 공개 주소 표시

const ts = () => new Date().toLocaleString("sv-SE");
function log(m) { const line = `[${ts()}] ${m}`; try { appendFileSync(LOG_FILE, line + "\n"); } catch {} console.log(line); }
function setState(s) { try { writeFileSync(STATE_FILE, JSON.stringify({ ...s, updatedAt: new Date().toISOString() })); } catch {} }

if (!process.env.WEB_USER || !process.env.WEB_PASS) {
  log("⚠ .env 에 WEB_USER / WEB_PASS 가 없어 외부 공개를 중단합니다 (인증 없이 공개되는 것을 막기 위함)");
  setState({ status: "disabled", reason: "WEB_USER/WEB_PASS 미설정" });
  process.exit(1);
}

process.on("uncaughtException", (e) => log("uncaughtException: " + (e?.stack || e)));
process.on("unhandledRejection", (e) => log("unhandledRejection: " + (e?.stack || e)));

let tunnel = null, retry = 0, reconnectTimer = null, reclaimTries = 0;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30000, 2000 * 2 ** retry++);
  log(`재연결 예약: ${Math.round(delay / 1000)}초 후`);
  setState({ status: "reconnecting", subdomain: SUBDOMAIN });
  reconnectTimer = setTimeout(() => { reconnectTimer = null; start(); }, delay);
}
async function start() {
  try {
    log(`연결 시도 (subdomain=${SUBDOMAIN}, port=${PORT})`);
    tunnel = await localtunnel({ port: PORT, subdomain: SUBDOMAIN });
    retry = 0;
    const wanted = `https://${SUBDOMAIN}.loca.lt`;
    log(`터널 연결됨 → ${tunnel.url}`);
    if (tunnel.url !== wanted) log(`⚠ 원하던 주소(${wanted})를 못 받아 임시 주소가 발급됨: ${tunnel.url}`);
    // loca.lt 안내 페이지에서 묻는 "IP" = 이 PC의 공인 IP. 대시보드에 표시하기 위해 조회해 둔다.
    let password = null;
    try { password = (await (await fetch("https://loca.lt/mytunnelpassword", { signal: AbortSignal.timeout(15000) })).text()).trim(); } catch (e) { log("공인 IP 조회 실패: " + e.message); }
    const fixed = tunnel.url === wanted;
    setState({ status: "connected", url: tunnel.url, wanted, fixed, password });
    if (password) log(`접속 안내 페이지에 입력할 IP: ${password}`);
    tunnel.on("close", () => { log("터널 종료됨"); scheduleReconnect(); });
    tunnel.on("error", (e) => { log("터널 오류: " + e.message); try { tunnel.close(); } catch {} scheduleReconnect(); });
    // 고정 이름을 못 받았으면(직전 터널이 아직 이름을 점유 중인 경우 등) 30초 뒤 다시 시도해 되찾는다
    if (!fixed && reclaimTries < 10) {
      reclaimTries++;
      log(`고정 주소 되찾기 ${reclaimTries}/10회: 30초 후 재연결`);
      setTimeout(() => { if (tunnel && tunnel.url !== wanted) { log("고정 주소 되찾기 위해 임시 터널 종료"); tunnel.close(); } }, 30000);
    } else if (fixed) reclaimTries = 0;
  } catch (e) {
    log("연결 실패: " + e.message);
    scheduleReconnect();
  }
}

// ---------- 상태 점검: 공개 주소가 실제로 응답하는지 주기적으로 확인 ----------
// localtunnel 은 서버 쪽에서 연결이 끊겨도(503 Tunnel Unavailable) close/error 이벤트를 주지 않는 경우가 있어
// 공개 주소를 직접 호출해 보고, 연속 2회 실패하면 터널을 닫아 재연결시킨다.
const HEALTH_MAX_FAILS = 3;   // loca.lt 가 일시적으로 408/502 를 내는 경우가 있어 연속 3회(약 2분) 실패 시에만 재연결
let healthFails = 0;
async function healthCheck() {
  if (!tunnel || reconnectTimer) return;
  let ok = false, detail = "";
  try {
    const r = await fetch(`${tunnel.url}/healthz`, { headers: { "Bypass-Tunnel-Reminder": "1" }, signal: AbortSignal.timeout(15000), redirect: "manual" });
    ok = r.status === 200; detail = `HTTP ${r.status}`;
  } catch (e) { detail = e.message; }
  if (ok) { if (healthFails) log("상태 점검 정상 복귀"); healthFails = 0; return; }
  healthFails++;
  log(`상태 점검 실패 ${healthFails}/${HEALTH_MAX_FAILS} (${detail})`);
  if (healthFails >= HEALTH_MAX_FAILS) {
    healthFails = 0;
    log("공개 주소가 응답하지 않아 터널을 다시 연결합니다");
    setState({ status: "reconnecting", subdomain: SUBDOMAIN });
    const t = tunnel; tunnel = null;
    try { t.close(); } catch {}
    scheduleReconnect();
  }
}
setInterval(healthCheck, 45000);

log("tunnel.js 시작");
start();
setInterval(() => {}, 1 << 30);   // 재연결 대기 중에도 프로세스 유지
