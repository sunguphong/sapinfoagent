import nodemailer from "nodemailer";

function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 메일 클라이언트는 CSS 변수·웹폰트·반투명 효과를 지원하지 않으므로 인라인 스타일만 쓴다.
// 관리 웹("Midnight Atelier")과 같은 톤: 차콜 헤더 + 샴페인 골드 마스트헤드, 아이보리 바탕의 카드.
const C = {
  page: "#f4f3ef", card: "#ffffff", line: "#e5e2da", lineSoft: "#eeebe4",
  ink: "#17191f", text: "#2b2f36", text2: "#5c6270", text3: "#8a8f99",
  gold: "#c8a55c", goldDeep: "#86682a", goldSoft: "#f6efdf", goldLine: "#e6d5a8",
  headBg: "#0f131b", headBg2: "#161c27", headText: "#eceef2", headMuted: "#a5adba", headGold: "#d9bc82",
  overviewBg: "#fbf9f3",
};
const FONT = "'Pretendard', 'Malgun Gothic', 'Apple SD Gothic Neo', 'Segoe UI', Roboto, sans-serif";

// digest(요약 JSON) → 메일 HTML. 제목·안내문은 에이전트 설정(mailTitle, note)에서 받는다.
export function renderHtml(digest, { dateLabel, articleCount, errors = [], articles = [], title = "데일리 브리핑", note = "" }) {
  const selected = (digest.categories || []).reduce((n, c) => n + c.items.length, 0);
  const fmtDate = (d) => d ? new Date(d).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const srcCount = {};
  for (const a of articles) srcCount[a.source] = (srcCount[a.source] || 0) + 1;
  const srcList = Object.entries(srcCount).map(([s, n]) => `${esc(s)} ${n}건`).join(" &nbsp;·&nbsp; ");
  const cats = (digest.categories || []).map((c, ci) => `
    <div style="margin:${ci ? 34 : 30}px 0 14px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:${C.goldDeep};text-transform:uppercase">${esc(c.name)}</div>
      <div style="height:1px;background:linear-gradient(90deg,${C.gold},${C.lineSoft});margin-top:8px"></div>
    </div>
    ${c.items.map((it) => `
      <div style="margin:0 0 12px;padding:16px 18px;background:${C.card};border:1px solid ${C.line};border-radius:12px">
        <div style="font-size:15.5px;font-weight:700;line-height:1.45;letter-spacing:-.01em">
          <a href="${esc(it.article.link)}" style="color:${C.ink};text-decoration:none">${esc(it.title_ko)}</a>
        </div>
        <div style="font-size:12px;color:${C.text3};margin:8px 0 10px;line-height:1.6">
          <span style="display:inline-block;background:${C.goldSoft};color:${C.goldDeep};border:1px solid ${C.goldLine};border-radius:999px;padding:1px 9px;font-weight:600">${esc(it.article.source)}</span>
          <span style="margin-left:6px">${esc(fmtDate(it.article.published))}</span><br>
          <span>원제: ${esc(it.article.title)}</span></div>
        <div style="font-size:14px;line-height:1.7;color:${C.text}">${esc(it.summary)}</div>
        <div style="font-size:13px;line-height:1.6;color:${C.goldDeep};margin-top:8px;padding-left:12px;border-left:2px solid ${C.gold}">${esc(it.why)}</div>
        <div style="font-size:12.5px;margin-top:10px"><a href="${esc(it.article.link)}" style="color:${C.goldDeep};font-weight:600;text-decoration:none">원문 보기 →</a></div>
      </div>`).join("")}`).join("");

  const errBlock = errors.length
    ? `<p style="font-size:12px;color:#be123c;margin:16px 0 0">피드 오류: ${errors.map(esc).join(" / ")}</p>` : "";

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page}">
  <div style="max-width:680px;margin:0 auto;padding:28px 14px 36px;font-family:${FONT};color:${C.text}">

    <div style="background:${C.headBg};background-image:linear-gradient(135deg,${C.headBg2},${C.headBg});border-radius:16px;padding:26px 28px 24px;border:1px solid #232a36">
      <div style="font-size:11px;font-weight:700;letter-spacing:.16em;color:${C.headGold}">SAP INFO AGENT &nbsp;·&nbsp; DAILY BRIEFING</div>
      <div style="font-size:23px;font-weight:700;color:${C.headText};margin-top:12px;letter-spacing:-.02em;line-height:1.3">${esc(title)}</div>
      <div style="font-size:13px;color:${C.headMuted};margin-top:8px">${esc(dateLabel)}</div>
      <div style="height:1px;background:linear-gradient(90deg,${C.headGold},rgba(217,188,130,0));margin:18px 0 14px"></div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
        <td style="padding:0 28px 0 0"><div style="font-size:11px;letter-spacing:.1em;color:${C.headMuted}">수집</div><div style="font-size:20px;font-weight:700;color:${C.headText};margin-top:2px">${articleCount}건</div></td>
        <td style="padding:0 28px 0 0"><div style="font-size:11px;letter-spacing:.1em;color:${C.headMuted}">선별</div><div style="font-size:20px;font-weight:700;color:${C.headGold};margin-top:2px">${selected}건</div></td>
        <td><div style="font-size:11px;letter-spacing:.1em;color:${C.headMuted}">카테고리</div><div style="font-size:20px;font-weight:700;color:${C.headText};margin-top:2px">${(digest.categories || []).length}개</div></td>
      </tr></table>
    </div>

    <div style="margin:18px 0 0;padding:18px 20px;background:${C.overviewBg};border:1px solid ${C.goldLine};border-left:3px solid ${C.gold};border-radius:12px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:${C.goldDeep};margin-bottom:8px">오늘의 요약</div>
      <div style="font-size:14.5px;line-height:1.8;color:${C.text}">${esc(digest.overview)}</div>
    </div>

    ${cats}
    ${errBlock}

    <div style="margin-top:36px;padding-top:16px;border-top:1px solid ${C.line}">
      <div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:${C.text3}">수집 출처</div>
      <div style="font-size:12px;color:${C.text2};line-height:1.8;margin-top:6px">${srcList}${note ? `<br>${esc(note)}` : ""}</div>
      <p style="font-size:11px;color:${C.text3};margin:22px 0 0">sapinfoagent · Claude 요약 · 자동 생성</p>
    </div>
  </div></body></html>`;
}

// 발신자 표시 이름과 수신자는 에이전트별로 바꿀 수 있다. to 가 비어 있으면 .env 의 MAIL_TO 를 쓴다.
export async function sendMail({ subject, html, fromName = "SAP Info Agent", to = "" }) {
  const { SMTP_USER, SMTP_PASS } = process.env;
  const toList = String(to || process.env.MAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!SMTP_USER || !SMTP_PASS || !toList.length) throw new Error("SMTP_USER / SMTP_PASS / MAIL_TO 환경변수(.env)가 필요합니다");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS.replace(/\s+/g, "") },
  });
  const info = await transporter.sendMail({
    from: `"${fromName.replace(/"/g, "'")}" <${SMTP_USER}>`,
    to: toList,
    subject, html,
  });
  return info.messageId;
}
