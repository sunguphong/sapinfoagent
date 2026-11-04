// 총괄 에이전트: 매일 08:00 다른 모든 에이전트의 오늘 실행 결과를 점검해 보고 메일을 만든다.
// index.js 가 agents/supervisor.json(kind: "supervisor")을 실행할 때 부른다. 수집·Claude 요약 대신 이 점검을 하고,
// 실행 기록·발송·ci-state 저장·실패 알림은 일반 에이전트와 같은 경로(index.js, briefing.yml)를 탄다.
//
// 근거 자료는 ci-state 브랜치(GitHub Actions 가 남기는 logs/<id>/runs.json, last-sent.txt, wanted-relay.json 등)다.
// GitHub Actions 안에서는 GITHUB_TOKEN 으로 지금 실행 중인 브리핑 작업도 확인한다.
// 아직 발송 시각 + 20분이 안 된 에이전트나 실행 중인 에이전트가 있으면 waitMinutes(기본 30분) 안에서 끝나기를 기다렸다가 보고한다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listAgents, ROOT } from "./agents.js";
import { C, FONT, esc } from "./mail.js";
import { LATE_MIN, localYmd, isOffDay, dueAt } from "./status.js";

const run = promisify(execFile);
const REF = "refs/remotes/origin/ci-state";
const CI = !!process.env.GITHUB_ACTIONS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = async (...args) => (await run("git", ["-C", ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;

// CI 의 체크아웃은 얕은 복제라 ci-state 도 마지막 커밋만 받는다. PC 의 전체 저장소를 얕게 만들지 않도록 PC 에서는 depth 를 주지 않는다.
async function fetchState() { await git("fetch", "-q", ...(CI ? ["--depth=1"] : []), "origin", `+ci-state:${REF}`); }
async function readState(p) { try { return await git("show", `${REF}:${p}`); } catch { return null; } }
async function readJson(p, fallback) { const t = await readState(p); try { return t ? JSON.parse(t) : fallback; } catch { return fallback; } }

// 지금 실행 중·대기 중인 브리핑 작업의 에이전트 id (GitHub Actions 안에서만; 작업 이름이 "run (<id>)")
async function activeJobs() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return null;
  const api = async (u) => {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${u}`, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    return r.json();
  };
  try {
    const ids = new Set();
    for (const status of ["in_progress", "queued"]) {
      const { workflow_runs = [] } = await api(`actions/workflows/briefing.yml/runs?status=${status}&per_page=20`);
      for (const wr of workflow_runs) {
        if (String(wr.id) === process.env.GITHUB_RUN_ID) continue;   // 이 점검 실행이 들어 있는 워크플로는 제외
        const { jobs = [] } = await api(`actions/runs/${wr.id}/jobs?per_page=50`);
        for (const j of jobs) { const m = j.status !== "completed" && j.name.match(/^run \((.+)\)$/); if (m) ids.add(m[1]); }
      }
    }
    return ids;
  } catch { return null; }
}

const minutes = (ms) => Math.round(ms / 60000);
const hm = (iso) => iso ? new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }) : "-";

// 에이전트 하나 점검
function inspect(agent, runs, lastSent, now, active) {
  const today = localYmd(now), due = dueAt(agent, now);
  const todays = runs.filter((r) => r.date === today && r.mode !== "dry-run");
  const sent = todays.filter((r) => r.status === "success" && r.mailId).slice(-1)[0] || null;
  const errs = todays.filter((r) => r.status === "error");
  const running = active?.has(agent.id) || false;
  // 최근 7일 (오늘 제외) 발송 실적: 수집 건수 평균, 발송 일수
  const past = Array.from({ length: 7 }, (_, i) => { const d = new Date(now); d.setDate(d.getDate() - (7 - i)); return d; });
  const week = [...past, now].map((d) => {
    const ymd = localYmd(d);
    return { date: ymd, sent: runs.some((r) => r.date === ymd && r.status === "success" && r.mailId), off: isOffDay(agent, d) };
  });
  const prevSent = past.map((d) => runs.filter((r) => r.date === localYmd(d) && r.status === "success" && r.mailId).slice(-1)[0]).filter(Boolean);
  const avgFetched = prevSent.length ? prevSent.reduce((n, r) => n + (r.fetched || 0), 0) / prevSent.length : null;
  const missedDays = week.slice(0, 7).filter((d) => !d.sent && !d.off).length;

  const issues = [], notes = [];
  let status;
  if (sent) {
    status = "sent";
    const late = minutes(new Date(sent.mailSentAt || sent.finishedAt) - due);
    if (late > LATE_MIN) { status = "late-sent"; issues.push(`발송 시각보다 ${late}분 늦게 발송 (${hm(sent.mailSentAt)})`); }
    if (errs.length) notes.push(`오류 ${errs.length}회 뒤 재실행으로 발송`);
    if (sent.feedErrors?.length) issues.push(`수집 경고 ${sent.feedErrors.length}건: ${sent.feedErrors.map((e) => String(e).slice(0, 120)).join(" / ")}`);
    if (avgFetched && sent.fetched != null && sent.fetched < avgFetched * 0.5) issues.push(`수집 건수 급감: ${sent.fetched}건 (최근 평균 ${Math.round(avgFetched)}건)`);
    if (!sent.picked) issues.push("메일에 실린 항목이 0건");
    if (lastSent !== today) notes.push("ci-state 발송 표시(last-sent.txt)가 오늘 날짜가 아님 — 늦은 예약 실행이 한 번 더 보낼 수 있음");
  } else if (isOffDay(agent, now)) {
    status = "off";
  } else if (running) {
    status = "working"; issues.push("점검 시각까지 실행이 끝나지 않음");
  } else if (errs.length) {
    status = "error"; issues.push(`오늘 ${errs.length}회 실행 모두 실패: ${String(errs.at(-1).error || "원인 미기록").slice(0, 200)}`);
  } else if (now - due > LATE_MIN * 60000) {
    status = "missing"; issues.push(`발송 시각(${agent.schedule})이 ${minutes(now - due)}분 지났는데 실행 기록이 없음`);
  } else {
    status = "waiting";
  }
  if (missedDays) notes.push(`최근 7일 중 미발송 ${missedDays}일`);
  return { agent, status, sent, errs, issues, notes, week, avgFetched, recipients: (agent.mailTo || process.env.MAIL_TO || "").split(",").filter((s) => s.trim()).length };
}

// PC 쪽 점검: PC 가 수집해 올려 주는 자료(relay), 관리 웹 공개 주소 응답
async function inspectPc(agents, cfg, now) {
  const items = [];
  for (const a of agents) for (const f of a.feeds || []) {
    if (!f.relay) continue;
    const r = await readJson(f.relay, null);
    const at = r?.fetchedAt ? new Date(r.fetchedAt) : null;
    const ok = at && localYmd(at) === localYmd(now);
    items.push({ ok, label: `${a.name} · ${f.name} PC 수집본`, detail: at ? `${hm(r.fetchedAt)} 수집 · ${r.items?.length ?? 0}건${ok ? "" : ` (${localYmd(at)} 자료 — 오늘 PC 수집이 없음)`}` : "수집본 없음" });
  }
  if (cfg.webUrl) {
    let detail, ok = false;
    try {
      const r = await fetch(cfg.webUrl, { headers: { "User-Agent": "sapinfoagent-supervisor" }, signal: AbortSignal.timeout(15000) });
      ok = r.status === 401 || r.ok;   // 관리 웹은 Basic 인증이라 401 이 정상 응답
      detail = ok ? "응답 정상" : `HTTP ${r.status}${r.headers.get("ngrok-error-code") ? ` (${r.headers.get("ngrok-error-code")})` : ""} — PC·터널 확인 필요`;
    } catch (e) { detail = `응답 없음 (${e.name === "TimeoutError" ? "15초 초과" : e.message}) — PC 가 꺼졌거나 터널이 끊김`; }
    items.push({ ok, label: "관리 웹 공개 주소", detail });
  }
  return items;
}

const DONE = new Set(["sent", "late-sent", "off", "error", "missing"]);

export async function runSupervisor(cfg, { log = console.log, now: nowArg } = {}) {
  // 발송 시각 15분 전 안쪽에 시작했으면(PC 가 10분 전에 실행을 요청함) 발송 시각까지 기다렸다가 점검한다
  const target = dueAt(cfg, new Date());
  const early = target - Date.now();
  if (!nowArg && early > 0 && early < 15 * 60000) { log(`waiting ${Math.ceil(early / 1000)}s until ${cfg.schedule}`); await sleep(early); }

  const agents = listAgents().filter((a) => a.kind !== "supervisor");
  const deadline = Date.now() + Number(cfg.waitMinutes ?? 30) * 60000;
  let results, now;
  for (let round = 0; ; round++) {
    await fetchState();
    now = nowArg || new Date();
    const active = await activeJobs();
    results = [];
    for (const a of agents) {
      const runs = await readJson(`logs/${a.id}/runs.json`, []);
      const lastSent = ((await readState(`logs/${a.id}/last-sent.txt`)) || "").trim();
      results.push(inspect(a, runs, lastSent, now, active));
    }
    // 아직 끝나지 않은(실행 중이거나 발송 시각 + 20분 전) 에이전트가 있으면 잠시 기다렸다 다시 본다
    const open = results.filter((r) => r.status === "working" || r.status === "waiting" && now - dueAt(r.agent, now) > -LATE_MIN * 60000);
    if (!open.length || nowArg || Date.now() + 60000 > deadline) break;
    if (round === 0) log(`waiting for: ${open.map((r) => r.agent.id).join(", ")}`);
    await sleep(60000);
  }
  const pc = await inspectPc(agents, cfg, now);
  for (const r of results) log(`${r.agent.id}: ${r.status}${r.issues.length ? ` - ${r.issues.join(" | ")}` : ""}`);
  for (const p of pc) log(`pc: ${p.label}: ${p.ok ? "ok" : "NG"} ${p.detail}`);

  const duty = results.filter((r) => r.status !== "off");
  const sentN = results.filter((r) => r.status === "sent" || r.status === "late-sent").length;
  const issueN = results.reduce((n, r) => n + r.issues.length, 0) + pc.filter((p) => !p.ok).length;
  const bad = results.filter((r) => ["error", "missing", "working"].includes(r.status));
  const overview = issueN === 0
    ? `점검 대상 ${results.length}개 에이전트 중 오늘 발송할 ${duty.length}개가 모두 정상 발송했습니다. 이상 없음.`
    : `오늘 발송 ${sentN}/${duty.length}. 확인이 필요한 항목이 ${issueN}건 있습니다${bad.length ? ` — 미발송: ${bad.map((r) => r.agent.name).join(", ")}` : ""}.`;
  return {
    html: renderReport({ cfg, results, pc, now, overview, sentN, duty: duty.length, issueN }),
    digest: { overview, categories: [], supervisor: { checkedAt: now.toISOString(), sent: sentN, duty: duty.length, issues: issueN,
      agents: results.map((r) => ({ id: r.agent.id, name: r.agent.name, status: r.status, issues: r.issues, notes: r.notes })), pc } },
    checked: results.length, issues: issueN, sentN, duty: duty.length,
  };
}

// ---------- 보고 메일 ----------
const ST = {
  sent: { label: "정상 발송", bg: "#e6f4ea", fg: "#1e6b3a", line: "#b9dfc5" },
  "late-sent": { label: "지연 발송", bg: "#fdf3dc", fg: "#8a5a00", line: "#f0d9a0" },
  check: { label: "발송·확인 필요", bg: "#fdf3dc", fg: "#8a5a00", line: "#f0d9a0" },
  working: { label: "실행 중", bg: "#e3edf9", fg: "#2c5487", line: "#bccfe8" },
  error: { label: "실패", bg: "#fde8e8", fg: "#a32020", line: "#f3bcbc" },
  missing: { label: "미실행", bg: "#fde8e8", fg: "#a32020", line: "#f3bcbc" },
  waiting: { label: "발송 전", bg: "#f0f0ee", fg: "#5c6270", line: "#dcdad3" },
  off: { label: "휴무", bg: "#f0f0ee", fg: "#5c6270", line: "#dcdad3" },
};
const ACTION = {
  error: "관리 웹 → 해당 에이전트 대시보드에서 '지금 실행'으로 다시 보내거나 GitHub Actions 실행 기록의 오류를 확인하세요.",
  missing: "PC 가 꺼져 있었거나 GitHub 실행 요청이 실패했을 수 있습니다. 관리 웹에서 '지금 실행'으로 보내 주세요.",
  working: "실행이 오래 걸리고 있습니다. 끝나면 발송되며, 30분 넘게 그대로면 GitHub Actions 에서 확인하세요.",
};

function renderReport({ cfg, results, pc, now, overview, sentN, duty, issueN }) {
  const dateLabel = now.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  const ok = issueN === 0;
  const pill = (s) => `<span style="display:inline-block;background:${ST[s].bg};color:${ST[s].fg};border:1px solid ${ST[s].line};border-radius:999px;padding:1px 10px;font-size:12px;font-weight:700;white-space:nowrap">${ST[s].label}</span>`;
  const dots = (week) => week.map((d, i) => `<span title="${d.date}" style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:3px;background:${d.sent ? "#3f9a6c" : d.off ? "#e5e2da" : i === 7 ? "#f0d9a0" : "#e08585"}"></span>`).join("");
  const order = { error: 0, missing: 1, working: 2, "late-sent": 3, sent: 4, waiting: 5, off: 6 };
  const rows = results.slice().sort((a, b) => order[a.status] - order[b.status] || String(a.agent.schedule).localeCompare(b.agent.schedule)).map((r) => {
    const s = r.sent;
    const stat = s ? `${hm(s.mailSentAt)} 발송 · 수집 ${s.fetched ?? "?"} → 선별 ${s.picked ?? "?"}건 · 수신 ${r.recipients}명` : r.status === "off" ? "오늘은 쉬는 날" : `예정 ${r.agent.schedule}`;
    const lines = [
      ...r.issues.map((t) => `<div style="color:#a32020;margin-top:4px">⚠ ${esc(t)}</div>`),
      ...r.notes.map((t) => `<div style="color:${C.text3};margin-top:4px">· ${esc(t)}</div>`),
      ACTION[r.status] ? `<div style="color:${C.goldDeep};margin-top:6px">→ ${esc(ACTION[r.status])}</div>` : "",
    ].join("");
    return `<div style="margin:0 0 10px;padding:14px 16px;background:${C.card};border:1px solid ${r.issues.length ? ST[r.status === "sent" ? "check" : r.status].line : C.line};border-radius:12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
        <td style="font-size:15px;font-weight:700;color:${C.ink}">${esc(r.agent.name)} <span style="font-size:12px;font-weight:400;color:${C.text3}">매일 ${esc(r.agent.schedule)}</span></td>
        <td align="right">${pill(r.issues.length && r.status === "sent" ? "check" : r.status)}</td>
      </tr></table>
      <div style="font-size:13px;color:${C.text2};margin-top:6px">${esc(stat)}</div>
      <div style="font-size:13px;line-height:1.6">${lines}</div>
      <div style="margin-top:8px;font-size:11px;color:${C.text3}">${dots(r.week)} 최근 7일 + 오늘</div>
    </div>`;
  }).join("");
  const pcRows = pc.map((p) => `<tr><td style="padding:6px 0;font-size:13px;color:${C.ink}">${p.ok ? "✅" : "⚠️"} ${esc(p.label)}</td><td style="padding:6px 0 6px 12px;font-size:13px;color:${p.ok ? C.text2 : "#a32020"}">${esc(p.detail)}</td></tr>`).join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>${esc(cfg.mailTitle)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
  <div style="max-width:680px;margin:0 auto;padding:28px 14px 36px;font-family:${FONT};color:${C.text}">
    <div style="background:${C.headBg};background-image:linear-gradient(135deg,${C.headBg2},${C.headBg});border-radius:16px;padding:26px 28px 24px;border:1px solid #232a36">
      <div style="font-size:11px;font-weight:700;letter-spacing:.16em;color:${C.headGold}">SAP INFO AGENT &nbsp;·&nbsp; SUPERVISOR</div>
      <div style="font-size:23px;font-weight:700;color:${C.headText};margin-top:12px;letter-spacing:-.02em">${esc(cfg.mailTitle)}</div>
      <div style="font-size:13px;color:${C.headMuted};margin-top:8px">${esc(dateLabel)} · ${hm(now.toISOString())} 점검</div>
      <div style="height:1px;background:linear-gradient(90deg,${C.headGold},rgba(217,188,130,0));margin:18px 0 14px"></div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
        <td style="padding:0 28px 0 0"><div style="font-size:11px;color:${C.headMuted}">오늘 발송</div><div style="font-size:20px;font-weight:700;color:${C.headText};margin-top:2px">${sentN}/${duty}</div></td>
        <td style="padding:0 28px 0 0"><div style="font-size:11px;color:${C.headMuted}">확인 필요</div><div style="font-size:20px;font-weight:700;color:${ok ? C.headGold : "#ff9b9b"};margin-top:2px">${issueN}건</div></td>
        <td><div style="font-size:11px;color:${C.headMuted}">판정</div><div style="font-size:20px;font-weight:700;color:${ok ? "#8fd6a8" : "#ff9b9b"};margin-top:2px">${ok ? "이상 없음" : "확인 필요"}</div></td>
      </tr></table>
    </div>
    <div style="margin:18px 0 22px;padding:16px 20px;background:${ok ? "#eef8f1" : "#fdf1f1"};border:1px solid ${ok ? "#b9dfc5" : "#f3bcbc"};border-left:3px solid ${ok ? "#3f9a6c" : "#c0392b"};border-radius:12px;font-size:14.5px;line-height:1.7">${esc(overview)}</div>
    <div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:${C.goldDeep};margin:0 0 10px">에이전트별 결과</div>
    ${rows}
    ${pcRows ? `<div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:${C.goldDeep};margin:26px 0 6px">PC · 관리 웹</div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${pcRows}</table>` : ""}
    <p style="font-size:11px;color:${C.text3};margin:28px 0 0;padding-top:14px;border-top:1px solid ${C.line}">근거: GitHub ci-state 실행 기록. 지연 기준은 발송 시각 + ${LATE_MIN}분. 7일 칸: 초록 발송 · 빨강 미발송 · 회색 휴무.${cfg.webUrl ? ` 관리 웹: <a href="${esc(cfg.webUrl)}/#office" style="color:${C.goldDeep}">${esc(cfg.webUrl)}</a>` : ""}</p>
  </div></body></html>`;
}
