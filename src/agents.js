// 에이전트 설정(agents/<id>.json) 로더. 에이전트마다 수집 소스·프롬프트·메일 제목·발송 시각이 다르고,
// 실행 기록은 logs/<id>/, 결과물은 output/<id>/ 에 따로 쌓인다.
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = path.join(ROOT, "agents");
export const DEFAULT_AGENT = "sap";
const ID_RE = /^[a-z0-9-]{1,32}$/;

export function loadAgent(id = DEFAULT_AGENT) {
  if (!ID_RE.test(id)) throw new Error(`잘못된 에이전트 이름: ${id}`);
  const file = path.join(AGENTS_DIR, `${id}.json`);
  if (!existsSync(file)) throw new Error(`에이전트 설정이 없습니다: agents/${id}.json`);
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(cfg.feeds) || !cfg.feeds.length) throw new Error(`agents/${id}.json 에 feeds 가 없습니다`);
  return { id, ...cfg };
}

export function listAgents() {
  if (!existsSync(AGENTS_DIR)) return [];
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json") && ID_RE.test(f.slice(0, -5)))
    .map((f) => loadAgent(f.slice(0, -5)))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id));
}

export function agentPaths(id, { create = false } = {}) {
  if (!ID_RE.test(id)) throw new Error(`잘못된 에이전트 이름: ${id}`);
  const logDir = path.join(ROOT, "logs", id), outDir = path.join(ROOT, "output", id);
  if (create) { mkdirSync(logDir, { recursive: true }); mkdirSync(outDir, { recursive: true }); }
  return { logDir, outDir, runsFile: path.join(logDir, "runs.json") };
}
