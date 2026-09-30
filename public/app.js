// sapinfoagent 관리 웹 프론트엔드 (의존성 없음)
// 대시보드·실행 기록·발송 메일은 사이드바에서 고른 에이전트(AGENT) 기준으로 보이고, 환경설정·장애 기록은 공통이다.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const api = async (url, opt) => { const r = await fetch(url, opt); const ct = r.headers.get("content-type") || ""; return ct.includes("json") ? r.json() : r.text(); };
const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const pad = (n) => String(n).padStart(2, "0");
const fmtDT = (iso) => { if (!iso) return "–"; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtT = (iso) => { if (!iso) return "–"; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDateK = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); const w = "일월화수목금토"[new Date(y, m - 1, d).getDay()]; return `${y}년 ${m}월 ${d}일 (${w})`; };
const ago = (iso) => { if (!iso) return ""; const s = Math.max(0, (Date.now() - new Date(iso)) / 1000); if (s < 60) return `${Math.floor(s)}초 전`; if (s < 3600) return `${Math.floor(s / 60)}분 전`; if (s < 86400) return `${Math.floor(s / 3600)}시간 전`; return `${Math.floor(s / 86400)}일 전`; };
const until = (iso) => { const s = Math.max(0, (new Date(iso) - Date.now()) / 1000); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}시간 ${m}분 후` : `${m}분 후`; };
const dur = (a, b) => { if (!a || !b) return ""; const s = Math.round((new Date(b) - new Date(a)) / 1000); return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`; };

const SRC = { scheduler: "스케줄러", web: "웹", manual: "수동(CLI)" };
const MODE = { send: "발송", "dry-run": "드라이런", "collect-only": "수집만" };
const STATUS = { success: "성공", error: "오류", running: "실행 중" };
const badge = (cls, txt) => `<span class="badge ${cls}">${esc(txt)}</span>`;

// ---------- 공용 UI 도우미 ----------
// 표의 각 셀에 머리글 텍스트를 data-label 로 붙인다 (모바일 카드 스택에서 CSS 가 라벨로 출력)
function labelTable(root) {
  $$("table", root).forEach((tbl) => {
    const heads = $$("thead th", tbl).map((th) => th.textContent.trim());
    $$("tbody tr", tbl).forEach((tr) => $$("td", tr).forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; }));
  });
}
// 클릭 가능한 행: 마우스 + 키보드(Enter/Space) 모두 열리게 하고 선택 표시를 남긴다
function bindKeyRows(root, handler) {
  $$("tr.clickable", root).forEach((tr) => {
    tr.tabIndex = 0; tr.setAttribute("role", "button");
    const open = () => { $$("tr[aria-selected]", root).forEach((x) => x.removeAttribute("aria-selected")); tr.setAttribute("aria-selected", "true"); handler(tr); };
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}
// 로그 텍스트를 <pre> 에 넣되 오류·경고 줄을 강조한다
function renderLog(pre, text) {
  const lines = String(text || "").split("\n");
  pre.innerHTML = lines.map((l) => {
    const h = esc(l);
    if (/ERROR|Exception|실패|error:|uncaught|unhandled/i.test(l)) return `<mark class="l-err">${h}</mark>`;
    if (/WARN|경고|⚠/i.test(l)) return `<mark class="l-warn">${h}</mark>`;
    return h;
  }).join("\n");
}
// 로그 도구 버튼: data-log="#pre-id" data-act="copy|bottom"
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-log]"); if (!b) return;
  const pre = $(b.dataset.log); if (!pre) return;
  if (b.dataset.act === "copy") {
    navigator.clipboard?.writeText(pre.textContent).then(() => { const t = b.textContent; b.textContent = "복사됨"; setTimeout(() => (b.textContent = t), 1500); });
  } else pre.scrollTop = pre.scrollHeight;
});

// ---------- 테마 ----------
function initTheme() {
  const html = document.documentElement;
  const q = new URLSearchParams(location.search).get("theme");   // ?theme=light|dark 로 강제(확인용)
  if (q === "light" || q === "dark") html.dataset.theme = q;
  if (!html.dataset.theme) html.dataset.theme = "dark";           // 기본은 다크
  $("#theme-toggle").addEventListener("click", () => {
    html.dataset.theme = html.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("theme", html.dataset.theme); } catch {}
  });
}

