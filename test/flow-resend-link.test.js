// A link they tap to act on is sent again, not pointed at. On 2026-10-23 Omari asked for a ride
// home a second time and Reason answered "same one as earlier, the link I sent at 2:42 still
// works" with no link in it — he had to scroll back for it. With the real model: two asks for the
// same ride, and the second reply has to carry a link. Skipped with no model reachable.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-flow-resend-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_PROFILE_ROOT = join(dir, "profiles");
process.env.REASON_SHOT_ROOT = join(dir, "shots");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";

const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock } = await import("../src/config.js");
const { skip } = await import("./live.js");

const OWNER = "+12025551234";
const C = "dm:owner";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM outbox; DELETE FROM accounts; DELETE FROM threads; DELETE FROM conversations; DELETE FROM usage; DELETE FROM inbound_messages;");
  db.upsertAccount({ conversationId: C, channel: "fake", address: OWNER, name: "Omari", isOperator: true });
});

function harness() {
  const rt = new Runtime();
  const router = new Router({ runtime: rt });
  const fake = router.register(new FakeChannel({ number: "+15122164639" }));
  rt.turnExtras.channels = router;
  rt.on("outbound", async ({ conversationId, to, text, chatId, channel, replyTo }) => {
    await router.send({ channel, to, text, chatId, conversationId, toOwner: true, replyTo });
  });
  async function says(handle, text, gapMs = 90_000) {
    clock.skip(gapMs);
    db.claimInbound({ channel: "fake", externalId: handle, conversationId: C, text });
    db.upsertThread({ conversationId: C, channel: "fake", address: OWNER, isOwner: true, service: "iMessage", lastInboundId: handle });
    return await rt.inbound(C, text, { channel: "fake", to: OWNER, fromOwner: true });
  }
  return { rt, fake, says };
}

const LINK = /https:\/\/m\.uber\.com\/\S+/;

test("asked for the same ride twice, the second reply carries the link again", { skip }, async () => {
  const { rt, fake, says } = harness();
  try {
    await says("H-1", "i'm at work, 430 W 17th St, New York. get me an uber home to 3247 Bruner Ave, Bronx");
    const first = fake.sent.map(m => m.text).join("\n");
    assert.match(first, LINK, `the first ride reply has a link: ${first}`);
    const sentBefore = fake.sent.length;
    await says("H-2", "get me a ride home", 20 * 60_000);
    const second = fake.sent.slice(sentBefore).map(m => m.text).join("\n");
    assert.match(second, LINK, `the second reply sends the link again, not a pointer to the old one: ${second}`);
  } finally { await rt.shutdown(); }
});
