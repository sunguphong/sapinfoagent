// GitHub Actions 에서 막히는 채용 사이트(원티드: HTTP 403)를 PC 에서 대신 수집해 ci-state 브랜치에 올린다.
// agents/<id>.json 의 feed 에 relay(저장 경로)가 있는 피드가 대상이고, 실행 쪽은 jobs.js fetchJobs 가 직접 수집에 실패할 때 이 파일을 쓴다.
// watchdog.ps1 이 매일 아침 발송 전에 실행한다. 로그는 watchdog.log 에 그대로 남고 콘솔 코드페이지에서 한글이 깨지므로 영어로 쓴다.
//   node src/relay-feeds.js
import { execFileSync } from "node:child_process";
import { listAgents } from "./agents.js";
import { scrapeFeed } from "./jobs.js";

const REPO = "sunguphong/sapinfoagent", BRANCH = "ci-state";

function githubToken() {
  const out = execFileSync(process.env.GIT_EXE || "git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const token = (out.match(/^password=(.+)$/m) || [])[1];
  if (!token) throw new Error("no GitHub token from git credential");
  return token;
}

// Contents API 로 파일 하나를 올린다. 그 사이 CI 가 같은 브랜치에 푸시하면 409 가 나므로 sha 를 다시 받아 재시도한다.
async function upload(token, file, body, message) {
  const url = `https://api.github.com/repos/${REPO}/contents/${file}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "sapinfoagent" };
  for (let i = 0; ; i++) {
    const cur = await fetch(`${url}?ref=${BRANCH}`, { headers, signal: AbortSignal.timeout(30000) });
    if (!cur.ok && cur.status !== 404) throw new Error(`GET ${file}: HTTP ${cur.status}`);
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const r = await fetch(url, {
      method: "PUT", headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ message, branch: BRANCH, sha, content: Buffer.from(body).toString("base64") }),
    });
    if (r.ok) return;
    if (i >= 2 || ![409, 422].includes(r.status)) throw new Error(`PUT ${file}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}

const feeds = listAgents().flatMap((a) => a.feeds.filter((f) => f.relay));
let token, failed = 0;
for (const feed of feeds) {
  try {
    const items = await scrapeFeed(feed);
    if (!items.length) throw new Error("0 items");
    token ||= githubToken();
    await upload(token, feed.relay, JSON.stringify({ fetchedAt: new Date().toISOString(), items }, null, 1), `relay: ${feed.type} ${new Date().toISOString().slice(0, 10)}`);
    console.log(`relay ok: ${feed.relay} (${items.length} items)`);
  } catch (e) {
    failed++;
    console.log(`relay failed: ${feed.relay}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
