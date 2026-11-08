// Security audit run 2, lead R2-G: on an inbound call matched by caller ID alone, an event organizer's
// tools that text the guests (or change what the guests see) must wait for the second check, the same
// as event_blast. Before this, event_cancel / event_update / event_release / event_guest_remove ran
// on a spoofed call with no check at all.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-call-event-gate-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_TOKEN_KEY = "45".repeat(32);
after(() => rmSync(dir, { recursive: true, force: true }));

const verify = await import("../src/calls/verify.js");
const { EVENT_ORGANIZER_TOOLS, EVENT_RIDE_ORGANIZER_TOOLS, EVENT_RIDE_GUEST_TOOLS } = await import("../src/eventtools.js");

test("every organizer tool that texts guests needs the second check on an unverified call", () => {
  for (const name of ["event_cancel", "event_update", "event_release", "event_guest_remove", "event_blast", "event_schedule"]) {
    assert.equal(verify.isConsequential(name, { event_id: 1 }), true, `${name} must need the check`);
    assert.equal(verify.isConsequential(name), true, `${name} with no input must need the check`);
  }
  // The rest of what an organizer can change that guests or strangers see.
  assert.equal(verify.isConsequential("event_password_rotate", { event_id: 1, new_password: "x" }), true);
  assert.equal(verify.isConsequential("event_detail_public", { event_id: 1, detail: "location" }), true);
  assert.equal(verify.isConsequential("event_cover", { event_id: 1, action: "approve" }), true);
  assert.equal(verify.isConsequential("event_scheduled", { event_id: 1, action: "cancel", scheduled_id: 2 }), true);
  assert.equal(verify.isConsequential("event_scheduled", { event_id: 1, action: "reminder", reminder: "day_before", enabled: false }), true);
  assert.equal(verify.isConsequential("event_rides_setting", { event_id: 1, enabled: true }), true);
  // Leaving ends their ride offers, which texts the ride partner.
  assert.equal(verify.isConsequential("event_leave", { event_id: 1 }), true);
  // A guest's ride tool texts the ride partner (free text), swaps numbers, or tells the organizer.
  for (const action of ["offer", "need", "cancel", "answer", "coordinate", "message", "report"]) {
    assert.equal(verify.isConsequential("event_ride", { event_id: 1, action, message: "x", mode: "intro" }), true, `event_ride ${action}`);
  }
});

test("an organizer tool is covered by default: only the named reads are not", () => {
  // Derived from the organizer list, so a NEW organizer tool is gated on a call until somebody says
  // it is a read. This is the test that fails if a tool that messages guests is added and missed.
  for (const name of [...EVENT_ORGANIZER_TOOLS, ...EVENT_RIDE_ORGANIZER_TOOLS, ...EVENT_RIDE_GUEST_TOOLS]) {
    if (name === "event_guests") continue; // the one tool that only ever reads
    assert.equal(verify.isConsequential(name), true, `${name} with no input must need the check`);
  }
});

test("reading their own event on a call stays unchecked", () => {
  assert.equal(verify.isConsequential("event_guests", { event_id: 1 }), false);
  assert.equal(verify.isConsequential("event_scheduled", { event_id: 1, action: "list" }), false);
  assert.equal(verify.isConsequential("event_cover", { event_id: 1, action: "status" }), false);
  assert.equal(verify.isConsequential("event_rides_setting", { event_id: 1 }), false);
  assert.equal(verify.isConsequential("event_ride", { event_id: 1, action: "neither" }), false);
  // Guest-side tools are about the caller themself and are unchanged.
  for (const name of ["event_list", "event_info", "event_join", "event_mute"]) {
    assert.equal(verify.isConsequential(name, { event_id: 1 }), false, name);
  }
});
