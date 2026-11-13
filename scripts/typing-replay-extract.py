# Read-only. Timing only: no text, no address; conversation ids replaced by a salted hash whose salt is thrown away.
import sqlite3, json, os, hashlib, time, sys
db = sqlite3.connect("file:/opt/reason/data/reason.db?mode=ro", uri=True)
salt = os.urandom(32)
h = lambda c: hashlib.sha256(salt + str(c).encode()).hexdigest()[:12]
since = int((time.time() - 30 * 86400) * 1000)
conv = {}
for c, ch, at, cancelled in db.execute("SELECT conversation_id, channel, received_at, cancelled_at FROM inbound_messages WHERE received_at >= ? AND conversation_id IS NOT NULL ORDER BY received_at", (since,)):
    if cancelled: continue
    conv.setdefault(c, {"in": [], "out": []})["in"].append([at, ch])
for c, ch, created, sent in db.execute("SELECT conversation_id, channel, created_at, sent_at FROM outbox WHERE created_at >= ? AND sent_at IS NOT NULL ORDER BY sent_at", (since,)):
    if c in conv: conv[c]["out"].append([created, sent, ch])
out = []
for c, v in conv.items():
    t0 = v["in"][0][0]
    out.append({"c": h(c), "in": [[a - t0, ch] for a, ch in v["in"]], "out": [[cr - t0, s - t0, ch] for cr, s, ch in v["out"]]})
json.dump({"days": 30, "conversations": out}, sys.stdout)
