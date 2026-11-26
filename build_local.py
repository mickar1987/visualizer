"""Builds one self-contained HTML file (no server, no internet) from the web app:

    python build_local.py  [output.html]

Default output: ..\\Visualizer.html. Open it by double-clicking (Chrome / Edge).
All JavaScript modules, the CSS, the icon and the libraries are put inside the file.
"""
import base64
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "Visualizer.html")

IMPORT_NAMED = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*$", re.M | re.S)
IMPORT_STAR = re.compile(r"^import\s*\*\s*as\s+(\w+)\s+from\s*'([^']+)';[ \t]*$", re.M)
EXPORT_DECL = re.compile(r"^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([\w$]+)", re.M)


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def key_of(base_file, spec):
    return os.path.normpath(os.path.join(os.path.dirname(base_file), spec))


modules = {}  # abs path -> (deps, code, exports)


def load(path):
    if path in modules:
        return
    src = read(path)
    deps = []

    def named(m):
        dep = key_of(path, m.group(2))
        deps.append(dep)
        parts = []
        for item in m.group(1).replace("\n", " ").split(","):
            item = item.strip()
            if not item:
                continue
            if " as " in item:
                a, b = [x.strip() for x in item.split(" as ")]
                parts.append(f"{a}: {b}")
            else:
                parts.append(item)
        return f"const {{ {', '.join(parts)} }} = __m[{dep!r}];"

    def star(m):
        dep = key_of(path, m.group(2))
        deps.append(dep)
        return f"const {m.group(1)} = __m[{dep!r}];"

    code = IMPORT_NAMED.sub(named, src)
    code = IMPORT_STAR.sub(star, code)
    if re.search(r"^\s*import[\s{*]", code, re.M) or "import(" in code:
        raise SystemExit(f"unsupported import in {path}")
    exports = EXPORT_DECL.findall(code)
    # extra names in "export const A = ..., B = ...;" on one line
    exports += [m.group(2) for m in re.finditer(
        r"^export\s+const\s+[\w$]+\s*=\s*('[^']*'|\"[^\"]*\"|[\d.]+)\s*,\s*([\w$]+)\s*=", code, re.M)]
    code = re.sub(r"^export\s+", "", code, flags=re.M)
    modules[path] = (deps, code, exports)
    for d in deps:
        load(d)


entry = os.path.normpath(os.path.join(HERE, "js", "app.js"))
load(entry)

order, seen = [], set()


def visit(p, stack=()):
    if p in seen:
        return
    if p in stack:
        raise SystemExit("import cycle: " + " -> ".join(stack + (p,)))
    for d in modules[p][0]:
        visit(d, stack + (p,))
    seen.add(p)
    order.append(p)


visit(entry)

bundle = ["const __m = {};"]
for p in order:
    deps, code, exports = modules[p]
    rel = os.path.relpath(p, HERE).replace("\\", "/")
    bundle.append(f"// ---- {rel}\n__m[{p!r}] = (() => {{\n{code}\nreturn {{ {', '.join(exports)} }};\n}})();")
js = "\n".join(bundle)
for p in order:  # absolute paths -> short relative keys
    js = js.replace(repr(p), repr(os.path.relpath(p, HERE).replace("\\", "/")))


def inline_js(code):
    return code.replace("</script", "<\\/script")


html = read(os.path.join(HERE, "index.html"))
icon = "data:image/svg+xml;base64," + base64.b64encode(read(os.path.join(HERE, "icon.svg")).encode()).decode()
html = html.replace('<link rel="manifest" href="manifest.webmanifest">\n', "")
html = html.replace('<link rel="apple-touch-icon" href="icon-192.png">\n', "")
html = html.replace('href="icon.svg"', f'href="{icon}"').replace('src="icon.svg"', f'src="{icon}"')
html = html.replace('<link rel="stylesheet" href="css/app.css">', "<style>\n" + read(os.path.join(HERE, "css", "app.css")) + "\n</style>")
libs = "".join(f"<script>\n{inline_js(read(os.path.join(HERE, 'vendor', n)))}\n</script>\n"
               for n in ("jszip.min.js", "mp4-muxer.min.js"))
html = html.replace('<script src="vendor/jszip.min.js"></script>\n', libs)
html = html.replace('<script type="module" src="js/app.js"></script>', "<script>\n" + inline_js(js) + "\n</script>")
for leftover in ('src="js/', 'href="css/', 'src="vendor/'):
    if leftover in html:
        raise SystemExit("not inlined: " + leftover)

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(html)
print(f"{OUT}  ({os.path.getsize(OUT) // 1024} KB, {len(order)} modules)")
