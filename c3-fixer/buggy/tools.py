"""Buggy's tools. Everything Sonnet can touch lives here; all paths are confined to the workspace."""
import json
import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

import jev

WS = Path(os.environ.get("C3_WORKSPACE", "/workspace")).resolve()
SRC = WS / "src"
SCRATCH = WS / ".buggy"                    # outside src/, so never graded
SCRATCH.mkdir(exist_ok=True)
PY = sys.executable
SEEDS = json.loads((WS / "case.json").read_text()).get("public_seeds", []) if (WS / "case.json").exists() else []


def _safe(path: str, write: bool = False) -> Path:
    p = (WS / path).resolve()
    if not str(p).startswith(str(WS)):
        raise ValueError("path escapes workspace")
    if write and not str(p).startswith(str(SRC) + os.sep):
        raise ValueError("edits are only allowed under src/")
    return p


def _run(cmd: list[str], timeout: int = 180) -> tuple[int, str]:
    try:
        r = subprocess.run(cmd, cwd=WS, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"


# ---------- reading ----------

def read_file(path: str, start: int = 1, end: int = 400) -> str:
    lines = _safe(path).read_text(errors="replace").splitlines()
    end = min(end, len(lines))
    body = "\n".join(f"{i:4}| {lines[i - 1]}" for i in range(max(1, start), end + 1))
    return body + (f"\n... ({len(lines)} lines total)" if end < len(lines) else "")


def list_files(path: str = ".") -> str:
    base = _safe(path)
    out = [str(p.relative_to(WS)) for p in sorted(base.rglob("*"))
           if p.is_file() and "__pycache__" not in p.parts and ".buggy" not in p.parts]
    return "\n".join(out[:300])


def grep(pattern: str, path: str = "src", max_hits: int = 60) -> str:
    rx, hits = re.compile(pattern), []
    for p in sorted(_safe(path).rglob("*") if _safe(path).is_dir() else [_safe(path)]):
        if not p.is_file() or "__pycache__" in p.parts or p.suffix in (".pyc", ".jsonl"):
            continue
        for n, line in enumerate(p.read_text(errors="replace").splitlines(), 1):
            if rx.search(line):
                hits.append(f"{p.relative_to(WS)}:{n}: {line.strip()[:200]}")
                if len(hits) >= max_hits:
                    return "\n".join(hits) + "\n... (truncated)"
    return "\n".join(hits) or "no matches"


# ---------- editing ----------

def edit_file(path: str, old: str, new: str) -> str:
    p = _safe(path, write=True)
    text = p.read_text()
    n = text.count(old)
    if n != 1:
        return f"error: `old` matched {n} times; it must match exactly once"
    p.write_text(text.replace(old, new))
    rc, out = _run([PY, "-m", "py_compile", str(p)])
    if rc:
        p.write_text(text)                        # never leave src/ unparseable
        return f"error: syntax error, edit reverted\n{out[-800:]}"
    return "ok"


def diff() -> str:
    rc, out = _run(["diff", "-ru", str(ORIG), str(SRC), "-x", "__pycache__"])
    return out or "(no changes)"


# ---------- checking ----------

def run_tests() -> str:
    rc, out = _run([PY, "-m", "pytest", "-q", "-x", "tests"], timeout=240)
    return ("PASS\n" if rc == 0 else "FAIL\n") + out[-2500:]


def sweep(scenario: str = "public", seeds: str = "", faults: str = "") -> str:
    """Replay + invariant check over many seeds. Returns a compact summary."""
    seeds = seeds or "1-60"
    cmd = [PY, "-m", "sim", "sweep", "--scenario", scenario, "--seeds", seeds, "--procs", "2"]
    if faults:
        cmd += ["--faults", faults]
    rc, out = _run(cmd, timeout=300)
    try:
        d = json.loads(out[out.index("{"):])
    except ValueError:
        return f"sweep crashed (rc={rc}):\n{out[-2000:]}"
    fails = d.get("failures", [])
    by_inv = Counter(v["invariant"] for f in fails for v in f.get("violations", []))
    lines = [f"{d['failed']}/{d['seeds']} seeds failed. violations by invariant: {dict(by_inv)}"]
    for f in fails[:6]:
        if f.get("error"):
            lines.append(f"seed {f['seed']}: ERROR {str(f['error'])[:400]}")
        for v in f.get("violations", [])[:2]:
            lines.append(f"seed {f['seed']} [{v['invariant']}] t={v['t']:.2f} {v['detail'][:200]}")
    return "\n".join(lines)


def replay(seed: int, scenario: str = "public", faults: str = "", grep_trace: str = "",
           max_lines: int = 80) -> str:
    """Single replay; writes logs + trace to .buggy/replay, optionally greps the trace."""
    out_dir = SCRATCH / "replay"
    shutil.rmtree(out_dir, ignore_errors=True)
    cmd = [PY, "-m", "sim", "replay", "--scenario", scenario, "--seed", str(seed), "--out", str(out_dir)]
    if faults:
        cmd += ["--faults", faults]
    rc, out = _run(cmd)
    res = f"replay rc={rc}, output in .buggy/replay/\n{out[-600:]}"
    if grep_trace:
        res += "\n" + grep(grep_trace, ".buggy/replay", max_lines)
    return res


def write_scenario(name: str, yaml_text: str) -> str:
    """Write a custom scenario (e.g. harsher faults) to scenarios/<name>.yaml for sweep/replay."""
    if not re.fullmatch(r"[a-z0-9_-]+", name):
        return "error: name must be [a-z0-9_-]+"
    (WS / "scenarios" / f"{name}.yaml").write_text(yaml_text)
    return f"wrote scenarios/{name}.yaml"


# ---------- Jev-powered ----------

def triage_logs(question: str, top: int = 15) -> str:
    """Jev scores every log window against `question`; returns the most relevant windows."""
    windows = []
    for p in sorted((WS / "logs").glob("*.log")):
        lines = p.read_text(errors="replace").splitlines()
        for i in range(0, len(lines), 12):
            windows.append((f"{p.name}:{i + 1}", "\n".join(lines[i:i + 12])))
    if not windows:
        return "no logs"
    scores = []
    for b in range(0, len(windows), 60):                 # batch to stay inside Jev's 32k context
        s = jev.score_many([w[1][:1200] for w in windows[b:b + 60]], question,
                           ["unrelated", "background", "related", "smoking gun"])
        if s is None:
            return "jev unavailable; use grep on logs/ instead"
        scores += s
    best = sorted(zip(scores, windows), key=lambda x: -x[0])[:top]
    return "\n\n".join(f"--- {loc} (rel {s:.2f})\n{txt}" for s, (loc, txt) in best)


def rank_suspects(symptom: str) -> str:
    """Jev picks which src files most likely hold the bug."""
    files = [p for p in SRC.rglob("*.py") if "__pycache__" not in p.parts]
    opts = [str(p.relative_to(WS)) for p in files]
    state = {"symptom": symptom[:4000],
             "files": {o: p.read_text(errors="replace")[:2500] for o, p in zip(opts, files)}}
    probs = jev.choice(state, "Which source file most likely contains the bug behind the symptom?", opts)
    if not probs:
        return "jev unavailable"
    return "\n".join(f"{p:.2f}  {f}" for f, p in sorted(probs.items(), key=lambda x: -x[1]))


def looks_like_bandaid(patch: str) -> float | None:
    """Jev: P(patch is a symptom-hiding hack rather than a root-cause fix)."""
    return jev.noul({"patch": patch[:20000]},
                    "Does this patch hide the symptom (sleeps, special-casing seeds or ids, swallowing "
                    "exceptions, disabling or loosening a safety check) rather than fix a root cause?")


ORIG = SCRATCH / "orig_src"
if not ORIG.exists():
    shutil.copytree(SRC, ORIG, ignore=shutil.ignore_patterns("__pycache__"))
