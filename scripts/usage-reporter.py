#!/usr/bin/env python3
"""Push the owner's coding-subscription usage from the Mac to Reason's status page.

Run every ten minutes by launchd (scripts/com.reason.usage-reporter.plist). Each run:

  1. reads the 5-hour and weekly limits from GET https://api.anthropic.com/api/oauth/usage — the
     endpoint Claude Code's own /usage screen reads, with the CLI's login token from the macOS
     keychain. Not a model call: it spends nothing from either window. If the token has expired the
     limits are skipped (the CLI refreshes it on its next run; refreshing it here could log it out);
  2. counts today's model requests in ~/.claude/projects/**/*.jsonl (Claude Code and OpenClaw's
     claude-cli runs) — distinct assistant message ids since local midnight. Only the count leaves;
  3. POSTs those numbers, HMAC-SHA256 signed with REASON_USAGE_INGEST_SECRET, to REASON_USAGE_URL.

Settings come from ~/.config/reason-usage/.env (mode 600). Prints one line, never the secret or
the token. Stdlib only.
"""
import datetime, hashlib, hmac, json, os, subprocess, sys, time, urllib.request

ENV = os.path.expanduser("~/.config/reason-usage/.env")
PROJECTS = os.path.expanduser("~/.claude/projects")


def settings():
    out = {}
    try:
        with open(ENV) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


def token():
    try:
        raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                             capture_output=True, text=True, timeout=10).stdout
        o = json.loads(raw).get("claudeAiOauth") or {}
    except Exception:
        return None
    if not o.get("accessToken"):
        return None
    if o.get("expiresAt") and int(o["expiresAt"]) <= time.time() * 1000 + 60_000:
        return None
    return o["accessToken"]


def to_ms(iso):
    if not iso:
        return None
    try:
        return int(datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def limit_name(l):
    """A scoped limit by what it is scoped to: "week Fable" rather than "weekly_scoped"."""
    model = (((l.get("scope") or {}).get("model")) or {}).get("display_name")
    return f"{'week' if l.get('group') == 'weekly' else l.get('group') or 'limit'} {model}" if model else str(l.get("kind"))


def limits():
    t = token()
    if not t:
        return {}, "no live login token"
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage",
                                 headers={"Authorization": f"Bearer {t}", "anthropic-beta": "oauth-2025-04-20"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.load(r)
    except Exception as e:
        return {}, f"usage endpoint: {type(e).__name__}"
    out = {}
    five, week = j.get("five_hour") or {}, j.get("seven_day") or {}
    if five.get("utilization") is not None:
        out["five_pct"], out["five_resets_at"] = five["utilization"], to_ms(five.get("resets_at"))
    if week.get("utilization") is not None:
        out["week_pct"], out["week_resets_at"] = week["utilization"], to_ms(week.get("resets_at"))
    extra = {limit_name(l): l["percent"] for l in (j.get("limits") or [])
             if isinstance(l, dict) and l.get("kind") not in ("session", "weekly_all") and l.get("percent") is not None}
    if extra:
        out["extra"] = extra
    return out, None


def requests_today():
    midnight = datetime.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    since = midnight.timestamp()
    ids = set()
    for root, _dirs, files in os.walk(PROJECTS):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(root, name)
            try:
                if os.path.getmtime(path) < since:
                    continue
                with open(path, "rb") as f:
                    for line in f:
                        if b'"type":"assistant"' not in line:
                            continue
                        try:
                            e = json.loads(line)
                            ts = datetime.datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp()
                        except Exception:
                            continue
                        if ts >= since:
                            ids.add((e.get("message") or {}).get("id") or e.get("uuid"))
            except OSError:
                continue
    return len(ids)


def main():
    s = settings()
    secret, url = s.get("REASON_USAGE_INGEST_SECRET"), s.get("REASON_USAGE_URL")
    if not secret or not url:
        print(f"not set up: {ENV} needs REASON_USAGE_INGEST_SECRET and REASON_USAGE_URL")
        return 1
    body, why = limits()
    body["turns_today"] = requests_today()
    raw = json.dumps(body, separators=(",", ":"))
    ts = str(int(time.time() * 1000))
    sig = hmac.new(secret.encode(), f"{ts}.{raw}".encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(url, data=raw.encode(), method="POST", headers={
        "content-type": "application/json", "x-reason-timestamp": ts, "x-reason-signature": f"sha256={sig}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception as e:
        print(f"push failed: {type(e).__name__}")
        return 1
    print(f"{datetime.datetime.now().isoformat(timespec='seconds')} pushed {status} · 5h {body.get('five_pct')}% · week {body.get('week_pct')}% · {body['turns_today']} requests today{f' · {why}' if why else ''}")
    return 0 if status == 204 else 1


if __name__ == "__main__":
    sys.exit(main())
