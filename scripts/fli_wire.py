"""What a Google Flights response looked like: real data, a refusal, or a consent page.

Kept apart from scripts/fli_sidecar.py and free of any Fli import so the offline suite can run it
against recorded bodies (test/fixtures/fli/) with nothing but python3.

Why it exists: Fli 0.9.0 reads an HTTP 200 whose only payload is an RPC error — e.g.
``[["wrb.fr",null,null,null,null,[13]],...]`` — as "no flights". Recorded from both the Mac and the
Hetzner server on 2026-10-25 after a short burst of searches. Reason must say "couldn't check"
there, never "there are no flights".
"""

from __future__ import annotations

import json


def inspect_body(text: str, url: str = "") -> dict:
    """Classify one HTTP 200 body: ``{"refused": bool, "why": str}``."""
    if "consent.google" in (url or ""):
        return {"refused": True, "why": f"consent page ({url.split('?')[0]})"}
    text = text or ""
    body = text.lstrip()
    if body.startswith(")]}'"):
        body = body[4:]
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("[["):
            continue
        try:
            rows = json.loads(line)
        except ValueError:
            continue
        for row in rows:
            if isinstance(row, list) and row and row[0] == "wrb.fr":
                payload = row[2] if len(row) > 2 else None
                if payload:
                    return {"refused": False}
                code = row[5] if len(row) > 5 else None
                return {"refused": True, "why": f"Google returned an RPC error {code!r} with no data"}
    if "<html" in text[:500].lower():
        return {"refused": True, "why": "Google returned an HTML page instead of data"}
    return {"refused": False}
