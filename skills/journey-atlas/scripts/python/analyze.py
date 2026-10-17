"""journey-atlas analyzer for Python packages -> graph.json (see references/graph-schema.md).

Usage: python3 -I analyze.py --repo <repo> --config <config.json> --out <graph.json>

Entries: typer apps (commands, sub-apps via add_typer, @app.callback as middleware).
Externals: subprocess calls named by executable (`externals.commands`), raw file reads
(`externals.fileReads`), a local artifact store as the database (`artifactStore`).
Resolution is static and type-light: imports (incl. function-local and re-exports),
self/cls, class fields, parameter/return annotations, inferred returns of unannotated
functions, `x = Cls(...)` locals, ternaries, structural Protocol dispatch, calls inside lambdas.
Unresolved calls are dropped, never guessed. Stdlib only.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--repo", required=True)
ap.add_argument("--config", required=True)
ap.add_argument("--out", required=True)
args = ap.parse_args()
repo = Path(args.repo).resolve()
config = json.loads(Path(args.config).read_text())
include = [re.compile(p) for p in config.get("include", [r"\.py$"])]
exclude = [re.compile(p) for p in config.get("exclude", [])] + [re.compile(r"(^|/)tests?/"), re.compile(r"__pycache__")]
pkg_root = config.get("pythonRoot", "src")
ext_cfg = config.get("externals", {})
cli_systems = ext_cfg.get("commands", [])  # [{match, name, kind}] on the executable name
fs_reads = ext_cfg.get("fileReads", [])  # [{match, name, kind}]: read_text/open in files matching `match`
store_cfg = config.get("artifactStore")  # local files acting as the database (CLI tools, batch jobs)
STORE_FNS = re.compile(store_cfg["functions"]) if store_cfg and store_cfg.get("functions") else None
STORE_FILE_LITERAL = re.compile(store_cfg.get("fileLiteral", r"^[\w.-]+\.(parquet|json|jsonl|csv|npy|sqlite|db|html)$")) if store_cfg else None
STORE_IGNORE = set((store_cfg or {}).get("ignore", []))
warnings: list[str] = []

files = sorted(
    str(p.relative_to(repo)).replace("\\", "/")
    for p in repo.rglob("*.py")
    if ".journey-atlas" not in p.parts
)
files = [f for f in files if any(r.search(f) for r in include) and not any(r.search(f) for r in exclude)]


def modname(f: str) -> str:
    rel = f[len(pkg_root) + 1 :] if f.startswith(pkg_root + "/") else f
    parts = rel[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


class Mod:
    def __init__(self, f: str):
        self.file = f
        self.name = modname(f)
        self.tree = ast.parse((repo / f).read_text(encoding="utf-8"), filename=f)
        self.defs: dict[str, str] = {}  # top-level function name -> id
        self.classes: dict[str, dict] = {}
        self.imports: dict[str, tuple] = {}  # alias -> ("mod", name) | ("sym", mod, name)
        self.consts: dict[str, ast.AST] = {}
        self.module_id = f"{f}#<module>"


mods: dict[str, Mod] = {}
by_file: dict[str, Mod] = {}
for f in files:
    try:
        m = Mod(f)
    except SyntaxError as e:
        warnings.append(f"{f}: syntax error {e}")
        continue
    mods[m.name] = m
    by_file[f] = m

functions: list[dict] = []
fn_info: dict[str, dict] = {}  # id -> {node, mod, cls, parent, locals}


def add_fn(mod: Mod, qual: str, node, cls=None, parent=None) -> str:
    fid = f"{mod.file}#{qual}@{node.lineno}"
    functions.append({"id": fid, "name": qual, "file": mod.file, "line": node.lineno})
    fn_info[fid] = {"node": node, "mod": mod, "cls": cls, "parent": parent, "nested": {}, "qual": qual}
    for stmt in ast.iter_child_nodes(node):
        collect_nested(mod, qual, stmt, fid, cls)
    return fid


def collect_nested(mod, qual, stmt, parent_id, cls):
    if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
        nid = add_fn(mod, f"{qual}.{stmt.name}", stmt, cls=None, parent=parent_id)
        fn_info[parent_id]["nested"][stmt.name] = nid
    elif isinstance(stmt, ast.ClassDef):
        return
    else:
        for c in ast.iter_child_nodes(stmt):
            if isinstance(c, (ast.stmt, ast.excepthandler)) or isinstance(c, ast.match_case):
                collect_nested(mod, qual, c, parent_id, cls)


def ann_name(a) -> str | None:
    if a is None:
        return None
    if isinstance(a, ast.Constant) and isinstance(a.value, str):
        try:
            a = ast.parse(a.value, mode="eval").body
        except SyntaxError:
            return None
    if isinstance(a, ast.BinOp):  # X | None
        return ann_name(a.left) or ann_name(a.right)
    if isinstance(a, ast.Subscript):  # Optional[X]
        return ann_name(a.slice)
    if isinstance(a, ast.Name):
        return a.id
    if isinstance(a, ast.Attribute):
        return a.attr
    return None


for mod in mods.values():
    for stmt in mod.tree.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            mod.defs[stmt.name] = add_fn(mod, stmt.name, stmt)
        elif isinstance(stmt, ast.ClassDef):
            info = {"name": stmt.name, "mod": mod, "methods": {}, "props": set(), "fields": {}, "bases": [ann_name(b) for b in stmt.bases]}
            mod.classes[stmt.name] = info
            for s in stmt.body:
                if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    mid = add_fn(mod, f"{stmt.name}.{s.name}", s, cls=info)
                    info["methods"][s.name] = mid
                    if any(ann_name(d) == "property" for d in s.decorator_list):
                        info["props"].add(s.name)
                elif isinstance(s, ast.AnnAssign) and isinstance(s.target, ast.Name):
                    info["fields"][s.target.id] = ann_name(s.annotation)
        elif isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                if isinstance(t, ast.Name):
                    mod.consts[t.id] = stmt.value
    functions.append({"id": mod.module_id, "name": "<module>", "file": mod.file, "line": 1})
    fn_info[mod.module_id] = {"node": mod.tree, "mod": mod, "cls": None, "parent": None, "nested": {}, "qual": "<module>"}


def record_import(table: dict, node, mod: Mod):
    if isinstance(node, ast.Import):
        for a in node.names:
            table[a.asname or a.name.split(".")[0]] = ("mod", a.name if a.asname else a.name.split(".")[0])
    elif isinstance(node, ast.ImportFrom):
        base = node.module or ""
        if node.level:
            pkg = mod.name.split(".")
            if not mod.file.endswith("__init__.py"):
                pkg = pkg[:-1]
            pkg = pkg[: len(pkg) - (node.level - 1)] if node.level > 1 else pkg
            base = ".".join(pkg + ([base] if base else []))
        for a in node.names:
            full = f"{base}.{a.name}"
            table[a.asname or a.name] = ("mod", full) if full in mods else ("sym", base, a.name)


for mod in mods.values():
    for stmt in ast.walk(mod.tree):
        if isinstance(stmt, (ast.Import, ast.ImportFrom)):
            # module-level and TYPE_CHECKING imports go in the module table; function-local ones too (cheap, rarely conflicting)
            record_import(mod.imports, stmt, mod)


def resolve_symbol(modname_: str, name: str, depth=0):
    """-> ("fn", id) | ("class", info) | ("mod", name) | ("ext", "pkg.name") | None"""
    if depth > 5:
        return None
    m = mods.get(modname_)
    if m is None:
        return ("ext", f"{modname_}.{name}")
    if name in m.defs:
        return ("fn", m.defs[name])
    if name in m.classes:
        return ("class", m.classes[name])
    imp = m.imports.get(name)
    if imp:
        if imp[0] == "mod":
            return ("mod", imp[1]) if imp[1] in mods else ("ext", imp[1])
        return resolve_symbol(imp[1], imp[2], depth + 1)
    return None


def find_class(mod: Mod, name: str | None):
    if not name:
        return None
    r = resolve_symbol(mod.name, name)
    return r[1] if r and r[0] == "class" else None


def method_of(cls, name, depth=0):
    if cls is None or depth > 5:
        return None
    if name in cls["methods"]:
        return cls["methods"][name]
    for b in cls["bases"]:
        mid = method_of(find_class(cls["mod"], b), name, depth + 1)
        if mid:
            return mid
    return None


_ret_cache: dict = {}


def fn_return_class(fid):
    info = fn_info.get(fid)
    if not info or not isinstance(info["node"], (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    c = find_class(info["mod"], ann_name(info["node"].returns))
    if c or info["node"].returns is not None:
        return c
    if fid in _ret_cache:
        return _ret_cache[fid]
    _ret_cache[fid] = None  # recursion guard
    types, _ = local_types(fid)
    attr_types = {}
    rets = []
    for n in own_nodes(info["node"]):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Attribute) and isinstance(n.targets[0].value, ast.Name) and n.targets[0].value.id == "self":
            ac = class_of_expr(n.value, info["mod"], types, {})
            if ac:
                attr_types[n.targets[0].attr] = ac
        if isinstance(n, ast.Return) and n.value is not None:
            rets.append(n.value)
    for r in rets:
        if isinstance(r, ast.Attribute) and isinstance(r.value, ast.Name) and r.value.id == "self" and r.attr in attr_types:
            c = attr_types[r.attr]
        else:
            c = class_of_expr(r, info["mod"], types, {})
        if c:
            break
    _ret_cache[fid] = c
    return c


# ---------------- per-function walk ----------------
calls, external_calls, model_queries, signals, throws = [], [], [], {}, []
externals: dict[str, str] = {}
unresolved_cmd: list[str] = []
store_name = (store_cfg or {}).get("name", config.get("database", "Database"))


def nested_scope(fid):
    """Nested defs visible from fid: its own and its enclosing functions'."""
    nested, p = {}, fid
    while p:
        for k, v in fn_info[p]["nested"].items():
            nested.setdefault(k, v)
        p = fn_info[p]["parent"]
    return nested


