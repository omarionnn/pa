// Cached cards are keyed by a design version, not by the colour. When the pen colour moved to brick
// red (10-26) the drawings changed but the keys did not, so every card drawn before kept being served
// orange. A colour change must bump these versions; this pins the bump that shipped with the red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INVITE_CARD_VERSION } from "../src/invitecard.js";
import { DRAWN_COVER_VERSION } from "../src/eventcover.js";

test("invite cards drawn in orange are drawn again in red", () => {
  assert.ok(INVITE_CARD_VERSION >= 3);
});

test("event covers drawn in orange are drawn again in red", () => {
  assert.ok(DRAWN_COVER_VERSION >= 2);
});
