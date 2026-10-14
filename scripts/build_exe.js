// 마법사를 실행 파일 하나로 묶는다: dist/ClaudeSetupWizard.exe (Windows에서 빌드한 경우)
//   node scripts/build_exe.js [출력파일]
//
// Node.js의 "단일 실행 파일(SEA)" 기능을 쓴다. 지금 빌드에 쓰는 node 실행 파일을 복사하고,
// 그 안에 server.js와 화면 파일(public/*.html)을 끼워 넣는다. 그래서 받는 사람 PC에 Node.js가 없어도
// 마법사가 켜진다(Claude Code 설치에 필요한 Node.js는 마법사의 [설치하기]가 winget으로 함께 설치).
// 빌드한 OS용 실행 파일이 나온다. Windows용 exe는 GitHub Actions(windows-latest)에서 만든다.
// 필요한 것: Node.js 20.12 이상(자산 기능), 인터넷(postject를 npx로 받음).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function main() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 12)) {
    console.error(`Node.js 20.12 이상이 필요합니다(지금 ${process.version}).`);
    process.exit(1);
  }
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.resolve(process.argv[2] || path.join(DIST, IS_WIN ? 'ClaudeSetupWizard.exe' : 'ClaudeSetupWizard'));
  const blob = path.join(DIST, 'sea-prep.blob');
  const cfg = path.join(DIST, 'sea-config.json');
  fs.writeFileSync(cfg, JSON.stringify({
    main: path.join(ROOT, 'server.js'),
    output: blob,
    disableExperimentalSEAWarning: true,
    // 이름은 server.js의 readPublic()이 찾는 이름과 같아야 한다.
    assets: {
      'index.html': path.join(ROOT, 'public', 'index.html'),
      'node-install.html': path.join(ROOT, 'public', 'node-install.html'),
    },
  }, null, 2));

  execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
  fs.copyFileSync(process.execPath, out);
  if (!IS_WIN) fs.chmodSync(out, 0o755);
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });

  const args = ['--yes', 'postject@1.0.0-alpha.6', out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync(IS_WIN ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', shell: IS_WIN });
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });

  fs.rmSync(blob, { force: true });
  fs.rmSync(cfg, { force: true });
  console.log(out);
}

main();
