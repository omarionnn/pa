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

test("the variants the code already reads as the marker: bold round it, punctuation after it", () => {
  assert.equal(clean("done **NO_REPLY** really"), "done really");
  assert.equal(clean("done\nNO_REPLY.\nreally"), "done\nreally");
});

// Review of #272, item 1: the token as part of a link, an address, an identifier, or code is not the marker.
test("a link, an address, an identifier or code with the token in it is left exactly as written", () => {
  for (const s of [
    "unsubscribe at https://bank.com/settings/NO_REPLY/off",
    "the page is https://x.com/?mode=NO_REPLY&x=1",
    "set flag=NO_REPLY then restart",
    "from NO_REPLY@BANK.COM this morning",
    "it came from no_reply@bank.com",
    "the env var is REASON_NO_REPLY now",
    "see config.NO_REPLY for it",
    "the key is a-NO_REPLY",
    "the host NO_REPLY.example.com is down",
    "run `echo NO_REPLY` to see it",
    "```\nif (reply === \"NO_REPLY\") return;\n```",
  ]) {
    const r = withoutNoReply(s);
    assert.equal(r.text, s, s);
    assert.equal(r.stripped, false, s);
  }
  // Code is protected, the loose marker next to it is not.
  assert.equal(clean("run `echo NO_REPLY` NO_REPLY now"), "run `echo NO_REPLY` now");
});

test("a list item that was only the marker goes, number and all", () => {
  assert.equal(clean("1. eggs\n2. NO_REPLY\n3. milk"), "1. eggs\n3. milk");
  assert.equal(clean("- eggs\n- NO_REPLY\n- milk"), "- eggs\n- milk");
});

// Review of #272, item 2: only the place the marker was is tidied.
test("the rest of the message keeps its spacing, indentation and blank lines", () => {
  assert.equal(clean("  indented line\n\n\n\nfar below\nok NO_REPLY then"), "  indented line\n\n\n\nfar below\nok then");
  assert.equal(clean("  step one  \nNO_REPLY\n    code-ish indent"), "  step one  \n    code-ish indent");
  assert.equal(clean("    NO_REPLY keep my indent"), "    keep my indent");
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
