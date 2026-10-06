"""배포용 zip 만들기: dist/claude_setup_wizard-<버전>.zip

zip 안의 구조:
  claude_setup_wizard/
    start.bat, server.js, 사용법.txt, README.md
    public/index.html, public/node-install.html
    .claude/settings.json   (Claude Code가 agent/.env를 읽지 못하게 막는 설정)

agent/ 폴더와 .env 파일은 절대 들어가면 안 된다. 들어가면 실패로 끝난다.
Python 표준 zipfile은 한글 파일 이름(사용법.txt)에 UTF-8 표시를 붙여서 Windows 탐색기에서도 깨지지 않는다.
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOP = "claude_setup_wizard"
FILES = [
    "start.bat",
    "server.js",
    "사용법.txt",
    "README.md",
    "public/index.html",
    "public/node-install.html",
    ".claude/settings.json",
]


def forbidden(name):
    parts = name.split("/")
    return "agent" in parts or any(p.endswith(".env") for p in parts) or "node_modules" in parts


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else "dev"
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", f"claude_setup_wizard-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in FILES:
            src = os.path.join(ROOT, rel)
            if not os.path.isfile(src):
                sys.exit(f"빠진 파일: {rel}")
            z.write(src, f"{TOP}/{rel}")
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        bad = [n for n in names if forbidden(n)]
        if bad:
            os.remove(out)
            sys.exit(f"zip에 들어가면 안 되는 파일: {bad}")
        bat = z.read(f"{TOP}/start.bat")
        if any(b > 0x7E for b in bat):
            sys.exit("start.bat에 ASCII가 아닌 문자가 있습니다.")
        if b"\r\n" not in bat:
            sys.exit("start.bat 줄바꿈이 CRLF가 아닙니다 (.gitattributes 확인).")
    print(out)
    for n in names:
        print("  " + n)


if __name__ == "__main__":
    main()
