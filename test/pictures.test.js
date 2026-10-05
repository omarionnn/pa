// Turning an iPhone's photo into something the model can read, and refusing to fetch one from
// somewhere it should not.
//
// The HEIC in test/fixtures/pictures is a real one: an 8x4 image written by `sips -s format heic`
// on this machine on 2026-10-05. It is here rather than generated at test time so the "there is no
// converter" path can be proved on a machine that happens to have one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  sniff, checkUrl, isPrivateHost, toJpeg, findSips, SIPS_PATH, JPEG_SIPS_ARGS, READABLE, CONVERTIBLE,
} = await import("../src/pictures.js");

const HEIC = readFileSync(new URL("./fixtures/pictures/iphone.heic", import.meta.url));
const PNG = readFileSync(new URL("./fixtures/pictures/plain.png", import.meta.url));

// ---------- what a thing really is, from its bytes ----------

test("the first bytes say what a picture is, whatever it is called", () => {
  assert.equal(sniff(HEIC), "heic", "a real iPhone-format file");
  assert.equal(sniff(PNG), "image/png");
  assert.equal(sniff(Buffer.from("ffd8ffe000104a46494600010100", "hex")), "image/jpeg");
  assert.equal(sniff(Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000", "binary")), "image/gif");
  assert.equal(sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(sniff(Buffer.concat([Buffer.from("BM"), Buffer.alloc(20)])), "bmp");
  assert.equal(sniff(Buffer.from("49492a00080000000e000000ff00", "hex")), "tiff");
  assert.equal(sniff(Buffer.from("4d4d002a00000008001200000012", "hex")), "tiff");
});

test("a PDF, a video and a page of text are not pictures, and neither is something too short", () => {
  assert.equal(sniff(Buffer.from("%PDF-1.7\n%\xc7\xec\x8f\xa2", "binary")), null);
  assert.equal(sniff(Buffer.from("00000020667479706d70343200000000", "hex")), null, "an mp4 ftyp is not a HEIF brand");
  assert.equal(sniff(Buffer.from("<!doctype html><html><head>")), null);
  assert.equal(sniff(Buffer.from("ffd8", "hex")), null, "two bytes decide nothing");
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.equal(sniff(null), null);
});

test("the four the model reads, and the three that have to be converted first, are not the same set", () => {
  assert.deepEqual([...READABLE].sort(), ["image/gif", "image/jpeg", "image/png", "image/webp"]);
  assert.deepEqual(Object.keys(CONVERTIBLE).sort(), ["bmp", "heic", "tiff"]);
  for (const k of Object.keys(CONVERTIBLE)) assert.equal(READABLE.has(k), false, k);
});

// ---------- where a media download may go ----------

test("https only: an http link is refused in words about the download", () => {
  const r = checkUrl("http://cdn.example.com/a.jpg");
  assert.equal(r.ok, false);
  assert.match(r.why, /http rather than https/);
  assert.equal(checkUrl("https://cdn.example.com/a.jpg").ok, true);
  for (const bad of ["file:///etc/passwd", "ftp://x/a.jpg", "data:image/png;base64,AAA", "not a url", "", null]) {
    assert.equal(checkUrl(bad).ok, false, String(bad));
  }
});

test("nothing on this machine's own network, in either address family", () => {
  for (const host of [
    "localhost", "LOCALHOST", "reason.local", "db.internal", "box.home.arpa", "x.localhost",
    "127.0.0.1", "127.9.9.9", "0.0.0.0", "10.0.0.5", "172.16.3.4", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "[::1]", "[::]", "[fd00::1]", "[fc00::abcd]", "[fe80::1]", "[::ffff:127.0.0.1]",
  ]) {
    assert.equal(isPrivateHost(host.replace(/^\[|\]$/g, "")), true, host);
    assert.equal(checkUrl(`https://${host}/a.jpg`).ok, false, host);
  }
  assert.match(checkUrl("https://169.254.169.254/latest/meta-data").why, /this machine's own network/);
});

test("the hosts a real inbound photo comes from are allowed", () => {
  for (const host of ["storage.googleapis.com", "cdn.sendblue.test", "8.8.8.8", "172.32.0.1", "192.167.1.1", "[2606:4700::1]"]) {
    assert.equal(checkUrl(`https://${host}/x/IMG_1.jpg`).ok, true, host);
  }
});

test("checkUrl hands back the normalised address, so what was checked is what gets fetched", () => {
  assert.equal(checkUrl("https://CDN.Example.com/a.jpg?x=1").url, "https://cdn.example.com/a.jpg?x=1");
});

// ---------- the conversion ----------

test("the sips command is the one that was run by hand, and it is feature-detected", () => {
  assert.deepEqual(JPEG_SIPS_ARGS("/tmp/a.heic", "/tmp/a.jpg"), ["-s", "format", "jpeg", "/tmp/a.heic", "--out", "/tmp/a.jpg"]);
  assert.equal(SIPS_PATH, "/usr/bin/sips");

  const had = process.env.REASON_SIPS_BIN;
  try {
    process.env.REASON_SIPS_BIN = "none";
    assert.equal(findSips(), null, "a machine without one says so rather than guessing");
    process.env.REASON_SIPS_BIN = "/definitely/not/here/sips";
    assert.equal(findSips(), null, "a named path that is not there is not a converter");
  } finally {
    if (had === undefined) delete process.env.REASON_SIPS_BIN; else process.env.REASON_SIPS_BIN = had;
  }
});

test("a real HEIC really comes back as a JPEG, on a machine that has sips", { skip: !existsSync("/usr/bin/sips") && "no sips on this machine" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reason-pic-"));
  try {
    const r = await toJpeg({ bytes: HEIC, filename: "IMG_4021.HEIC", tmpDir: dir, bin: "/usr/bin/sips" });
    assert.equal(r.ok, true, r.error);
    assert.equal(sniff(r.bytes), "image/jpeg", "and it is a JPEG by its bytes, not by its name");
    assert.equal(r.from, "heic");
    assert.equal(r.name, "IMG_4021.jpg");
    assert.deepEqual(readdirSync(dir), [], "and neither file is left on the disk afterwards");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no converter nothing is attempted and nothing is claimed", async () => {
  const r = await toJpeg({ bytes: HEIC, filename: "a.heic", bin: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /no image converter on this machine/);
});

test("something that is not convertible is refused rather than run through anyway", async () => {
  let ran = 0;
  const r = await toJpeg({ bytes: PNG, filename: "a.png", bin: "/usr/bin/sips", run: async () => { ran++; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(ran, 0);
});

test("a converter that fails, writes nothing, writes an empty file, or writes the wrong thing: four honest answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reason-pic-"));
  try {
    const broke = await toJpeg({ bytes: HEIC, filename: "a.heic", tmpDir: dir, bin: "/x/sips", run: async () => ({ ok: false, error: "sips: Error 4: no image data" }) });
    assert.equal(broke.ok, false);
    assert.match(broke.error, /no image data/);

    const nothing = await toJpeg({
      bytes: HEIC, filename: "a.heic", tmpDir: dir, bin: "/x/sips",
      run: async () => ({ ok: true }), read: () => { throw new Error("ENOENT"); },
    });
    assert.match(nothing.error, /wrote no file/);

    const empty = await toJpeg({
      bytes: HEIC, filename: "a.heic", tmpDir: dir, bin: "/x/sips",
      run: async () => ({ ok: true }), read: () => Buffer.alloc(0),
    });
    assert.match(empty.error, /empty file/);

    // sips exits 0 on things it did not really convert, so the output is sniffed too.
    const wrong = await toJpeg({
      bytes: HEIC, filename: "a.heic", tmpDir: dir, bin: "/x/sips",
      run: async () => ({ ok: true }), read: () => HEIC,
    });
    assert.match(wrong.error, /did not produce a JPEG/);

    assert.deepEqual(readdirSync(dir), [], "and no path leaves somebody's photo behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
