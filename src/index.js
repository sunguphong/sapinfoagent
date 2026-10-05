// 브리핑 파이프라인: 수집 → Claude 요약 → HTML → 메일. 어느 에이전트(주제)인지는 --agent=<id> 로 받는다 (기본 sap).
//   node src/index.js --agent=realestate [--dry-run] [--collect-only] [--source=scheduler|web|manual] [--run-id=...]
import { existsSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { collect } from "./collect.js";
import { summarize } from "./summarize.js";
import { renderHtml, sendMail } from "./mail.js";
import { ROOT, DEFAULT_AGENT, loadAgent, agentPaths } from "./agents.js";

const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry-run");
const COLLECT_ONLY = args.has("--collect-only");
const getOpt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const SOURCE = getOpt("source", "manual");          // manual | scheduler | web
const RUN_ID = getOpt("run-id", new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14));
const AGENT_ID = getOpt("agent", DEFAULT_AGENT);

const agent = loadAgent(AGENT_ID);
const { logDir: LOG_DIR, outDir: OUT_DIR, runsFile: RUNS_FILE } = agentPaths(AGENT_ID, { create: true });
const runLogPath = path.join(LOG_DIR, `run-${RUN_ID}.log`);

const log = (...m) => {
  const line = `${new Date().toISOString()} ${m.join(" ")}`;
  console.log(line);
  try { appendFileSync(runLogPath, line + "\n"); } catch {}
};

// ---------- 실행 기록 (logs/<agent>/runs.json) ----------
function readRuns() {
  try { return JSON.parse(readFileSync(RUNS_FILE, "utf8")); } catch { return []; }
}
function saveRun(patch) {
  const runs = readRuns();
  const i = runs.findIndex((r) => r.id === RUN_ID);
  const rec = { ...(i >= 0 ? runs[i] : { id: RUN_ID, agent: AGENT_ID }), ...patch };
  if (i >= 0) runs[i] = rec; else runs.push(rec);
  writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(-500), null, 2));
  return rec;
}

const localDate = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");

async function main() {
  const lookbackHours = Number(agent.lookbackHours || process.env.LOOKBACK_HOURS || 24);
  const maxArticles = Number(agent.maxArticles || process.env.MAX_ARTICLES || 40);
  const mailTo = agent.mailTo || process.env.MAIL_TO || "";
  const today = new Date();
  const dateLabel = today.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const stamp = localDate(today);
  const mode = COLLECT_ONLY ? "collect-only" : DRY ? "dry-run" : "send";
  // 실행마다 별도 파일 (같은 날 여러 번 실행해도 발송본이 덮어써지지 않음)
  const base = `${stamp}_${RUN_ID}`;

  saveRun({ startedAt: today.toISOString(), date: stamp, source: SOURCE, mode, status: "running", log: path.basename(runLogPath), base });
  log(`run ${RUN_ID} start (agent=${AGENT_ID} "${agent.name}", source=${SOURCE}, mode=${mode})`);

  log(`collecting from ${agent.feeds.length} feeds...`);
  const { articles, errors, totalFetched, usedHours } = await collect({ feeds: agent.feeds, lookbackHours, maxArticles });
  log(`fetched ${totalFetched}, selected ${articles.length} (last ${usedHours}h), feed errors: ${errors.length}`);
  for (const e of errors) log("feed error:", e);
  writeFileSync(path.join(OUT_DIR, `${base}-articles.json`), JSON.stringify(articles, null, 2));
  saveRun({ fetched: totalFetched, selected: articles.length, usedHours, feedErrors: errors });
  if (COLLECT_ONLY) return {};
  if (articles.length === 0) throw new Error("수집된 기사가 없습니다");

  log("summarizing with claude...");
  const digest = summarize(articles, agent.prompt);
  writeFileSync(path.join(OUT_DIR, `${base}-digest.json`), JSON.stringify(digest, null, 2));
  const picked = (digest.categories || []).reduce((n, c) => n + c.items.length, 0);

  // skincare 에이전트용 동탄2신도시 피부관리실 통계
  let stats = null;
  if (AGENT_ID === "skincare" && agent.dongtan2Stats?.enabled) {
    try {
      const statsFile = path.join(ROOT, agent.dongtan2Stats.source);
      const statsData = JSON.parse(readFileSync(statsFile, "utf8"));
      const today = statsData[statsData.length - 1];
      const yesterday = statsData.length > 1 ? statsData[statsData.length - 2] : null;
      stats = {
        title: agent.dongtan2Stats.title,
        today: today || { date: localDate(new Date()), count: 0 },
        yesterday: yesterday,
        change: today && yesterday ? today.count - yesterday.count : 0,
      };
    } catch (e) {
      log("동탄2신도시 통계 로드 실패:", e.message);
    }
  }

  const html = renderHtml(digest, { dateLabel, articleCount: articles.length, errors, articles, title: agent.mailTitle, note: agent.note, stats });
  const htmlPath = path.join(OUT_DIR, `${base}.html`);
  writeFileSync(htmlPath, html);
  log("html saved:", htmlPath);
  saveRun({ picked, html: path.basename(htmlPath) });

  if (DRY) { log("dry-run: mail not sent"); return {}; }
  const id = await sendMail({ subject: `${agent.subjectPrefix} ${dateLabel}`, html, fromName: agent.fromName, to: mailTo });
  log("mail sent:", id, "->", mailTo);
  return { mailId: id, mailTo, mailSentAt: new Date().toISOString() };
}

main()
  .then((extra) => { saveRun({ ...extra, status: "success", finishedAt: new Date().toISOString() }); log("done"); })
  .catch((e) => {
    log("ERROR", e.stack || e.message);
    saveRun({ status: "error", error: String(e.message || e), finishedAt: new Date().toISOString() });
    process.exit(1);
  });
