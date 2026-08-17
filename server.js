// Claude Code 설치 마법사 - 로컬 대시보드 서버.
// Node.js 내장 모듈만 사용한다(별도 패키지 설치 없이 이 서버 자체는 바로 동작해야 하므로).
// Claude Code 자체가 Node.js 기반이라, 이 마법사도 같은 Node.js 위에서 돌아가게 만들어
// 파이썬 같은 별도 실행환경을 추가로 요구하지 않는다.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

// exe로 패키징(pkg)하면 __dirname은 exe 안에 번들된 읽기전용 가상 경로가 된다.
// index.html 같은 번들 자산은 그 가상 경로에서 읽어도 되지만(pkg가 fs 읽기를 가로채 처리),
// agent/.env처럼 실제로 디스크에 써야 하는 파일은 그 가상 경로에 write가 불가능하고
// 터미널을 그 경로로 cd 시키는 것도 실패한다(실존하지 않는 경로라서) — 그래서 쓰기/터미널용
// 기준 경로는 process.pkg 여부로 분기해 "exe가 실제로 놓인 폴더"를 쓴다.
const BASE = __dirname;
const WRITABLE_BASE = process.pkg ? path.dirname(process.execPath) : __dirname;
const AGENT_DIR = path.join(WRITABLE_BASE, 'agent');
const ENV_PATH = path.join(AGENT_DIR, '.env');
const PUBLIC_DIR = path.join(BASE, 'public');
const PORT = 5055;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout: opts.timeout || 60000, windowsHide: true, shell: opts.shell || false,
      cwd: opts.cwd || undefined,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code || -1) : 0, stdout: stdout || '', stderr: stderr || (err ? String(err.message) : '') });
    });
  });
}

function which(cmd) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch (e) { /* ignore */ }
    }
  }
  return null;
}

function systemNodeBin() {
  // exe로 패키징된 경우 process.execPath는 "진짜 시스템 Node"가 아니라 이 exe 자신을 가리킨다.
  // 그 상태로 이 exe를 재실행하면 새 서버 인스턴스가 뜨려다 포트충돌만 감지하고 끝나버려서,
  // 시스템에 Node가 실제로 없다면 null을 그대로 반환해 "없음"으로 처리해야 한다.
  return which('node') || (process.pkg ? null : process.execPath);
}

function safeSpawn(cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  p.on('error', () => { /* 실행파일을 못 찾아도 서버가 죽지 않도록 무시 */ });
  return p;
}

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

async function apiCheck() {
  const nodeBin = systemNodeBin();
  const claudeBin = which('claude') || which('claude.cmd');
  const nodeVer = nodeBin ? await run(nodeBin, ['--version']) : { ok: false, stdout: '', stderr: '' };
  const claudeVer = claudeBin ? await run(claudeBin, ['--version']) : null;
  return {
    os: process.platform === 'win32' ? 'Windows' : (process.platform === 'darwin' ? 'Mac' : 'Linux'),
    node: { installed: nodeVer.ok, version: nodeVer.ok ? nodeVer.stdout.trim() : null },
    claude_cli: { installed: !!(claudeBin && claudeVer && claudeVer.ok), version: (claudeVer && claudeVer.ok) ? claudeVer.stdout.trim() : null },
    env_configured: fs.existsSync(ENV_PATH),
    agent_exists: fs.existsSync(path.join(AGENT_DIR, 'sector_report_agent.js')),
  };
}

async function apiInstallClaude() {
  let npm = which('npm') || which('npm.cmd');
  if (!npm) {
    // exe로 실행 중이면 exe 자체엔 Node 런타임이 내장돼 있지만, Claude Code 설치(npm install -g)는
    // 시스템에 진짜 설치된 npm이 있어야 한다 — start.bat이 하던 winget 자동설치를 여기서도 시도한다.
    if (process.platform !== 'win32') {
      return { ok: false, message: 'npm을 찾을 수 없습니다. Node.js가 정상 설치됐는지 확인해주세요.' };
    }
    const winget = which('winget') || which('winget.exe');
    if (!winget) {
      return { ok: false, message: 'Node.js가 설치되어 있지 않고, winget도 찾을 수 없습니다. https://nodejs.org 에서 LTS 버전을 직접 설치한 뒤 이 프로그램을 다시 실행해주세요.' };
    }
    const installResult = await run(winget, ['install', '-e', '--id', 'OpenJS.NodeJS.LTS', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeout: 300000 });
    if (!installResult.ok) {
      return { ok: false, message: 'Node.js 자동 설치에 실패했습니다. https://nodejs.org 에서 LTS 버전을 직접 설치한 뒤 이 프로그램을 다시 실행해주세요.', stdout: installResult.stdout, stderr: installResult.stderr };
    }
    // winget으로 막 설치한 직후엔 이 프로세스의 PATH가 아직 갱신 전이라 which()가 못 찾을 수 있다 —
    // 새로 설치되는 표준 경로를 직접 추정해서 재시도한다. 그래도 못 찾으면 프로그램 재시작을 안내한다.
    const guess = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npm.cmd');
    npm = fs.existsSync(guess) ? guess : (which('npm') || which('npm.cmd'));
    if (!npm) {
      return { ok: false, message: 'Node.js는 설치됐지만 아직 인식되지 않습니다. 이 프로그램을 완전히 종료했다가 다시 실행해주세요.' };
    }
  }
  return run(npm, ['install', '-g', '@anthropic-ai/claude-code'], { timeout: 180000, shell: true });
}

