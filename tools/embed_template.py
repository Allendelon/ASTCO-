"""Embed assets/templates/ipc-template.xlsx as base64 in assets/templates/ipc-template.js.

The browser export reads the template from this JS file (not via fetch) so that
"Download Excel IPC" also works when index.html is opened directly from disk (file://).
Usage: python3 tools/embed_template.py
"""
import base64

SRC = "assets/templates/ipc-template.xlsx"
DST = "assets/templates/ipc-template.js"

b64 = base64.b64encode(open(SRC, "rb").read()).decode()
with open(DST, "w") as f:
    f.write("/* Official IPC workbook template (cleaned copy of IPC_-_1.xlsx), base64. "
            "Regenerate with: python3 tools/embed_template.py */\n")
    f.write('window.IPC_TEMPLATE_XLSX_B64 = "' + b64 + '";\n')
print("wrote", DST)
