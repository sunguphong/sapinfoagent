// 개발구성 화면: 이 사이트와 브리핑 메일이 돌아가는 인프라(내 PC · GitHub · 외부 서비스)를 구성도·저장 위치 표·기술 목록으로 보여 준다.
// 구성도는 고정 좌표의 SVG 이고, 상자 안 일부 줄(가동 시간, ngrok 실행 여부 등)만 /api/infra 의 실시간 값으로 채운다.
// app.js 보다 먼저 로드되므로 헬퍼($ api esc fmtT ago)는 실제 호출 시점에 쓴다.
let infraData = null;

const infraBytes = (n) => {
  if (n == null) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)} ${u[i]}`;
};
const infraUptime = (s) => {
  if (s == null) return "–";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`;
};
const infraDT = (iso) => iso ? new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "–";

async function loadInfra() {
  $("#infra-time").textContent = "불러오는 중…";
  infraData = await api("/api/infra");
  renderInfra();
}

function renderInfra() {
  const d = infraData;
  if (!d) return;
  $("#infra-time").textContent = new Date(d.checkedAt).toLocaleString("ko-KR", { hour12: true });
  const tile = (v, label, cls = "") => `<div class="infra-tile ${cls}"><b>${v}</b><span>${label}</span></div>`;
  const diskPct = d.disk ? d.disk.free / d.disk.total : 1;
  $("#infra-tiles").innerHTML = [
    tile(infraUptime(d.uptimeSec), `관리 웹 가동 시간 (마지막 재시작 ${infraDT(d.startedAt)})`),
    tile(infraBytes(d.data.bytes), `데이터 크기 (JSON·HTML 파일 ${d.data.files.toLocaleString()}개)`),
    tile(d.disk ? infraBytes(d.disk.free) : "–", d.disk ? `디스크 남은 공간 (${esc(d.disk.drive)} 전체 ${infraBytes(d.disk.total)})` : "디스크 정보 없음", diskPct < 0.1 ? "warn" : ""),
    tile(infraBytes(d.memory.used), `메모리 사용 (전체 ${infraBytes(d.memory.total)}, 앱 ${infraBytes(d.memory.app)})`),
    tile(`${d.agents.total}개`, `에이전트 (브리핑 ${d.agents.briefing} · 총괄 ${d.agents.supervisor})`),
    tile(`${d.agents.sentToday}/${d.agents.dutyToday}`, "오늘 발송 완료", d.agents.sentToday < d.agents.dutyToday ? "" : "ok"),
  ].join("");
  $("#infra-diagram").innerHTML = infraSvg(d);
  $("#infra-storage").innerHTML = infraStorage();
  $("#infra-stack").innerHTML = infraStack(d);
}

// ---------- 구성도 (SVG) ----------
// live: [ok(true/false/null), 문구] — 상자 오른쪽 위 점 색과 마지막 줄
function infraLive(d) {
  const recent = (iso, min) => iso && Date.now() - new Date(iso) < min * 60000;
  const t = d.task, gh = d.lastGithubRun, s = d.lastSync;
  return {
    ngrokexe: d.ngrok == null ? [null, "실행 여부 확인 불가"] : d.ngrok ? [true, "지금 실행 중"] : [false, "꺼져 있음 — watchdog 이 다시 띄움"],
    server: [true, `${d.node} · 포트 ${d.port} · 가동 ${infraUptime(d.uptimeSec)}`],
    json: [null, `지금 ${infraBytes(d.data.bytes)} (파일 ${d.data.files.toLocaleString()}개)`],
    watchdog: !t ? [null, "작업 정보 확인 불가"] : recent(t.last, 12) ? [true, `마지막 실행 ${fmtT(t.last)} · 다음 ${fmtT(t.next)}`] : [false, `마지막 실행 ${infraDT(t.last)} — 멈춤?`],
    actions: !gh ? [null, "실행 기록 없음"] : [gh.status === "success", `최근 ${infraDT(gh.finishedAt)} ${gh.status === "success" ? "완료" : "실패"} (${gh.agent})`],
    cistate: !s ? [null, "아직 가져오지 않음"] : s.error ? [false, `가져오기 실패 ${fmtT(s.at)}`] : [true, `PC 로 가져옴 ${fmtT(s.at)}`],
  };
}