async function apiOpenTerminal() {
  // Claude Code는 "지금 터미널이 있는 폴더"를 기준으로 파일을 찾고 만든다.
  // 그래서 새 터미널은 반드시 실제로 쓰기 가능한 폴더(WRITABLE_BASE) 안에서 열려야 한다 — 그냥 spawn만 하면
  // Windows에서 System32 등 엉뚱한 폴더에서 열리는 경우가 있어(cwd 미지정), 명시적으로 이동시킨다.
  try {
    if (process.platform === 'win32') {
      // /d 로 드라이브까지 같이 이동, echo로 지금 어느 폴더인지 눈으로 보이게 함
      // (exe로 패키징된 경우 BASE가 아니라 exe가 실제로 놓인 WRITABLE_BASE로 이동해야
      //  Claude Code가 만드는 agent/ 폴더가 실제 디스크에 남는다)
      const cmdLine = `cd /d "${WRITABLE_BASE}" && echo 지금 이 폴더 안에서 작업합니다: ${WRITABLE_BASE} && echo claude 라고 입력한 뒤 Enter를 눌러 시작하세요.`;
      safeSpawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', cmdLine], { detached: true, stdio: 'ignore', windowsHide: false, cwd: WRITABLE_BASE }).unref();
    } else if (process.platform === 'darwin') {
      safeSpawn('open', ['-a', 'Terminal', WRITABLE_BASE], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const terms = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
      let launched = false;
      for (const t of terms) {
        const p = which(t);
        if (p) { safeSpawn(p, [], { detached: true, stdio: 'ignore', cwd: WRITABLE_BASE }).unref(); launched = true; break; }
      }
      if (!launched) return { ok: false, message: '터미널 프로그램을 찾지 못했습니다.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}

async function apiCheckLogin() {
  const claudeBin = which('claude') || which('claude.cmd');
  if (!claudeBin) return { ok: false, logged_in: false, message: 'Claude Code CLI가 설치되어 있지 않습니다.' };
  const r = await run(claudeBin, ['-p', '이 메시지를 받으면 정확히 OK 라고만 답해줘'], { timeout: 30000 });
  const loggedIn = r.ok && r.stdout.includes('OK');
  return { ok: true, logged_in: loggedIn, raw: r.stdout.slice(0, 300), stderr: r.stderr.slice(0, 300) };
}

function readEnvKv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const kv = {};
  for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) kv[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return kv;
}

function apiSaveConfig(data) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const existing = readEnvKv();
  // 비밀번호/API키 칸을 비워둔 채 저장하면 "삭제"가 아니라 "기존 값 유지"로 처리한다.
  // (화면 새로고침 후 다시 저장할 때, 마스킹 표시 때문에 실수로 빈 값을 덮어쓰는 사고를 막기 위함)
  const gmailPw = data.gmail_app_password || existing.GMAIL_APP_PASSWORD || '';
  const krxKey = data.krx_key || existing.KRX_AUTH_KEY || '';
  const lines = [
    `GMAIL_SENDER=${data.gmail_sender || ''}`,
    `GMAIL_APP_PASSWORD=${gmailPw}`,
    `REPORT_RECIPIENT=${data.recipient || ''}`,
    `KRX_AUTH_KEY=${krxKey}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf-8');
  return { ok: true };
}

function apiLoadConfig() {
  const kv = readEnvKv();
  return {
    gmail_sender: kv.GMAIL_SENDER || '',
    has_gmail_password: !!kv.GMAIL_APP_PASSWORD,
    recipient: kv.REPORT_RECIPIENT || '',
    has_krx_key: !!kv.KRX_AUTH_KEY,
  };
}

async function ensureNodeModules() {
  const nmPath = path.join(AGENT_DIR, 'node_modules', 'nodemailer');
  if (fs.existsSync(nmPath)) return { ok: true };
  const npm = which('npm') || which('npm.cmd');
  if (!npm) return { ok: false, stderr: 'npm을 찾을 수 없습니다.' };
  return run(npm, ['install', '--no-audit', '--no-fund', 'nodemailer'], { timeout: 120000, shell: true, cwd: AGENT_DIR });
}

async function apiTestSend() {
  const prep = await ensureNodeModules();
  if (!prep.ok) return prep;
  const nodeBin = systemNodeBin();
  if (!nodeBin) return { ok: false, stderr: '시스템에 설치된 Node.js를 찾을 수 없습니다.' };
  return run(nodeBin, [path.join(AGENT_DIR, 'sector_report_agent.js')], { timeout: 180000 });
}

async function apiSchedule(data) {
  const hh = String(data.hour || '07').padStart(2, '0');
  const mm = String(data.minute || '00').padStart(2, '0');
  const nodeBin = systemNodeBin();
  if (!nodeBin) return { ok: false, stderr: '시스템에 설치된 Node.js를 찾을 수 없습니다.' };
  const scriptPath = path.join(AGENT_DIR, 'sector_report_agent.js');
  if (process.platform === 'win32') {
    return run('schtasks', ['/create', '/f', '/sc', 'DAILY', '/st', `${hh}:${mm}`,
      '/tn', 'ClaudeSectorReport', '/tr', `"${nodeBin}" "${scriptPath}"`]);
  } else {
    const cur = await run('crontab', ['-l']);
    const existing = cur.ok ? cur.stdout : '';
    const lines = existing.split('\n').filter((l) => !l.includes('ClaudeSectorReport'));
    lines.push('# ClaudeSectorReport');
    lines.push(`${parseInt(mm, 10)} ${parseInt(hh, 10)} * * * ${nodeBin} ${scriptPath}`);
    return new Promise((resolve) => {
      const p = spawn('crontab', ['-']);
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', (code) => resolve({ ok: code === 0, stderr }));
      p.stdin.write(lines.join('\n') + '\n');
      p.stdin.end();
    });
  }
}

const routes = {
  'GET /api/check': async () => ({ code: 200, body: await apiCheck() }),
  'POST /api/install/claude': async () => ({ code: 200, body: await apiInstallClaude() }),
  'POST /api/open-terminal': async () => ({ code: 200, body: await apiOpenTerminal() }),
  'POST /api/check-login': async () => ({ code: 200, body: await apiCheckLogin() }),
  'GET /api/load-config': async () => ({ code: 200, body: apiLoadConfig() }),
  'POST /api/test-send': async () => ({ code: 200, body: await apiTestSend() }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (key === 'POST /api/save-config') {
    const data = await readBody(req);
    return sendJson(res, apiSaveConfig(data));
  }
  if (key === 'POST /api/schedule') {
    const data = await readBody(req);
    return sendJson(res, await apiSchedule(data));
  }

  if (routes[key]) {
    try {
      const { code, body } = await routes[key]();
      return sendJson(res, body, code);
    } catch (e) {
      return sendJson(res, { ok: false, message: String(e) }, 500);
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function openBrowser(openUrl) {
  try {
    if (process.platform === 'win32') safeSpawn('cmd', ['/c', 'start', '""', openUrl], { shell: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') safeSpawn('open', [openUrl], { stdio: 'ignore' }).unref();
    else safeSpawn('xdg-open', [openUrl], { stdio: 'ignore' }).unref();
  } catch (e) { console.log('브라우저를 자동으로 열지 못했습니다. 위 주소를 직접 열어주세요.'); }
}

server.on('error', (err) => {
  const openUrl = `http://127.0.0.1:${PORT}`;
  if (err.code === 'EADDRINUSE') {
    console.log('이미 대시보드가 실행 중인 것 같습니다. 새로 켜는 대신 기존 화면을 엽니다.');
    console.log(openUrl);
    openBrowser(openUrl);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.error('서버 시작 중 오류가 발생했습니다:', err);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const openUrl = `http://127.0.0.1:${PORT}`;
  console.log(`Claude Code 설치 마법사가 준비됐습니다: ${openUrl}`);
  openBrowser(openUrl);
});
