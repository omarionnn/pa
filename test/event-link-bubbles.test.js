// Every link Reason sends in an event message leaves in its own bubble, after the words about it,
// in full — so iMessage can draw it as a card (owner, 2026-10-25). The split is delivery's
// (src/plain.js outgoingTexts → src/links.js); these pin that the event texts written in code come
// out as words-then-link, and that tool results handing the model a link tell it the same.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-event-links-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.reason.omarinyarko.com";
process.env.REASON_EVENTS = "owner";

const events = await import("../src/events.js");
const db = await import("../src/db.js");
const { outgoingTexts } = await import("../src/plain.js");
const { runTool } = await import("../src/tools.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const URL_ONLY = /^https:\/\/\S+$/;

test("the welcome: details first, then the who's-going link alone and in full", async () => {
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: "dm:fake:+13475550000", channel: "fake", address: "+13475550000", name: "Ama" });
  const made = await runTool("event_create", { name: "Halloween Party", description: "x", starts_at: "2026-10-31T21:00", location: "12 Elm St", password: "pumpkin", show_time_on_join: true, show_location_on_join: false, guest_list_visible: true }, { conversationId: "dm:owner", messages: [] });
  const ev = db.getEventRow(made.event.event_id);
  const j = await events.joinExisting({ conversationId: "dm:fake:+13475550000", name: "Halloween Party", password: "pumpkin" });
  const bubbles = outgoingTexts(events.welcomeText(ev, j.attendee));
  assert.equal(bubbles.length, 2, JSON.stringify(bubbles));
  assert.match(bubbles[0], /you're in for Halloween Party/);
  assert.ok(!/https?:/.test(bubbles[0]), "no link inside the text bubble");
  assert.match(bubbles[0], /:$/);
  assert.equal(bubbles[1], events.directoryUrl(ev, j.attendee), "the full URL, alone, never shortened");
  assert.match(bubbles[1], URL_ONLY);
  // The note after it carries no link at all.
  const att = events.afterJoin({ ev, att: j.attendee });
  assert.equal(outgoingTexts(events.listNoteText(ev, att, "ask")).length, 1);
  // The owner's creation text: each link after its words, each alone.
  const owner = outgoingTexts(events.ownerCreationLine(ev, { opsLink: "https://reason.omarinyarko.com/ops?k=x#events" }));
  assert.deepEqual(owner.map(b => URL_ONLY.test(b)), [false, true, false, true], JSON.stringify(owner));
  // A result that hands the model a link tells it to send the link the same way.
  const dirOut = await runTool("event_directory", { event_id: ev.id, display_name: "Ama K" }, { conversationId: "dm:fake:+13475550000", messages: [] });
  assert.match(dirOut.links, /full link on its own line/);
});
