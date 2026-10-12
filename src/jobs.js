// 채용 사이트 검색 결과 수집. 채용공고는 RSS 가 없어서 검색 결과 페이지(또는 공개 JSON)를 직접 읽는다.
// agents/<id>.json 의 feed 에 type 을 주면 collect.js 가 여기로 보낸다:
//   { "name": "사람인", "type": "saramin", "query": "SAP MM" }   type: saramin | jobkorea | wanted | linkedin
// 반환 형식은 RSS 기사와 같다 (source, title, link, published, snippet) + company. 등록일이 없는 사이트(원티드)는
// published 를 수집 시각으로 두므로, 새 공고인지는 index.js 의 seen 기록(trackSeen)으로 가린다.
// addCompanyInfo() 는 수집 뒤 회사별 사원수·최근 매출액·영업이익을 잡코리아 기업정보에서 찾아 article.companyInfo 에 붙인다.
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

// 잡코리아 검색 페이지에 같이 실려 오는 공고 JSON(Next.js 페이로드, 따옴표가 \" 로 이스케이프됨)에서
// 공고번호 → { 등록일, 회사명, 회사번호(memberSystemNo) } 를 뽑는다. 회사번호로 기업정보 페이지를 찾는다.
function jobkoreaPayload(html) {
  const map = new Map();
  for (const chunk of html.split('{\\"id\\":\\"').slice(1)) {
    const id = pick(chunk, /^(\d+)\\"/), no = pick(chunk.slice(0, 1500), /\\"memberSystemNo\\":\\"(\d+)\\"/);
    if (!id || !no || map.has(id)) continue;
    map.set(id, {
      createdAt: pick(chunk.slice(0, 1500), /\\"createdAt\\":\\"([^"\\]+)\\"/),
      company: pick(chunk.slice(0, 1500), /\\"postingCompanyName\\":\\"([^"\\]+)\\"/),
      companyNo: no,
    });
  }
  return map;
}

// 잡코리아: Next.js 렌더 결과에서 카드(CardJob)를 읽고, 등록일·회사번호는 페이로드 JSON 에서 붙인다.
async function jobkorea(q) {
  const html = await get(`https://www.jobkorea.co.kr/Search/?stext=${enc(q)}&tabType=recruit&Ord=RegDtDesc`);
  const meta = jobkoreaPayload(html);
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
      published: meta.get(id)?.createdAt ? new Date(meta.get(id).createdAt).toISOString() : new Date().toISOString(),
      jkCompanyNo: meta.get(id)?.companyNo || "",
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

// ---------- 회사 정보 (사원수·최근 매출액·영업이익) ----------
// 잡코리아 기업정보(/Recruit/Co_Read/C/<회사번호> → /Company/<id>/Info)의 기본정보 표와 재무분석 카드를 읽는다.
// 잡코리아 공고는 회사번호를 이미 알고, 다른 사이트 공고는 회사명으로 잡코리아를 검색해 회사명이 같은 공고의 회사번호를 쓴다.
// 못 찾거나 공개되지 않은 값은 비워 둔다 (작은 회사는 영업이익이 없는 경우가 많다).
// 주의: 잡코리아는 요청을 동시에 여러 개 보내면 다른 회사 페이지(제목과 본문이 섞인 페이지까지)를 돌려준다 (2026-10-12 확인).
// 그래서 한 번에 하나씩 조회하고, 페이지 제목의 회사명이 찾던 회사와 같은지 확인한다.
const normCo = (s = "") => s.replace(/\(주\)|㈜|주\)|\(유\)|주식회사|유한회사/g, "").replace(/[^a-z0-9가-힣]/gi, "").toLowerCase();

// "Hyundai Autoever (현대오토에버)" 처럼 괄호 안에 한글명이 있으면 그것도 후보로 쓴다
const nameCands = (name) => [...new Set([name, pick(name, /\(([^)]*[가-힣][^)]*)\)/), name.replace(/\([^)]*\)/g, "")].map((s) => s.trim()).filter(Boolean))];

async function findJobkoreaCompanyNo(name) {
  for (const c of nameCands(name)) {
    const key = normCo(c);
    if (key.length < 2) continue;
    const meta = jobkoreaPayload(await get(`https://www.jobkorea.co.kr/Search/?stext=${enc(c)}&tabType=recruit`));
    // 같은 이름의 회사번호가 둘 이상이면 동명 회사일 수 있으니 붙이지 않는다
    const nos = new Set([...meta.values()].filter((m) => normCo(m.company) === key).map((m) => m.companyNo));
    if (nos.size === 1) return [...nos][0];
    if (nos.size > 1) return "";
  }
  return "";
}

function parseJobkoreaCompany(html, no) {
  const field = (label) => text(pick(html, new RegExp(String.raw`<th class="field-label">${label}</th>\s*<td class="field-value">\s*<div class="value-container">\s*<div class="values">\s*<div class="value">([^<]*)</div>`)));
  const card = (label) => {
    const m = html.match(new RegExp(String.raw`<div class="header">(\d{4})년 ${label}\s*</div>\s*<div class="value">([^<]*)</div>`));
    return m ? `${text(m[2])} (${m[1]}년)` : "";
  };
  return {
    title: text(pick(html, /<title>\s*([\s\S]*?)\s+\d{4}년 기업정보/)),
    employees: field("사원수"),
    revenue: card("매출액") || field("매출액"),
    operatingProfit: card("영업이익"),
    url: `https://www.jobkorea.co.kr/Recruit/Co_Read/C/${no}`,
  };
}

// 페이지 제목의 회사명이 찾던 이름과 같으면 받아들인다. 잡코리아 공고에 적힌 회사번호(trustNo)는 이름 표기가 달라도
// (예: "신세계I&C" ↔ "(주)신세계아이앤씨") 맞는 번호이므로, 두 번 읽어 내용이 같으면(섞인 응답이 아니면) 받아들인다.
async function jobkoreaCompany(no, name, { trustNo = false } = {}) {
  const keys = nameCands(name).map(normCo);
  const seen = [];
  for (let tries = 0; tries < 3; tries++) {
    const info = parseJobkoreaCompany(await get(`https://www.jobkorea.co.kr/Recruit/Co_Read/C/${no}`), no);
    if (keys.includes(normCo(info.title))) return info;
    const same = JSON.stringify(info);
    if (trustNo && info.title && seen.includes(same)) return info;
    seen.push(same);
  }
  return null;
}

export async function addCompanyInfo(articles) {
  const byName = new Map();
  for (const a of articles) {
    if (!a.company) continue;
    const k = normCo(a.company);
    if (!byName.has(k)) byName.set(k, { name: a.company, no: a.jkCompanyNo || "", list: [] });
    const g = byName.get(k);
    if (!g.no && a.jkCompanyNo) g.no = a.jkCompanyNo;
    g.list.push(a);
  }
  const groups = [...byName.values()], errors = [];
  let found = 0;
  for (const g of groups) {
    try {
      const no = g.no || await findJobkoreaCompanyNo(g.name);
      const info = no && await jobkoreaCompany(no, g.name, { trustNo: !!g.no });
      if (!info || (!info.employees && !info.revenue && !info.operatingProfit)) continue;
      found++;
      const line = `사원수 ${info.employees || "-"} / 매출액 ${info.revenue || "-"} / 영업이익 ${info.operatingProfit || "-"}`;
      for (const a of g.list) { a.companyInfo = info; a.snippet = `${a.snippet} / 회사정보: ${line}`; }
    } catch (e) { errors.push(`${g.name}: ${e.message}`); }
  }
  return { total: groups.length, found, errors };
}
