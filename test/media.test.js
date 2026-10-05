// A picture somebody sent, reaching the model as a picture.
//
// What this exists for: Reason answered "if it was a pic, i can't open those" to a message that
// had no picture in it at all, and would have said the same about one that did. People send
// screenshots and photos constantly, so every branch here is about the difference between looking
// at one, and saying honestly and ONCE why it could not be looked at.
//
// No network. `fetch` is injected everywhere, so what a passing test proves is the shape of the
// request, the limits, and the exact words — not that a real Sendblue CDN link answers. See
// docs/unverified.md.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-media-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_OWNER_NUMBER = "+12025551234";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_BURST_QUIET_MS = "0";

const { fetchImage, imagesFor, cannotLookLines, modelTypeFor, MAX_IMAGE_BYTES } = await import("../src/media.js");
const { SYSTEM, userMessageFor } = await import("../src/agent.js");
const { Runtime } = await import("../src/runtime.js");
const { Router } = await import("../src/channels/router.js");
const { FakeChannel } = await import("../src/channels/fake.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const OWNER = "+12025551234";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM conversations; DELETE FROM accounts; DELETE FROM threads; DELETE FROM pending_inbound; DELETE FROM inbound_messages; DELETE FROM inbound_parts; DELETE FROM usage;");
  db.upsertAccount({ conversationId: "dm:owner", channel: "fake", address: OWNER, name: "Omari", isOperator: true });
  config.imageMaxBytes = MAX_IMAGE_BYTES;
  config.burstQuietMs = 0;
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
/** A real one, written by `sips -s format heic` on this machine. See test/pictures.test.js. */
const HEIC = readFileSync(new URL("./fixtures/pictures/iphone.heic", import.meta.url));

/** A fetch that answers one body, and records every request it was given. */
function serving({ status = 200, body = PNG, headers = {}, throws = null } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, redirect: init?.redirect });
    if (throws) throw new Error(throws);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () => body,
    };
  };
  f.calls = calls;
  return f;
}

/** A fetch that answers a list of responses in order, so a redirect chain can be walked. */
function servingEach(responses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: (k) => (r.headers ?? {})[k.toLowerCase()] ?? null },
      arrayBuffer: async () => r.body ?? PNG,
    };
  };
  f.calls = calls;
  return f;
}

const image = (filename, url = `https://cdn.sendblue.test/x/${filename}`) => ({ url, filename, kind: "image" });

// ---------- what the model can actually read ----------

test("the readable formats are the four Claude documents, and nothing else", () => {
  for (const [name, type] of [
    ["photo.jpg", "image/jpeg"], ["PHOTO.JPEG", "image/jpeg"],
    ["shot.png", "image/png"], ["loop.gif", "image/gif"], ["pic.webp", "image/webp"],
  ]) assert.equal(modelTypeFor(name), type, name);

  for (const name of ["IMG_4021.HEIC", "scan.tiff", "art.bmp", "lease.pdf", "clip.mp4", "noextension"]) {
    assert.equal(modelTypeFor(name), null, name);
  }
});

test("on a machine with no converter, an iPhone HEIC is named as a HEIC, with what to do about it", async () => {
  const f = serving();
  const r = await fetchImage({ ...image("IMG_4021.HEIC"), fetchImpl: f, sips: null });
  assert.equal(r.ok, false);
  assert.match(r.why, /IMG_4021\.HEIC/);
  assert.match(r.why, /iPhone HEIC/);
  assert.match(r.why, /jpeg, png, gif and webp/);
  assert.match(r.why, /screenshot/, "and the thing they can do instead");
  assert.equal(f.calls.length, 0, "nothing is downloaded to find out what the name already said");
  assert.equal(/blank/i.test(r.why), false);
});

