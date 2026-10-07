// Claude Code 설치 마법사 - 로컬 대시보드 서버.
// Node.js 내장 모듈만 사용한다(별도 패키지 설치 없이 이 서버 자체는 바로 동작해야 하므로).
// Claude Code 자체가 Node.js 기반이라, 이 마법사도 같은 Node.js 위에서 돌아가게 만들어
// 파이썬 같은 별도 실행환경을 추가로 요구하지 않는다.
//
// 이 파일은 두 가지로 쓰인다.
//  - `node server.js` : 마법사 서버를 띄우고 브라우저를 연다(start.bat이 이렇게 실행).
//  - 모듈로 불러오기 : 테스트(test/server.test.js)가 내부 함수를 불러 검사한다.
'use strict';
const http = require('http');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const APP_ID = 'claude-setup-wizard';
const BASE = __dirname;
// 테스트에서는 WIZARD_WORK_DIR로 임시 폴더를 지정해 실제 agent/ 폴더를 건드리지 않는다.
const WORK_DIR = process.env.WIZARD_WORK_DIR ? path.resolve(process.env.WIZARD_WORK_DIR) : BASE;
const AGENT_DIR = path.join(WORK_DIR, 'agent');
const ENV_PATH = path.join(AGENT_DIR, '.env');
const PUBLIC_DIR = path.join(BASE, 'public');
const DEFAULT_PORT = 5055;
const MIN_NODE_MAJOR = 18;
const IS_WIN = process.platform === 'win32';

// 실습으로 만드는 자동화 두 가지. 파일 이름은 4단계 요청 문장(index.html)과 반드시 같아야 한다.
const AGENTS = {
  basic: { file: 'daily_market_agent.js', task: 'ClaudeDailyMarket', label: '매일 아침 환율·코스피 요약' },
  advanced: { file: 'sector_report_agent.js', task: 'ClaudeSectorReport', label: '섹터 리포트(심화)' },
};

// ---------------------------------------------------------------------------
// 명령 실행 도우미
// ---------------------------------------------------------------------------

// 한국어 Windows의 명령 프롬프트 출력은 UTF-8이 아니라 CP949(EUC-KR 확장)라서,
// 그대로 UTF-8로 읽으면 오류 문구가 깨진다. UTF-8로 먼저 시도하고 안 되면 CP949로 읽는다.
function decodeOutput(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('euc-kr').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}

// cmd.exe를 거쳐 실행할 때(.cmd 파일) "C:\Program Files\..."처럼 띄어쓰기가 있는 경로는 따옴표로 감싸야 한다.
function quoteForShell(p) {
  return /[\s&()^]/.test(p) && !/^".*"$/.test(p) ? `"${p}"` : p;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const useShell = !!opts.shell;
    let child;
    try {
      child = execFile(useShell ? quoteForShell(cmd) : cmd, useShell ? args.map(quoteForShell) : args, {
        timeout: opts.timeout || 60000, windowsHide: true, shell: useShell,
        cwd: opts.cwd || undefined, env: opts.env || process.env, encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        const out = decodeOutput(stdout);
        let errText = decodeOutput(stderr);
        if (err && !errText) errText = String(err.message || err);
        resolve({
          ok: !err,
          code: err ? (err.code !== undefined ? err.code : -1) : 0,
          timedOut: !!(err && err.killed && err.signal === 'SIGTERM'),
          stdout: out, stderr: errText,
        });
      });
    } catch (e) {
      resolve({ ok: false, code: e.code || -1, stdout: '', stderr: String(e.message || e) });
      return;
    }
    if (opts.input !== undefined && child.stdin) { child.stdin.end(opts.input); }
  });
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function which(cmd) {
  const exts = IS_WIN ? ['.cmd', '.exe'] : [''];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

function systemNodeBin() {
  return which('node') || process.execPath;
}

function npmBin() {
  const w = which('npm');
  if (w) return w;
  // Node.js를 막 설치해서 PATH가 아직 갱신되지 않은 경우, 표준 설치 위치를 직접 찾아본다.
  const guess = IS_WIN
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npm.cmd')
    : path.join(path.dirname(process.execPath), 'npm');
  return isFile(guess) ? guess : null;
}

// Claude Code는 설치 방법에 따라 놓이는 곳이 다르다. PATH가 아직 갱신되지 않았어도
// (설치 직후 흔함) 찾을 수 있도록 알려진 위치를 함께 살펴본다.
function claudeCandidates(home = os.homedir()) {
  const list = [];
  const w = which('claude');
  if (w) list.push(w);
  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    list.push(path.join(appData, 'npm', 'claude.cmd'));
    list.push(path.join(home, '.local', 'bin', 'claude.exe'));
  } else {
    list.push(path.join(home, '.local', 'bin', 'claude'));
    list.push(path.join(home, '.claude', 'local', 'claude'));
    list.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  }
  return list;
}

function findClaude(home) {
  return claudeCandidates(home).find(isFile) || null;
}

// 다른 프로그램(터미널, 예약 작업)을 띄울 때 node와 claude를 확실히 찾을 수 있도록 PATH 앞에 덧붙인다.
function augmentedEnv() {
  const extra = [path.dirname(systemNodeBin())];
  const c = findClaude();
  if (c) extra.push(path.dirname(c));
  if (IS_WIN && process.env.APPDATA) extra.push(path.join(process.env.APPDATA, 'npm'));
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...process.env, [key]: extra.concat([process.env[key] || '']).join(path.delimiter) };
}

