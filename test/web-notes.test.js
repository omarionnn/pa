// Reason Web: the pipeline's notes in a person's stored message are drawn for people, never shown raw
// (src/pages/webnotes.js). 2026-10-30: a location shared over iMessage showed on Web as
// "[they shared their location: … (40.74…, -73.99…, accuracy ~19m) (sharing: endOfDay) — … Use
// nearby_places with these coordinates …]" under a "?" (the share's U+FFFD body). The model still
// reads every word; only the page changes.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-web-notes-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
process.env.REASON_SITE_URL = "https://heyreason.test";
process.env.REASON_WEB = "on";

const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const convo = await import("../src/pages/webconvo.js");
const { searchMessages } = await import("../src/pages/webhistory.js");
const daily = await import("../src/daily.js");
const notes = await import("../src/pages/webnotes.js");

const C = "dm:fake:+12025551234";
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db.db.exec("DELETE FROM accounts; DELETE FROM threads; DELETE FROM messages;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertThread({ conversationId: C, channel: "fake", address: "+12025551234", isOwner: true, service: "iMessage" });
});
const NOW = Date.UTC(2026, 9, 30, 19, 20);
clock.now = () => NOW;
let seq = 0;
const say = (role, text, media = []) => db.writeMessage({ conversationId: C, role, channel: "sendblue", externalId: role === "user" ? `e${++seq}` : null, outboxId: role === "user" ? null : 1000 + ++seq, text, media, at: NOW - 60_000 + seq });
const lastRow = () => { const r = db.db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").get(); return { ...r, media: JSON.parse(r.media || "[]") }; };
const draw = () => convo.rowOut(lastRow(), { conversationId: C, service: "iMessage", now: NOW });

// The row exactly as live stored it (row 737, coordinates changed).
const LOCATION = "�\n[they shared their location: Lefcourt Clothing Center Building, 164, West 26th Street, Chelsea District, Manhattan Community Board 4, Manhattan, New York County, New York, 10001, United States (40.7458123, -73.9940456, accuracy ~19m) (sharing: endOfDay) — use this as their current position for anything location-related. Use nearby_places with these coordinates to find places near them]";
const RAW = /nearby_places|40\.745|-73\.99|accuracy|\[they |\]|current position|�|Community Board|County/;

test("a shared location is a location card: short address, how long, no coordinates, no instructions, no '?'", () => {
  say("user", LOCATION);
  const m = draw();
  assert.doesNotMatch(m.html, RAW);
  assert.match(m.html, /class="wnote wloc"/);
  assert.match(m.html, /SHARED LOCATION · UNTIL END OF DAY/);
  assert.match(m.html, /164 W 26th St, Chelsea/);
  assert.doesNotMatch(m.html, /class="said"/, "no words line: they typed nothing");
  assert.equal(m.plain, "Shared location · 164 W 26th St, Chelsea · until end of day");
  // What the model reads is the stored text, untouched.
  assert.match(lastRow().text, /Use nearby_places with these coordinates/);
});

test("a location with no address found is still a card, still no coordinates", () => {
  say("user", "[they shared their location: 40.7458, -73.9940, accuracy ~19m (sharing: oneHour) — use this as their current position for anything location-related]");
  const m = draw();
  assert.doesNotMatch(m.html, RAW);
  assert.match(m.html, /SHARED LOCATION · FOR AN HOUR/);
  assert.doesNotMatch(m.html, /wn-v/);
});

test("an inline reply, a contact card, a screen effect, an app card: their words, then what it was — no bracket", () => {
  say("user", "[they sent this as an inline reply in the thread under your message: \"Yes, it's real and it's cheap. I read the treg.to page…\". in that thread since: they: \"Can you run it?\" / you: \"I can't run it\" — so it is about that thread, whatever came after]\nCan you run it on poke?");
  let m = draw();
  assert.doesNotMatch(m.html, /\[they |whatever came after|in that thread since/);
  assert.match(m.html, /IN REPLY TO/);
  assert.match(m.html, /Can you run it on poke\?/);

  say("user", "That’s him\n[they shared a contact card (rytCHiLR_Stella_Rosa.vcf) — here is what it says:\nname: Stella Rosa\nphone (cell): +16165550100]");
  m = draw();
  assert.doesNotMatch(m.html, /\[they |here is what it says|\+1616|phone \(cell\)/);
  assert.match(m.html, /CONTACT CARD/);
  assert.match(m.html, /Stella Rosa/);
  assert.match(m.html, /That’s him/);

  say("user", "we got the table\n[they sent that with the 'slam' screen effect on it — that is them being emphatic, so read it that way]");
  m = draw();
  assert.doesNotMatch(m.html, /\[they |emphatic/);
  assert.match(m.html, /SENT WITH SLAM/);

  say("user", "[they sent an iMessage app card — this is often a location share, but could be a game, a sticker or another app. You cannot read what is in it. If context suggests they were trying to share where they are, use get_location to check whether their coordinates are available]");
  m = draw();
  assert.doesNotMatch(m.html, /get_location|\[they /);
  assert.match(m.html, /IMESSAGE APP CARD/);
});

test("a note for a file the line already draws is not drawn twice; a link preview's file is not drawn at all", () => {
  say("user", "[they sent a file, which you cannot open: vGTp29Cx_81D9.pluginPayloadAttachment]", [{ url: "https://x.test/a", filename: "vGTp29Cx_81D9.pluginPayloadAttachment", kind: "file" }]);
  const m = draw();
  assert.doesNotMatch(m.html, /\[they |cannot open|wnote/);
});

test("History search reads a person's line as the page shows it: no hit on the notes, a hit on the place", () => {
  say("user", LOCATION);
  assert.equal(searchMessages(C, "nearby_places").total, 0);
  assert.equal(searchMessages(C, "coordinates").total, 0);
  const { hits } = searchMessages(C, "chelsea");
  assert.equal(hits.length, 1);
  assert.doesNotMatch(hits[0].text, RAW);
});

test("the daily edition's pickup shows the shared location plainly", () => {
  say("assistant", "Want me to find lunch nearby?");
  say("user", LOCATION);
  const p = daily.pickupFor(C);
  assert.equal(p.lines.at(-1).text, "Shared location · 164 W 26th St, Chelsea · until end of day");
  for (const l of p.lines) assert.doesNotMatch(l.text, RAW);
});

test("short addresses: a house number needs a road after it, never a postcode", () => {
  assert.equal(notes.shortPlace("Union Square, Manhattan Community Board 5, Manhattan, New York County, New York, 10003, United States"), "Union Square, Manhattan");
  assert.equal(notes.shortPlace("1600, Amphitheatre Parkway, Mountain View, Santa Clara County, California, 94043, United States"), "1600 Amphitheatre Pkwy, Mountain View");
});

test("words a person typed are never taken for a note unless a line is exactly one", () => {
  assert.equal(notes.readLine("my [they sent] joke stays").words, "my [they sent] joke stays");
  assert.equal(notes.readLine("hello there").notes.length, 0);
});
