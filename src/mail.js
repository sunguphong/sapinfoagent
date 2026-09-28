import nodemailer from "nodemailer";

function esc(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderHtml(digest, { dateLabel, articleCount, errors = [], articles = [] }) {
  const selected = (digest.categories || []).reduce((n, c) => n + c.items.length, 0);
  const fmtDate = (d) => d ? new Date(d).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const srcCount = {};
  for (const a of articles) srcCount[a.source] = (srcCount[a.source] || 0) + 1;
  const srcList = Object.entries(srcCount).map(([s, n]) => `${esc(s)} ${n}건`).join(" · ");
  const cats = (digest.categories || []).map((c) => `
    <h2 style="font-size:16px;color:#0a6ed1;border-bottom:2px solid #0a6ed1;padding-bottom:4px;margin:28px 0 12px">${esc(c.name)}</h2>
    ${c.items.map((it) => `
      <div style="margin:0 0 16px;padding:12px 14px;background:#f7f9fb;border-radius:8px">
        <div style="font-size:15px;font-weight:600;line-height:1.4">
          <a href="${esc(it.article.link)}" style="color:#1a1a1a;text-decoration:none">${esc(it.title_ko)}</a>
        </div>
        <div style="font-size:12px;color:#777;margin:6px 0 8px;line-height:1.5">
          <span style="display:inline-block;background:#e3eefc;color:#0a6ed1;border-radius:3px;padding:1px 6px;font-weight:600">출처: ${esc(it.article.source)}</span>
          <span style="margin-left:6px">${esc(fmtDate(it.article.published))}</span><br>
          <span style="color:#999">원제: ${esc(it.article.title)}</span></div>
        <div style="font-size:14px;line-height:1.6;color:#333">${esc(it.summary)}</div>
        <div style="font-size:13px;line-height:1.5;color:#0a6ed1;margin-top:6px">▶ ${esc(it.why)}</div>
        <div style="font-size:12px;margin-top:6px"><a href="${esc(it.article.link)}" style="color:#0a6ed1">원문 보기 →</a></div>
      </div>`).join("")}`).join("");

  const errBlock = errors.length
    ? `<p style="font-size:12px;color:#b00">피드 오류: ${errors.map(esc).join(" / ")}</p>` : "";

  return `<!doctype html><html><body style="margin:0;padding:0;background:#eef1f4">
  <div style="max-width:680px;margin:0 auto;padding:24px 16px;font-family:'Malgun Gothic','Apple SD Gothic Neo','Segoe UI',sans-serif;background:#fff">
    <h1 style="font-size:22px;margin:0 0 4px">📰 SAP 데일리 브리핑</h1>
    <div style="font-size:13px;color:#777;margin-bottom:20px">${esc(dateLabel)} · 수집 ${articleCount}건 중 ${selected}건 선별</div>
    <div style="font-size:14px;line-height:1.7;padding:14px 16px;background:#fff8e1;border-left:4px solid #f0ab00;border-radius:4px">${esc(digest.overview)}</div>
    ${cats}
    ${errBlock}
    <h2 style="font-size:14px;color:#555;border-top:1px solid #ddd;padding-top:12px;margin:28px 0 6px">수집 출처</h2>
    <div style="font-size:12px;color:#777;line-height:1.6">${srcList}<br>영문 기사는 Claude가 한국어로 번역·요약했습니다. 각 항목의 "원제"는 원문 제목입니다.</div>
    <p style="font-size:11px;color:#aaa;margin-top:32px">sapinfoagent · 자동 생성 (Claude 요약)</p>
  </div></body></html>`;
}

export async function sendMail({ subject, html }) {
  const { SMTP_USER, SMTP_PASS, MAIL_TO } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !MAIL_TO) throw new Error("SMTP_USER / SMTP_PASS / MAIL_TO 환경변수(.env)가 필요합니다");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS.replace(/\s+/g, "") },
  });
  const info = await transporter.sendMail({
    from: `"SAP Info Agent" <${SMTP_USER}>`,
    to: MAIL_TO.split(",").map((s) => s.trim()).filter(Boolean),
    subject, html,
  });
  return info.messageId;
}
