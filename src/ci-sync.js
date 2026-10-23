// GitHub Actions 에서 실행·발송된 기록을 PC 로 가져온다.
// Actions 는 ci-state 브랜치의 logs/<id>/runs.json 과 output/<id>/*.html, *-digest.json 을 남긴다(.github/workflows/briefing.yml).
// 여기서 그 브랜치를 받아 로컬 logs/<id>/runs.json 에 없는 실행 기록을 합치고, 없는 발송본 파일을 output/<id>/ 로 복사한다.
// 관리 웹(server.js)이 시작할 때와 5분마다 호출한다.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT, listAgents, agentPaths } from "./agents.js";

const run = promisify(execFile);
const REF = "refs/remotes/origin/ci-state";
const git = async (...args) => (await run("git", ["-C", ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout;
const show = async (p, encoding = "utf8") =>
  (await run("git", ["-C", ROOT, "show", `${REF}:${p}`], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding })).stdout;

let busy = false;
export async function syncCi() {
  if (busy) return null;
  busy = true;
  const added = { runs: 0, files: 0 };
  try {
    await git("fetch", "-q", "origin", `+ci-state:${REF}`);
    for (const agent of listAgents()) {
      const { runsFile, outDir } = agentPaths(agent.id, { create: true });

      // 1) 발송본 파일
      const files = (await git("ls-tree", "--name-only", REF, `output/${agent.id}/`)).split("\n").filter(Boolean);
      for (const f of files) {
        const dest = path.join(outDir, path.basename(f));
        if (existsSync(dest)) continue;
        writeFileSync(dest, await show(f, "buffer"));
        added.files++;
      }

      // 2) 실행 기록: 로컬에 없는 id 만 추가 (PC 실행 기록은 건드리지 않음)
      let remote = [];
      try { remote = JSON.parse(await show(`logs/${agent.id}/runs.json`)); } catch { continue; }
      let local = [];
      try { local = JSON.parse(readFileSync(runsFile, "utf8")); } catch {}
      const have = new Set(local.map((r) => r.id));
      const fresh = remote.filter((r) => !have.has(r.id) && r.status !== "running");
      if (!fresh.length) continue;
      const merged = [...local, ...fresh].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      writeFileSync(runsFile, JSON.stringify(merged.slice(-500), null, 2));
      added.runs += fresh.length;
    }
    return added;
  } finally { busy = false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, "src", "ci-sync.js")) {
  console.log(await syncCi());
}