function safeSpawn(cmd, args, opts) {
  const p = spawn(cmd, args, opts);
  p.on('error', () => { /* 실행파일을 못 찾아도 서버가 죽지 않도록 무시 */ });
  return p;
}

// ---------------------------------------------------------------------------
// 오류 번역: 명령의 stderr/종료코드를 "무슨 일인지 / 지금 할 일"로 바꾼다.
// 화면에는 이 결과를 보여주고, 원문은 [자세히 보기] 안에 접어둔다.
// ---------------------------------------------------------------------------

const ERROR_RULES = [
  {
    kind: 'timeout',
    match: (t, r) => r.timedOut || /\bETIMEDOUT\b.*(smtp|465)|SMTP timeout/i.test(t),
    title: '시간이 너무 오래 걸려서 멈췄어요',
    what: '정해진 시간 안에 작업이 끝나지 않았어요. 인터넷이 느리거나, 상대편 서버가 대답을 안 했을 수 있어요.',
    todo: ['잠시(1~2분) 기다린 뒤 [다시 시도]를 눌러주세요.', '계속 반복되면 인터넷 연결(와이파이·랜선)을 확인해주세요.'],
  },
  {
    kind: 'port_in_use',
    match: (t) => /EADDRINUSE|address already in use/i.test(t),
    title: '포트 5055를 다른 프로그램이 쓰고 있어요',
    what: '마법사가 이미 다른 창에서 켜져 있거나, 다른 프로그램이 같은 번호(5055)를 쓰고 있어요.',
    todo: ['열려 있는 다른 검은 창(마법사 창)을 모두 닫아주세요.', 'start.bat을 다시 더블클릭하세요. 그래도 안 되면 마법사가 5056~5064번을 자동으로 대신 씁니다.'],
  },
  {
    kind: 'smtp_app_password_required',
    match: (t) => /\b534\b|Application-specific password required/i.test(t),
    title: 'Gmail이 "앱 비밀번호"를 요구해요 (534)',
    what: '평소 로그인 비밀번호를 넣으신 것 같아요. 프로그램이 메일을 보낼 때는 따로 발급한 16자리 "앱 비밀번호"가 필요해요.',
    todo: ['3단계 화면의 그림 안내를 따라 앱 비밀번호를 발급받으세요.', '받은 16자리 코드를 "Gmail 앱 비밀번호" 칸에 붙여넣고 [저장하고 확인]을 누르세요.'],
  },
  {
    kind: 'smtp_auth',
    match: (t) => /\b535\b|Username and Password not accepted|Invalid login|BadCredentials|EAUTH/i.test(t),
    title: 'Gmail 로그인이 거절됐어요 (535)',
    what: 'Gmail 주소나 앱 비밀번호가 맞지 않는다고 구글이 대답했어요. 오타가 있거나, 앱 비밀번호를 삭제했거나, 평소 비밀번호를 넣은 경우에 이렇게 돼요.',
    todo: ['Gmail 주소에 오타가 없는지 확인하세요.', '앱 비밀번호를 새로 발급받아 다시 붙여넣고 [저장하고 확인]을 누르세요(예전 것은 지워도 됩니다).'],
  },
  {
    kind: 'smtp_missing_credentials',
    match: (t) => /Missing credentials|GMAIL_(SENDER|APP_PASSWORD).*(undefined|missing|없)/i.test(t),
    title: 'Gmail 정보가 비어 있어요',
    what: '메일을 보낼 Gmail 주소나 앱 비밀번호를 프로그램이 찾지 못했어요.',
    todo: ['3단계에서 Gmail 주소와 앱 비밀번호를 저장했는지 확인하세요(초록 체크가 보여야 해요).', '저장했는데도 같다면 아래 [고쳐달라고 요청 복사]를 눌러 Claude Code에게 붙여넣으세요.'],
  },
  {
    kind: 'npm_eacces',
    match: (t) => /EACCES/.test(t) && /npm/i.test(t),
    title: '설치 폴더에 쓸 권한이 없어요',
    what: 'npm이 프로그램을 넣으려는 폴더가 잠겨 있어요(주로 Mac/리눅스에서 생겨요).',
    todo: ['관리자 권한(sudo)으로 억지로 설치하지 마세요.', '[막혔어요]의 "공식 설치 페이지" 안내대로 Claude Code 공식 설치 방법을 써주세요.'],
  },
  {
    kind: 'npm_enoent',
    match: (t) => /npm (ERR!|error) (code|syscall|errno) ENOENT|ENOENT.*npm|npm.*ENOENT/i.test(t),
    title: '필요한 폴더나 파일이 없어요',
    what: 'npm이 작업에 필요한 폴더를 찾지 못했어요. Windows에서는 "AppData\\Roaming\\npm" 폴더가 없을 때 자주 생겨요.',
    todo: ['[다시 시도]를 눌러주세요. 마법사가 폴더를 만들고 다시 설치합니다.', '계속되면 nodejs.org에서 Node.js LTS를 다시 설치한 뒤 start.bat을 다시 실행하세요.'],
  },
  {
    kind: 'network',
    match: (t) => /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|getaddrinfo|proxy|SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF|socket hang up|network/i.test(t),
    title: '인터넷 연결에 문제가 있어요',
    what: '인터넷에 연결하지 못했거나, 회사·학교 네트워크의 보안 장치(프록시·방화벽)가 막고 있어요.',
    todo: ['와이파이나 랜선이 연결돼 있는지, 다른 웹사이트가 잘 열리는지 확인하세요.', '회사 PC라면 전산 담당자에게 "npm(registry.npmjs.org)과 Gmail 메일 발송(smtp.gmail.com 465번)이 막혀 있는지" 물어보세요.', '확인 후 [다시 시도]를 눌러주세요.'],
  },
  {
    kind: 'not_logged_in',
    match: (t) => /not logged in|please run \/login|Invalid API key|authentication_error|OAuth token/i.test(t),
    title: '아직 Claude 로그인이 안 돼 있어요',
    what: 'Claude Code가 로그인 정보를 찾지 못했어요.',
    todo: ['2단계의 [로그인 창 열기]를 눌러 로그인을 마쳐주세요.', '유료 구독(Pro/Max) 계정인지 확인하세요. 무료 계정은 Claude Code를 쓸 수 없어요.'],
  },
  {
    kind: 'node_old',
    match: (t) => /requires Node(\.js)? (version )?1[89]|Node\.js \d+ or (higher|newer)|Unsupported engine|SyntaxError: Unexpected token '\?'/i.test(t),
    title: 'Node.js 버전이 너무 낮아요',
    what: `Claude Code는 Node.js ${MIN_NODE_MAJOR} 이상에서만 동작해요.`,
    todo: ['nodejs.org에서 "LTS" 버전을 받아 설치하세요(다음·다음·마침).', '마법사 검은 창을 닫고 start.bat을 다시 실행하세요.'],
  },
  {
    kind: 'not_found',
    match: (t, r) => /is not recognized as an internal or external command|내부 또는 외부 명령|command not found|spawn \S+ ENOENT|No such file or directory.*(node|claude|npm)/i.test(t) || r.code === 'ENOENT' || r.code === 9009 || r.code === 127,
    title: '프로그램을 찾지 못했어요',
    what: '컴퓨터가 실행할 프로그램을 찾지 못했어요. 방금 설치했다면, 컴퓨터가 새 프로그램을 아직 알아차리지 못한 상태일 수 있어요.',
    todo: ['마법사 검은 창을 닫고 start.bat을 다시 더블클릭하세요(새로 설치된 프로그램을 알아차리게 됩니다).', '그래도 안 되면 PC를 다시 시작한 뒤 start.bat을 실행하세요.'],
  },
  {
    kind: 'permission',
    match: (t) => /EPERM|EACCES|Access is denied|액세스가 거부|권한이 없|permission denied|operation not permitted/i.test(t),
    title: '권한이 없어서 막혔어요',
    what: '이 작업에 필요한 권한이 없어서 컴퓨터가 막았어요. 다른 창이 파일을 쓰고 있거나, 백신 프로그램이 막는 경우도 있어요.',
    todo: ['열려 있는 Claude Code·명령 프롬프트 창을 모두 닫고 [다시 시도]를 눌러주세요.', '회사 PC라면 관리자에게 "프로그램 설치/예약 작업 등록 권한"을 문의하세요.'],
  },
  {
    kind: 'module_missing',
    match: (t) => /Cannot find module|MODULE_NOT_FOUND/.test(t),
    title: '필요한 부품(모듈)이 설치되지 않았어요',
    what: '만든 프로그램이 쓰는 부품이 이 컴퓨터에 아직 없어요.',
    todo: ['[다시 시도]를 누르면 마법사가 부품 설치를 다시 시도해요.', '그래도 같으면 [고쳐달라고 요청 복사]를 눌러 Claude Code에게 붙여넣으세요.'],
  },
  {
    kind: 'code_error',
    match: (t) => /SyntaxError|TypeError|ReferenceError|RangeError|Error: /.test(t),
    title: '만든 프로그램 안에 오류가 있어요',
    what: 'Claude Code가 만든 프로그램이 실행 도중 멈췄어요. 흔한 일이고, Claude Code에게 고쳐달라고 하면 됩니다.',
    todo: ['아래 [고쳐달라고 요청 복사]를 누르세요.', 'Claude Code 창에 Ctrl+V로 붙여넣고 Enter를 누르세요. 고쳐지면 다시 [테스트 메일 보내기]를 누르세요.'],
  },
];

