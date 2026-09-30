# sapinfoagent

뉴스를 매일 아침 자동으로 수집하고, Claude로 한국어 요약해서 메일로 보내주는 브리핑 에이전트입니다.
주제별 에이전트를 `agents/<id>.json` 하나로 추가할 수 있고(수집 RSS · 요약 프롬프트 · 메일 제목 · 발송 시각), 현재 세 개가 들어 있습니다.

| 에이전트 | 설정 | 내용 | 발송 |
| --- | --- | --- | --- |
| SAP 브리핑 | `agents/sap.json` | SAP 제품·기술·시장 뉴스 (영문 번역 포함) | 매일 06:55 |
| 부동산 브리핑 | `agents/realestate.json` | 국내 부동산 정책·시장·분양·대출 동향 + 동탄 지역 소식 | 매일 07:00 |
| 증시 브리핑 | `agents/stock.json` | 전날 미국 증시 분석 + 오늘 국내 증시(코스피·코스닥) 전망 | 평일 07:00 |

관리 웹(에이전트별 수동 실행 · 실행 기록 · 발송 메일 조회, 공통 환경설정 · 장애 기록)도 함께 들어 있습니다.
실행 기록은 `logs/<id>/`, 결과물은 `output/<id>/` 에 에이전트별로 쌓입니다. 실행은 `node src/index.js --agent=<id>`, 스케줄러는 `run.cmd <id>`.

- 안내 페이지 (GitHub Pages): https://sunguphong.github.io/sapinfoagent/
- 관리 웹 (담당자 PC에서 실행, 로그인 필요): https://sap-info-agent.loca.lt

```
RSS 수집 (SAP News / SAP Community / Google News EN·KR)
  → Claude 요약·번역 (claude CLI)
  → HTML 브리핑 생성
  → Gmail SMTP 발송 (매일 06:55 Windows 작업 스케줄러)
```

## 요구 사항

- Node.js 20 이상
- [Claude Code CLI](https://claude.com/claude-code) (`claude` 명령이 PATH에 있어야 함)
- Gmail 계정 + 앱 비밀번호 (Google 계정 → 보안 → 2단계 인증 → 앱 비밀번호)

## 설치

```powershell
git clone https://github.com/sunguphong/sapinfoagent.git
cd sapinfoagent
npm install
copy .env.example .env    # 편집: SMTP_USER / SMTP_PASS / MAIL_TO
```

## 실행

| 명령 | 설명 |
| --- | --- |
| `npm start` | 수집 → 요약 → 메일 발송 |
| `npm run dry-run` | 메일 없이 HTML만 생성 (`output/`) |
| `npm run collect` | 수집만 (기사 목록 JSON) |
| `npm run mail-test` | 최근 HTML을 그대로 재발송해 SMTP 설정만 점검 |
| `npm run web` | 관리 웹 서버 (http://localhost:5174) |
| `npm run tunnel` | 관리 웹을 인터넷에 공개 (localtunnel 고정 주소) |

## 자동 실행 (Windows)

- `run.cmd` 를 작업 스케줄러에 매일 06:55 로 등록합니다.

  ```powershell
  schtasks /Create /TN "SAP Info Agent" /TR "D:\ANTI\sapinfoagent\run.cmd" /SC DAILY /ST 06:55
  ```

- `start-web-hidden.vbs` 를 시작프로그램 폴더(`shell:startup`)에 복사하면 로그인 시 관리 웹이 창 없이 자동 기동됩니다.
- 두 파일 안의 경로는 설치 위치에 맞게 수정하세요.

## 외부 접속 (인터넷 공개)

- `.env` 에 `WEB_USER` / `WEB_PASS` 를 설정하면 관리 웹 전체에 Basic Auth 로그인이 걸립니다.
- `npm run tunnel` (또는 `start-web-hidden.vbs`) 이 localtunnel 로 `https://<LT_SUBDOMAIN>.loca.lt` 고정 주소를 열고, 끊기면 자동 재연결합니다.
  접속 계정이 없으면 터널은 시작을 거부합니다.
- 처음 접속할 때 loca.lt 안내 페이지가 한 번 뜰 수 있습니다. 대시보드에 현재 공개 주소와 상태가 표시됩니다.

## 관리 웹

- **대시보드**: 상태·다음 실행·마지막 발송·외부 접속 주소 확인, 수동 실행 / 드라이런 버튼
- **실행 기록**: 스케줄러·웹·CLI 실행 이력, 행 클릭 시 로그
- **발송 메일**: 일자별 브리핑 HTML 미리보기 (발송본 / 드라이런 구분)
- **환경설정**: 수신자 추가·삭제, 발신 계정, 수집 옵션, 외부 접속 계정·주소 이름 → `.env` 에 저장

## 폴더 구조

```
src/
  index.js      파이프라인 진입점 (실행 기록 logs/runs.json 기록)
  collect.js    RSS 수집·필터·중복 제거 (24h → 48h → 72h 자동 확장)
  summarize.js  claude CLI 호출, JSON 요약
  mail.js       HTML 렌더링, Gmail 발송
  mailtest.js   SMTP 점검용 재발송
  server.js     관리 웹 서버 (Basic Auth, 설정 API)
  tunnel.js     localtunnel 외부 공개 (자동 재연결, 상태를 logs/tunnel.json 에 기록)
public/         관리 웹 프론트엔드
docs/           GitHub Pages 안내 페이지 (정적, 관리 웹으로 연결)
output/         생성된 브리핑 (<날짜>_<실행ID>.html / -digest.json / -articles.json)  ※ git 제외
logs/           실행 로그, runs.json  ※ git 제외
```

## 환경 변수 (.env)

| 키 | 설명 | 기본값 |
| --- | --- | --- |
| `SMTP_USER` | 발신 Gmail 주소 | |
| `SMTP_PASS` | Gmail 앱 비밀번호 (16자리) | |
| `MAIL_TO` | 수신자 (쉼표 구분) | |
| `LOOKBACK_HOURS` | 수집 기간(시간) | 24 |
| `MAX_ARTICLES` | 최대 기사 수 | 40 |
| `PORT` | 관리 웹 포트 | 5174 |
| `WEB_USER` / `WEB_PASS` | 관리 웹 로그인 계정 (외부 공개 시 필수) | |
| `LT_SUBDOMAIN` | 공개 주소 이름 (`https://<이름>.loca.lt`) | sap-info-agent |