const INFRA_NODES = [
  { id: "user", k: "user", x: 20, y: 240, w: 190, h: 112, icon: "👤", title: "사용자", lines: ["PC · 휴대폰 브라우저", "관리 웹: 아이디·비밀번호", "메일은 각자 메일함에서"] },
  { id: "tunnel", k: "ext", x: 250, y: 70, w: 190, h: 112, icon: "🌐", title: "ngrok 터널", lines: ["무료 · 고정 주소", "repaying-showing-", "gooey.ngrok-free.dev"] },
  { id: "ngrokexe", k: "pc", x: 490, y: 90, w: 310, h: 92, icon: "🔒", title: "ngrok 에이전트 (ngrok.exe)", lines: ["PC 서버를 https 로 내보냄"] },
  { id: "server", k: "pc", x: 490, y: 240, w: 310, h: 120, icon: "⚙️", title: "Node.js 관리 웹 (server.js)", lines: ["실행·기록·발송 메일·설정 화면", "5분마다 GitHub 기록 가져오기"] },
  { id: "json", k: "pc", x: 490, y: 420, w: 310, h: 120, icon: "🗄️", title: "JSON 파일 (DB 없음)", lines: ["logs/ 실행 기록 · output/ 발송본", "agents/*.json 설정 · .env 비밀값"] },
  { id: "watchdog", k: "pc", x: 490, y: 600, w: 310, h: 158, icon: "🕒", title: "작업 스케줄러 · 5분마다", lines: ["watchdog.ps1", "웹 서버·터널 꺼지면 다시 실행", "06:30~ 원티드 PC 수집 → 업로드", "발송 10분 전 GitHub 실행 요청"] },
  { id: "repo", k: "gh", x: 918, y: 90, w: 224, h: 100, icon: "📦", title: "저장소 (main)", lines: ["소스 코드", "agents/*.json 에이전트 설정"] },
  { id: "actions", k: "gh", x: 918, y: 240, w: 224, h: 140, icon: "🤖", title: "GitHub Actions", lines: ["briefing.yml · 에이전트별 실행", "수집 → Claude 요약 → 메일", "예약 실행 + PC 실행 요청"] },
  { id: "cistate", k: "gh", x: 918, y: 430, w: 224, h: 120, icon: "🗂️", title: "ci-state 브랜치", lines: ["실행 기록 · 발송 표시", "발송 메일 원본 · 공고 이력"] },
  { id: "pages", k: "gh", x: 918, y: 610, w: 224, h: 100, icon: "📄", title: "GitHub Pages", lines: ["jobs.html 공고 이력 팝업", "(채용 메일의 링크)"] },
  { id: "sources", k: "ext", x: 1210, y: 90, w: 200, h: 130, icon: "📰", title: "수집 대상", lines: ["Google News RSS", "원티드·LinkedIn·리멤버", "사람인·잡코리아·지자체"] },
  { id: "claude", k: "ext", x: 1210, y: 260, w: 200, h: 100, icon: "✳️", title: "Claude (Opus)", lines: ["Claude Code CLI", "기사 선별 · 요약"] },
  { id: "smtp", k: "ext", x: 1210, y: 420, w: 200, h: 100, icon: "✉️", title: "Gmail SMTP", lines: ["nodemailer · 앱 비밀번호", "수신자별로 따로 발송"] },
  { id: "inbox", k: "ext", x: 1210, y: 580, w: 200, h: 100, icon: "📬", title: "받는 메일함", lines: ["Gmail · 다음 메일", "매일 06:55 ~ 08:00"] },
];
// [경로, 라벨, 라벨 x, 라벨 y, 옵션]  옵션: dash(점선) both(양방향) halo(교차 지점 끊어 보이기) green(코드 반영)
const INFRA_EDGES = [
  ["M115,240 V126 H250", "관리 웹 접속 (HTTPS)", 124, 196, { start: true }],
  ["M440,126 H490", "터널", 465, 118, { mid: true }],
  ["M645,182 V240", "localhost:5174", 655, 216],
  ["M645,360 V420", "읽기 · 쓰기", 655, 396, { both: true }],
  ["M490,690 H480 V136 H490 M480,300 H490", "", 0, 0, { dash: true, ends: [[490, 136], [490, 300]] }],
  ["M800,670 H860 V350 H918", "실행 요청", 804, 662],
  ["M800,720 H880 V520 H918", "수집본 업로드", 804, 740],
  ["M918,470 H830 V320 H800", "5분마다", 866, 450, { halo: true, line2: "가져오기" }],
  ["M820,112 H918", "git push", 869, 104, { mid: true, green: true }],
  ["M1030,190 V240", "코드 · 설정", 1040, 220],
  ["M1030,380 V430", "기록 저장 · 불러오기", 1040, 410, { both: true }],
  ["M1030,550 V610", "공고 이력 읽기", 1040, 585],
  ["M1142,265 H1176 V155 H1210", "수집", 1193, 147, { mid: true }],
  ["M1142,310 H1210", "요약", 1176, 302, { mid: true }],
  ["M1142,355 H1176 V470 H1210", "발송", 1193, 462, { mid: true }],
  ["M1310,520 V580", "수신자별 발송", 1320, 555],
];