def own_nodes(node):
    """Walk a function body without descending into nested defs/classes."""
    stack = list(ast.iter_child_nodes(node))
    while stack:
        n = stack.pop()
        yield n
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        stack.extend(ast.iter_child_nodes(n))


def add_signal(fid, sig, sample):
    s = signals.setdefault((fid, sig), {"fn": fid, "signal": sig, "count": 0, "samples": []})
    s["count"] += 1
    if len(s["samples"]) < 3:
        s["samples"].append(sample)


def system_for_cmd(exe: str):
    for r in cli_systems:
        if re.search(r["match"], exe):
            externals[r["name"]] = r.get("kind", "compute")
            return r["name"]
    return None


def literal_str(node, mod, scope_vals):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        v = scope_vals.get(node.id) or mod.consts.get(node.id)
        if v is not None and v is not node:
            return literal_str(v, mod, {})
    if isinstance(node, ast.Call) and ann_name(node.func) == "which" and node.args:
        return literal_str(node.args[0], mod, {})
    if isinstance(node, (ast.List, ast.Tuple)) and node.elts:
        return literal_str(node.elts[0], mod, scope_vals)
    return None


_types_cache: dict = {}


def local_types(fid):
    if fid in _types_cache:
        return _types_cache[fid]
    info = fn_info[fid]
    node, mod, cls = info["node"], info["mod"], info["cls"]
    is_module = fid == mod.module_id
    nested = nested_scope(fid)
    types, vals = {}, {}
    _types_cache[fid] = (types, vals)
    if not is_module:
        a = node.args
        params = a.posonlyargs + a.args + a.kwonlyargs
        for prm in params:
            c = find_class(mod, ann_name(prm.annotation))
            if c:
                types[prm.arg] = c
        if cls and params and params[0].arg in ("self", "cls"):
            types[params[0].arg] = cls
    body_nodes = list(own_nodes(node)) if not is_module else [n for s in node.body if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for n in [s, *ast.walk(s)]]
    for n in body_nodes:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            vals[n.targets[0].id] = n.value
            c = class_of_expr(n.value, mod, types, nested)
            if c:
                types[n.targets[0].id] = c
        elif isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name):
            c = find_class(mod, ann_name(n.annotation))
            if c:
                types[n.target.id] = c
            if n.value is not None:
                vals[n.target.id] = n.value
        elif isinstance(n, (ast.With, ast.AsyncWith)):
            for item in n.items:
                if isinstance(item.optional_vars, ast.Name):
                    c = class_of_expr(item.context_expr, mod, types, nested)
                    if c:
                        types[item.optional_vars.id] = c
    return types, vals


