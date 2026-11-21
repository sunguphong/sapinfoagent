// PC 에서 GitHub 를 다룰 때 쓰는 공통 함수: git credential 로 토큰 얻기, ci-state 브랜치에 파일 올리기, 실행 중인 브리핑 작업 조회.
// relay-feeds.js(원티드 PC 수집)와 local-fallback.js(GitHub 실패 시 PC 발송)가 같이 쓴다.
import { execFileSync } from "node:child_process";

export const REPO = "sunguphong/sapinfoagent";
const BRANCH = "ci-state";

export function githubToken() {
  const out = execFileSync(process.env.GIT_EXE || "git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const token = (out.match(/^password=(.+)$/m) || [])[1];
  if (!token) throw new Error("no GitHub token from git credential");
  return token;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "sapinfoagent" });

// Contents API 로 ci-state 에 파일 하나를 올린다. 그 사이 CI 가 같은 브랜치에 푸시하면 409 가 나므로 sha 를 다시 받아 재시도한다.
export async function upload(token, file, body, message) {
  const url = `https://api.github.com/repos/${REPO}/contents/${file}`;
  for (let i = 0; ; i++) {
    const cur = await fetch(`${url}?ref=${BRANCH}`, { headers: headers(token), signal: AbortSignal.timeout(30000) });
    if (!cur.ok && cur.status !== 404) throw new Error(`GET ${file}: HTTP ${cur.status}`);
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const r = await fetch(url, {
      method: "PUT", headers: headers(token), signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ message, branch: BRANCH, sha, content: Buffer.from(body).toString("base64") }),
    });
    if (r.ok) return;
    if (i >= 2 || ![409, 422].includes(r.status)) throw new Error(`PUT ${file}: HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}

// 지금 GitHub 에서 실행 중·대기 중인 브리핑 작업의 에이전트 id ("run (<id>)" 작업 이름)
export async function activeAgents(token) {
  const api = async (u) => {
    const r = await fetch(`https://api.github.com/repos/${REPO}/${u}`, { headers: headers(token), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    return r.json();
  };
  const ids = new Set();
  for (const status of ["in_progress", "queued"]) {
    const { workflow_runs = [] } = await api(`actions/workflows/briefing.yml/runs?status=${status}&per_page=20`);
    for (const wr of workflow_runs) {
      const { jobs = [] } = await api(`actions/runs/${wr.id}/jobs?per_page=50`);
      for (const j of jobs) { const m = j.status !== "completed" && j.name.match(/^run \((.+)\)$/); if (m) ids.add(m[1]); }
      if (!jobs.length) ids.add("*");   // 아직 작업이 만들어지지 않은 실행 (어느 에이전트인지 모름)
    }
  }
  return ids;
}