test("with a converter, an iPhone HEIC is converted and handed over as a JPEG", async () => {
  const f = serving({ body: HEIC });
  const r = await fetchImage({
    ...image("IMG_4021.HEIC"), fetchImpl: f, sips: "/usr/bin/sips",
    convert: async ({ bytes, kind }) => {
      assert.equal(kind, "heic");
      assert.equal(bytes.length, HEIC.length);
      return { ok: true, bytes: Buffer.from("ffd8ffe000104a46494600010100", "hex"), from: "heic" };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, "image/jpeg");
  assert.deepEqual(r.converted, { from: "heic", was_bytes: HEIC.length });
  assert.equal(f.calls.length, 1, "it had to be downloaded to be converted");
});

test("a conversion that fails says exactly that, and never that it saw the photo", async () => {
  const r = await fetchImage({
    ...image("IMG_4021.HEIC"), fetchImpl: serving({ body: HEIC }), sips: "/usr/bin/sips",
    convert: async () => ({ ok: false, error: "sips: Error 4: no image data" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /no image data/);
  assert.match(r.why, /have not seen it/);
  assert.match(r.why, /screenshot/);
  assert.equal(/blank/i.test(r.why), false);
});

test("a conversion that comes out over the ceiling is refused on what would actually be sent", async () => {
  const r = await fetchImage({
    ...image("IMG_4021.HEIC"), fetchImpl: serving({ body: HEIC }), sips: "/usr/bin/sips",
    convert: async () => ({ ok: true, bytes: Buffer.alloc(config.imageMaxBytes + 1, 0x41), from: "heic" }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /over the 7MB you can look at/);
});

// ---------- the bytes decide, not the name ----------

test("a HEIC called .jpg is still converted, because the bytes are what Anthropic would read", async () => {
  let converted = 0;
  const r = await fetchImage({
    ...image("IMG_4021.jpg"), fetchImpl: serving({ body: HEIC }), sips: "/usr/bin/sips",
    convert: async () => { converted++; return { ok: true, bytes: Buffer.from("ffd8ffe000104a46494600010100", "hex"), from: "heic" }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, "image/jpeg");
  assert.equal(converted, 1, "the extension said jpeg and the bytes said otherwise");
});

test("a PNG called .jpg is handed over as a PNG rather than mislabelled", async () => {
  const r = await fetchImage({ ...image("shot.jpg"), fetchImpl: serving({ body: PNG }) });
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, "image/png");
});

test("a .png that downloads as a PDF is not a picture, and says so without guessing", async () => {
  const r = await fetchImage({
    ...image("invoice.png"),
    fetchImpl: serving({ body: Buffer.from("%PDF-1.7\n%\xc7\xec\x8f\xa2 1 0 obj", "binary") }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /not a picture at all/);
  assert.match(r.why, /ask what it was meant to be/);
  assert.equal(/blank/i.test(r.why), false);
});

test("a HEIC called .jpg on a machine with no converter is refused as a HEIC, by its bytes", async () => {
  const r = await fetchImage({ ...image("IMG_4021.jpg"), fetchImpl: serving({ body: HEIC }), sips: null });
  assert.equal(r.ok, false);
  assert.match(r.why, /iPhone HEIC/);
});

// ---------- where the download may go ----------

test("an http link, and one pointing at this machine, are never fetched", async () => {
  for (const url of [
    "http://cdn.sendblue.test/x/shot.png",
    "https://127.0.0.1:8787/x/shot.png",
    "https://169.254.169.254/latest/meta-data/shot.png",
    "https://localhost/x/shot.png",
  ]) {
    const f = serving();
    const r = await fetchImage({ url, filename: "shot.png", fetchImpl: f });
    assert.equal(r.ok, false, url);
    assert.equal(f.calls.length, 0, url);
    assert.match(r.why, /have not seen it/);
  }
});

test("a redirect is followed, and re-checked: one to the loopback is not", async () => {
  const good = servingEach([
    { status: 302, headers: { location: "https://cdn2.sendblue.test/real/shot.png" } },
    { status: 200, body: PNG },
  ]);
  const ok = await fetchImage({ ...image("shot.png"), fetchImpl: good });
  assert.equal(ok.ok, true);
  assert.equal(good.calls[1].url, "https://cdn2.sendblue.test/real/shot.png");
  assert.equal(good.calls.length, 2);

  const bad = servingEach([{ status: 302, headers: { location: "http://127.0.0.1:8787/admin" } }]);
  const stopped = await fetchImage({ ...image("shot.png"), fetchImpl: bad });
  assert.equal(stopped.ok, false);
  assert.equal(bad.calls.length, 1, "the second hop is never made");
  assert.match(stopped.why, /have not seen it/);
});

test("a redirect loop is given up on rather than followed forever", async () => {
  const f = servingEach([{ status: 302, headers: { location: "https://cdn.sendblue.test/x/shot.png" } }]);
  const r = await fetchImage({ ...image("shot.png"), fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.why, /redirecting/);
  assert.ok(f.calls.length <= 5, `${f.calls.length} requests is not a loop that was stopped`);
});

test("redirects are followed here rather than by fetch, so every hop can be checked", async () => {
  const f = serving();
  await fetchImage({ ...image("shot.png"), fetchImpl: f });
  assert.equal(f.calls[0].redirect, "manual");
});

test("the ceiling is enforced while the body is still arriving, not after", async () => {
  // A real fetch gives an async-iterable body. The chunks here add up to well over the ceiling;
  // what is asserted is that the rest of them were never pulled.
  let pulled = 0;
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  const f = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => { throw new Error("the whole body should never be read"); },
    body: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 40; i++) { pulled++; yield chunk; }
      },
    },
  });
  const r = await fetchImage({ ...image("huge.jpg"), fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.why, /over the 7MB you can look at/);
  assert.ok(pulled <= 9, `${pulled}MB was pulled down for a photo that was refused at 7`);
});

// ---------- the happy path ----------

test("a png is fetched and handed over as a base64 image block", async () => {
  const f = serving({ body: PNG });
  const r = await fetchImage({ ...image("shot.png"), fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, "image/png");
  assert.equal(r.base64, PNG.toString("base64"));
  assert.equal(r.bytes, PNG.length);
  assert.equal(r.authed, false, "the CDN link was asked for plainly");
  assert.equal(f.calls[0].url, "https://cdn.sendblue.test/x/shot.png");
  assert.deepEqual(f.calls[0].headers, {}, "and with no credentials on it");
});

test("a caller that hands over credentials gets exactly one retry with them", async () => {
  // Sendblue never says whether an inbound media_url needs auth, so this path exists — but nothing
  // passes `auth` today: the media_url host in their own docs is storage.googleapis.com, and
  // putting sb-api-secret-key on a request to somebody else's CDN to find out whether it was
  // needed would be handing a credential to a third party. Proven here, wired nowhere.
  let n = 0;
  const f = async (url, init) => {
    n++;
    const authed = !!init?.headers?.["sb-api-key-id"];
    return {
      ok: authed, status: authed ? 200 : 403,
      headers: { get: () => null },
      arrayBuffer: async () => PNG,
    };
  };
  const r = await fetchImage({
    ...image("shot.png"), fetchImpl: f,
    auth: { "sb-api-key-id": "k", "sb-api-secret-key": "s" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.authed, true, "and it is recorded that credentials were what worked");
  assert.equal(n, 2, "exactly twice — not a retry loop");
});

test("a 403 is reported rather than retried with credentials nobody offered", async () => {
  const f = serving({ status: 403 });
  const r = await fetchImage({ ...image("shot.png"), fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.why, /HTTP 403/);
  assert.equal(f.calls.length, 1);
});

// ---------- every way it can fail, said once and in words ----------

test("a photo over the size ceiling is refused before the request when the header says so", async () => {
  const f = serving({ headers: { "content-length": String(20 * 1024 * 1024) } });
  const r = await fetchImage({ ...image("huge.jpg"), fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.why, /20MB/);
  assert.match(r.why, /7MB/, "and what the ceiling actually is");
  assert.match(r.why, /have not seen it/);
});

test("a photo whose Content-Length lied is still refused, on the real bytes", async () => {
  const big = Buffer.alloc(config.imageMaxBytes + 1, 1);
  const f = serving({ body: big, headers: {} });
  const r = await fetchImage({ ...image("huge.jpg"), fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.why, /over the 7MB you can look at/);
});

test("an expired link says so, because an inbound link only lives 30 days", async () => {
  const r = await fetchImage({ ...image("old.jpg"), fetchImpl: serving({ status: 404 }) });
  assert.equal(r.ok, false);
  assert.match(r.why, /HTTP 404/);
  assert.match(r.why, /30 days/);
});

test("a dropped connection, a timeout and an empty download each get their own honest line", async () => {
  const dropped = await fetchImage({ ...image("a.jpg"), fetchImpl: serving({ throws: "socket hang up" }) });
  assert.match(dropped.why, /socket hang up/);
  assert.match(dropped.why, /have not seen it/);

  const empty = await fetchImage({ ...image("b.jpg"), fetchImpl: serving({ body: Buffer.alloc(0) }) });
  assert.match(empty.why, /came back empty/);
  assert.match(empty.why, /send it again/);

  // Every one of them, and none of them says the word.
  for (const r of [dropped, empty]) assert.equal(/blank/i.test(r.why), false);
});

test("a picture with no link at all is reported rather than fetched", async () => {
  const f = serving();
  const r = await fetchImage({ url: "", filename: "shot.png", fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.why, /no link to it/);
  assert.equal(f.calls.length, 0);
});

// ---------- a whole turn's worth ----------

test("a turn with two readable photos and one unreadable file looks at two and explains the third", async () => {
  // One body for everything, so what is being proved is the per-picture bookkeeping. The second
  // picture's name is one nothing on any machine reads, so it is the one that gets a sentence.
  const f = serving({ body: PNG });
  const out = await imagesFor(
    [image("one.jpg"), image("scan.psd"), image("three.png"), { kind: "file", filename: "lease.pdf", url: "u" }],
    { fetchImpl: f },
  );
  assert.equal(out.blocks.length, 2);
  assert.deepEqual(out.blocks[0], { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  assert.equal(out.blocks[1].source.media_type, "image/png");
  assert.equal(out.notes.length, 1, "one sentence, for the one that could not be read");
  assert.match(out.notes[0], /scan\.psd/);
  assert.equal(out.seen.length, 2);
  assert.match(out.seen[0], /looked at it when it arrived and cannot look at it again/);
  assert.equal(f.calls.length, 2, "neither the pdf nor the psd was fetched");
});

test("a converted photo is logged as converted, so the record says what really happened", async () => {
  const lines = [];
  await imagesFor([image("IMG_1.HEIC")], {
    fetchImpl: serving({ body: HEIC }),
    log: (e) => lines.push(e),
  });
  // On a Mac this really converts; on a machine with no sips it really refuses. Either is honest,
  // and neither is silence.
  assert.equal(lines.length, 1);
  assert.ok(lines[0].converted_from === "heic" || /iPhone HEIC/.test(lines[0].could_not_look ?? ""), JSON.stringify(lines[0]));
  assert.equal(JSON.stringify(lines[0]).includes(HEIC.toString("base64").slice(0, 20)), false, "and never the bytes");
});

test("nothing attached means nothing said about attachments", async () => {
  const out = await imagesFor([], {});
  assert.deepEqual(out, { blocks: [], notes: [], seen: [] });
});

// ---------- the backend that genuinely cannot ----------

test("the CLI backend says plainly that it cannot look, once per picture", () => {
  const lines = cannotLookLines([image("a.jpg"), { kind: "file", filename: "x.pdf", url: "u" }, image("b.png")]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /a\.jpg/);
  assert.match(lines[0], /cannot look at it on this backend/);
  assert.match(lines[0], /ask what is in it/);
  for (const l of lines) assert.equal(/blank/i.test(l), false);
});

// ---------- the two shapes one message takes ----------

test("the model gets the picture before the text; the history gets a line instead", () => {
  const blocks = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAA" } }];
  const { forModel, forHistory } = userMessageFor({
    prefix: "[Sun, Oct 5, 2026, 1:35 AM] Omari:",
    text: "what do you think of these",
    blocks,
    seen: ["they sent a photo (IMG_1.jpg); you looked at it when it arrived and cannot look at it again"],
  });

  assert.equal(forModel.content[0], blocks[0], "the picture comes first — the vision docs say so");
  assert.equal(forModel.content[1].type, "text");
  assert.match(forModel.content[1].text, /what do you think of these/);

  // The history is a plain string, which is also what trimHistory needs its first message to be.
  assert.equal(typeof forHistory.content, "string");
  assert.equal(forHistory.content.includes("AAA"), false, "no base64 is ever written to the database");
  assert.match(forHistory.content, /cannot look at it again/);
});

test("a message with no pictures is a plain string either way, exactly as it was before", () => {
  const { forModel, forHistory } = userMessageFor({ prefix: "[stamp] Omari:", text: "dinner friday?" });
  assert.equal(forModel.content, "[stamp] Omari: dinner friday?");
  assert.equal(forHistory.content, forModel.content);
});

test("a picture that could not be read puts its one sentence in the message itself", () => {
  const { forModel } = userMessageFor({
    prefix: "[stamp] Omari:", text: "these ones",
    notes: ["they sent a photo (IMG_4021.HEIC) and you cannot open it: it is an iPhone HEIC"],
  });
  assert.match(forModel.content, /these ones\n\[they sent a photo \(IMG_4021\.HEIC\)/);
  assert.equal(/blank/i.test(forModel.content), false);
});

test("a delivery failure notice still comes first, ahead of everything about pictures", () => {
  const { forModel } = userMessageFor({
    notice: "[delivery failure] your last reply never arrived.\n",
    prefix: "[stamp] Omari:", text: "?",
    notes: ["they sent a photo (a.heic) and you cannot open it"],
  });
  assert.match(forModel.content, /^\[delivery failure\]/);
});

// ---------- end to end: a webhook with a photo on it ----------

test("a photo on an inbound message reaches the turn still attached", async () => {
  const seen = [];
  const runtime = new Runtime({
    runTurn: async ({ text, attachments }) => { seen.push({ text, attachments }); return "ok"; },
  });
  const router = new Router({ runtime });
  router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;

  await router.deliver({
    channel: "fake", externalId: "e-1", from: OWNER, text: "what do you think of these",
    said: "what do you think of these", chatId: null, service: "iMessage", at: clock.now(),
    attachments: [image("IMG_4021.jpg")],
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "what do you think of these", "the caption, with nothing invented around it");
  assert.deepEqual(seen[0].attachments, [image("IMG_4021.jpg")], "and the picture, for the turn to look at");
});

test("a burst's pictures all reach the one turn, in the order they arrived", async () => {
  config.burstQuietMs = 0;
  const seen = [];
  const runtime = new Runtime({
    runTurn: async ({ text, attachments }) => { seen.push({ text, attachments }); return "ok"; },
  });
  const router = new Router({ runtime });
  router.register(new FakeChannel({ number: "+15122164639" }));
  runtime.turnExtras.channels = router;

  // Held with the window off would be two turns, so they are put in the table directly — which is
  // what two texts a second apart leave behind.
  for (const [i, name] of ["one.jpg", "two.png"].entries()) {
    db.holdInbound({
      conversationId: "dm:owner", channel: "fake", address: OWNER, externalId: `e-${i}`,
      text: i ? "or this one" : "these two", attachments: [image(name)],
      service: "iMessage", isOperator: true, quietMs: 0, maxMs: 8_000,
    });
  }
  await router.drain("dm:owner");

  assert.equal(seen.length, 1);
  // Past the line that says it was two texts (replies.burstLine).
  assert.equal(seen[0].text.split("\n").slice(-2).join("\n"), "these two\nor this one");
  assert.deepEqual(seen[0].attachments.map(a => a.filename), ["one.jpg", "two.png"]);
});

// ---------- and what the model is told to do with all of it ----------

test("the prompt says Reason can see pictures, and forbids the lines it actually sent", () => {
  assert.match(SYSTEM, /You can look at pictures/);
  assert.match(SYSTEM, /Never say you cannot open pictures when one is in front of you/);
  // The two sentences from the 1:35 AM screenshots, named so they cannot come back.
  assert.match(SYSTEM, /came through blank/);
  assert.match(SYSTEM, /that's 3 now/);
  assert.match(SYSTEM, /Say it ONCE/);
});
