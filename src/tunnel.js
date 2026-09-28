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

let tunnel = null, retry = 0, reconnectTimer = null;
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
    setState({ status: "connected", url: tunnel.url, wanted, fixed: tunnel.url === wanted });
    tunnel.on("close", () => { log("터널 종료됨"); scheduleReconnect(); });
    tunnel.on("error", (e) => { log("터널 오류: " + e.message); try { tunnel.close(); } catch {} scheduleReconnect(); });
  } catch (e) {
    log("연결 실패: " + e.message);
    scheduleReconnect();
  }
}

log("tunnel.js 시작");
start();
setInterval(() => {}, 1 << 30);   // 재연결 대기 중에도 프로세스 유지
