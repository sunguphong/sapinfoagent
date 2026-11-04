// 에이전트 오피스 화면: 모든 에이전트의 오늘 근무 상태를 카드 · 평면도 · 상태 레인으로 본다.
// app.js 보다 먼저 로드되므로 여기서는 함수 정의와 이벤트 연결만 하고, app.js 의 헬퍼($ $$ api esc fmtT ago SRC)와
// 에이전트 전환(selectAgent)은 실제 호출 시점(라우팅 이후)에 쓴다. 상태 판정은 서버(/api/office)가 한다.
const OFFICE_STATUS = {
  working: { label: "업무 중", cls: "info", order: 0 },
  error: { label: "오류", cls: "err", order: 1 },
  late: { label: "지연", cls: "warn", order: 2 },
  waiting: { label: "출근 전", cls: "neutral", order: 3 },
  sent: { label: "발송 완료", cls: "ok", order: 4 },
  off: { label: "휴무", cls: "neutral", order: 5 },
};
const OFFICE_DONE = new Set(["sent", "off"]);   // '완료 포함'을 끄면 숨기는 상태
const OFFICE_MONO = { sap: "SAP", realestate: "부동", stock: "증시", skincare: "피부", "sapmm-jobs": "MM", ces: "CES", smallbiz: "소상", supervisor: "총괄" };
const isChief = (a) => a.kind === "supervisor";   // 총괄 에이전트: 매일 다른 에이전트를 점검해 보고 메일을 보냄
let officeData = null, officeView = "cards", officeDone = true, officeTimer = null;
try { officeView = localStorage.getItem("officeView") || "cards"; officeDone = localStorage.getItem("officeDone") !== "0"; } catch {}

async function loadOffice() {
  clearTimeout(officeTimer);
  const v = (location.hash.split("/")[1] || "");   // #office/floor 처럼 보기 방식을 주소로 지정할 수 있다
  if (["cards", "floor", "lanes"].includes(v)) officeView = v;
  officeData = await api("/api/office");
  renderOffice();
  officeTimer = setTimeout(() => { if (!$("#view-office").classList.contains("hidden")) loadOffice(); }, 30000);
}

// 에이전트 한 명의 지금 상태를 한 줄로
function officeLine(a) {
  if (a.status === "working") return `${SRC[a.running.source] || a.running.source} 실행 · ${ago(a.running.startedAt)} 시작`;
  if (a.status === "sent" && isChief(a)) return `${fmtT(a.sent.mailSentAt)} 점검 보고 · ${a.sent.checked ?? "?"}명 점검 · ${a.sent.issues ? `확인 필요 ${a.sent.issues}건` : "이상 없음"}`;
  if (a.status === "sent") return `${fmtT(a.sent.mailSentAt)} 발송 · ${a.sent.picked ?? "?"}건 선별 · ${SRC[a.sent.source] || a.sent.source || ""}`;
  if (a.status === "error") return `${fmtT(a.todayError.at)} 오류 · ${a.todayError.error || "로그 확인"}`;
  if (a.status === "late") return `${a.schedule} 예정 · ${ago(a.due).replace(" 전", "")} 지남, 아직 미발송`;
  if (a.status === "off") return "오늘은 쉬는 날";
  return `${a.schedule} ${isChief(a) ? "점검" : "발송"} 예정 · ${until(a.due)}`;
}

function officeCard(a) {
  const s = OFFICE_STATUS[a.status];
  const warns = a.sent?.feedErrors?.length ? `<div class="oc-warn" title="${esc(a.sent.feedErrors.join("\n"))}">수집 경고 ${a.sent.feedErrors.length}건</div>` : "";
  return `
    <button type="button" class="oc st-${a.status}${isChief(a) ? " chief" : ""}" data-agent="${esc(a.id)}" title="${esc(a.name)} 대시보드 열기">
      <div class="oc-top">
        <span class="oc-avatar">${esc(OFFICE_MONO[a.id] || a.name.slice(0, 2))}<i class="oc-light"></i></span>
        <span class="oc-name">${esc(a.name)}<span class="oc-time">${isChief(a) ? `매일 ${esc(a.schedule)} 전체 점검 · 보고 메일` : `매일 ${esc(a.schedule)}`}</span></span>
        <span class="ostat ${s.cls}">${s.label}</span>
      </div>
      <div class="oc-line">${esc(officeLine(a))}</div>
      ${warns}
      <div class="oc-foot">
        <span class="oc-week" aria-label="최근 7일 발송">${a.week.map((d) => `<i class="${d.sent ? "on" : d.off ? "off" : ""}" title="${d.date} ${d.sent ? "발송" : d.off ? "휴무" : "미발송"}"></i>`).join("")}</span>
        <span class="muted">수신 ${a.recipients}명 · 오늘 ${a.todayRuns}회 실행</span>
      </div>
    </button>`;
}

// 평면도: 발송 시각이 같은 에이전트끼리 한 방을 쓴다
function officeFloor(list) {
  const rooms = new Map();
  for (const a of list.slice().sort((x, y) => isChief(y) - isChief(x) || x.schedule.localeCompare(y.schedule))) {
    const room = isChief(a) ? `총괄실 · ${a.schedule} 점검` : `${a.schedule} 발송실`;   // 총괄 에이전트는 따로 방을 쓴다
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(a);
  }
  return `<div class="floor">${Array.from(rooms.entries()).map(([time, agents]) => `
    <div class="room${time.startsWith("총괄") ? " chief" : ""}">
      <div class="room-name">${esc(time)} <span class="muted">${agents.length}석</span></div>
      <div class="desks">${agents.map((a) => `
        <button type="button" class="desk st-${a.status}${isChief(a) ? " chief" : ""}" data-agent="${esc(a.id)}" title="${esc(a.name)} · ${esc(OFFICE_STATUS[a.status].label)}">
          <span class="desk-mon"><span class="oc-avatar sm">${esc(OFFICE_MONO[a.id] || a.name.slice(0, 2))}<i class="oc-light"></i></span></span>
          <span class="desk-name">${esc(a.name)}</span>
          <span class="ostat ${OFFICE_STATUS[a.status].cls}">${OFFICE_STATUS[a.status].label}</span>
        </button>`).join("")}</div>
    </div>`).join("")}</div>`;
}

