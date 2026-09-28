import { existsSync, writeFileSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "./collect.js";
import { summarize } from "./summarize.js";
import { renderHtml, sendMail } from "./mail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry-run");
const COLLECT_ONLY = args.has("--collect-only");
const getOpt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SOURCE = getOpt("source", "manual");          // manual | scheduler | web
const RUN_ID = getOpt("run-id", new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14));

const LOG_DIR = path.join(ROOT, "logs");
const OUT_DIR = path.join(ROOT, "output");
const RUNS_FILE = path.join(LOG_DIR, "runs.json");
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const runLogPath = path.join(LOG_DIR, `run-${RUN_ID}.log`);

const log = (...m) => {
  const line = `${new Date().toISOString()} ${m.join(" ")}`;
  console.log(line);
  try { appendFileSync(runLogPath, line + "\n"); } catch {}
};

// ---------- 실행 기록 (logs/runs.json) ----------
function readRuns() {
  try { return JSON.parse(readFileSync(RUNS_FILE, "utf8")); } catch { return []; }
}
function saveRun(patch) {
  const runs = readRuns();
  const i = runs.findIndex((r) => r.id === RUN_ID);
  const rec = { ...(i >= 0 ? runs[i] : { id: RUN_ID }), ...patch };
  if (i >= 0) runs[i] = rec; else runs.push(rec);
  writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-500), null, 2));
  return rec;
}

const localDate = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");

async function main() {
  const lookbackHours = Number(process.env.LOOKBACK_HOURS || 24);
  const maxArticles = Number(process.env.MAX_ARTICLES || 40);
  const today = new Date();
  const dateLabel = today.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const stamp = localDate(today);
  const mode = COLLECT_ONLY ? "collect-only" : DRY ? "dry-run" : "send";
  // 실행마다 별도 파일 (같은 날 여러 번 실행해도 발송본이 덮어써지지 않음)
  const base = `${stamp}_${RUN_ID}`;

  saveRun({ startedAt: today.toISOString(), date: stamp, source: SOURCE, mode, status: "running", log: path.basename(runLogPath), base });
  log(`run ${RUN_ID} start (source=${SOURCE}, mode=${mode})`);

  log("collecting...");
  const { articles, errors, totalFetched, usedHours } = await collect({ lookbackHours, maxArticles });
  log(`fetched ${totalFetched}, selected ${articles.length} (last ${usedHours}h), feed errors: ${errors.length}`);
  for (const e of errors) log("feed error:", e);
  writeFileSync(path.join(OUT_DIR, `${base}-articles.json`), JSON.stringify(articles, null, 2));
  saveRun({ fetched: totalFetched, selected: articles.length, usedHours, feedErrors: errors });
  if (COLLECT_ONLY) return {};
  if (articles.length === 0) throw new Error("수집된 기사가 없습니다");

  log("summarizing with claude...");
  const digest = summarize(articles);
  writeFileSync(path.join(OUT_DIR, `${base}-digest.json`), JSON.stringify(digest, null, 2));
  const picked = (digest.categories || []).reduce((n, c) => n + c.items.length, 0);

  const html = renderHtml(digest, { dateLabel, articleCount: articles.length, errors, articles });
  const htmlPath = path.join(OUT_DIR, `${base}.html`);
  writeFileSync(htmlPath, html);
  log("html saved:", htmlPath);
  saveRun({ picked, html: path.basename(htmlPath) });

  if (DRY) { log("dry-run: mail not sent"); return {}; }
  const id = await sendMail({ subject: `[SAP 브리핑] ${dateLabel}`, html });
  log("mail sent:", id);
  return { mailId: id, mailTo: process.env.MAIL_TO, mailSentAt: new Date().toISOString() };
}

main()
  .then((extra) => { saveRun({ ...extra, status: "success", finishedAt: new Date().toISOString() }); log("done"); })
  .catch((e) => {
    log("ERROR", e.stack || e.message);
    saveRun({ status: "error", error: String(e.message || e), finishedAt: new Date().toISOString() });
    process.exit(1);
  });