def analyze_fn(fid):
    info = fn_info[fid]
    node, mod, cls = info["node"], info["mod"], info["cls"]
    is_module = fid == mod.module_id
    nested = nested_scope(fid)
    types, vals = local_types(fid)
    body_nodes = list(own_nodes(node)) if not is_module else [n for s in node.body if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) for n in [s, *ast.walk(s)]]
    seen_calls = set()
    callee_funcs = set()
    writes_here = any(isinstance(n, ast.Call) and ann_name(n.func) in ("write_text", "to_parquet", "save", "write_bytes", "dump") for n in body_nodes)

    def edge(to, kind):
        k = (to, kind)
        if to and to != fid and k not in seen_calls:
            seen_calls.add(k)
            calls.append({"from": fid, "to": to, "kind": kind})

    for n in body_nodes:
        if isinstance(n, ast.Call):
            callee_funcs.add(id(n.func))
            target, kind = resolve_call(n.func, mod, types, nested)
            for t in (target if isinstance(target, list) else [target] if target else []):
                edge(t, kind)
            cname = ann_name(n.func) or ""
            # subprocess / shell-outs
            sub = resolve_dotted(n.func, mod)
            if sub in ("subprocess.run", "subprocess.Popen", "subprocess.check_output", "subprocess.call", "subprocess.check_call"):
                exe = literal_str(n.args[0], mod, vals) if n.args else None
                sysname = system_for_cmd(exe or "")
                sample = f"{mod.file}:{n.lineno}"
                if sysname:
                    op = "run"
                    if n.args and isinstance(n.args[0], (ast.List, ast.Tuple)) and len(n.args[0].elts) > 1:
                        op = literal_str(n.args[0].elts[1], mod, {}) or "run"
                    external_calls.append({"from": fid, "dep": sysname, "ops": [op], "sync": True, "line": n.lineno, "via": "subprocess"})
                else:
                    unresolved_cmd.append(sample)
                if any(k.arg == "shell" and isinstance(k.value, ast.Constant) and k.value.value is True for k in n.keywords):
                    add_signal(fid, "shell-invocation", sample)
                if any(k.arg == "timeout" for k in n.keywords):
                    add_signal(fid, "timeout", sample)
            # artifact store reads/writes keyed by a literal artifact name
            if STORE_FNS and STORE_FNS.search(cname):
                lit = next((a.value for a in n.args if isinstance(a, ast.Constant) and isinstance(a.value, str)), None)
                if lit and lit not in STORE_IGNORE:
                    if re.match(r"^(write|put|save)", cname):
                        op = "upsert"
                    elif cname.endswith("_path"):
                        op = "upsert" if writes_here else "read"
                    else:
                        op = "read"
                    model_queries.append({"from": fid, "model": lit, "ops": [op]})
            if sub in ("os.system", "os.popen"):
                add_signal(fid, "shell-invocation", f"{mod.file}:{n.lineno}")
            if cname in ("ThreadPoolExecutor", "ProcessPoolExecutor") and any(k.arg == "max_workers" for k in n.keywords):
                add_signal(fid, "concurrency-limit", f"{mod.file}:{n.lineno}")
            if cname in ("read_text", "open", "read_bytes"):
                for r in fs_reads:
                    if re.search(r["match"], mod.file):
                        externals[r["name"]] = r.get("kind", "storage")
                        external_calls.append({"from": fid, "dep": r["name"], "ops": ["read"], "sync": True, "line": n.lineno, "via": "file"})
                        break
        elif STORE_FILE_LITERAL and isinstance(n, ast.BinOp) and isinstance(n.op, ast.Div) and isinstance(n.right, ast.Constant) and isinstance(n.right.value, str) and STORE_FILE_LITERAL.match(n.right.value):
            # `base / "name.parquet"` style paths
            name = n.right.value.rsplit(".", 1)[0]
            if name not in STORE_IGNORE and n.right.value not in STORE_IGNORE:
                model_queries.append({"from": fid, "model": name, "ops": ["upsert" if writes_here else "read"]})
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and id(n) not in callee_funcs:
            r = resolve_name(n.id, mod, nested)
            if r and r[0] == "fn":
                edge(r[1], "ref")
        elif isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Load) and id(n) not in callee_funcs:
            c = class_of_expr(n.value, mod, types, nested)
            if c and n.attr in c["props"]:
                edge(c["methods"][n.attr], "call")
        elif isinstance(n, ast.Raise) and n.exc is not None:
            exc = n.exc.func if isinstance(n.exc, ast.Call) else n.exc
            cls_name = ann_name(exc) or "?"
            msg = ""
            if isinstance(n.exc, ast.Call) and n.exc.args:
                a0 = n.exc.args[0]
                msg = a0.value if isinstance(a0, ast.Constant) else ast.unparse(a0)[:80]
            throws.append({"fn": fid, "cls": cls_name, "category": category_of(cls_name, n.exc), "message": str(msg)[:120]})
        elif isinstance(n, ast.ExceptHandler):
            reraises = any(isinstance(x, ast.Raise) for s in n.body for x in ast.walk(s))
            if not reraises:
                txt = ast.unparse(n)
                handled = ast.unparse(n.type) if n.type else "everything"
                sample = f"{mod.file}:{n.lineno} except {handled}"
                if re.search(r"\b(print|warn|warning|warnings\.append|logger|logging|echo|stderr)\b", txt):
                    add_signal(fid, "error-logged-and-swallowed", sample)
                elif re.search(r"\b(errors?|failures?)\b.*\.append|error\b.*=", txt):
                    add_signal(fid, "error-reported-and-swallowed", sample)
                else:
                    add_signal(fid, "error-silently-swallowed", sample)


