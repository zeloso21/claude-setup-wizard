# Claude Code 설치 마법사

터미널 명령어를 몰라도, 더블클릭 몇 번으로 [Claude Code](https://claude.com/claude-code)를 설치하고
로그인한 뒤, 실습 삼아 "매일 아침 섹터 등락률을 이메일로 보내주는 에이전트"까지 직접 만들어보는 로컬 웹 마법사입니다.

## 사용법

1. 이 저장소의 [Releases](../../releases) 페이지에서 zip 파일을 다운로드합니다.
2. 압축을 풀고, 안의 `claude_setup_wizard` 폴더째로 둔 채 `start.bat`을 더블클릭합니다.
   - Node.js가 없으면 자동으로 설치를 시도합니다(winget 사용). 설치 후 안내에 따라 한 번 더 실행해주세요.
   - 잠시 후 브라우저가 자동으로 열립니다.
3. "Windows에서 PC를 보호했습니다" 경고가 뜨면 **추가 정보 → 실행**을 눌러주세요. 서명되지 않은 로컬 프로그램이라 뜨는 안내이며 위험하지 않습니다.
4. 화면에 나오는 1~5단계를 순서대로 따라가면 됩니다.

## 이 프로그램이 하는 일 / 하지 않는 일

- 이 컴퓨터 안에서만 동작하는 로컬 웹서버입니다(포트 5055). 외부로 아무 데이터도 전송하지 않습니다.
- 입력한 Gmail/KRX API 키 등은 이 컴퓨터의 `agent/.env` 파일에만 저장됩니다 — 이 저장소(GitHub)에는 올라가지 않습니다.
- Claude Code 자체는 [claude.com/claude-code](https://claude.com/claude-code)에서 정식 배포되는 프로그램을 그대로 설치합니다.

## 폴더 구조

- `start.bat` — 실행 진입점 (Node.js 확인/자동설치 후 서버 실행)
- `server.js` — 대시보드 웹서버 (Node.js 내장 모듈만 사용)
- `public/index.html` — 단계별 위저드 화면