// ---------- 에이전트 선택 ----------
let AGENTS = [], AGENT = "sap";
const agentObj = () => AGENTS.find((a) => a.id === AGENT) || { id: AGENT, name: AGENT, subjectPrefix: "[브리핑]", schedule: "", task: "" };
const aq = (u) => u + (u.includes("?") ? "&" : "?") + "agent=" + encodeURIComponent(AGENT);   // 에이전트별 API 주소
async function loadAgents() {
  AGENTS = await api("/api/agents");
  let saved = null; try { saved = localStorage.getItem("agent"); } catch {}
  AGENT = AGENTS.some((a) => a.id === saved) ? saved : (AGENTS[0]?.id || "sap");
  const sel = $("#agent-select");
  sel.innerHTML = AGENTS.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("");
  sel.value = AGENT;
  sel.addEventListener("change", () => {
    AGENT = sel.value; try { localStorage.setItem("agent", AGENT); } catch {}
    applyAgentLabels();
    $("#run-log-panel").classList.add("hidden"); $("#run-result").classList.add("hidden"); watchingRunId = null;
    if ((location.hash || "").startsWith("#mails/")) location.hash = "#mails"; else route();
  });
  applyAgentLabels();
}
function applyAgentLabels() {
  const a = agentObj();
  document.documentElement.dataset.agent = a.id;
  $$(".agent-tag").forEach((el) => (el.textContent = a.name));
  $("#agent-desc").textContent = a.description || "";
  document.title = `${a.name} · SAP Info Agent 관리`;
}