def category_of(cls_name, exc):
    """CLI mapping onto derive's HTTP-style categories: an uncaught exception (a traceback) is 'generic 500'."""
    if cls_name in (config.get("errors", {}).get("classes") or {}):
        code = config["errors"]["classes"][cls_name]
        return f"{code} mapped"
    if cls_name in ("Exit", "SystemExit"):
        code = None
        if isinstance(exc, ast.Call):
            for k in exc.keywords:
                if k.arg == "code":
                    code = ast.unparse(k.value)
            if exc.args:
                code = ast.unparse(exc.args[0])
        return "clean exit" if code in (None, "0") else "exit 1 (message printed)"
    if cls_name in ("FileNotFoundError",):
        return "404 not found"
    if cls_name in ("ValueError", "BadParameter", "KeyError", "TypeError"):
        return "400 invalid input"
    return "generic 500"


def resolve_name(name, mod, nested):
    if name in nested:
        return ("fn", nested[name])
    return resolve_symbol(mod.name, name)


def resolve_dotted(func, mod):
    """subprocess.run / run (from subprocess import run) -> 'subprocess.run'."""
    if isinstance(func, ast.Name):
        imp = mod.imports.get(func.id)
        if imp and imp[0] == "sym":
            return f"{imp[1]}.{imp[2]}"
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        imp = mod.imports.get(func.value.id)
        if imp and imp[0] == "mod":
            return f"{imp[1]}.{func.attr}"
    return None