function infraSvg(d) {
  const live = infraLive(d);
  const box = (n) => {
    const lv = live[n.id];
    const lines = [...n.lines, ...(lv ? [lv[1]] : [])];
    const dot = lv && lv[0] !== null ? `<circle cx="${n.x + n.w - 16}" cy="${n.y + 20}" r="5" class="ldot ${lv[0] ? "ok" : "err"}"/>` : "";
    return `<g class="inode ${n.k}">
      <rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="12"/>
      <text x="${n.x + 16}" y="${n.y + 27}" class="it">${n.icon} ${esc(n.title)}</text>
      ${lines.map((l, i) => `<text x="${n.x + 16}" y="${n.y + 50 + i * 18}" class="il${lv && i === lines.length - 1 ? ` live${lv[0] === false ? " bad" : ""}` : ""}">${esc(l)}</text>`).join("")}
      ${dot}</g>`;
  };
  const edge = ([p, label, lx, ly, o = {}]) => {
    const cls = `iedge${o.dash ? " dash" : ""}${o.green ? " green" : ""}`;
    const marker = o.green ? "url(#ia-g)" : "url(#ia)";
    const path = o.ends
      ? `<path d="${p}" class="${cls}"/>${o.ends.map(([x, y]) => `<path d="M${x - 9},${y - 5} L${x},${y} L${x - 9},${y + 5}" class="ihead"/>`).join("")}`
      : `${o.halo ? `<path d="${p}" class="ihalo"/>` : ""}<path d="${p}" class="${cls}" marker-end="${marker}"${o.both ? ` marker-start="${marker}"` : ""}/>`;
    const anchor = o.mid ? "middle" : "start";
    const text = label ? `<text x="${lx}" y="${ly}" text-anchor="${anchor}" class="ilabel${o.green ? " green" : ""}">${esc(label)}</text>${o.line2 ? `<text x="${lx}" y="${ly + 13}" text-anchor="${anchor}" class="ilabel">${esc(o.line2)}</text>` : ""}` : "";
    return path + text;
  };
  return `<svg class="infra-svg" viewBox="0 0 1430 790" role="img" aria-label="sapinfoagent 인프라 구성도">
    <defs>
      <marker id="ia" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="imark"/></marker>
      <marker id="ia-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="imark green"/></marker>
    </defs>
    <rect x="470" y="20" width="350" height="760" rx="18" class="igroup pc"/>
    <text x="490" y="50" class="ig">💻 내 PC · Windows</text>
    <text x="490" y="70" class="igs">${esc(d.root || "D:\\ANTI\\sapinfoagent")} · 꺼지면 관리 웹만 멈춤</text>
    <rect x="900" y="20" width="260" height="760" rx="18" class="igroup gh"/>
    <text x="918" y="50" class="ig">☁️ GitHub · 클라우드</text>
    <text x="918" y="70" class="igs">PC 가 꺼져도 메일 발송은 계속</text>
    ${INFRA_EDGES.map(edge).join("")}
    ${INFRA_NODES.map(box).join("")}
  </svg>`;
}