// ---------- 라우팅 ----------
function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${name}`));
  $$(".menu-item").forEach((a) => { const on = a.dataset.view === name; a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  if (name === "dashboard") loadDashboard();
  if (name === "runs") loadRuns();
  if (name === "mails") loadMails();
  if (name === "settings") loadSettings();
  if (name === "incidents") loadIncidents();
}
function route() { const h = (location.hash || "#dashboard").slice(1).split("/"); if (h[0] === "mails" && h[1]) pendingMail = h[1]; showView(["dashboard", "runs", "mails", "incidents", "settings"].includes(h[0]) ? h[0] : "dashboard"); }
window.addEventListener("hashchange", route);

// ---------- 대시보드 (오늘자 판) ----------
let pollTimer = null;
async function loadDashboard() {
  const st = await api(aq("/api/status"));
  if (st.agent?.id !== AGENT) return;   // 응답 도착 전에 에이전트가 바뀜
  const running = st.running;

  // 마스트헤드: 날짜 · 에이전트 · 호수(발송 통수)
  $("#mast-date").textContent = new Date().toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  $("#mast-edition").textContent = `${st.agent.name} · 제 ${st.totals.mails}호`;

  const tState = $("#t-state");
  if (running) { tState.textContent = "실행 중"; tState.className = "tile-value warn"; $("#t-state-sub").textContent = `${SRC[running.source] || running.source} · ${fmtT(running.startedAt)} 시작`; }
  else if (st.lastRun) {
    const ok = st.lastRun.status === "success";
    const today = st.lastRun.date === new Date().toISOString().slice(0, 10) || fmtDT(st.lastRun.finishedAt).slice(0, 10) === fmtDT(new Date().toISOString()).slice(0, 10);
    tState.textContent = ok ? (st.lastRun.mailId && today ? "오늘 발행 완료" : "정상") : "마지막 실행 오류";
    tState.className = `tile-value ${ok ? "ok" : "err"}`;
    $("#t-state-sub").textContent = `${fmtDT(st.lastRun.finishedAt)} (${ago(st.lastRun.finishedAt)})`;
  }
  else { tState.textContent = "기록 없음"; tState.className = "tile-value"; $("#t-state-sub").textContent = "아직 실행된 적이 없습니다"; }

  $("#t-next").textContent = `내일 ${st.schedule.time}`.replace("내일", new Date(st.schedule.next).getDate() === new Date().getDate() ? "오늘" : "내일");
  $("#t-next-sub").textContent = `${until(st.schedule.next)} · 작업 스케줄러 "${st.schedule.task}"`;
  $("#side-schedule").textContent = `다음 호 ${st.schedule.time} · ${st.agent.name}`;

  if (st.lastSent) { $("#t-last-sent").textContent = fmtDT(st.lastSent.mailSentAt).slice(5, 16); $("#t-last-sent-sub").textContent = `${st.lastSent.mailTo || ""} · ${st.lastSent.picked ?? "?"}건 선별`; }
  else { $("#t-last-sent").textContent = "없음"; $("#t-last-sent-sub").textContent = ""; }

  renderPublic(st.tunnel, st.authEnabled);
  $("#t-totals").textContent = `${st.totals.runs}회`;
  $("#t-totals-sub").textContent = `성공 ${st.totals.success} · 오류 ${st.totals.error} · 메일 ${st.totals.mails}통`;
  $("#mail-target").textContent = st.smtpReady ? `수신: ${st.mailTo.join(", ")}` : "⚠ .env의 SMTP 설정이 비어 있어 발송할 수 없습니다";
  $("#btn-run").disabled = !!running || !st.smtpReady;
  $("#btn-dry").disabled = !!running;

  const prog = $("#run-progress");
  if (running) {
    prog.classList.remove("hidden");
    $("#run-progress-title").textContent = `실행 중… (${MODE[running.mode] || running.mode}, ${SRC[running.source] || running.source}, ${ago(running.startedAt)} 시작)`;
    try { const log = await api(aq(`/api/runs/${running.id}/log`)); renderLog($("#run-progress-log"), typeof log === "string" ? log.split("\n").filter(Boolean).slice(-4).join("\n") : ""); } catch {}
    clearTimeout(pollTimer); pollTimer = setTimeout(loadDashboard, 3000);
  } else {
    prog.classList.add("hidden");
    if (watchingRunId) { showRunResult(st); watchingRunId = null; }
  }

  const runs = await api(aq("/api/runs"));
  const recent = $("#recent-runs");
  recent.innerHTML = runsTable(runs.slice(0, 5), false);
  labelTable(recent); bindKeyRows(recent, (tr) => openRunLog(tr.dataset.id));
}

function renderPublic(t, authEnabled) {
  const state = $("#public-state"), url = $("#public-url"), hint = $("#public-hint"), details = $("#public-details");
  const tile = $("#t-public"), tileSub = $("#t-public-sub");
  const setTile = (txt, cls, sub) => { tile.textContent = txt; tile.className = `tile-value ${cls}`; tileSub.textContent = sub; };
  if (t && t.status === "connected" && t.alive === false) {
    state.className = "badge error"; state.textContent = "꺼짐 · 프로세스 없음"; url.textContent = "–";
    hint.textContent = "터널 프로세스가 실행되고 있지 않습니다. PC 로그인 시 시작프로그램으로 자동 실행되며, 지금 켜려면 시작프로그램의 'SAP Info Agent 관리웹.vbs'를 실행하세요.";
    details.open = true; setTile("꺼짐", "err", "터널 프로세스가 없습니다");
    return;
  }
  if (t && t.status === "connected") {
    state.className = t.fixed ? "badge success" : "badge warn"; state.textContent = t.fixed ? "공개 중 · 고정 주소" : "공개 중 · 임시 주소";
    url.innerHTML = `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.url)}</a>`
      + (t.password ? `<div class="public-pass">안내 페이지("IP Address")에 입력할 값: <b>${esc(t.password)}</b> <button class="btn ghost small" id="copy-pass">복사</button></div>` : "");
    hint.textContent = "처음 접속하는 브라우저에는 loca.lt 안내 페이지가 뜹니다. 위 IP 값을 입력하면 이후에는 묻지 않습니다. "
      + (authEnabled ? "그 다음 로그인 창에 환경설정의 접속 아이디·비밀번호를 입력합니다. " : "⚠ 접속 인증이 꺼져 있습니다. 환경설정에서 접속 계정을 설정하세요. ")
      + (t.fixed ? "" : `고정 주소(${t.wanted})를 아직 못 받아 임시 주소로 열려 있습니다. 30초~2분 간격으로 자동으로 되찾습니다. `)
      + (t.lastCheckAt ? `마지막 점검 ${fmtDT(t.lastCheckAt).slice(11)} ${t.lastCheckOk ? "정상" : "실패 (" + (t.lastCheckDetail || "") + ")"}.` : "");
    details.open = !(t.fixed && authEnabled && t.lastCheckOk !== false);
    setTile(t.fixed ? "공개 중" : "임시 주소", t.fixed ? "ok" : "warn", t.lastCheckAt ? `마지막 점검 ${fmtDT(t.lastCheckAt).slice(11, 16)} ${t.lastCheckOk ? "정상" : "실패"}` : t.url.replace("https://", ""));
    const cp = $("#copy-pass"); if (cp) cp.addEventListener("click", () => navigator.clipboard?.writeText(t.password).then(() => { cp.textContent = "복사됨"; setTimeout(() => (cp.textContent = "복사"), 1500); }));
  } else if (t && t.status === "reconnecting") {
    state.className = "badge running"; state.textContent = "재연결 중"; url.textContent = "–"; hint.textContent = `터널이 끊겨 다시 연결하고 있습니다 (${fmtDT(t.updatedAt)})`; details.open = true;
    setTile("재연결 중", "warn", fmtDT(t.updatedAt));
  } else if (t && t.status === "disabled") {
    state.className = "badge error"; state.textContent = "중단됨"; url.textContent = "–"; hint.textContent = `외부 공개가 중단되었습니다: ${t.reason}`; details.open = true;
    setTile("중단됨", "err", t.reason || "");
  } else {
    state.className = "badge mode"; state.textContent = "꺼짐"; url.textContent = "–"; hint.textContent = "터널이 실행되고 있지 않습니다. start-web-hidden.vbs 를 실행하거나 npm run tunnel 로 켤 수 있습니다."; details.open = true;
    setTile("꺼짐", "", "터널 상태 파일이 없습니다");
  }
}

let watchingRunId = null;
function showRunResult(st) {
  const r = st.lastRun; if (!r) return;
  const box = $("#run-result"); box.classList.remove("hidden");
  if (r.status === "success") {
    box.className = "result ok";
    box.innerHTML = r.mailId
      ? `✅ <b>발송 완료</b> · ${esc(r.mailTo || "")} · 기사 ${r.selected}건 중 ${r.picked}건 선별 · 소요 ${dur(r.startedAt, r.finishedAt)} &nbsp; <a href="#mails/${r.date}">메일 보기 →</a>`
      : `✅ <b>드라이런 완료</b> · 기사 ${r.selected}건 중 ${r.picked ?? "?"}건 선별 · 소요 ${dur(r.startedAt, r.finishedAt)} &nbsp; <a href="#mails/${r.date}">결과 HTML 보기 →</a>`;
  } else {
    box.className = "result err";
    box.innerHTML = `❌ <b>실행 오류</b> · ${esc(r.error || "")} &nbsp; <a href="#runs">로그 확인 →</a>`;
  }
}

async function triggerRun(dryRun) {
  $("#run-result").classList.add("hidden");
  const r = await api("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dryRun, agent: AGENT }) });
  if (!r.ok) { alert(r.error || "실행 실패"); return; }
  watchingRunId = r.id;
  setTimeout(loadDashboard, 800);
}
$("#btn-run").addEventListener("click", () => { if (confirm(`${agentObj().name}을(를) 지금 생성해서 메일을 발송할까요?`)) triggerRun(false); });
$("#btn-dry").addEventListener("click", () => triggerRun(true));

// ---------- 실행 기록 ----------
// 열 순서: 상태 | 시작 | 소요 | 수집→선별 | 메일 | 출처 | 모드 | (오류). 시각은 모노, 숫자는 우측 정렬. mh = 모바일에서 숨김
function runsTable(runs, full = true) {
  if (!runs.length) return `<div class="empty">실행 기록이 없습니다.<br><span class="muted">다음 발행은 예정 시각에 자동으로 이루어집니다.</span></div>`;
  const rows = runs.map((r) => `
    <tr class="clickable" data-id="${esc(r.id)}">
      <td>${badge(r.status, STATUS[r.status] || r.status)}</td>
      <td class="t">${fmtDT(r.startedAt)}</td>
      <td class="num">${dur(r.startedAt, r.finishedAt) || (r.status === "running" ? "…" : "-")}</td>
      <td class="num mh">${r.fetched != null ? `${r.fetched} → ${r.selected}${r.picked != null ? ` → <b>${r.picked}</b>` : ""}` : "-"}${r.usedHours ? ` <span class="muted">(${r.usedHours}h)</span>` : ""}</td>
      <td class="mh">${r.mailId ? "✉ " + esc(r.mailTo || "발송") : r.mode === "dry-run" ? "<span class='muted'>미발송</span>" : "-"}</td>
      <td class="mh">${badge("src", SRC[r.source] || r.source || "-")}</td>
      <td class="mh">${badge("mode", MODE[r.mode] || r.mode || "-")}</td>
      ${full ? `<td class="wrap" style="max-width:320px;color:var(--err)" title="${esc(r.error || "")}">${esc(r.error || "")}</td>` : ""}
    </tr>`).join("");
  return `<table><thead><tr><th>상태</th><th>시작</th><th class="num">소요</th><th class="num">수집 → 선택 → 선별</th><th>메일</th><th>출처</th><th>모드</th>${full ? "<th>오류</th>" : ""}</tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadRuns() {
  const all = await api(aq("/api/runs"));
  const f = $("#runs-filter").value, s = $("#runs-source").value;
  const runs = all.filter((r) => (!f || r.status === f) && (!s || r.source === s));
  const root = $("#runs-table");
  root.innerHTML = runsTable(runs, true);
  labelTable(root); bindKeyRows(root, (tr) => openRunLog(tr.dataset.id));
  const errs = all.filter((r) => r.status === "error").length;
  const chip = $("#runs-err-chip"); chip.textContent = `오류 ${errs}건`; chip.classList.toggle("hidden", !errs);
}
async function openRunLog(id) {
  if (location.hash !== "#runs") { location.hash = "#runs"; await new Promise((r) => setTimeout(r, 50)); }
  const panel = $("#run-log-panel"); panel.classList.remove("hidden");
  $("#run-log-title").textContent = `로그 · ${agentObj().name} · ${id}`;
  const txt = await api(aq(`/api/runs/${id}/log`));
  renderLog($("#run-log"), typeof txt === "string" ? txt : (txt.error || "로그가 없습니다 (스케줄러 초기 실행분은 logs/<에이전트>/날짜.log 참고)"));
  panel.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}