def class_of_expr(e, mod, types, nested):
    if isinstance(e, ast.IfExp):
        return class_of_expr(e.body, mod, types, nested) or class_of_expr(e.orelse, mod, types, nested)
    if isinstance(e, ast.Name):
        return types.get(e.id)
    if isinstance(e, ast.Call):
        if isinstance(e.func, ast.Name):
            r = resolve_name(e.func.id, mod, nested)
            if r and r[0] == "class":
                return r[1]
            if r and r[0] == "fn":
                return fn_return_class(r[1])
        if isinstance(e.func, ast.Attribute):
            c = class_of_expr(e.func.value, mod, types, nested)
            if c:
                mid = method_of(c, e.func.attr)
                return fn_return_class(mid) if mid else None
            if isinstance(e.func.value, ast.Name):
                r = resolve_name(e.func.value.id, mod, nested)
                if r and r[0] == "mod" and r[1] in mods:
                    r2 = resolve_symbol(r[1], e.func.attr)
                    if r2 and r2[0] == "class":
                        return r2[1]
                    if r2 and r2[0] == "fn":
                        return fn_return_class(r2[1])
                if r and r[0] == "class":  # Cls.factory()
                    mid = method_of(r[1], e.func.attr)
                    return fn_return_class(mid) if mid else None
    if isinstance(e, ast.Attribute):
        c = class_of_expr(e.value, mod, types, nested)
        if c:
            if e.attr in c["fields"]:
                return find_class(c["mod"], c["fields"][e.attr])
            if e.attr in c["props"]:
                return fn_return_class(c["methods"][e.attr])
    return None


