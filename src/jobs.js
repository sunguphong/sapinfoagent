// 채용 사이트 검색 결과 수집. 채용공고는 RSS 가 없어서 검색 결과 페이지(또는 공개 JSON)를 직접 읽는다.
// agents/<id>.json 의 feed 에 type 을 주면 collect.js 가 여기로 보낸다:
//   { "name": "사람인", "type": "saramin", "query": "SAP MM" }   type: saramin | jobkorea | wanted | linkedin
// 반환 형식은 RSS 기사와 같다 (source, title, link, published, snippet). 등록일이 없는 사이트(잡코리아·원티드)는
// published 를 수집 시각으로 두므로, 새 공고인지는 index.js 의 seen 기록(trackSeen)으로 가린다.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function get(url, { json = false } = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return json ? r.json() : r.text();
}

const decode = (s = "") => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&nbsp;/g, " ");
const text = (s = "") => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pick = (s, re) => (s.match(re) || [])[1] || "";
const enc = encodeURIComponent;

// 사람인: 등록일순 검색 결과. "등록일 26/10/10" 을 published 로 쓴다.
async function saramin(q) {
  const html = await get(`https://www.saramin.co.kr/zf_user/search/recruit?searchword=${enc(q)}&recruitSort=reg_dt&recruitPageCount=40`);
  return html.split('<div class="item_recruit"').slice(1).map((b) => {
    const idx = pick(b, /^\s*value="(\d+)"/);
    const reg = b.match(/등록일\s*(\d{2})\/(\d{2})\/(\d{2})/);
    const company = text(pick(b, /<strong class="corp_name">([\s\S]*?)<\/strong>/));
    return {
      title: text(pick(b, /<h2 class="job_tit">([\s\S]*?)<\/h2>/)),
      company,
      link: `https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=${idx}`,
      published: reg ? new Date(`20${reg[1]}-${reg[2]}-${reg[3]}T09:00:00+09:00`).toISOString() : null,
      snippet: [
        `회사: ${company}`,
        `조건: ${text(pick(b, /<div class="job_condition">([\s\S]*?)<\/div>/))}`,
        `마감: ${text(pick(b, /<span class="date">([\s\S]*?)<\/span>/))}`,
        `분야: ${text(pick(b, /<div class="job_sector">([\s\S]*?)<span class="job_day">/))}`,
      ].join(" / "),
    };
  }).filter((a) => a.title);
}

// 잡코리아: Next.js 렌더 결과에서 카드(CardJob)를 읽는다. 등록일 표기가 없어 최신 등록순 정렬만 믿는다.
async function jobkorea(q) {
  const html = await get(`https://www.jobkorea.co.kr/Search/?stext=${enc(q)}&tabType=recruit&Ord=RegDtDesc`);
  return html.split('data-sentry-component="CardJob"').slice(1).map((b) => {
    const id = pick(b, /Recruit\/GI_Read\/(\d+)/);
    const title = text(pick(b, /data-sentry-component="Title"[^>]*>([\s\S]*?)<\/a>/));
    const company = text(pick(b, /text-gray700 text-typo-b2-16">([^<]*)</));
    // 카드의 나머지 텍스트(배지·지역·직무·경력)를 snippet 으로 쓴다
    const rest = b.replace(/<[^>]+>/g, "|").split("|").map((s) => text(s)).filter((s) => s && !s.includes("=") && s !== "스크랩" && s !== title && s !== company);
    return {
      title,
      company,
      link: id ? `https://www.jobkorea.co.kr/Recruit/GI_Read/${id}` : "",
      published: new Date().toISOString(),
      snippet: [`회사: ${company}`, ...rest.slice(0, 6)].join(" / "),
    };
  }).filter((a) => a.title && a.link);
}

// 원티드: 공개 검색 API(JSON). 등록일이 없다.
async function wanted(q) {
  const d = await get(`https://www.wanted.co.kr/api/chaos/search/v1/position?query=${enc(q)}&limit=30&offset=0`, { json: true });
  const emp = { regular: "정규직", contract: "계약직", intern: "인턴", freelancer: "프리랜서" };
  return (d.data || []).map((p) => ({
    title: p.position,
    company: p.company?.name || "",
    link: `https://www.wanted.co.kr/wd/${p.id}`,
    published: new Date().toISOString(),
    snippet: [
      `회사: ${p.company?.name || ""}`,
      p.annual_from != null ? `경력: ${p.annual_from}~${p.annual_to}년` : "",
      emp[p.employment_type] || p.employment_type || "",
    ].filter(Boolean).join(" / "),
  }));
}

// LinkedIn: 비로그인 공개 검색(guest API). 최근 7일, 최신순. location 은 feed.location (기본 South Korea).
async function linkedin(q, feed) {
  const loc = feed.location || "South Korea";
  const html = await get(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${enc(q)}&location=${enc(loc)}&f_TPR=r604800&sortBy=DD`);
  return html.split("<li>").slice(1).map((b) => {
    const company = text(pick(b, /<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>/));
    const date = pick(b, /datetime="([\d-]+)"/);
    return {
      title: text(pick(b, /<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/)),
      company,
      link: decode(pick(b, /href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/)),
      published: date ? new Date(`${date}T09:00:00+09:00`).toISOString() : null,
      snippet: `회사: ${company} / 지역: ${text(pick(b, /<span class="job-search-card__location">([\s\S]*?)<\/span>/))}`,
    };
  }).filter((a) => a.title && a.link);
}

const SCRAPERS = { saramin, jobkorea, wanted, linkedin };

export function isJobFeed(feed) {
  return !!SCRAPERS[feed.type];
}

// feed.filter: 제목에 이 정규식(대소문자 무시)이 있는 공고만 남긴다. 검색이 느슨한 사이트(원티드 등)의 무관한 공고를 거른다.
export async function fetchJobs(feed) {
  let items = await SCRAPERS[feed.type](feed.query, feed);
  if (feed.filter) { const re = new RegExp(feed.filter, "i"); items = items.filter((a) => re.test(a.title)); }
  return items.map((a) => ({ source: feed.name, ...a, snippet: a.snippet.slice(0, 400) }));
}
