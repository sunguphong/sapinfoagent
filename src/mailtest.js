// 최근 생성된 output/<agent>/*.html 을 그대로 발송해 SMTP 설정만 빠르게 점검한다 (수집·요약 생략)
//   node src/mailtest.js [--agent=realestate]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sendMail } from "./mail.js";
import { ROOT, DEFAULT_AGENT, loadAgent, agentPaths } from "./agents.js";

const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const agentArg = process.argv.find((a) => a.startsWith("--agent="));
const agent = loadAgent(agentArg ? agentArg.slice(8) : DEFAULT_AGENT);
const { outDir } = agentPaths(agent.id);
const latest = existsSync(outDir) ? readdirSync(outDir).filter((f) => /^\d{4}-\d{2}-\d{2}(_\d+)?\.html$/.test(f)).sort().pop() : null;
if (!latest) { console.error(`output/${agent.id}/ 에 HTML이 없습니다. 먼저 node src/index.js --agent=${agent.id} --dry-run 을 실행하세요.`); process.exit(1); }
const html = readFileSync(path.join(outDir, latest), "utf8");
const to = agent.mailTo || process.env.MAIL_TO;
const id = await sendMail({ subject: `${agent.subjectPrefix} 메일 테스트 (${latest.slice(0, 10)})`, html, fromName: agent.fromName, to });
console.log("mail sent:", id, "->", to, `(${agent.id}/${latest})`);
