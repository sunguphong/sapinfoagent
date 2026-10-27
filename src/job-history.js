// 채용공고 이력: 수집한 공고를 logs/<agent>/job-history.json 에 쌓아 두고, 회사별로 최근 1년 안에 몇 번 공고가 나왔는지 센다.
// 메일 카드에 "최근 1년 공고 N회" 로 표시하고, 숫자를 누르면 GitHub Pages(docs/jobs.html)가 ci-state 브랜치의 이 파일을 읽어
// 그 회사의 공고 목록을 팝업으로 보여 준다. 이력은 이 기능을 넣은 2026-10-27 전 수집분(2026-10-12~)부터 쌓여 있다.
//
// 같은 공고가 여러 사이트(사람인·잡코리아 등)에 함께 올라오거나 며칠씩 계속 걸리므로, 회사·제목이 같은 공고는
// 30일 안에 다시 보이면 한 번으로 센다(30일 넘게 지나 다시 올라오면 재공고로 보고 따로 센다).
import { readFileSync, writeFileSync } from "node:fs";
import { normCo } from "./jobs.js";

export const PAGE_URL = "https://sunguphong.github.io/sapinfoagent/jobs.html";
const YEAR = 365 * 86400e3, KEEP = 400 * 86400e3, SAME_POST = 30 * 86400e3;
const normTitle = (s = "") => s.replace(/\[[^\]]*\]|\([^)]*\)/g, "").replace(/[^a-z0-9가-힣]/gi, "").toLowerCase();

export function loadHistory(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
}

// 이번 수집분 중 회사가 있는 공고(채용 사이트 결과)를 이력에 더한다. 링크가 이미 있으면 그대로 둔다.
export function addToHistory(history, articles, now = new Date()) {
  const have = new Set(history.map((h) => h.link));
  for (const a of articles) {
    if (!a.company || !a.link || have.has(a.link)) continue;
    history.push({ company: a.company, title: a.title, link: a.link, source: a.source, seenAt: now.toISOString() });
    have.add(a.link);
  }
  const cutoff = now.getTime() - KEEP;
  return history.filter((h) => new Date(h.seenAt).getTime() >= cutoff).sort((x, y) => x.seenAt.localeCompare(y.seenAt));
}

// 회사별 최근 1년 공고 (중복을 합친 목록). 반환: Map<normCo, [{title, seenAt, links:[{source, link}]}]>
export function postingsByCompany(history, now = new Date()) {
  const from = now.getTime() - YEAR, map = new Map();
  for (const h of history) {
    const t = new Date(h.seenAt).getTime();
    if (t < from) continue;
    const key = normCo(h.company);
    if (!key) continue;
    const list = map.get(key) || [];
    const nt = normTitle(h.title);
    const same = list.find((p) => p.nt === nt && t - new Date(p.lastAt).getTime() < SAME_POST);
    if (same) { same.lastAt = h.seenAt; if (!same.links.some((l) => l.link === h.link)) same.links.push({ source: h.source, link: h.link }); }
    else list.push({ nt, title: h.title, seenAt: h.seenAt, lastAt: h.seenAt, links: [{ source: h.source, link: h.link }] });
    map.set(key, list);
  }
  return map;
}

// 메일 렌더 전에 article.jobHistory = { count, url } 를 붙인다
export function attachHistory(articles, history, agentId, now = new Date()) {
  const byCo = postingsByCompany(history, now);
  for (const a of articles) {
    if (!a.company) continue;
    const list = byCo.get(normCo(a.company)) || [];
    a.jobHistory = { count: list.length, url: `${PAGE_URL}?agent=${encodeURIComponent(agentId)}&company=${encodeURIComponent(a.company)}` };
  }
}

export function saveHistory(file, history) {
  writeFileSync(file, JSON.stringify(history, null, 1));
}
