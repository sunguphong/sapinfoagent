// 에이전트 근무 상태 판정에 쓰는 공통 규칙. 관리 웹(server.js 의 에이전트 오피스)과 총괄 에이전트(supervisor.js)가 같이 쓴다.
export const LATE_MIN = 20;   // 발송 시각에서 이만큼 지나도록 미발송이면 '지연'
export const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// 쉬는 날: 증시는 일요일 (briefing.yml 의 월~토 예약·watchdog.ps1 과 맞춤)
export const isOffDay = (agent, d = new Date()) => agent.id === "stock" && d.getDay() === 0;
// 그날의 발송 예정 시각
export function dueAt(agent, now = new Date()) {
  const [h, m] = String(agent.schedule || "07:00").split(":").map(Number);
  const due = new Date(now); due.setHours(h, m, 0, 0);
  return due;
}