const UNKNOWN_ERROR = {
  kind: 'unknown',
  title: '예상하지 못한 문제가 생겼어요',
  what: '마법사가 아는 유형의 문제가 아니에요.',
  todo: ['[다시 시도]를 한 번 눌러보세요.', '그래도 같으면 [자세히 보기]의 내용을 복사해 Claude Code에게 "이 오류가 무슨 뜻이야? 쉽게 설명해줘"라고 물어보세요.'],
};

function classifyError(result = {}) {
  const text = [result.stderr, result.stdout, result.message, typeof result.code === 'string' ? result.code : '']
    .filter(Boolean).join('\n');
  const rule = ERROR_RULES.find((r) => r.match(text, result)) || UNKNOWN_ERROR;
  return { kind: rule.kind, title: rule.title, what: rule.what, todo: rule.todo.slice() };
}

// ---------------------------------------------------------------------------
// agent/.env 읽기/쓰기. 비밀번호는 화면·로그로 되돌려 보내지 않는다(저장 여부만 알려준다).
// ---------------------------------------------------------------------------

const ENV_ORDER = ['GMAIL_SENDER', 'GMAIL_APP_PASSWORD', 'REPORT_RECIPIENT', 'KRX_AUTH_KEY'];
const SECRET_KEYS = ['GMAIL_APP_PASSWORD', 'KRX_AUTH_KEY'];

