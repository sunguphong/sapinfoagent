// 최근 생성된 output/*.html을 그대로 발송해 SMTP 설정만 빠르게 점검한다 (수집·요약 생략)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendMail } from "./mail.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const outDir = path.join(ROOT, "output");
const latest = readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}(_\d+)?\.html$/.test(f)).sort().pop();
if (!latest) { console.error("output/ 에 HTML이 없습니다. 먼저 npm run dry-run 을 실행하세요."); process.exit(1); }
const html = readFileSync(path.join(outDir, latest), "utf8");
const id = await sendMail({ subject: `[SAP 브리핑] 메일 테스트 (${latest.slice(0, 10)})`, html });
console.log("mail sent:", id, "->", process.env.MAIL_TO, `(${latest})`);
