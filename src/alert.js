// GitHub Actions 에서 브리핑 실행이 실패했을 때 알림 메일을 보낸다.
// 사용: node src/alert.js <agent> [실행 URL]
// SMTP 로그인 자체가 실패한 경우에는 이 메일도 못 보내므로, 그때는 GitHub 기본 실패 알림에 의존한다.
import fs from "node:fs";
import path from "node:path";
import { sendMail } from "./mail.js";

const [agent = "unknown", runUrl = ""] = process.argv.slice(2);

// 브리핑 에이전트의 실패는 따로 알리지 않는다: PC 가 발송 시각 + 15분쯤 대신 보내고(local-fallback.js),
// 실패 원인과 대신 발송 여부는 08:00 총괄 에이전트 보고에 나온다. 에이전트마다 매일 오던 중복 알림을 막기 위함 (2026-11-24).
// 총괄 에이전트 자신이 실패하면 보고가 없으므로 그때만 알린다.
if (agent !== "supervisor") {
  console.log(`${agent} 실패 알림 생략 - PC 대신 발송(local-fallback)과 총괄 보고가 맡음`);
  process.exit(0);
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function lastLogLines(n = 40) {
  const dir = path.join("logs", agent);
  try {
    const logs = fs.readdirSync(dir).filter((f) => /^run-.*\.log$/.test(f)).sort();
    if (!logs.length) return "실행 로그 없음";
    return fs.readFileSync(path.join(dir, logs.at(-1)), "utf8").trimEnd().split("\n").slice(-n).join("\n");
  } catch {
    return "실행 로그 없음";
  }
}

const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const html = `<div style="font-family:sans-serif;font-size:14px;color:#222">
  <h2 style="color:#c0392b;margin:0 0 12px">브리핑 실패: ${esc(agent)}</h2>
  <p>${esc(now)} 실행이 실패해 오늘 <b>${esc(agent)}</b> 브리핑 메일이 발송되지 않았습니다.</p>
  ${runUrl ? `<p><a href="${esc(runUrl)}">GitHub Actions 실행 기록 보기</a> (Run workflow 로 다시 실행 가능)</p>` : ""}
  <p style="margin:16px 0 4px"><b>로그 마지막 부분</b></p>
  <pre style="background:#f6f6f6;padding:12px;font-size:12px;white-space:pre-wrap;word-break:break-all">${esc(lastLogLines())}</pre>
</div>`;

try {
  await sendMail({ subject: `[실패] ${agent} 브리핑 발송 실패`, html, fromName: "SAP Info Agent 알림" });
  console.log("실패 알림 메일 발송 완료");
} catch (e) {
  console.error("실패 알림 메일도 발송 실패:", e.message);
  process.exit(1);
}
