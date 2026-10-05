"""Build the hosted claude.ai Artifact page from index.html.

Usage: python3 tools/build_artifact.py OUT_DIR
Writes OUT_DIR/index.html. The Artifact host wraps the page in its own <!doctype>/<head>/<body>
skeleton, so this strips those wrappers, keeps <title>, styles and scripts, and moves the body's
classes onto a wrapper div. The assets/ files are published alongside it unchanged.
"""
import re
import sys
import pathlib

src = pathlib.Path("index.html").read_text()
out_dir = pathlib.Path(sys.argv[1])
out_dir.mkdir(parents=True, exist_ok=True)

head = re.search(r"<head>(.*?)</head>", src, re.S).group(1)
body_m = re.search(r'<body class="([^"]*)">(.*)</body>', src, re.S)
body_cls, body = body_m.group(1), body_m.group(2)

# The skeleton supplies charset and viewport (with viewport-fit=cover).
head = re.sub(r'\s*<meta charset="UTF-8">', "", head)
head = re.sub(r'\s*<meta name="viewport"[^>]*>', "", head)
title = re.search(r"<title>.*?</title>", head).group(0)
head = head.replace(title, "", 1)

page = (
    title + "\n"
    "<style>\n"
    "  /* Single light look by design: explicit ground and ink so the host theme never shows through. */\n"
    "  :root { --ipc-ground: #f1f5f9; --ipc-ink: #1e293b; color-scheme: light; }\n"
    "  body { background: var(--ipc-ground); color: var(--ipc-ink); }\n"
    "  header.sticky { top: env(safe-area-inset-top, 0px); }\n"
    "</style>"
    + head.rstrip() + "\n"
    '<div class="' + body_cls + '">' + body.rstrip() + "\n</div>\n"
)
(out_dir / "index.html").write_text(page)
print("wrote", out_dir / "index.html", len(page), "bytes")
