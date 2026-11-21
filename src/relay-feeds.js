// GitHub Actions 에서 막히는 채용 사이트(원티드: HTTP 403)를 PC 에서 대신 수집해 ci-state 브랜치에 올린다.
// agents/<id>.json 의 feed 에 relay(저장 경로)가 있는 피드가 대상이고, 실행 쪽은 jobs.js fetchJobs 가 직접 수집에 실패할 때 이 파일을 쓴다.
// watchdog.ps1 이 매일 아침 발송 전에 실행한다. 로그는 watchdog.log 에 그대로 남고 콘솔 코드페이지에서 한글이 깨지므로 영어로 쓴다.
//   node src/relay-feeds.js
import { listAgents } from "./agents.js";
import { scrapeFeed } from "./jobs.js";
import { githubToken, upload } from "./github.js";

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
