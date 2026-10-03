"""Jev client: cheap typed decisions (Choice / Noul / Score) via POST /api/alpha/decisions.

Every call fails soft and returns None, so Buggy degrades to plain Sonnet if Jev is unreachable.
"""
import os
from concurrent.futures import ThreadPoolExecutor

import httpx

URL = os.environ.get("JEV_DECISIONS_URL", "")
MODEL = os.environ.get("JEV_MODEL", "typesafe/jev-1.13")
KEY = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY", "")


def _ask(state, questions: dict) -> dict | None:
    """questions: {id: {type, instructions, criteria}} -> {id: answer}"""
    if not URL:
        return None
    try:
        r = httpx.post(URL, timeout=30, headers={"Authorization": f"Bearer {KEY}"},
                       json={"model": MODEL, "state": state, "questions": questions})
        r.raise_for_status()
        return r.json().get("answers")
    except Exception as e:  # noqa: BLE001
        print(f"[jev] failed: {e}", flush=True)
        return None


def noul(state, instructions: str, yes: str, no: str) -> float | None:
    """P(yes)."""
    a = _ask(state, {"q": {"type": "noul", "instructions": instructions,
                           "criteria": {"true": yes, "false": no}}})
    return a["q"]["noul"] if a else None


def choice(state, instructions: str, options: dict[str, str]) -> dict[str, float] | None:
    """options: {name: description} -> {name: probability}"""
    a = _ask(state, {"q": {"type": "choice", "instructions": instructions, "criteria": options}})
    return a["q"].get("probabilities") if a else None


def score_many(items: list[str], instructions: str, levels: list[str]) -> list[float] | None:
    """Score each item independently (parallel requests). Returns 0..1 per item, or None if Jev is down."""
    q = {"s": {"type": "score", "instructions": instructions, "criteria": levels}}
    top = max(1, len(levels) - 1)
    with ThreadPoolExecutor(8) as ex:
        answers = list(ex.map(lambda it: _ask(it, q), items))
    if all(a is None for a in answers):
        return None
    return [a["s"]["score"] / top if a else 0.0 for a in answers]
