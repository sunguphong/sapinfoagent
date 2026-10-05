// Claude CLI 로 기사 목록을 요약한다. 프롬프트의 주제별 부분(역할·카테고리·선별 규칙)은 에이전트 설정(agents/<id>.json 의 prompt)에서 받고,
// 출력 JSON 스키마는 mail.js 가 그대로 그리므로 고정이다.
//
// 모델은 --model 로 지정한다 (기본 opus). Anthropic API(@anthropic-ai/sdk)를 직접 쓰지 않는 이유:
// API 는 ANTHROPIC_API_KEY 가 필요하고 Claude Code 구독과 별도로 토큰당 과금된다. CLI 는 이 PC 의 구독 로그인을 그대로 쓴다.
// (2026-10-05: SDK 로 바꿨다가 "Could not resolve authentication method" 로 발송이 멈춰 되돌림)
import { spawnSync } from "node:child_process";

const MODEL = process.env.CLAUDE_MODEL || "opus";

export function buildPrompt(p = {}) {
  const rules = [
    `중요도가 낮거나 중복되는 기사는 빼도 됩니다. ${p.pick || "총 8~15건으로 추립니다."}`,
    "index는 반드시 아래 목록의 번호를 그대로 씁니다.",
    ...(p.rules || []),
    "title_ko와 summary, why는 반드시 한국어로 씁니다. 영어 문장을 그대로 두지 마세요.",
  ];
  return `${p.intro || "당신은 일일 뉴스 브리핑 작성자입니다."}
아래 기사 목록을 읽고 한국어로 정리하세요. 영어 기사는 제목과 내용을 모두 자연스러운 한국어로 번역해서 작성합니다(고유명사·제품명은 원문 유지 가능). 반드시 아래 JSON 스키마만 출력하고, 코드펜스나 다른 텍스트는 붙이지 마세요.

{
  "overview": "${p.overview || "오늘 동향 3~4문장 요약"}",
  "categories": [
    {
      "name": "카테고리명 (예: ${p.categories || "주요 소식, 시장 동향, 기타"})",
      "items": [
        { "index": 기사번호(정수), "title_ko": "한국어 제목", "summary": "핵심 내용 2~3문장", "why": "${p.why || "독자에게 의미 있는 이유 1문장"}" }
      ]
    }
  ]
}

규칙:
${rules.map((r) => `- ${r}`).join("\n")}

기사 목록:
`;
}

function buildInput(articles) {
  return articles.map((a, i) =>
    `[${i}] (${a.source}) ${a.title}\n    published: ${a.published}\n    snippet: ${a.snippet}`
  ).join("\n\n");
}

function extractJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON in Claude output:\n" + text.slice(0, 500));
  return JSON.parse(t.slice(start, end + 1));
}

export function summarize(articles, promptConfig) {
  const input = buildPrompt(promptConfig) + buildInput(articles);
  const isWin = process.platform === "win32";
  const r = spawnSync(isWin ? "claude.cmd" : "claude", ["-p", "--model", MODEL, "--output-format", "text", "--tools", '""'], {
    input, encoding: "utf8", shell: isWin, timeout: 20 * 60 * 1000, maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${r.stderr}`);
  const data = extractJson(r.stdout);
  // index -> 원본 기사 연결
  for (const c of data.categories || []) {
    c.items = (c.items || []).map((it) => ({ ...it, article: articles[it.index] })).filter((it) => it.article);
  }
  return data;
}