def implementations(proto, meth):
    need = {k for k in proto["methods"] if not k.startswith("_")}
    out = []
    for m in mods.values():
        for c in m.classes.values():
            if c is not proto and "Protocol" not in c["bases"] and need <= set(c["methods"]) and meth in c["methods"]:
                out.append(c["methods"][meth])
    return out


def resolve_call(func, mod, types, nested):
    if isinstance(func, ast.Name):
        r = resolve_name(func.id, mod, nested)
        if r and r[0] == "fn":
            return r[1], "call"
        if r and r[0] == "class":
            return method_of(r[1], "__init__"), "new"
        return None, None
    if isinstance(func, ast.Attribute):
        c = class_of_expr(func.value, mod, types, nested)
        if c:
            if "Protocol" in c["bases"]:
                return [m for m in implementations(c, func.attr)] or None, "dispatch"
            return method_of(c, func.attr), "call"
        if isinstance(func.value, ast.Name):
            r = resolve_name(func.value.id, mod, nested)
            if r and r[0] == "mod" and r[1] in mods:
                r2 = resolve_symbol(r[1], func.attr)
                if r2 and r2[0] == "fn":
                    return r2[1], "call"
                if r2 and r2[0] == "class":
                    return method_of(r2[1], "__init__"), "new"
            if r and r[0] == "class":
                return method_of(r[1], func.attr), "call"
    return None, None


for fid in list(fn_info):
    analyze_fn(fid)

# ---------------- journeys: typer apps ----------------
journeys, entries, middleware, mw_passes = [], [], [], []
cli_cfg = config.get("cli", {})
prog = cli_cfg.get("prog", "cli")
for mod in mods.values():
    typer_vars = {}
    groups = {}
    for stmt in mod.tree.body:
        if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call) and ann_name(stmt.value.func) == "Typer":
            typer_vars[stmt.targets[0].id] = stmt.lineno
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call) and ann_name(stmt.value.func) == "add_typer":
            c = stmt.value
            sub = c.args[0].id if c.args and isinstance(c.args[0], ast.Name) else None
            name = next((k.value.value for k in c.keywords if k.arg == "name"), None)
            if sub and name:
                groups[sub] = (c.func.value.id, name)
    if not typer_vars:
        continue

    def path_of(var):
        if var in groups:
            parent, name = groups[var]
            return path_of(parent) + [name]
        return []

    callbacks = {}
    for stmt in mod.tree.body:
        if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for d in stmt.decorator_list:
            if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and isinstance(d.func.value, ast.Name) and d.func.value.id in typer_vars:
                if d.func.attr == "callback":
                    callbacks[d.func.value.id] = (mod.defs[stmt.name], stmt)
    for stmt in mod.tree.body:
        if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for d in stmt.decorator_list:
            if isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and isinstance(d.func.value, ast.Name) and d.func.value.id in typer_vars and d.func.attr == "command":
                var = d.func.value.id
                cmd = d.args[0].value if d.args and isinstance(d.args[0], ast.Constant) else stmt.name.replace("_", "-")
                command = " ".join(path_of(var) + [cmd])
                jid = f"CLI {prog} {command}"
                journeys.append({"id": jid, "kind": "cli", "name": f"{prog} {command}", "command": command, "source": f"{mod.file}:{stmt.lineno}"})
                order = 0
                chain = [var]
                v = var
                while v in groups:
                    v = groups[v][0]
                    chain.insert(0, v)
                for cv in chain:
                    if cv in callbacks:
                        cb_id, cb = callbacks[cv]
                        mw_name = cli_cfg.get("callbackNames", {}).get(cb.name, cb.name)
                        entries.append({"journey": jid, "fn": cb_id, "role": "middleware", "order": order})
                        mw_passes.append({"journey": jid, "mw": mw_name, "order": order, "scope": "app" if cv == chain[0] else "router"})
                        if not any(m["name"] == mw_name for m in middleware):
                            middleware.append({"name": mw_name, "impl": cb_id, "kind": cli_cfg.get("callbackKinds", {}).get(cb.name, "other")})
                        order += 1
                entries.append({"journey": jid, "fn": mod.defs[stmt.name], "role": "handler", "order": order})

