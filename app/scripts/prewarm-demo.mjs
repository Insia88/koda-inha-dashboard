// 공개 데모 사전 예열(pre-demo warm-up). 시연 5분 전에 한 번 실행한다.
//   node scripts/prewarm-demo.mjs [baseUrl]
// 1) /api/healthz 2) 데모 사용자 목록 3) 한 사용자로 dev-login 4) 홈·승인 대기·감사 기록 API를 같은 쿠키로 호출
// 응답한 인스턴스 ID를 찍어 준다. 인스턴스는 요청마다 달라질 수 있으므로, 출력에서 2곳 이상이면 데모 중
// '다른 데모 서버로 연결되었습니다' 안내가 뜰 수 있다는 뜻이다(데이터는 모의·인스턴스별).
const base = (process.argv[2] || 'https://koda-inha-dashboard.vercel.app').replace(/\/+$/, '');
const show = (label, r, body) => {
  const inst = r.headers.get('x-demo-instance') ?? '-';
  const ms = Date.now() - t0;
  console.log(`${label.padEnd(22)} ${r.status}  ${String(ms).padStart(5)}ms  instance=${inst.slice(0, 8)}${body ? `  ${body}` : ''}`);
};
let t0 = Date.now();
const health = await fetch(`${base}/api/healthz`);
show('healthz', health, (await health.json()).mode);
const usersRes = await fetch(`${base}/api/auth/dev-users`);
const users = await usersRes.json();
show('dev-users', usersRes, `${users.length} users`);
const pick = users.find((u) => u.name === '한지수') ?? users[0];
t0 = Date.now();
const login = await fetch(`${base}/api/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ userId: pick.id }),
});
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
show(`dev-login ${pick.name}`, login);
const get = async (path) => {
  t0 = Date.now();
  const r = await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} });
  const text = await r.text();
  let note = '';
  try { const j = JSON.parse(text); note = Array.isArray(j) ? `${j.length} items` : (j.tasks ? `${j.tasks.length} tasks` : 'ok'); } catch { note = ''; }
  show(path, r, note);
};
await get('/api/me');
await get('/api/dashboard');
await get('/api/requests?view=to_approve&order=asc&pageSize=10');
await get('/api/addresses?view=to_review&pageSize=10');
// 승인자·감사 담당자 역할의 화면도 미리 데운다(같은 인스턴스에서 권한별 API 경로).
for (const name of ['오민재', '문태호']) {
  const u = users.find((x) => x.name === name);
  if (!u) continue;
  t0 = Date.now();
  const lg = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
  const c = (lg.headers.get('set-cookie') ?? '').split(';')[0];
  show(`dev-login ${u.name}`, lg);
  for (const path of ['/api/dashboard', '/api/requests?view=to_approve&order=asc&pageSize=10', '/api/audit?pageSize=10']) {
    t0 = Date.now();
    const rr = await fetch(`${base}${path}`, { headers: c ? { cookie: c } : {} });
    const inst = rr.headers.get('x-demo-instance') ?? '-';
    console.log(`${path.padEnd(46)} ${rr.status}${rr.status === 403 ? ' (권한 없음·정상)' : ''}  ${String(Date.now() - t0).padStart(5)}ms  instance=${inst.slice(0, 8)}`);
  }
}
console.log('\n예열 완료. 같은 탭에서 /login을 열고 시연을 시작하세요.');
console.log('참고: 데이터는 인스턴스별 메모리에 있고 재배포·재시작 때 초기화됩니다. 시연 도중 새로 고침은 피하세요.');
