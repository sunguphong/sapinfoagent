// 장애 기록 화면. app.js 보다 먼저 로드되므로 여기서는 함수 정의와 이벤트 연결만 하고,
// app.js 의 헬퍼($ $$ api esc fmtDT ago badge)는 실제 호출 시점(라우팅 이후)에 쓴다.
const INC_BADGE = { down: "error", temp: "warn", restart: "src", dead: "error", warn: "mode" };
let incCache = [];

function incDur(sec) {
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60); if (m < 60) return `${m}분 ${sec % 60}초`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

async function loadIncidents() {
  const data = await api("/api/incidents");
  incCache = data.incidents;
  const c = data.current || {};
  const now = $("#inc-now"), sub = $("#inc-now-sub");
  const check = c.lastCheckAt ? ` · 마지막 점검 ${fmtDT(c.lastCheckAt).slice(11)} ${c.lastCheckOk ? "정상" : "실패 (" + (c.lastCheckDetail || "") + ")"}` : "";
  if (c.alive === false) { now.textContent = "프로세스 꺼짐"; now.className = "tile-value err"; sub.textContent = "터널이 실행되고 있지 않습니다. 시작프로그램의 'SAP Info Agent 관리웹.vbs'를 실행하세요."; }
  else if (c.status === "connected" && c.fixed) { now.textContent = "정상"; now.className = "tile-value ok"; sub.textContent = `고정 주소 연결${c.upSince ? ` · ${ago(c.upSince)}부터` : ""}${check}`; }
  else if (c.status === "connected") { now.textContent = "임시 주소"; now.className = "tile-value warn"; sub.textContent = `${c.url} · 고정 주소 되찾는 중${check}`; }
  else if (c.status === "reconnecting") { now.textContent = "재연결 중"; now.className = "tile-value warn"; sub.textContent = `${fmtDT(c.updatedAt)}부터`; }
  else if (c.status === "disabled") { now.textContent = "공개 중단"; now.className = "tile-value err"; sub.textContent = c.reason || ""; }
  else { now.textContent = "알 수 없음"; now.className = "tile-value"; sub.textContent = "터널 상태 파일이 없습니다"; }

  const s = data.stats;
  $("#inc-7d").textContent = `${s.d7.count}건`; $("#inc-7d-sub").textContent = s.d7.count ? `불통 합계 ${incDur(s.d7.seconds)}` : "장애 없음";
  $("#inc-30d").textContent = `${s.d30.count}건`; $("#inc-30d-sub").textContent = s.d30.count ? `불통 합계 ${incDur(s.d30.seconds)} · 일시 경고 ${s.warns}건` : `장애 없음 · 일시 경고 ${s.warns}건`;
  const last = incCache.find((i) => i.severity === "outage");
  $("#inc-last").textContent = last ? fmtDT(last.start).slice(5, 16) : "없음";
  $("#inc-last-sub").textContent = last ? `${last.label} · ${incDur(last.durationSec)}${last.ongoing ? " (진행 중)" : ""}` : "";

  const ongoing = incCache.find((i) => i.ongoing);
  const ban = $("#inc-ongoing");
  if (ongoing) { ban.classList.remove("hidden"); ban.innerHTML = `⚠ <b>장애 진행 중</b> · ${esc(ongoing.label)} · ${fmtDT(ongoing.start)}부터 ${incDur(ongoing.durationSec)} 경과 · ${esc(ongoing.cause)}`; }
  else ban.classList.add("hidden");
  renderIncidents();
}

function renderIncidents() {
  const f = $("#inc-filter").value;
  const rows = incCache.filter((i) => !f || i.severity === f);
  const el = $("#inc-table");
  if (!rows.length) { el.innerHTML = `<div class="empty">기록된 장애가 없습니다.</div>`; return; }
  el.innerHTML = `<table><thead><tr><th>발생</th><th>복구</th><th>지속</th><th>유형</th><th>원인</th><th>경과</th></tr></thead><tbody>${rows.map((i) => `
    <tr class="clickable${i.ongoing ? " inc-ongoing" : ""}" data-id="${esc(i.id)}" title="클릭하면 이 구간의 터널 로그를 봅니다">
      <td>${i.startEstimated ? '<span class="muted" title="직전 로그 시각 기준 추정">≈</span> ' : ""}${fmtDT(i.start)}</td>
      <td>${i.end ? fmtDT(i.end) : '<span class="badge error">진행 중</span>'}</td>
      <td>${incDur(i.durationSec)}</td>
      <td>${badge(INC_BADGE[i.type] || "mode", i.label)}</td>
      <td class="inc-cause">${esc(i.cause)}</td>
      <td class="inc-flow">${esc(i.summary)}</td>
    </tr>`).join("")}</tbody></table>`;
  $$("tr.clickable", el).forEach((tr) => tr.addEventListener("click", () => openIncident(tr.dataset.id)));
}

function openIncident(id) {
  const i = incCache.find((x) => x.id === id); if (!i) return;
  const panel = $("#inc-detail"); panel.classList.remove("hidden");
  $("#inc-detail-title").textContent = `${i.label} · ${fmtDT(i.start)} ~ ${i.end ? fmtDT(i.end) : "진행 중"} (${incDur(i.durationSec)})`;
  $("#inc-detail-meta").innerHTML = `원인: ${esc(i.cause)}<br>경과: ${esc(i.summary)}${i.startEstimated ? "<br>발생 시각은 직전 로그 시각 기준 추정치입니다 (프로세스가 로그 없이 중단됨)." : ""}`;
  $("#inc-detail-log").textContent = i.events.join("\n") || "(이 구간의 로그가 없습니다)";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openTunnelLog() {
  const panel = $("#inc-log-panel"); panel.classList.remove("hidden");
  const txt = await api("/api/tunnel-log?lines=300");
  const pre = $("#inc-log"); pre.textContent = typeof txt === "string" && txt ? txt : "(로그 없음)";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
  pre.scrollTop = pre.scrollHeight;
}

document.querySelector("#inc-filter").addEventListener("change", renderIncidents);
document.querySelector("#inc-refresh").addEventListener("click", loadIncidents);
document.querySelector("#inc-log-btn").addEventListener("click", openTunnelLog);
document.querySelector("#inc-detail-close").addEventListener("click", () => document.querySelector("#inc-detail").classList.add("hidden"));
document.querySelector("#inc-log-close").addEventListener("click", () => document.querySelector("#inc-log-panel").classList.add("hidden"));