function readEnvKv() {
  if (!isFile(ENV_PATH)) return {};
  const kv = {};
  for (const raw of fs.readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return kv;
}

function cleanValue(v) {
  // 줄바꿈이 들어가면 .env에 다른 줄을 끼워 넣을 수 있으므로 제거한다.
  return String(v == null ? '' : v).replace(/[\r\n]/g, '').trim();
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function inputError(what, todo) {
  return { ok: false, error: { kind: 'bad_input', title: '입력한 내용을 한 번 확인해주세요', what, todo } };
}

function saveConfig(data = {}) {
  const existing = readEnvKv();
  const sender = cleanValue(data.gmail_sender) || existing.GMAIL_SENDER || '';
  // 앱 비밀번호는 구글이 "abcd efgh ijkl mnop"처럼 띄어 보여주므로 공백을 모두 지운다.
  const newPw = cleanValue(data.gmail_app_password).replace(/\s+/g, '');
  const newKrx = cleanValue(data.krx_key);

  if (!sender) return inputError('보내는 Gmail 주소가 비어 있어요.', ['예: hong@gmail.com 처럼 입력해주세요.']);
  if (!EMAIL_RE.test(sender)) return inputError(`"${sender}"는 이메일 주소 모양이 아니에요.`, ['@와 .com이 들어간 전체 주소를 입력해주세요.']);
  if (newPw && !/^[A-Za-z]{16}$/.test(newPw)) {
    return inputError(`앱 비밀번호는 띄어쓰기를 빼면 영어 16글자예요. 지금은 ${newPw.length}글자예요.`,
      ['평소 로그인 비밀번호가 아니라, 구글이 노란 상자에 보여준 16자리 코드를 붙여넣어주세요.']);
  }
  if (!newPw && !existing.GMAIL_APP_PASSWORD) return inputError('Gmail 앱 비밀번호가 비어 있어요.', ['아래 그림 안내를 따라 16자리 앱 비밀번호를 발급받아 붙여넣어주세요.']);
  const recipient = cleanValue(data.recipient) || sender;
  if (!EMAIL_RE.test(recipient)) return inputError(`받는 주소 "${recipient}"가 이메일 주소 모양이 아니에요.`, ['비워두면 보내는 주소로 받습니다.']);

  // 비밀번호/API키 칸을 비워둔 채 저장하면 "삭제"가 아니라 "기존 값 유지"로 처리한다.
  // (화면에는 저장된 값을 다시 보여주지 않으므로, 빈 칸으로 다시 저장해도 사라지지 않아야 한다)
  const next = { ...existing };
  next.GMAIL_SENDER = sender;
  next.GMAIL_APP_PASSWORD = newPw || existing.GMAIL_APP_PASSWORD || '';
  next.REPORT_RECIPIENT = recipient;
  next.KRX_AUTH_KEY = newKrx || existing.KRX_AUTH_KEY || '';

  const keys = ENV_ORDER.concat(Object.keys(next).filter((k) => !ENV_ORDER.includes(k)));
  const lines = ['# Claude Code 설치 마법사가 만든 파일입니다. 이 PC에만 저장되며 다른 사람에게 보내지 마세요.']
    .concat(keys.map((k) => `${k}=${cleanValue(next[k])}`));
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
  lastSmtp = null; // 정보가 바뀌었으니 이전 확인 결과는 무효
  return { ok: true, config: loadConfig() };
}

function loadConfig() {
  const kv = readEnvKv();
  return {
    gmail_sender: kv.GMAIL_SENDER || '',
    recipient: kv.REPORT_RECIPIENT || '',
    has_gmail_password: !!kv.GMAIL_APP_PASSWORD,
    has_krx_key: !!kv.KRX_AUTH_KEY,
  };
}

// 실행 결과에 비밀번호가 섞여 나오면(만든 프로그램이 실수로 출력한 경우 등) 화면에 보내기 전에 가린다.
function redact(text) {
  let out = String(text || '');
  const kv = readEnvKv();
  for (const key of SECRET_KEYS) {
    const v = kv[key];
    if (!v || v.length < 4) continue;
    const variants = [v];
    if (key === 'GMAIL_APP_PASSWORD' && v.length === 16) variants.push(v.match(/.{4}/g).join(' '));
    for (const s of variants) out = out.split(s).join('●●●●(숨김)');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gmail 앱 비밀번호 확인: 메일을 보내지 않고 로그인(AUTH)까지만 해본다.
// nodemailer 같은 외부 패키지 없이 tls 모듈로 SMTP 대화를 직접 한다.
// ---------------------------------------------------------------------------

let lastSmtp = null;

function smtpAuthCheck({ user, pass, host = 'smtp.gmail.com', port = 465, timeoutMs = 20000, connect } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let stage = 'greet';
    let buf = '';
    let sock;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.end(); } catch (e) { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, timedOut: true, stderr: 'SMTP timeout: 서버가 응답하지 않습니다.' }), timeoutMs);
    try {
      sock = connect ? connect() : tls.connect({ host, port, servername: host });
    } catch (e) {
      finish({ ok: false, stderr: String(e.message || e) });
      return;
    }
    const send = (line) => sock.write(line + '\r\n');
    sock.on('error', (e) => finish({ ok: false, code: e.code, stderr: `${e.code || ''} ${e.message}`.trim() }));
    sock.on('close', () => finish({ ok: false, stderr: 'SMTP 연결이 끊어졌습니다.' }));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m || m[2] === '-') continue; // 여러 줄 응답의 중간 줄
        const code = Number(m[1]);
        if (stage === 'greet') {
          if (code !== 220) return finish({ ok: false, stderr: line });
          stage = 'ehlo'; send('EHLO localhost');
        } else if (stage === 'ehlo') {
          if (code !== 250) return finish({ ok: false, stderr: line });
          stage = 'auth';
          send('AUTH PLAIN ' + Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64'));
        } else if (stage === 'auth') {
          if (code === 235) { stage = 'quit'; send('QUIT'); return finish({ ok: true, stdout: 'Gmail 로그인 확인 완료' }); }
          return finish({ ok: false, stderr: line });
        }
      }
    });
  });
}