$("#runs-filter").addEventListener("change", loadRuns);
$("#runs-source").addEventListener("change", loadRuns);
$("#runs-refresh").addEventListener("click", loadRuns);
$("#runs-err-chip").addEventListener("click", () => { $("#runs-filter").value = "error"; loadRuns(); });
$("#run-log-close").addEventListener("click", () => $("#run-log-panel").classList.add("hidden"));

// ---------- 발송 메일 (지난 호 보관함: 일자별 그룹, 실행별 항목) ----------
let pendingMail = null, mailsCache = [];
async function loadMails() {
  mailsCache = await api(aq("/api/mails"));
  const list = $("#mails-list");
  if (!mailsCache.length) {
    list.innerHTML = `<div class="empty">${esc(agentObj().name)}은(는) 아직 발행된 호가 없습니다.<br><span class="muted">대시보드에서 드라이런으로 첫 교정쇄를 찍어 보세요.</span></div>`;
    $("#mail-title").textContent = "아직 발행된 호가 없습니다"; $("#mail-meta").textContent = ""; $("#mail-frame").src = "about:blank"; $("#mail-open").hidden = true;
    return;
  }
  const byDate = new Map();
  for (const m of mailsCache) { if (!byDate.has(m.date)) byDate.set(m.date, []); byDate.get(m.date).push(m); }
  list.innerHTML = Array.from(byDate.entries()).map(([date, items]) => `
    <div class="mail-date">${fmtDateK(date)} <span class="muted">${items.filter((x) => x.sent).length}통 발송 · ${items.length}회 생성</span></div>
    ${items.map((m) => `
      <div class="mail-item" data-base="${esc(m.base)}" tabindex="0" role="button">
        <div class="d"><span>${fmtT(m.generatedAt)} ${m.sent ? "발송" : m.mode === "dry-run" ? "드라이런" : "생성"}</span>${m.sent ? badge("success", "발송") : badge("mode", "미발송")}</div>
        <div class="s">${m.picked != null ? `${m.picked}건 선별` : ""}${m.source ? ` · ${SRC[m.source] || m.source}` : ""}${m.mailTo ? ` · ${esc(m.mailTo)}` : ""}</div>
        ${m.overview ? `<div class="o">${esc(m.overview)}</div>` : ""}
      </div>`).join("")}`).join("");
  $$(".mail-item", list).forEach((el) => {
    el.addEventListener("click", () => openMail(el.dataset.base));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMail(el.dataset.base); } });
  });
  const first = mailsCache.find((m) => m.sent) || mailsCache[0];
  openMail(pendingMail && mailsCache.some((m) => m.base === pendingMail || m.date === pendingMail)
    ? (mailsCache.find((m) => m.base === pendingMail) || mailsCache.find((m) => m.date === pendingMail && m.sent) || mailsCache.find((m) => m.date === pendingMail)).base
    : first.base);
  pendingMail = null;
}
function openMail(base) {
  const m = mailsCache.find((x) => x.base === base); if (!m) return;
  $$(".mail-item").forEach((el) => el.classList.toggle("active", el.dataset.base === base));
  $("#mail-title").textContent = `${agentObj().subjectPrefix} ${fmtDateK(m.date)}${m.sent ? "" : " (미발송)"}`;
  $("#mail-meta").innerHTML = [
    m.sent ? `✉ ${fmtDT(m.mailSentAt)} → ${esc(m.mailTo || "")}` : `메일 미발송 (${m.mode === "dry-run" ? "드라이런" : "발송 전 오류"})`,
    `생성 ${fmtDT(m.generatedAt)}${m.source ? ` · ${SRC[m.source] || m.source}` : ""}`,
    m.categories.length ? m.categories.map((c) => `${esc(c.name)} ${c.count}`).join(" · ") : "",
  ].filter(Boolean).join(" &nbsp;|&nbsp; ");
  const src = aq(`/mail/${m.file}`);
  $("#mail-frame").src = src;
  const open = $("#mail-open"); open.href = src; open.hidden = false;
  if (location.hash !== `#mails/${base}`) history.replaceState(null, "", `#mails/${base}`);
}