// ---------- 저장 위치 표 ----------
function infraStorage() {
  const rows = [
    ["에이전트 설정", "수집 소스 · Claude 지시문 · 수신자 · 발송 시각", "GitHub 저장소 <code>agents/*.json</code> (PC 에도 같은 사본)", "관리 웹 환경설정에서 수신자 변경 → git push"],
    ["비밀값", "Gmail 계정·앱 비밀번호 · Claude 토큰 · 관리 웹 비밀번호", "PC <code>.env</code> · GitHub Secrets", "저장소에는 올리지 않음"],
    ["실행 기록", "언제 · 어디서 실행했는지, 수집·선별 건수, 오류", "GitHub <code>ci-state</code> 브랜치 <code>logs/&lt;id&gt;/runs.json</code> → PC <code>logs/</code>", "관리 웹이 5분마다 git fetch 로 복사"],
    ["오늘 발송 표시", "같은 날 두 번 보내지 않도록", "<code>ci-state</code> <code>logs/&lt;id&gt;/last-sent.txt</code>", "예약·PC 실행 요청 모두 이것을 보고 건너뜀"],
    ["보낸 메일 원본", "메일 HTML · Claude 요약 결과(JSON)", "<code>ci-state</code> <code>output/&lt;id&gt;/</code> → PC <code>output/</code>", "관리 웹 '발송 메일'에서 열람"],
    ["본 기사 · 공고 이력", "이미 보낸 링크(새 글 표시), 회사별 1년 공고 횟수", "<code>ci-state</code> <code>seen.json</code> · <code>job-history.json</code>", "GitHub Pages <code>jobs.html</code> 이 직접 읽음"],
    ["원티드 PC 수집본", "GitHub 에서 막힌 원티드를 PC 가 대신 수집", "<code>ci-state</code> <code>logs/sapmm-jobs/wanted-relay.json</code>", "매일 06:30 이후 watchdog 이 업로드"],
    ["감시 · 터널 로그", "watchdog 동작, ngrok 재시작, 장애 기록", "PC <code>logs/watchdog.log</code> · <code>ngrok.log</code> · <code>tunnel.log</code>", "관리 웹 '장애 기록'의 근거"],
  ];
  return `<div class="table-wrap"><table class="infra-table"><thead><tr><th>데이터</th><th>내용</th><th>저장 위치</th><th>비고</th></tr></thead><tbody>
    ${rows.map(([a, b, c, e]) => `<tr><td><b>${a}</b></td><td class="wrap">${b}</td><td class="wrap">${c}</td><td class="wrap muted">${e}</td></tr>`).join("")}
  </tbody></table></div><p class="footnote">데이터베이스는 쓰지 않습니다. 모든 기록이 JSON 파일이고, GitHub 의 ci-state 브랜치가 원본, PC 는 사본입니다. PC 가 꺼져 있어도 기록은 GitHub 에 쌓이고, 켜면 관리 웹이 따라잡습니다.</p>`;
}

// ---------- 사용 기술 ----------
function infraStack(d) {
  const groups = [
    ["실행 환경", [["Node.js", `${d.node} (PC) · 22 (GitHub)`], ["Windows 작업 스케줄러", "watchdog.vbs → watchdog.ps1"], ["PowerShell", "감시 · 실행 요청"]]],
    ["클라우드", [["GitHub Actions", "briefing.yml · ubuntu-24.04"], ["GitHub 브랜치 저장", "ci-state"], ["GitHub Pages", "docs/jobs.html"]]],
    ["외부 서비스", [["Claude Code CLI", "Opus · 요약·선별"], ["Gmail SMTP", "nodemailer"], ["ngrok", "무료 고정 주소 터널"]]],
    ["수집", [["rss-parser", "Google News 등 RSS"], ["fetch", "원티드·LinkedIn·리멤버·사람인·잡코리아 등 9종"], ["git credential", "PC 업로드용 GitHub 토큰"]]],
  ];
  return `<div class="stack-grid">${groups.map(([g, items]) => `<div class="stack-col"><div class="stack-h">${g}</div>${items.map(([n, s]) => `<div class="stack-item"><b>${n}</b><span>${esc(s)}</span></div>`).join("")}</div>`).join("")}</div>`;
}

document.querySelector("#infra-refresh").addEventListener("click", loadInfra);
