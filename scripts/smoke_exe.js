// 만든 실행 파일이 실제로 켜지는지 확인한다(CI용).
//   node scripts/smoke_exe.js dist/ClaudeSetupWizard.exe
// 임시 작업 폴더로 켜서 /api/ping, 첫 화면(제목), .claude/settings.json 생성까지 본 뒤 끈다.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const exe = path.resolve(process.argv[2] || '');
if (!fs.existsSync(exe)) { console.error(`실행 파일이 없습니다: ${exe}`); process.exit(1); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-smoke-'));

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: 5055, path: p, timeout: 3000 }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  let log = '';
  const child = spawn(exe, [], { env: { ...process.env, WIZARD_NO_BROWSER: '1', WIZARD_WORK_DIR: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const fail = (msg) => { console.error(msg); console.error(log); child.kill(); process.exit(1); };
  let ping = null;
  for (let i = 0; i < 60 && !ping; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await get('/api/ping'); if (r.status === 200) ping = JSON.parse(r.text); } catch (e) { /* 아직 안 켜짐 */ }
  }
  if (!ping || ping.app !== 'claude-setup-wizard') fail('마법사가 켜지지 않았습니다.');
  const page = await get('/');
  if (!/<title>Claude Code 설치 마법사<\/title>/.test(page.text)) fail('첫 화면(index.html)을 exe 안에서 읽지 못했습니다.');
  const status = JSON.parse((await get('/api/status')).text);
  if (status.exe !== true) fail('status.exe가 true가 아닙니다(SEA로 인식 안 됨).');
  if (!fs.existsSync(path.join(work, '.claude', 'settings.json'))) fail('.claude/settings.json을 만들지 않았습니다.');
  console.log('OK', JSON.stringify({ node: status.node, claude: status.claude }));
  child.kill();
  setTimeout(() => process.exit(0), 500);
})();
