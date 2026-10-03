"""BM25 over the corpus, chunked by markdown section. Jev reranks the top hits."""
import math
import os
import re
from collections import Counter
from pathlib import Path

import jev

ROOT = Path(os.environ.get("C3_CORPUS", "/corpus"))
TOK = re.compile(r"[A-Za-z_][A-Za-z0-9_]+|\d+")
NOISE = ("background/",)          # proceedings: theory, rarely the needle
NOISE_WEIGHT = 0.15


def _tokens(s: str) -> list[str]:
    return [t.lower() for t in TOK.findall(s)]


class Corpus:
    def __init__(self):
        self.chunks: list[tuple[str, str]] = []
        for p in sorted(ROOT.rglob("*")):
            if not p.is_file() or p.suffix not in (".md", ".txt"):
                continue
            rel = str(p.relative_to(ROOT))
            if rel.startswith(NOISE) and p.stat().st_size > 2_000_000:
                continue                       # skip giant proceedings outright
            text = p.read_text(errors="replace")
            for sec in re.split(r"\n(?=#{1,3} )", text):
                for i in range(0, len(sec), 3000):
                    self.chunks.append((rel, sec[i:i + 3000]))
        self.tf = [Counter(_tokens(c)) for _, c in self.chunks]
        self.len = [sum(t.values()) or 1 for t in self.tf]
        self.avg = sum(self.len) / max(1, len(self.len))
        df = Counter(w for t in self.tf for w in t)
        n = len(self.chunks)
        self.idf = {w: math.log(1 + (n - d + .5) / (d + .5)) for w, d in df.items()}

    def _bm25(self, q: list[str], i: int) -> float:
        tf, s = self.tf[i], 0.0
        for w in q:
            f = tf.get(w, 0)
            if f:
                s += self.idf[w] * f * 2.2 / (f + 1.2 * (.25 + .75 * self.len[i] / self.avg))
        rel = self.chunks[i][0]
        if rel.startswith(NOISE):
            s *= NOISE_WEIGHT
        if "SUPERSEDED" in self.chunks[i][1][:400]:
            s *= 0.5
        return s

    def search(self, query: str, k: int = 5) -> str:
        q = _tokens(query)
        ranked = sorted(range(len(self.chunks)), key=lambda i: -self._bm25(q, i))[:25]
        ranked = [i for i in ranked if self._bm25(q, i) > 0]
        if not ranked:
            return "no hits"
        scores = jev.score_many([self.chunks[i][1][:1500] for i in ranked],
                                f"How relevant is this passage to: {query}",
                                ["irrelevant", "tangential", "relevant", "answers it"])
        if scores:
            ranked = [i for _, i in sorted(zip(scores, ranked), key=lambda x: -x[0])]
        out = []
        for i in ranked[:k]:
            rel, txt = self.chunks[i]
            out.append(f"--- {rel}\n{txt[:1800]}")
        return "\n\n".join(out)
