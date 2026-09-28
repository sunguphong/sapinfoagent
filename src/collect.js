import Parser from "rss-parser";

const FEEDS = [
  { name: "SAP News Center", url: "https://news.sap.com/feed/" },
  { name: "SAP Community (Technology Blog)", url: "https://community.sap.com/khhcw49343/rss/board?board.id=technology-blog-sap" },
  { name: "Google News (EN)", url: "https://news.google.com/rss/search?q=(SAP+ERP+OR+%22SAP+S%2F4HANA%22+OR+%22SAP+BTP%22)+when:3d&hl=en-US&gl=US&ceid=US:en" },
  { name: "Google News (KR)", url: "https://news.google.com/rss/search?q=(SAP+ERP+OR+S%2F4HANA+OR+%22SAP+%EC%BD%94%EB%A6%AC%EC%95%84%22)+when:3d&hl=ko&gl=KR&ceid=KR:ko" },
];

const parser = new Parser({ timeout: 20000, headers: { "User-Agent": "sapinfoagent/1.0" } });

function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTitle(t = "") {
  return t.toLowerCase().replace(/\s+-\s+[^-]+$/, "").replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

export async function collect({ lookbackHours = 24, maxArticles = 40 } = {}) {
  const results = await Promise.allSettled(FEEDS.map(async (f) => {
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
    else errors.push(`${FEEDS[i].name}: ${r.reason?.message || r.reason}`);
  });

  // 최근 N시간 필터. 기사가 적으면(주말 등) 48h -> 72h로 단계 확장
  const filterBy = (hours) => items.filter((a) => a.published && new Date(a.published).getTime() >= Date.now() - hours * 3600 * 1000);
  const MIN_ARTICLES = 8;
  let usedHours = lookbackHours;
  let recent = filterBy(usedHours);
  for (const h of [48, 72]) {
    if (recent.length >= MIN_ARTICLES || h <= usedHours) break;
    usedHours = h; recent = filterBy(h);
  }

  // 제목 기준 중복 제거, 최신순 정렬, 상한
  const seen = new Set();
  recent = recent
    .filter((a) => { const k = normalizeTitle(a.title); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, maxArticles);

  return { articles: recent, errors, totalFetched: items.length, usedHours };
}