async function checkSmtp() {
  const kv = readEnvKv();
  if (!kv.GMAIL_SENDER || !kv.GMAIL_APP_PASSWORD) {
    return { ok: false, stderr: 'Missing credentials: GMAIL_SENDER/GMAIL_APP_PASSWORD missing' };
  }
  const r = await smtpAuthCheck({ user: kv.GMAIL_SENDER, pass: kv.GMAIL_APP_PASSWORD });
  lastSmtp = { ok: r.ok, at: Date.now() };
  return r;
}

// ---------------------------------------------------------------------------
// 상태 확인(5초마다 화면이 부른다) — 가볍게 끝나도록 무거운 결과는 잠깐 기억해둔다.
// ---------------------------------------------------------------------------

const versionCache = new Map();

async function claudeVersion(bin) {
  let mtime = 0;
  try { mtime = fs.statSync(bin).mtimeMs; } catch (e) { return null; }
  const hit = versionCache.get(bin);
  if (hit && hit.mtime === mtime) return hit.version;
  const r = await run(bin, ['--version'], { timeout: 20000, shell: IS_WIN && /\.cmd$/i.test(bin), env: augmentedEnv() });
  const version = r.ok ? (r.stdout.trim().split(/\s+/)[0] || 'installed') : null;
  if (version) versionCache.set(bin, { mtime, version });
  return version;
}

// 로그인 여부를 매번 Claude에게 물어보면 느리고 사용량도 든다. 그래서 평소에는
// 로그인하면 생기는 파일만 살펴보고, [실제로 확인] 버튼을 누를 때만 진짜로 물어본다.
function loginIndicators(home = os.homedir(), env = process.env) {
  if (env.ANTHROPIC_API_KEY) return { logged_in: true, how: 'api_key' };
  const cfgDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  try {
    if (fs.statSync(path.join(cfgDir, '.credentials.json')).size > 20) return { logged_in: true, how: 'credentials' };
  } catch (e) { /* 없음 */ }
  const cj = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json');
  try {
    const j = JSON.parse(fs.readFileSync(cj, 'utf-8'));
    if (j && j.oauthAccount) return { logged_in: true, how: 'account' };
  } catch (e) { /* 없음 */ }
  return { logged_in: false, how: null };
}

let loginVerified = null; // { ok, at }

async function verifyLogin() {
  const bin = findClaude();
  if (!bin) return { ok: false, code: 'ENOENT', stderr: 'claude: command not found' };
  const r = await run(bin, ['-p', 'Reply with exactly the two letters: OK'], {
    timeout: 120000, cwd: WORK_DIR, shell: IS_WIN && /\.cmd$/i.test(bin), env: augmentedEnv(),
  });
  const ok = r.ok && /OK/.test(r.stdout);
  loginVerified = { ok, at: Date.now() };
  return ok ? { ok: true, stdout: '로그인 확인 완료' } : { ...r, ok: false, stderr: r.stderr || r.stdout || 'not logged in' };
}

function agentPath(job) { return path.join(AGENT_DIR, AGENTS[job].file); }

function agentInfo(job) {
  try {
    const st = fs.statSync(agentPath(job));
    return { exists: st.isFile(), file: `agent/${AGENTS[job].file}`, modified: st.mtimeMs };
  } catch (e) {
    return { exists: false, file: `agent/${AGENTS[job].file}` };
  }
}

