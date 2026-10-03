"""Jev client: cheap typed decisions (Choice / Noul / Score) through the proxy.

Every call fails soft and returns None, so Buggy degrades to plain Sonnet if Jev is unreachable.
"""
import os

import httpx

URL = os.environ.get("JEV_DECISIONS_URL", "")
MODEL = os.environ.get("JEV_MODEL", "typesafe/jev-1.13")
KEY = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY", "")


def _ask(state: dict, questions: list[dict]) -> dict | None:
    if not URL:
        return None
    try:
        r = httpx.post(URL, timeout=30, headers={"Authorization": f"Bearer {KEY}"},
                       json={"model": MODEL, "state": state, "questions": questions})
        r.raise_for_status()
        return r.json()
    except Exception as e:  # noqa: BLE001
        print(f"[jev] failed: {e}", flush=True)
        return None


def _answers(resp: dict | None) -> dict:
    """Map question id -> answer object, tolerant of response shape."""
    if not resp:
        return {}
    items = resp.get("answers") or resp.get("decisions") or []
    return {a.get("id"): a for a in items if isinstance(a, dict)}


def noul(state: dict, question: str) -> float | None:
    """P(yes) that `question` holds given `state`."""
    a = _answers(_ask(state, [{"id": "q", "type": "noul", "question": question}])).get("q")
    if not a:
        return None
    return a.get("probability", a.get("p_yes"))


def score_many(items: list[str], question: str, levels: list[str]) -> list[float] | None:
    """Score each item on an ordinal scale in one request. Returns a 0..1 position per item."""
    qs = [{"id": f"i{i}", "type": "score", "question": question, "levels": levels,
           "state_ref": f"items.{i}"} for i in range(len(items))]
    ans = _answers(_ask({"items": items}, qs))
    if not ans:
        return None
    out = []
    for i in range(len(items)):
        a = ans.get(f"i{i}") or {}
        pos = a.get("position", a.get("score"))
        out.append(float(pos) / max(1, len(levels) - 1) if pos is not None else 0.0)
    return out


def choice(state: dict, question: str, options: list[str]) -> dict[str, float] | None:
    """Probability per option."""
    a = _answers(_ask(state, [{"id": "q", "type": "choice", "question": question,
                               "options": options}])).get("q")
    return a.get("probabilities") if a else None