// 상태 레인: 상태별 칸반
function officeLanes(list) {
  const keys = Object.keys(OFFICE_STATUS).filter((k) => k !== "off" || list.some((a) => a.status === "off"));
  return `<div class="lanes">${keys.map((k) => {
    const items = list.filter((a) => a.status === k);
    return `<div class="lane st-${k}">
      <div class="lane-head"><span class="ostat ${OFFICE_STATUS[k].cls}">${OFFICE_STATUS[k].label}</span><b>${items.length}</b></div>
      ${items.map((a) => `
        <button type="button" class="lane-item" data-agent="${esc(a.id)}">
          <span class="oc-avatar sm">${esc(OFFICE_MONO[a.id] || a.name.slice(0, 2))}<i class="oc-light"></i></span>
          <span><b>${esc(a.name)}</b><span class="muted">${esc(officeLine(a))}</span></span>
        </button>`).join("") || `<div class="lane-empty">없음</div>`}
    </div>`;
  }).join("")}</div>`;
}

function renderOffice() {
  if (!officeData) return;
  const all = officeData.agents;
  const count = (k) => all.filter((a) => a.status === k).length;
  const duty = all.length - count("off"), pct = duty ? Math.round((count("sent") / duty) * 100) : 0;
  $("#office-stats").innerHTML = `
    <div class="office-progress" title="오늘 발송 진행률 ${pct}% (${count("sent")}/${duty})"><span style="width:${pct}%"></span><em>오늘 발송 ${count("sent")}/${duty}</em></div>
    <div class="ostat-tiles">${[["working", "업무 중"], ["late", "지연"], ["error", "오류"], ["waiting", "출근 전"], ["sent", "발송 완료"]]
      .map(([k, label]) => `<div class="ostat-tile st-${k}${count(k) ? " has" : ""}"><b>${count(k)}</b><span>${label}</span></div>`).join("")}</div>`;
  const work = all.filter((a) => a.status === "working");
  $("#office-summary").textContent = work.length
    ? `지금 ${work.map((a) => a.name).join(", ")}이(가) 브리핑을 만들고 있습니다.`
    : all.some((a) => a.status === "error" || a.status === "late")
      ? `확인이 필요한 에이전트가 ${all.filter((a) => a.status === "error" || a.status === "late").length}명 있습니다.`
      : count("sent") === all.length - count("off") ? "오늘 발송할 에이전트가 모두 메일을 보냈습니다." : `지금 일하는 에이전트가 없습니다. 오늘 ${count("sent")}명 발송 완료, ${count("waiting")}명 출근 전입니다.`;
  $("#office-updated").textContent = `갱신 ${fmtT(officeData.now)}`;
  $("#office-late").textContent = officeData.lateMinutes;

  const list = all.filter((a) => officeDone || !OFFICE_DONE.has(a.status))
    .sort((x, y) => isChief(y) - isChief(x) || OFFICE_STATUS[x.status].order - OFFICE_STATUS[y.status].order || x.schedule.localeCompare(y.schedule));
  const body = $("#office-body");
  const view = !list.length
    ? `<div class="office-empty">오늘 할 일이 남은 에이전트가 없습니다. '완료 포함'을 켜면 발송을 마친 에이전트도 함께 보입니다.</div>`
    : officeView === "floor" ? officeFloor(list) : officeView === "lanes" ? officeLanes(list) : `<div class="office-grid">${list.map(officeCard).join("")}</div>`;
  const legend = `<div class="office-legend">${Object.entries(OFFICE_STATUS).map(([k, s]) => `<span><i class="sw st-${k}"></i>${s.label}${k === "late" ? ` (${officeData.lateMinutes}분 초과)` : ""}</span>`).join("")}</div>`;
  body.innerHTML = view + (officeView === "floor" ? legend + `<p class="office-note">발송 시각이 같은 에이전트끼리 한 방(발송실)을 씁니다. 책상의 불빛은 그 에이전트의 오늘 상태이고, 실행 중이면 깜박입니다. 상태는 관리 웹이 GitHub 자동 실행 기록을 5분마다 받아 와 판단하므로 실제보다 최대 5분 늦을 수 있습니다.</p>` : "");
  body.querySelectorAll("[data-agent]").forEach((el) => el.addEventListener("click", () => selectAgent(el.dataset.agent, "#dashboard")));
  document.querySelectorAll("[data-ov]").forEach((b) => { const on = b.dataset.ov === officeView; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
  const done = $("#office-done"); done.classList.toggle("on", officeDone); done.setAttribute("aria-pressed", String(officeDone));
}

document.querySelectorAll("[data-ov]").forEach((b) => b.addEventListener("click", () => {
  officeView = b.dataset.ov; try { localStorage.setItem("officeView", officeView); } catch {}
  renderOffice();
}));
document.querySelector("#office-done").addEventListener("click", () => {
  officeDone = !officeDone; try { localStorage.setItem("officeDone", officeDone ? "1" : "0"); } catch {}
  renderOffice();
});
document.querySelector("#office-refresh").addEventListener("click", loadOffice);