function lastRunLog() {
  const p = path.join(AGENT_DIR, 'last_run.log');
  try {
    const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/).filter(Boolean);
    return { lines: lines.slice(-5).map(redact), modified: fs.statSync(p).mtimeMs };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 매일 자동 실행(예약). Windows는 작업 스케줄러, 맥/리눅스는 crontab.
// ---------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// schtasks의 간단한 /sc DAILY 방식은 "노트북이 배터리일 때는 실행 안 함"이 기본값이라
// 노트북 사용자는 메일을 못 받는 일이 생긴다. XML로 등록하면 그 설정을 끌 수 있고,
// 정해진 시각에 PC가 꺼져 있었으면 다음에 켜졌을 때 한 번 실행(StartWhenAvailable)도 된다.
function buildTaskXml({ hour, minute, nodeBin, script, workDir, user, now = new Date() }) {
  const pad = (n) => String(n).padStart(2, '0');
  const start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(hour)}:${pad(minute)}:00`;
  const userId = user ? `<UserId>${xmlEscape(user)}</UserId>` : '';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Claude Code setup wizard - daily email</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${start}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${userId}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(nodeBin)}</Command>
      <Arguments>"${xmlEscape(script)}"</Arguments>
      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const CRON_MARK = '# ClaudeWizard:';

function parseCrontab(text, task) {
  const lines = String(text || '').split('\n');
  const i = lines.findIndex((l) => l.trim() === CRON_MARK + task);
  if (i < 0 || !lines[i + 1]) return { registered: false };
  const m = /^(\d+)\s+(\d+)\s/.exec(lines[i + 1].trim());
  return m ? { registered: true, hour: Number(m[2]), minute: Number(m[1]) } : { registered: true };
}

function updateCrontab(text, task, newLine) {
  const lines = String(text || '').split('\n').filter((l, idx, arr) => {
    if (l.trim() === CRON_MARK + task) return false;
    if (idx > 0 && arr[idx - 1].trim() === CRON_MARK + task) return false;
    return true;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (newLine) lines.push(CRON_MARK + task, newLine);
  return lines.length ? lines.join('\n') + '\n' : '';
}

const scheduleCache = {};

async function querySchedule(job) {
  const task = AGENTS[job].task;
  const hit = scheduleCache[job];
  if (hit && Date.now() - hit.at < 10000) return hit.value;
  let value;
  if (IS_WIN) {
    const r = await run('schtasks', ['/query', '/tn', task, '/xml'], { timeout: 15000 });
    if (!r.ok) value = { registered: false };
    else {
      const m = /<StartBoundary>[^T<]*T(\d{2}):(\d{2})/.exec(r.stdout);
      value = m ? { registered: true, hour: Number(m[1]), minute: Number(m[2]) } : { registered: true };
    }
  } else {
    const r = await run('crontab', ['-l'], { timeout: 10000 });
    value = parseCrontab(r.ok ? r.stdout : '', task);
  }
  scheduleCache[job] = { at: Date.now(), value };
  return value;
}

function validTime(hour, minute) {
  const h = Number(hour); const m = Number(minute);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

async function registerSchedule(job, hour, minute) {
  if (!AGENTS[job]) return { ok: false, stderr: 'unknown job' };
  const t = validTime(hour, minute);
  if (!t) return inputError('시간을 다시 골라주세요.', ['시는 0~23, 분은 0~59 사이여야 해요.']);
  const script = agentPath(job);
  if (!isFile(script)) {
    return { ok: false, error: { kind: 'agent_missing', title: '아직 자동화 프로그램이 없어요', what: `${AGENTS[job].file} 파일을 찾지 못했어요.`, todo: ['4단계에서 Claude Code에게 요청 문장을 붙여넣어 프로그램을 먼저 만들어주세요.'] } };
  }
  const nodeBin = systemNodeBin();
  const task = AGENTS[job].task;
  delete scheduleCache[job];
  if (IS_WIN) {
    const user = process.env.USERNAME ? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME) : '';
    const xml = buildTaskXml({ hour: t.h, minute: t.m, nodeBin, script, workDir: AGENT_DIR, user });
    const xmlPath = path.join(AGENT_DIR, `${task}.task.xml`);
    // 작업 스케줄러는 XML을 UTF-16(BOM 포함)으로 읽는 것이 가장 안전하다.
    fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]));
    let r = await run('schtasks', ['/create', '/f', '/tn', task, '/xml', xmlPath], { timeout: 20000 });
    if (!r.ok) {
      // XML 등록이 막힌 PC를 위한 예비 방법(배터리 설정은 바꿀 수 없음)
      const hh = String(t.h).padStart(2, '0'); const mm = String(t.m).padStart(2, '0');
      r = await run('schtasks', ['/create', '/f', '/sc', 'DAILY', '/st', `${hh}:${mm}`, '/tn', task, '/tr', `"${nodeBin}" "${script}"`], { timeout: 20000 });
      if (r.ok) r.fallback = true;
    }
    try { fs.unlinkSync(xmlPath); } catch (e) { /* ignore */ }
    return r;
  }
  const cur = await run('crontab', ['-l'], { timeout: 10000 });
  const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const line = `${t.m} ${t.h} * * * cd ${q(AGENT_DIR)} && ${q(nodeBin)} ${q(script)} >> ${q(path.join(AGENT_DIR, 'cron.log'))} 2>&1`;
  return run('crontab', ['-'], { timeout: 10000, input: updateCrontab(cur.ok ? cur.stdout : '', task, line) });
}

async function unregisterSchedule(job) {
  if (!AGENTS[job]) return { ok: false, stderr: 'unknown job' };
  const task = AGENTS[job].task;
  delete scheduleCache[job];
  if (IS_WIN) {
    const r = await run('schtasks', ['/delete', '/f', '/tn', task], { timeout: 15000 });
    // 이미 없는 작업을 지우려 한 경우도 "해제됨"으로 본다
    const q = await run('schtasks', ['/query', '/tn', task], { timeout: 15000 });
    return q.ok ? r : { ok: true };
  }
  const cur = await run('crontab', ['-l'], { timeout: 10000 });
  return run('crontab', ['-'], { timeout: 10000, input: updateCrontab(cur.ok ? cur.stdout : '', task, null) });
}

// ---------------------------------------------------------------------------
// 설치 / 실행
// ---------------------------------------------------------------------------

async function installClaude() {
  const npm = npmBin();
  if (!npm) return { ok: false, code: 'ENOENT', stderr: 'npm: command not found' };
  if (IS_WIN && process.env.APPDATA) {
    // 이 폴더가 없으면 npm이 ENOENT로 실패하는 경우가 많아서 미리 만들어둔다.
    try { fs.mkdirSync(path.join(process.env.APPDATA, 'npm'), { recursive: true }); } catch (e) { /* ignore */ }
  }
  const r = await run(npm, ['install', '-g', '@anthropic-ai/claude-code'], { timeout: 300000, shell: IS_WIN, env: augmentedEnv() });
  versionCache.clear();
  if (r.ok && !findClaude()) {
    return { ok: false, code: 'ENOENT', stderr: (r.stderr || '') + '\nclaude: command not found (설치는 끝났지만 위치를 찾지 못함)', stdout: r.stdout };
  }
  return r;
}

async function ensureAgentDeps(script) {
  const nm = path.join(AGENT_DIR, 'node_modules');
  const hasPkg = isFile(path.join(AGENT_DIR, 'package.json'));
  let src = '';
  try { src = fs.readFileSync(script, 'utf-8'); } catch (e) { /* ignore */ }
  const needsMailer = /require\(\s*['"]nodemailer['"]\s*\)|from\s+['"]nodemailer['"]/.test(src) && !fs.existsSync(path.join(nm, 'nodemailer'));
  if (!(hasPkg && !fs.existsSync(nm)) && !needsMailer) return { ok: true };
  const npm = npmBin();
  if (!npm) return { ok: false, code: 'ENOENT', stderr: 'npm: command not found' };
  const args = hasPkg && !fs.existsSync(nm) ? ['install', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund', 'nodemailer'];
  return run(npm, args, { timeout: 180000, shell: IS_WIN, cwd: AGENT_DIR, env: augmentedEnv() });
}

async function runAgent(job) {
  const script = agentPath(job);
  if (!isFile(script)) return { ok: false, stderr: `Cannot find agent file ${AGENTS[job].file}`, error: { kind: 'agent_missing', title: '아직 자동화 프로그램이 없어요', what: `${AGENTS[job].file} 파일을 찾지 못했어요.`, todo: ['4단계에서 Claude Code에게 요청 문장을 붙여넣어 프로그램을 먼저 만들어주세요.'] } };
  const prep = await ensureAgentDeps(script);
  if (!prep.ok) return prep;
  return run(systemNodeBin(), [script], { timeout: 180000, cwd: AGENT_DIR, env: augmentedEnv() });
}

function openTerminal() {
  const claude = findClaude();
  const env = augmentedEnv();
  try {
    if (IS_WIN) {
      // start /D 로 작업 폴더를 정해서 연다(Claude Code는 "지금 있는 폴더"를 기준으로 파일을 만들기 때문).
      // claude가 있으면 바로 실행되게 해서, 사용자가 명령어를 칠 필요가 없게 한다.
      const inner = claude ? `cmd.exe /k "${claude}"` : 'cmd.exe /k';
      safeSpawn('cmd.exe', ['/d', '/c', `start "Claude Code" /D "${WORK_DIR}" ${inner}`], {
        detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env, cwd: WORK_DIR,
      }).unref();
    } else if (process.platform === 'darwin') {
      const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
      const cmd = `cd ${q(WORK_DIR)}${claude ? ' && ' + q(claude) : ''}`;
      const osa = `tell application "Terminal" to do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      safeSpawn('osascript', ['-e', osa, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore', env }).unref();
    } else {
      const t = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].map(which).find(Boolean);
      if (!t) return { ok: false, code: 'ENOENT', stderr: 'terminal: command not found' };
      safeSpawn(t, claude ? ['-e', claude] : [], { detached: true, stdio: 'ignore', cwd: WORK_DIR, env }).unref();
    }
    return { ok: true, claude_found: !!claude };
  } catch (e) {
    return { ok: false, stderr: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// 오래 걸리는 작업(설치, 테스트 발송 등)은 "작업"으로 돌리고, 화면은 상태를 주기적으로 받아본다.
// 이렇게 하면 브라우저를 새로고침해도 진행 상황이 사라지지 않는다.
// ---------------------------------------------------------------------------

const jobs = {};
const JOB_FNS = {
  'install': installClaude,
  'login-verify': verifyLogin,
  'smtp-check': checkSmtp,
  'run-basic': () => runAgent('basic'),
  'run-advanced': () => runAgent('advanced'),
};

function tail(text, n = 4000) {
  const s = String(text || '');
  return s.length > n ? '…' + s.slice(-n) : s;
}

function finishJob(r) {
  const out = { state: r.ok ? 'ok' : 'error', finished: Date.now() };
  out.output = redact(tail([r.stdout, r.ok ? r.stderr : ''].filter(Boolean).join('\n').trim()));
  if (!r.ok) {
    out.error = r.error || classifyError(r);
    out.raw = redact(tail([r.stderr, r.stdout, r.code !== undefined ? `(종료 코드: ${r.code})` : ''].filter(Boolean).join('\n').trim()));
  }
  return out;
}

function startJob(name) {
  const fn = JOB_FNS[name];
  if (!fn) return null;
  if (jobs[name] && jobs[name].state === 'running') return jobs[name];
  const job = { state: 'running', started: Date.now() };
  jobs[name] = job;
  Promise.resolve().then(fn).then(
    (r) => { jobs[name] = { ...finishJob(r || { ok: false }), started: job.started }; },
    (e) => { jobs[name] = { ...finishJob({ ok: false, stderr: String(e && e.stack || e) }), started: job.started }; },
  );
  return job;
}

async function getStatus() {
  const nodeVer = process.version;
  const major = Number(nodeVer.replace(/^v/, '').split('.')[0]);
  const claudeBin = findClaude();
  const version = claudeBin ? await claudeVersion(claudeBin) : null;
  const ind = loginIndicators();
  const [schedBasic, schedAdv] = await Promise.all([querySchedule('basic'), querySchedule('advanced')]);
  return {
    app: APP_ID,
    os: IS_WIN ? 'Windows' : (process.platform === 'darwin' ? 'Mac' : 'Linux'),
    work_dir: WORK_DIR,
    node: { version: nodeVer, ok: major >= MIN_NODE_MAJOR, min: MIN_NODE_MAJOR },
    claude: { installed: !!(claudeBin && version), version, found_but_broken: !!(claudeBin && !version) },
    login: { logged_in: ind.logged_in || !!(loginVerified && loginVerified.ok), how: ind.how, verified: loginVerified },
    config: loadConfig(),
    smtp: lastSmtp,
    agents: { basic: agentInfo('basic'), advanced: agentInfo('advanced') },
    schedule: { basic: schedBasic, advanced: schedAdv },
    last_run: lastRunLog(),
    jobs,
  };
}

// ---------------------------------------------------------------------------
// HTTP 서버
// ---------------------------------------------------------------------------

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/node-install.html': 'node-install.html' };

function createServer() {
  return http.createServer(async (req, res) => {
    // 이 서버는 이 PC 안에서만 쓰인다. 다른 웹사이트가 몰래 명령을 실행시키지 못하도록
    // 주소(Host)와 전용 헤더를 확인한다.
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const url = new URL(req.url, `http://${host}`);

    if (req.method === 'GET' && STATIC[url.pathname]) {
      try {
        const html = fs.readFileSync(path.join(PUBLIC_DIR, STATIC[url.pathname]), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (e) { res.writeHead(404); res.end('Not found'); }
      return;
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }
    if (req.method === 'POST' && req.headers['x-wizard'] !== '1') { sendJson(res, { ok: false, message: 'forbidden' }, 403); return; }

    try {
      const p = url.pathname;
      if (req.method === 'GET' && p === '/api/ping') return sendJson(res, { app: APP_ID });
      if (req.method === 'GET' && p === '/api/status') return sendJson(res, await getStatus());
      if (req.method === 'POST' && p === '/api/save-config') return sendJson(res, saveConfig(await readBody(req)));
      if (req.method === 'POST' && p === '/api/open-terminal') return sendJson(res, finishResult(openTerminal()));
      if (req.method === 'POST' && p.startsWith('/api/jobs/')) {
        const job = startJob(p.slice('/api/jobs/'.length));
        return job ? sendJson(res, { ok: true, job }) : sendJson(res, { ok: false, message: 'unknown job' }, 404);
      }
      if (req.method === 'POST' && p === '/api/schedule') {
        const b = await readBody(req);
        return sendJson(res, finishResult(await registerSchedule(b.job || 'basic', b.hour, b.minute)));
      }
      if (req.method === 'POST' && p === '/api/unschedule') {
        const b = await readBody(req);
        return sendJson(res, finishResult(await unregisterSchedule(b.job || 'basic')));
      }
    } catch (e) {
      return sendJson(res, { ok: false, error: classifyError({ stderr: String(e && e.message) }), raw: redact(String(e && e.stack)) }, 500);
    }
    sendJson(res, { ok: false, message: 'not found' }, 404);
  });
}

// 즉시 끝나는 요청의 결과를 화면용으로 정리한다(성공/실패 + 쉬운 설명 + 원문).
function finishResult(r) {
  if (r.ok) return { ok: true, fallback: !!r.fallback, claude_found: r.claude_found };
  const f = finishJob(r);
  return { ok: false, error: f.error, raw: f.raw };
}

function openBrowser(openUrl) {
  try {
    if (IS_WIN) safeSpawn('cmd.exe', ['/d', '/c', `start "" "${openUrl}"`], { stdio: 'ignore', windowsVerbatimArguments: true, detached: true }).unref();
    else if (process.platform === 'darwin') safeSpawn('open', [openUrl], { stdio: 'ignore' }).unref();
    else safeSpawn('xdg-open', [openUrl], { stdio: 'ignore' }).unref();
  } catch (e) { /* 아래 안내 문구로 대신한다 */ }
}

function isOurWizard(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 2000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d).app === APP_ID); } catch (e) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function line(s) { console.log(s); }

function start(port = DEFAULT_PORT, lastPort = DEFAULT_PORT + 9) {
  const server = createServer();
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      if (await isOurWizard(port)) {
        line('마법사가 이미 켜져 있어서, 새로 켜는 대신 기존 화면을 엽니다.');
        line(`주소: http://127.0.0.1:${port}`);
        openBrowser(`http://127.0.0.1:${port}`);
        setTimeout(() => process.exit(0), 1500);
        return;
      }
      if (port < lastPort) {
        line(`${port}번 포트를 다른 프로그램이 쓰고 있어서 ${port + 1}번으로 다시 시도합니다.`);
        start(port + 1, lastPort);
        return;
      }
    }
    const e = classifyError({ stderr: `${err.code || ''} ${err.message}` });
    line('');
    line(`[문제] ${e.title}`);
    line(`  무슨 일인지: ${e.what}`);
    e.todo.forEach((t, i) => line(`  지금 할 일 ${i + 1}: ${t}`));
    line(`  (원문: ${err.code || ''} ${err.message})`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    const openUrl = `http://127.0.0.1:${port}`;
    line('');
    line('==============================================');
    line('  Claude Code 설치 마법사가 켜졌습니다.');
    line(`  브라우저가 자동으로 열립니다: ${openUrl}`);
    line('  (안 열리면 위 주소를 브라우저 주소창에 붙여넣으세요)');
    line('');
    line('  이 검은 창은 닫지 말고 그대로 두세요.');
    line('  이 창을 닫으면 마법사도 꺼집니다.');
    line('==============================================');
    openBrowser(openUrl);
  });
  return server;
}

module.exports = {
  AGENTS, APP_ID, WORK_DIR, AGENT_DIR, ENV_PATH,
  classifyError, decodeOutput, saveConfig, loadConfig, readEnvKv, redact,
  smtpAuthCheck, loginIndicators, buildTaskXml, parseCrontab, updateCrontab,
  createServer, startJob, jobs, finishJob, getStatus, run, start,
};

if (require.main === module) start();
