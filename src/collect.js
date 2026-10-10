// RSS 수집. 피드 목록은 에이전트 설정(agents/<id>.json 의 feeds)에서 받는다.
//   feed.keep = N : 이 피드의 기사는 상한(maxArticles)과 무관하게 최신순 N건을 먼저 확보한다 (예: 동탄 지역 소식)
//   feed.lookbackHours = H : 이 피드만 최소 H시간 전 기사까지 받는다 (예: 기사가 드문 동탄 트램·GTX-C)
//   제목 중복 제거는 피드 순서대로 먼저 나온 기사를 남기므로, 우선 확보할 피드를 목록 앞에 둔다.
import Parser from "rss-parser";

const parser = new Parser({ timeout: 20000, headers: { "User-Agent": "sapinfoagent/1.0" } });

function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(t = "") {
  return t.toLowerCase().replace(/\s+-\s+[^-]+$/, "").replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

export async function collect({ feeds, lookbackHours = 24, maxArticles = 40 } = {}) {
  if (!feeds?.length) throw new Error("수집할 피드가 없습니다");
  const results = await Promise.allSettled(feeds.map(async (f) => {
    const feed = await parser.parseURL(f.url);
    return feed.items.map((it) => ({
      source: f.name,
      title: (it.title || "").trim(),
      link: it.link,
      published: it.isoDate || it.pubDate || null,
      snippet: stripHtml(it.contentSnippet || it.content || it.summary || "").slice(0, 400),
    }));
  }));

  const errors = [];
  let items = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push(`${feeds[i].name}: ${r.reason?.message || r.reason}`);
  });

  // 최근 N시간 필터. 기사가 적으면(주말 등) 48h -> 72h로 단계 확장
  const feedHours = Object.fromEntries(feeds.map((f) => [f.name, f.lookbackHours || 0]));
  const filterBy = (hours) => items.filter((a) => a.published && new Date(a.published).getTime() >= Date.now() - Math.max(hours, feedHours[a.source] || 0) * 3600 * 1000);
  const MIN_ARTICLES = 8;
  let usedHours = lookbackHours;
  let recent = filterBy(usedHours);
  for (const h of [48, 72]) {
    if (recent.length >= MIN_ARTICLES || h <= usedHours) break;
    usedHours = h; recent = filterBy(h);
  }

  // 제목 기준 중복 제거 (피드 순서대로 먼저 나온 기사를 남김), 최신순 정렬
  const seen = new Set();
  recent = recent
    .filter((a) => { const k = normalizeTitle(a.title); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.published) - new Date(a.published));

  // 상한 적용: keep 이 지정된 피드의 기사를 먼저 확보하고, 나머지를 최신순으로 채운다
  const kept = [];
  for (const f of feeds) if (f.keep > 0) kept.push(...recent.filter((a) => a.source === f.name).slice(0, f.keep));
  const keptSet = new Set(kept);
  const rest = recent.filter((a) => !keptSet.has(a)).slice(0, Math.max(0, maxArticles - kept.length));
  recent = [...kept, ...rest].sort((a, b) => new Date(b.published) - new Date(a.published));

  return { articles: recent, errors, totalFetched: items.length, usedHours };
}