# ---------------- meta ----------------
if model_queries:
    externals.setdefault(store_name, "database")


def git(*a):
    try:
        return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ""


if unresolved_cmd:
    warnings.append(f"subprocess calls with no recognised executable: {', '.join(unresolved_cmd)}")
fn_ids = {f["id"] for f in functions}
journeys_without_handler = [j["id"] for j in journeys if not any(e["journey"] == j["id"] and e["role"] == "handler" and e["fn"] in fn_ids for e in entries)]
warnings.append("Python analyzer: calls on untyped receivers (no annotation, not self, not assigned from a known class) are dropped")
graph = {
    "meta": {
        "schema": 1, "analyzer": "journey-atlas/python-ast", "project": config.get("name", repo.name), "root": str(repo),
        "commit": git("rev-parse", "--short", "HEAD"), "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "database": store_name, "frameworks": ["typer"], "warnings": warnings,
        "unresolved_http": sorted(set(s.split(":")[0] for s in unresolved_cmd)), "journeys_without_handler": journeys_without_handler,
    },
    "functions": functions,
    "calls": [c for c in calls if c["to"] in fn_ids],
    "journeys": journeys,
    "entries": entries,
    "externals": [{"name": k, "kind": v} for k, v in sorted(externals.items())],
    "externalCalls": external_calls,
    "modelQueries": model_queries,
    "middleware": middleware,
    "mwPasses": mw_passes,
    "throws": throws,
    "signals": list(signals.values()),
    "events": [], "emits": [], "handles": [], "txCalls": [],
}
Path(args.out).write_text(json.dumps(graph, indent=1))

# ---------------- coverage summary ----------------
from collections import Counter

reach_cnt = Counter(c["kind"] for c in graph["calls"])
print(f"files {len(files)}  functions {len(functions)}  calls {len(graph['calls'])} {dict(reach_cnt)}")
print(f"journeys {len(journeys)} by kind {dict(Counter(j['kind'] for j in journeys))}")
print(f"externals {graph['externals']}")
print(f"externalCalls {len(external_calls)}  modelQueries {len(model_queries)} models {sorted(set(m['model'] for m in model_queries))}")
print(f"signals {dict(Counter(s['signal'] for s in graph['signals']))}  throws {dict(Counter(t['category'] for t in throws))}")
print(f"journeys_without_handler {journeys_without_handler}")
print(f"unresolved subprocess {unresolved_cmd}")
# coverage test for a hand-rolled resolver: what no journey reaches is either an entry point,
# a Protocol stub, dead code, or a resolution gap; read the list and decide which
adj = {}
for c in graph["calls"]:
    adj.setdefault(c["from"], []).append(c["to"])
seen, stack = set(), [e["fn"] for e in entries]
while stack:
    f = stack.pop()
    if f not in seen:
        seen.add(f)
        stack.extend(adj.get(f, []))
unreached = [f["id"] for f in functions if f["id"] not in seen and not f["id"].endswith("#<module>")]
print(f"reached {len(seen)} of {len(functions) - len(mods)} functions; unreached ({len(unreached)}):")
for u in unreached[:60]:
    print("   ", u)
for w in warnings:
    print("WARN", w)
