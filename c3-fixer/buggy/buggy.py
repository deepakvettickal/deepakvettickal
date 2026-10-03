#!/usr/bin/env python3
"""Buggy: a single Sonnet agent that reproduces, diagnoses and fixes, gated by a deterministic harness."""
import json
import os
import shutil
import signal
import sys
import time

import anthropic

import tools as T
from corpus import Corpus

DEADLINE = float(os.environ.get("C3_DEADLINE", time.time() + 900))
BUDGET = float(os.environ.get("C3_BUDGET_USD", 3))
MODEL = os.environ.get("ANTHROPIC_MODEL", "anthropic/claude-sonnet-4.6")
BEST = T.SCRATCH / "best_src"
client = anthropic.Anthropic(base_url=os.environ.get("ANTHROPIC_BASE_URL"),
                             api_key=os.environ.get("ANTHROPIC_API_KEY"), max_retries=2)
spent = 0.0


def log(*a):
    print(f"[buggy {DEADLINE - time.time():5.0f}s left ${spent:.2f}]", *a, flush=True)


# ---------- src snapshots ----------

def snapshot(dst):
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(T.SRC, dst, ignore=shutil.ignore_patterns("__pycache__"))


def restore(src):
    shutil.rmtree(T.SRC)
    shutil.copytree(src, T.SRC)


def restore_safe():
    restore(BEST if BEST.exists() else T.ORIG)


signal.signal(signal.SIGTERM, lambda *_: (restore_safe(), sys.exit(0)))


# ---------- the gate (Senior, minus the opinions) ----------

custom_scenarios: set[str] = set()


def gate() -> tuple[bool, str]:
    t = T.run_tests()
    if not t.startswith("PASS"):
        return False, "tests fail:\n" + t
    for scen, seeds in [("public", "1-80"), *[(s, "1-40") for s in sorted(custom_scenarios)]]:
        s = T.sweep(scen, seeds)
        if not s.startswith("0/"):
            return False, f"sweep {scen} {seeds}:\n{s}"
    rc, out = T._run([T.PY, "-m", "sim", "determinism", "--scenario", "public", "--seeds", "1,2,3", "--runs", "2"])
    if rc:
        return False, "replays are nondeterministic:\n" + out[-800:]
    p = T.looks_like_bandaid(T.diff())
    if p is not None and p > 0.8:
        return False, f"Jev rates this patch a likely band-aid (p={p:.2f}). Fix the root cause."
    return True, "gate passed"


# ---------- tool table ----------

corpus = None


def search_corpus(query: str) -> str:
    global corpus
    corpus = corpus or Corpus()
    return corpus.search(query)


def submit_fix(summary: str) -> str:
    ok, why = gate()
    if not ok:
        log("gate FAIL", why.splitlines()[0])
        return "REJECTED. " + why
    snapshot(BEST)
    log("gate PASS:", summary[:120])
    return ("ACCEPTED and saved. The case may hide more bugs. Write harsher scenarios (more crashes, "
            "drops, pauses, clock skew, per the README and scenario_schema) to hunt for remaining "
            "failures, or call `done` if you are confident nothing else is broken.")


def write_scenario(name: str, yaml_text: str) -> str:
    custom_scenarios.add(name)
    return T.write_scenario(name, yaml_text)


S = {"type": "string"}
I = {"type": "integer"}
TOOLS = {
    "read_file": (T.read_file, "Read lines of a workspace file.", {"path": S, "start": I, "end": I}, ["path"]),
    "list_files": (T.list_files, "List files under a workspace dir.", {"path": S}, []),
    "grep": (T.grep, "Regex search under a workspace path (default src).", {"pattern": S, "path": S}, ["pattern"]),
    "edit_file": (T.edit_file, "Replace exactly one occurrence of `old` with `new` in a file under src/.",
                  {"path": S, "old": S, "new": S}, ["path", "old", "new"]),
    "diff": (T.diff, "Show your current patch against the original src.", {}, []),
    "run_tests": (T.run_tests, "Run the public unit tests.", {}, []),
    "sweep": (T.sweep, "Replay + invariant-check many seeds (e.g. '1-60'). Fast: ~0.3s/seed.",
              {"scenario": S, "seeds": S, "faults": S}, []),
    "replay": (T.replay, "Run one seed, save logs/trace to .buggy/replay/, optionally regex-grep them.",
               {"seed": I, "scenario": S, "faults": S, "grep_trace": S}, ["seed"]),
    "write_scenario": (write_scenario, "Write scenarios/<name>.yaml. Custom scenarios join the acceptance gate.",
                       {"name": S, "yaml_text": S}, ["name", "yaml_text"]),
    "search_corpus": (search_corpus, "Search the platform/service docs (contracts, runbooks, changelogs). "
                      "Use exact log tokens and error codes as keywords.", {"query": S}, ["query"]),
    "triage_logs": (T.triage_logs, "Cheaply rank every log window by relevance to a question.",
                    {"question": S}, ["question"]),
    "rank_suspects": (T.rank_suspects, "Rank src files by likelihood of holding the bug.", {"symptom": S}, ["symptom"]),
    "submit_fix": (submit_fix, "Submit the current src for acceptance (tests, 80-seed sweep, your scenarios, "
                   "determinism). Accepted fixes are saved.", {"summary": S}, ["summary"]),
    "done": (lambda reason="": "bye", "Finish. Only after at least one accepted fix, or when out of ideas.",
             {"reason": S}, []),
}
TOOL_SPECS = [{"name": n, "description": d, "input_schema": {"type": "object", "properties": p, "required": r}}
              for n, (_, d, p, r) in TOOLS.items()]