// ---------- 환경설정 (공통) ----------
let recipients = [], savedRecipients = [];
function msg(id, ok, html) { const el = $(id); el.className = `result ${ok ? "ok" : "err"}`; el.innerHTML = html; el.classList.remove("hidden"); }
function renderRecipients() {
  const list = $("#recip-list");
  list.innerHTML = recipients.length
    ? recipients.map((e, i) => `<div class="recip-row ${savedRecipients.includes(e) ? "" : "new"}"><span class="addr">${esc(e)}</span>${savedRecipients.includes(e) ? "" : '<span class="badge mode">저장 전</span>'}<button class="del" title="삭제" aria-label="${esc(e)} 삭제" data-i="${i}">✕</button></div>`).join("")
    : `<div class="empty">구독자가 없습니다.<br><span class="muted">주소를 추가하면 다음 조간부터 받습니다.</span></div>`;
  $$(".del", list).forEach((b) => b.addEventListener("click", () => { recipients.splice(Number(b.dataset.i), 1); renderRecipients(); }));
  const dirty = JSON.stringify(recipients) !== JSON.stringify(savedRecipients);
  $("#recip-count").textContent = `${recipients.length}명${dirty ? " · 저장되지 않은 변경 있음" : ""}`;
  $("#recip-save").disabled = !dirty;
}
function addRecipient() {
  const inp = $("#recip-input"); const v = inp.value.trim();
  if (!v) return;
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(v)) { msg("#recip-msg", false, "이메일 형식이 올바르지 않습니다."); return; }
  if (recipients.includes(v)) { msg("#recip-msg", false, "이미 목록에 있는 주소입니다."); return; }
  recipients.push(v); inp.value = ""; $("#recip-msg").classList.add("hidden"); renderRecipients(); inp.focus();
}
async function loadSettings() {
  const s = await api("/api/settings");
  savedRecipients = s.mailTo.slice(); recipients = s.mailTo.slice(); renderRecipients();
  $("#set-smtp-user").value = s.smtpUser || "";
  $("#set-smtp-pass").value = "";
  $("#set-pass-state").textContent = s.smtpPassSet ? "(설정됨)" : "(미설정 — 발송 불가)";
  $("#set-lookback").value = s.lookbackHours; $("#set-max").value = s.maxArticles;
  $("#set-env-path").textContent = s.envPath;
  $("#set-web-user").value = s.webUser || ""; $("#set-web-pass").value = "";
  $("#set-web-pass-state").textContent = s.webPassSet ? "(설정됨)" : "(미설정 — 외부 공개 불가)";
  $("#set-subdomain").value = s.subdomain || "";
  $("#set-tunnel-state").textContent = s.tunnel?.status === "connected" ? `현재 공개 주소: ${s.tunnel.url}` : "현재 외부 공개 터널이 연결되어 있지 않습니다.";
  const sched = $("#set-schedule-list");
  sched.innerHTML = `<table><thead><tr><th>에이전트</th><th>발송 시각</th><th>작업 스케줄러 이름</th><th>수집 소스</th><th>설정 파일</th></tr></thead><tbody>${(s.agents || []).map((a) => `
    <tr><td class="wrap"><b>${esc(a.name)}</b><div class="muted">${esc(a.description)}</div></td><td class="t">매일 ${esc(a.schedule)}</td><td>${esc(a.task)}</td><td class="wrap">${a.feeds.length}개 (${a.feeds.map((f) => esc(f.name) + (f.keep ? ` <span class="muted">우선 ${f.keep}건</span>` : "")).join(", ")})</td><td><code>agents/${esc(a.id)}.json</code></td></tr>`).join("")}</tbody></table>`;
  labelTable(sched);
  $("#recip-test").textContent = `저장된 수신자에게 테스트 메일 (${agentObj().name})`;
  ["#recip-msg", "#smtp-msg", "#collect-msg", "#web-msg"].forEach((id) => $(id).classList.add("hidden"));
}
$("#web-save").addEventListener("click", async () => {
  const body = { webUser: $("#set-web-user").value, subdomain: $("#set-subdomain").value };
  const pass = $("#set-web-pass").value; if (pass) body.webPass = pass;
  const s = await saveSettings(body, "#web-msg", "외부 접속 설정 저장 완료. 주소 이름을 바꿨다면 터널을 다시 시작해야 적용됩니다 (PC 재로그인 또는 start-web-hidden.vbs 실행).");
  if (s) { $("#set-web-pass").value = ""; $("#set-web-pass-state").textContent = s.webPassSet ? "(설정됨)" : "(미설정 — 외부 공개 불가)"; }
});
async function saveSettings(body, msgId, okText) {
  const r = await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { msg(msgId, false, `❌ ${esc(r.error)}`); return null; }
  msg(msgId, true, `✅ ${okText}`);
  return r.settings;
}
$("#recip-add").addEventListener("click", addRecipient);
$("#recip-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addRecipient(); } });
$("#recip-save").addEventListener("click", async () => {
  const s = await saveSettings({ mailTo: recipients }, "#recip-msg", `수신자 저장 완료: ${esc(recipients.join(", "))}`);
  if (s) { savedRecipients = s.mailTo.slice(); recipients = s.mailTo.slice(); renderRecipients(); }
});
$("#recip-test").addEventListener("click", async () => {
  const dirty = JSON.stringify(recipients) !== JSON.stringify(savedRecipients);
  if (dirty && !confirm("저장되지 않은 변경이 있습니다. 저장된 수신자 기준으로 테스트 메일을 보낼까요?")) return;
  const btn = $("#recip-test"); btn.disabled = true; const label = btn.textContent; btn.textContent = "보내는 중…";
  try {
    const r = await api("/api/mail-test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: AGENT }) });
    msg("#recip-msg", r.ok, r.ok ? `✅ 테스트 메일 발송 완료 → ${esc(r.to.join(", "))} (${esc(r.agent)}/${esc(r.file)})` : `❌ ${esc(r.error)}`);
  } finally { btn.disabled = false; btn.textContent = label; }
});
$("#smtp-save").addEventListener("click", async () => {
  const body = { smtpUser: $("#set-smtp-user").value };
  const pass = $("#set-smtp-pass").value; if (pass.trim()) body.smtpPass = pass;
  const s = await saveSettings(body, "#smtp-msg", "발신 계정 저장 완료");
  if (s) { $("#set-smtp-pass").value = ""; $("#set-pass-state").textContent = s.smtpPassSet ? "(설정됨)" : "(미설정 — 발송 불가)"; }
});
$("#collect-save").addEventListener("click", () => saveSettings({ lookbackHours: $("#set-lookback").value, maxArticles: $("#set-max").value }, "#collect-msg", "수집 옵션 저장 완료"));

// ---------- 시계 · 시작 ----------
setInterval(() => { $("#side-clock").textContent = fmtDT(new Date().toISOString()); }, 1000);
initTheme();
loadAgents().then(route).catch((e) => { console.error(e); route(); });
