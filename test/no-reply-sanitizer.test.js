// withoutNoReply (src/plain.js): the one rule every outbound path uses to take the silence marker
// off at the last step. The strings; test/no-reply-midtext.test.js proves it is wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutNoReply, readSilence } from "../src/plain.js";

const clean = (s) => withoutNoReply(s).text;

test("the marker comes off wherever it sits, and the space it leaves is tidied", () => {
  assert.equal(clean("on it\nNO_REPLY\nback in ten"), "on it\nback in ten");
  assert.equal(clean("on it NO_REPLY, checking now"), "on it, checking now");
  assert.equal(clean("on it NO_REPLY checking now"), "on it checking now");
  assert.equal(clean("NO_REPLY on it"), "on it");
  assert.equal(clean("on it NO_REPLY."), "on it.");
  assert.equal(clean("first\n\nNO_REPLY\n\nsecond"), "first\n\nsecond");
});

test("the variants the code already reads as the marker: markdown round it, punctuation after it", () => {
  assert.equal(clean("done **NO_REPLY** really"), "done really");
  assert.equal(clean("done `NO_REPLY` really"), "done really");
  assert.equal(clean("done _NO_REPLY_ really"), "done really");
  assert.equal(clean("done\nNO_REPLY.\nreally"), "done\nreally");
});

test("only markers left: empty, so nothing is sent", () => {
  for (const s of ["NO_REPLY", "NO_REPLY NO_REPLY", "**NO_REPLY** — NO_REPLY", "NO_REPLY\n\nNO_REPLY."]) {
    const r = withoutNoReply(s);
    assert.equal(r.empty, true, s);
    assert.equal(r.text, "");
  }
  assert.equal(withoutNoReply("👍 NO_REPLY").empty, false, "an emoji is something to send");
});

test("text that is not the marker is untouched, byte for byte", () => {
  for (const s of [
    "she's sent no reply yet", "write to no_reply@bank.com", "NO REPLY from the landlord", "THE_NO_REPLY_FLAG", "NO_REPLYING",
    "  - indented\n\n\n\nkept as written  ", "",
  ]) {
    const r = withoutNoReply(s);
    assert.equal(r.text, s, s);
    assert.equal(r.stripped, false);
  }
});

test("a strip is one log line with the path and no content", () => {
  const lines = [];
  withoutNoReply("secret plan NO_REPLY here", { path: "outbox", log: (l) => lines.push(l) });
  withoutNoReply("nothing to see", { path: "outbox", log: (l) => lines.push(l) });
  withoutNoReply("NO_REPLY", { path: "send_now", log: (l) => lines.push(l) });
  assert.deepEqual(lines, [{ no_reply_stripped: "outbox" }, { no_reply_stripped: "send_now", dropped: true }]);
});

test("readSilence still decides whole-reply silence the way it did", () => {
  assert.equal(readSilence("NO_REPLY").silent, true);
  assert.equal(readSilence("NO_REPLY\nbecause nothing changed").silent, true);
  assert.deepEqual(readSilence("on it\nNO_REPLY"), { text: "on it", silent: false, stripped: true });
});