TOOL_SPECS[-1]["cache_control"] = {"type": "ephemeral"}

SYSTEM = """You are Buggy, an expert distributed-systems engineer fixing a small Python service with no human help.
Only files under src/ are graded. A bug counts as fixed only if a harsher hidden scenario passes on 20 unseen seeds.
Patches that break any unit test score zero.

Method:
1. Read SYMPTOM.md, README.md, INVARIANTS.md. Reproduce with `sweep` on the public scenario.
2. Find the exact mechanism: trace events, logs, code. Look up the platform contract the code must honour
   with `search_corpus`. CURRENT docs beat SUPERSEDED ones; changelogs often hold the needle.
3. Make the smallest root-cause fix. No sleeps, no seed or id special-casing, no loosened checks, no edits to
   tests/sim. Keep behaviour deterministic.
4. `submit_fix`. If rejected, read why and iterate.
5. The ticket may hide several bugs. After an acceptance, stress harder scenarios to find others.
Be economical: targeted reads, not whole-file dumps. Time and money are limited."""


def price(u) -> float:
    cr = getattr(u, "cache_read_input_tokens", 0) or 0
    cw = getattr(u, "cache_creation_input_tokens", 0) or 0
    return (u.input_tokens * 3 + cr * 0.3 + cw * 3.75 + u.output_tokens * 15) / 1e6


def trim(messages, keep=8):
    """Shrink old tool results so the transcript stays cheap."""
    results = [b for m in messages if m["role"] == "user" and isinstance(m["content"], list)
               for b in m["content"] if b.get("type") == "tool_result"]
    for b in results[:-keep]:
        if len(b["content"]) > 400:
            b["content"] = b["content"][:400] + "\n...[trimmed]"


def main():
    global spent
    log("start")
    base = T.sweep("public", ",".join(map(str, T.SEEDS)) or "1-20")
    first = (f"Workspace: {T.WS}\n\n# SYMPTOM.md\n{(T.WS / 'SYMPTOM.md').read_text()}\n\n"
             f"# Baseline public sweep\n{base}\n\n# Files\n{T.list_files()}")
    messages = [{"role": "user", "content": first}]
    while True:
        left = DEADLINE - time.time()
        if left < 60 or spent > BUDGET * 0.85:
            log("stopping: limits")
            break
        trim(messages)
        try:
            r = client.messages.create(
                model=MODEL, max_tokens=8000, tools=TOOL_SPECS, messages=messages,
                system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
                timeout=max(30, left - 45))
        except anthropic.APIStatusError as e:
            log("model error", e.status_code, str(e)[:200])
            break
        except anthropic.APIError as e:
            log("model error", str(e)[:200])
            break
        spent += price(r.usage)
        messages.append({"role": "assistant", "content": r.content})
        for b in r.content:
            if b.type == "text" and b.text.strip():
                log("💭", b.text.strip()[:300])
        calls = [b for b in r.content if b.type == "tool_use"]
        if not calls:
            messages.append({"role": "user", "content": "Use a tool, or call `done`."})
            continue
        results, finished = [], False
        for c in calls:
            log("🔧", c.name, json.dumps(c.input)[:160])
            fn = TOOLS.get(c.name, (None,))[0]
            try:
                out = str(fn(**c.input)) if fn else f"unknown tool {c.name}"
            except Exception as e:  # noqa: BLE001
                out = f"error: {type(e).__name__}: {e}"
            results.append({"type": "tool_result", "tool_use_id": c.id, "content": out[:12000]})
            finished |= c.name == "done"
        messages.append({"role": "user", "content": results})
        if finished:
            break
    finalize()


def finalize():
    """Keep unverified edits only if they at least pass tests; otherwise fall back to the last accepted src."""
    if BEST.exists() and T._run(["diff", "-rq", str(BEST), str(T.SRC), "-x", "__pycache__"])[0] == 0:
        log("final: best accepted src in place")
        return
    if DEADLINE - time.time() > 40 and T.run_tests().startswith("PASS") and not BEST.exists():
        log("final: keeping unverified edits (tests pass, nothing accepted)")
        return
    restore_safe()
    log("final: restored", "best" if BEST.exists() else "original")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log("crash", repr(e))
        restore_safe()
