// node --test 로 실행. 실제 agent/ 폴더를 건드리지 않도록 임시 폴더를 작업 폴더로 쓴다.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-test-'));
process.env.WIZARD_WORK_DIR = TMP;
const W = require('../server.js');

const PW = 'abcdefghijklmnop';

function resetEnv() {
  fs.rmSync(path.join(TMP, 'agent'), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 오류 분류
// ---------------------------------------------------------------------------
test('오류 분류: 대표 메시지가 알맞은 종류로 바뀐다', () => {
  const cases = [
    [{ stderr: "'claude'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다." }, 'not_found'],
    [{ stderr: "'npm' is not recognized as an internal or external command," }, 'not_found'],
    [{ stderr: 'bash: claude: command not found', code: 127 }, 'not_found'],
    [{ stderr: 'spawn schtasks ENOENT', code: 'ENOENT' }, 'not_found'],
    [{ stderr: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' }, 'network'],
    [{ stderr: 'npm ERR! code SELF_SIGNED_CERT_IN_CHAIN' }, 'network'],
    [{ stderr: 'tunneling socket could not be established, proxy error' }, 'network'],
    [{ stderr: '오류: 액세스가 거부되었습니다.' }, 'permission'],
    [{ stderr: 'Error: EPERM: operation not permitted, rename' }, 'permission'],
    [{ stderr: 'whatever', timedOut: true }, 'timeout'],
    [{ stderr: 'SMTP timeout: 서버가 응답하지 않습니다.' }, 'timeout'],
    [{ stderr: "npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules'" }, 'npm_eacces'],
    [{ stderr: "npm error code ENOENT\nnpm error syscall lstat\nnpm error path C:\\Users\\hong\\AppData\\Roaming\\npm" }, 'npm_enoent'],
    [{ stderr: '535-5.7.8 Username and Password not accepted. For more information, go to\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials' }, 'smtp_auth'],
    [{ stderr: 'Error: Invalid login: 535-5.7.8 Username and Password not accepted' }, 'smtp_auth'],
    [{ stderr: '534-5.7.9 Application-specific password required.' }, 'smtp_app_password_required'],
    [{ stderr: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:5055' }, 'port_in_use'],
    [{ stderr: "Error: Cannot find module 'nodemailer'" }, 'module_missing'],
    [{ stderr: "TypeError: Cannot read properties of undefined (reading 'x')" }, 'code_error'],
    [{ stderr: 'Invalid API key · Please run /login' }, 'not_logged_in'],
    [{ stderr: 'Error: Missing credentials for "PLAIN"' }, 'smtp_missing_credentials'],
    [{ stderr: '뭔지 모를 메시지' }, 'unknown'],
  ];
  for (const [input, kind] of cases) {
    const r = W.classifyError(input);
    assert.equal(r.kind, kind, `${JSON.stringify(input)} → ${r.kind}`);
    assert.ok(r.title && r.what && r.todo.length > 0, '쉬운 설명이 모두 채워져야 함');
  }
});

test('CP949로 된 Windows 오류 문구도 깨지지 않게 읽는다', () => {
  const buf = Buffer.from('bfc0b7f93a20bed7bcbcbdbab0a120b0c5baceb5c7befabdc0b4cfb4d92e', 'hex');
  assert.equal(W.decodeOutput(buf), '오류: 액세스가 거부되었습니다.');
  assert.equal(W.decodeOutput(Buffer.from('정상 UTF-8', 'utf8')), '정상 UTF-8');
});

// ---------------------------------------------------------------------------
// .env 저장
// ---------------------------------------------------------------------------
test('.env 저장: 공백 제거, 빈 칸으로 다시 저장해도 기존 비밀번호 유지', () => {
  resetEnv();
  let r = W.saveConfig({ gmail_sender: 'hong@gmail.com', gmail_app_password: 'abcd efgh ijkl mnop', recipient: '' });
  assert.equal(r.ok, true);
  let kv = W.readEnvKv();
  assert.equal(kv.GMAIL_APP_PASSWORD, PW);
  assert.equal(kv.REPORT_RECIPIENT, 'hong@gmail.com', '받는 주소가 비면 보내는 주소');

  r = W.saveConfig({ gmail_sender: 'hong@gmail.com', gmail_app_password: '', recipient: 'kim@gmail.com', krx_key: 'KRXKEY123' });
  assert.equal(r.ok, true);
  kv = W.readEnvKv();
  assert.equal(kv.GMAIL_APP_PASSWORD, PW, '빈 칸이면 기존 값 유지');
  assert.equal(kv.REPORT_RECIPIENT, 'kim@gmail.com');
  assert.equal(kv.KRX_AUTH_KEY, 'KRXKEY123');

  r = W.saveConfig({ gmail_sender: 'hong@gmail.com', recipient: 'kim@gmail.com' });
  assert.equal(W.readEnvKv().KRX_AUTH_KEY, 'KRXKEY123', 'KRX 키도 유지');
});

test('.env 저장: 잘못된 입력은 거절하고 기존 파일을 건드리지 않는다', () => {
  resetEnv();
  W.saveConfig({ gmail_sender: 'hong@gmail.com', gmail_app_password: PW });
  const before = fs.readFileSync(W.ENV_PATH, 'utf-8');
  for (const bad of [
    { gmail_sender: 'hong@gmail.com', gmail_app_password: 'my-normal-password' },
    { gmail_sender: 'hong@gmail.com', gmail_app_password: 'abcd efgh ijkl' },
    { gmail_sender: 'not-an-email', gmail_app_password: PW },
  ]) {
    const r = W.saveConfig(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'bad_input');
    assert.ok(!JSON.stringify(r).includes(bad.gmail_app_password) || bad.gmail_app_password === PW, '오류 응답에 입력한 비밀번호가 섞이면 안 됨');
  }
  assert.equal(fs.readFileSync(W.ENV_PATH, 'utf-8'), before);
});

test('.env 저장: 처음 저장할 때 비밀번호가 없으면 거절', () => {
  resetEnv();
  const r = W.saveConfig({ gmail_sender: 'hong@gmail.com' });
  assert.equal(r.ok, false);
  assert.ok(!fs.existsSync(W.ENV_PATH));
});

test('.env 저장: 줄바꿈으로 다른 값을 끼워넣을 수 없고, 다른 키는 보존된다', () => {
  resetEnv();
  fs.mkdirSync(W.AGENT_DIR, { recursive: true });
  fs.writeFileSync(W.ENV_PATH, 'MY_EXTRA=keep-me\nGMAIL_APP_PASSWORD=' + PW + '\n');
  const r = W.saveConfig({ gmail_sender: 'hong@gmail.com\nGMAIL_APP_PASSWORD=hacked' });
  assert.equal(r.ok, false, '줄바꿈이 섞인 주소는 이메일 모양이 아니므로 거절');
  W.saveConfig({ gmail_sender: 'hong@gmail.com', recipient: 'a@b.com\nX=1' });
  const kv = W.readEnvKv();
  assert.equal(kv.GMAIL_APP_PASSWORD, PW);
  assert.equal(kv.MY_EXTRA, 'keep-me');
  assert.equal(kv.X, undefined);
});

test('loadConfig와 redact는 비밀번호를 내보내지 않는다', () => {
  resetEnv();
  W.saveConfig({ gmail_sender: 'hong@gmail.com', gmail_app_password: PW, krx_key: 'SECRETKRXKEY' });
  const c = W.loadConfig();
  assert.equal(c.has_gmail_password, true);
  assert.equal(c.has_krx_key, true);
  assert.ok(!JSON.stringify(c).includes(PW));
  assert.ok(!JSON.stringify(c).includes('SECRETKRXKEY'));
  const red = W.redact(`pw=${PW} spaced=abcd efgh ijkl mnop key=SECRETKRXKEY`);
  assert.ok(!red.includes(PW) && !red.includes('abcd efgh ijkl mnop') && !red.includes('SECRETKRXKEY'), red);
});

// ---------------------------------------------------------------------------
// HTTP 엔드포인트
// ---------------------------------------------------------------------------
function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, text: d, json: (() => { try { return JSON.parse(d); } catch (e) { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('HTTP: 저장/상태/실행 응답 어디에도 비밀번호가 섞이지 않는다', async (t) => {
  resetEnv();
  const server = W.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const H = { 'X-Wizard': '1' };

  const save = await request(port, 'POST', '/api/save-config', { gmail_sender: 'hong@gmail.com', gmail_app_password: 'abcd efgh ijkl mnop' }, H);
  assert.equal(save.status, 200);
  assert.equal(save.json.ok, true);
  assert.equal(save.json.config.has_gmail_password, true);
  assert.ok(!save.text.includes(PW) && !save.text.includes('abcd efgh'));

  const status = await request(port, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.app, 'claude-setup-wizard');
  assert.ok(!status.text.includes(PW));

  // 만든 프로그램이 실수로 비밀번호를 출력하더라도 화면으로는 가려져서 간다
  fs.writeFileSync(path.join(W.AGENT_DIR, W.AGENTS.basic.file),
    "const fs=require('fs');const p=require('path');const kv=fs.readFileSync(p.join(__dirname,'.env'),'utf8');\n" +
    "console.log('읽은 값:', kv);\nconsole.error('Error: Invalid login: 535-5.7.8 Username and Password not accepted');process.exit(1);\n");
  const start = await request(port, 'POST', '/api/jobs/run-basic', {}, H);
  assert.equal(start.json.ok, true);
  let job;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    job = (await request(port, 'GET', '/api/status')).json.jobs['run-basic'];
    if (job.state !== 'running') break;
  }
  assert.equal(job.state, 'error');
  assert.equal(job.error.kind, 'smtp_auth');
  const all = JSON.stringify(job);
  assert.ok(!all.includes(PW), '실행 결과에서 비밀번호가 가려져야 함');
  assert.ok(all.includes('●●●●(숨김)'));
  const status2 = await request(port, 'GET', '/api/status');
  assert.ok(!status2.text.includes(PW));
});

test('HTTP: 다른 웹사이트에서 온 요청은 막는다', async (t) => {
  const server = W.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const noHeader = await request(port, 'POST', '/api/save-config', { gmail_sender: 'x@y.com', gmail_app_password: PW });
  assert.equal(noHeader.status, 403, '전용 헤더 없는 POST는 거절');
  const badHost = await request(port, 'GET', '/api/status', undefined, { Host: 'evil.example.com' });
  assert.equal(badHost.status, 403, 'DNS 리바인딩 방지: Host 확인');
  const page = await request(port, 'GET', '/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Claude Code 설치 마법사'));
  const nf = await request(port, 'POST', '/api/jobs/rm-rf', {}, { 'X-Wizard': '1' });
  assert.equal(nf.status, 404, '정해진 작업 이름만 실행');
});

// ---------------------------------------------------------------------------
// SMTP 로그인 확인 (가짜 SMTP 서버로)
// ---------------------------------------------------------------------------
function fakeSmtp(authReply) {
  const seen = [];
  const server = net.createServer((sock) => {
    sock.write('220 fake.smtp ready\r\n');
    sock.on('data', (d) => {
      for (const line of d.toString().split('\r\n').filter(Boolean)) {
        seen.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake.smtp\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n');
        else if (line.startsWith('AUTH')) sock.write(authReply + '\r\n');
        else if (line === 'QUIT') sock.end('221 bye\r\n');
      }
    });
  });
  return { server, seen };
}

test('SMTP: 535 응답이면 smtp_auth로 분류되고 비밀번호는 결과에 없다', async (t) => {
  const { server, seen } = fakeSmtp('535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const r = await W.smtpAuthCheck({ user: 'hong@gmail.com', pass: PW, connect: () => net.connect(port, '127.0.0.1') });
  assert.equal(r.ok, false);
  assert.equal(W.classifyError(r).kind, 'smtp_auth');
  assert.ok(!JSON.stringify(r).includes(PW));
  const auth = seen.find((l) => l.startsWith('AUTH PLAIN '));
  assert.equal(Buffer.from(auth.slice(11), 'base64').toString(), `\u0000hong@gmail.com\u0000${PW}`);
});

test('SMTP: 235 응답이면 성공', async (t) => {
  const { server } = fakeSmtp('235 2.7.0 Accepted');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  const r = await W.smtpAuthCheck({ user: 'hong@gmail.com', pass: PW, connect: () => net.connect(port, '127.0.0.1') });
  assert.equal(r.ok, true);
});

test('SMTP: 연결이 안 되면 network로 분류', async () => {
  const r = await W.smtpAuthCheck({ user: 'a', pass: 'b', connect: () => net.connect(1, '127.0.0.1') });
  assert.equal(r.ok, false);
  assert.equal(W.classifyError(r).kind, 'network');
});

// ---------------------------------------------------------------------------
// 예약 / 로그인 확인 보조 함수
// ---------------------------------------------------------------------------
test('작업 스케줄러 XML: 배터리여도 실행, 놓친 실행은 나중에, 경로 이스케이프', () => {
  const xml = W.buildTaskXml({ hour: 7, minute: 5, nodeBin: 'C:\\Program Files\\nodejs\\node.exe', script: 'C:\\Users\\R&D\\agent\\daily_market_agent.js', workDir: 'C:\\Users\\R&D\\agent', user: 'PC\\홍길동', now: new Date(2026, 9, 6) });
  assert.match(xml, /<StartBoundary>2026-10-06T07:05:00<\/StartBoundary>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false</);
  assert.match(xml, /<StartWhenAvailable>true</);
  assert.match(xml, /R&amp;D/);
  assert.ok(!/R&D/.test(xml));
  assert.match(xml, /<UserId>PC\\홍길동<\/UserId>/);
});

test('crontab: 등록/변경/해제가 다른 줄을 건드리지 않는다', () => {
  const orig = 'MAILTO=me\n0 1 * * * backup.sh\n';
  const a = W.updateCrontab(orig, 'ClaudeDailyMarket', '5 7 * * * cd /x && node a.js');
  assert.deepEqual(W.parseCrontab(a, 'ClaudeDailyMarket'), { registered: true, hour: 7, minute: 5 });
  const b = W.updateCrontab(a, 'ClaudeDailyMarket', '30 8 * * * cd /x && node a.js');
  assert.deepEqual(W.parseCrontab(b, 'ClaudeDailyMarket'), { registered: true, hour: 8, minute: 30 });
  assert.equal((b.match(/ClaudeWizard/g) || []).length, 1, '중복 등록 없음');
  const c = W.updateCrontab(b, 'ClaudeDailyMarket', null);
  assert.equal(c, orig);
  assert.deepEqual(W.parseCrontab(c, 'ClaudeDailyMarket'), { registered: false });
});

test('로그인 표시 파일 확인', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-home-'));
  assert.equal(W.loginIndicators(home, {}).logged_in, false);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'x' } }));
  assert.equal(W.loginIndicators(home, {}).logged_in, true);
  fs.rmSync(path.join(home, '.claude.json'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(40) } }));
  assert.equal(W.loginIndicators(home, {}).logged_in, true);
});

// ---------------------------------------------------------------------------
// 배포 파일 규칙
// ---------------------------------------------------------------------------
test('start.bat에는 ASCII 문자만 있다 (cmd.exe 한글 깨짐 방지)', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'start.bat'));
  const bad = [...buf].filter((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
  assert.equal(bad.length, 0, `비ASCII 바이트 ${bad.length}개`);
});

test('server.js는 Node 내장 모듈만 require한다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const builtin = new Set(require('module').builtinModules);
  for (const m of mods) assert.ok(builtin.has(m.replace(/^node:/, '')), `외부 모듈 사용: ${m}`);
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
