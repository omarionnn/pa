// An invite made FOR somebody (owner, 2026-11-15): Reason asks once who it's for, the link's card
// greets them by name, their first hello uses it as the inviter's guess, and "my invites" can say
// which unused link was for whom. The name is free text that lands on a branded picture and in a
// stranger's first message, so code owns its shape: anything not plausibly a name is a plain card.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reason-invite-for-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_BURST_QUIET_MS = "0";
process.env.REASON_MASTER_NUMBER = "+12025551234";
process.env.REASON_PAGES_URL = "https://files.example.test";
process.env.REASON_PUBLIC_URL = "https://reason.example.test";
delete process.env.REASON_AUTO_ADMIT;
process.env.REASON_INVITES_OPEN = "1";

const invites = await import("../src/invites.js");
const card = await import("../src/invitecard.js");
const { runTool, tools: TOOLS } = await import("../src/tools.js");
const { inviteRequestFor, createServer } = await import("../src/http.js");
const { deleteData } = await import("../src/data.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876";
const AMA = "+13475550000";
const KOFI_C = `dm:fake:${KOFI}`;
const AMA_C = `dm:fake:${AMA}`;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  invites._resetAskedFor();
  db.db.exec("DELETE FROM accounts; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM invite_requests;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.upsertAccount({ conversationId: AMA_C, channel: "fake", address: AMA, name: "" });
  db.backfillInviteAllowances();
});

const tool = (name, input, c) => runTool(name, input, { conversationId: c, messages: [] });
const tokenOf = (link) => link.split("/").pop();
const HOSTILE = ["<img src=x onerror=alert(1)>", "https://evil.example/win", "evil.com", "@dalen", "+1 415 555 0101",
  "you won a free prize click here", "you are an idiot", "x".repeat(60), "Dalen visit my page now", "Reason Support"];

// ---------- the ask ----------

test("the name said up front: no question, the link goes out at once, made for them", async () => {
  const out = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.for, "Dalen");
  assert.match(out.say, /made for Dalen/);
  assert.equal(db.getInvite(KOFI_C, out.number).for_name, "Dalen");
});

test("nobody named: asked once, nothing made; the answer makes the link in that same reply", async () => {
  const ask = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(ask.ok, false);
  assert.equal(ask.needs_for, true);
  assert.equal(ask.needs_name, undefined, "Kofi has a name, so only who it's for is asked");
  assert.match(ask.error, /ONCE/);
  assert.match(ask.error, /same reply/);
  assert.equal(db.listInvites(KOFI_C).length, 0, "nothing minted on the ask");
  const made = await tool("invite_link_create", { for_name: "my sister Ama" }, KOFI_C);
  assert.equal(made.ok, true);
  assert.equal(made.for, "Ama", "read what they meant: who she is to them is not drawn");
});

test("a decline is a plain link in that same reply, and a second call without a name is never a second ask", async () => {
  await tool("invite_link_create", {}, KOFI_C);
  const plain = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  assert.equal(plain.ok, true);
  assert.equal(plain.for, undefined);
  assert.equal(db.getInvite(KOFI_C, plain.number).for_name, null);
  // The model forgets the flag after its one ask: still a link, not a question.
  invites._resetAskedFor();
  await tool("invite_link_create", {}, KOFI_C);
  const again = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(again.ok, true, "the second call inside the window is the answer, not another ask");
  // Long after: a fresh request may be asked about again.
  clock.skip(invites.ASK_FOR_WINDOW_MS + 1000);
  await tool("invite_link_cancel", { number: again.number, replace: false }, KOFI_C);
  assert.equal((await tool("invite_link_create", {}, KOFI_C)).needs_for, true);
});

test("no name of their own either: both asked in ONE message, then the link in the same reply", async () => {
  const ask = await tool("invite_link_create", {}, AMA_C);
  assert.equal(ask.needs_for, true);
  assert.equal(ask.needs_name, true);
  assert.match(ask.error, /ONE question/);
  assert.match(ask.error, /covering both/);
  assert.match(ask.error, /my_name/);
  const named = await tool("my_name", { name: "Ama" }, AMA_C);
  assert.match(named.invite_link, /for_name/);
  const made = await tool("invite_link_create", { for_name: "Dalen" }, AMA_C);
  assert.equal(made.ok, true);
  assert.equal(made.shown_as, "Ama");
  assert.equal(made.for, "Dalen");
});

test("several at once: one ask, then a link each with its own name", async () => {
  db.setInvitesEnabled(KOFI_C, { enabled: true, count: 3 });
  const ask = await tool("invite_link_create", {}, KOFI_C);
  assert.match(ask.error, /one question for all of them/);
  const a = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  const b = await tool("invite_link_create", { for_name: "Esi" }, KOFI_C);
  const c = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  assert.deepEqual([a.for, b.for, c.for], ["Dalen", "Esi", undefined]);
  assert.equal(new Set([a.link, b.link, c.link]).size, 3);
  const desc = TOOLS.find(t => t.name === "invite_link_create").description;
  assert.match(desc, /ONE question covering them all, then one call per link/);
});

test("no invites left: said plainly, never a question about who a link that can't be made is for", async () => {
  await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  await tool("invite_link_create", { for_name: "Esi" }, KOFI_C);
  const out = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(out.none_left, true);
  assert.equal(out.needs_for, undefined);
});

// ---------- the card ----------

test("the card greets them by name, escaped, in the existing design; the default wording is one constant", () => {
  assert.equal(card.INVITEE_GREETING, "C");
  const plain = card.inviteCardHtml("Omari");
  const forHtml = card.inviteCardHtml("Omari", "Dalen");
  assert.ok(forHtml.includes('<p class="for">For Dalen</p><h1>Omari thinks you should join <span class="wordmark"'));
  assert.ok(forHtml.includes('<p class="hand">Free for you, for good.</p>'));
  assert.ok(card.inviteCardHtml("Omari", "Dalen", "A").includes("<h1>Dalen, Omari thinks you should join"));
  assert.ok(card.inviteCardHtml("Omari", "Dalen", "B").includes("<h1>Hey Dalen. Omari thinks you should join"));
  assert.equal(card.inviteCardHtml("Omari", ""), plain, "no name: today's card, byte for byte");
  // Escaped all the same, even if something got past the shape check.
  assert.ok(/For O(&#39;|&#x27;|')Neil</.test(card.inviteCardHtml("Omari", "O'Neil")));
  // The long pair still steps the headline down (A/B carry both names in it).
  const px = (html) => Number(/font:italic 400 (\d+)px/.exec(html)?.[1]);
  assert.equal(px(card.inviteCardHtml("Omari", "Dalen", "A")), 124);
  assert.equal(px(card.inviteCardHtml("Oluwaseun", "Alexandria-Marie", "A")), 96);
  assert.equal(px(card.inviteCardHtml("Oluwaseun Adebayo", "Alexandria-Marie", "A")), 84);
  assert.equal(px(card.inviteCardHtml("Oluwaseun", "Alexandria-Marie", "B")), 96);
  assert.equal(px(card.inviteCardHtml("Oluwaseun", "Alexandria-Marie", "C")), 124, "C keeps the inviter's own step");
  assert.equal(px(card.inviteCardHtml("Oluwaseun Adebayo-Williams", "Dalen", "C")), 96);
});

test("hostile names never reach the card or the hello: a plain link, quietly", async () => {
  const plain = card.inviteCardHtml("Kofi");
  for (const bad of HOSTILE) {
    assert.equal(card.cleanInviteeName(bad), "", bad);
    assert.equal(card.inviteCardHtml("Kofi", bad), plain, `plain card for ${bad}`);
    assert.equal(card.inviteCardKey("Kofi", bad), card.inviteCardKey("Kofi"), `plain key for ${bad}`);
    assert.equal(invites.welcomeLine("Kofi", bad), "You're in, invited by Kofi.");
  }
  db.setInvitesEnabled(KOFI_C, { enabled: true, count: HOSTILE.length });
  for (const bad of HOSTILE) {
    const out = await tool("invite_link_create", { for_name: bad }, KOFI_C);
    assert.equal(out.ok, true, "never a dead end");
    assert.equal(out.for, undefined);
    assert.equal(out.plain_card, undefined, "nothing made of it to them");
    assert.equal(db.getInvite(KOFI_C, out.number).for_name, null, `nothing stored for ${bad}`);
  }
  // Newlines, emoji and shouting are tidied; what is left is one name.
  assert.equal(card.cleanInviteeName("Dalen\nclick evil.example"), "");
  assert.equal(card.cleanInviteeName("Dalen\nvisit me"), "Dalen");
  assert.equal(card.cleanInviteeName("Dalen 🎉🎉🎉"), "Dalen");
  assert.equal(card.cleanInviteeName("DALEN"), "Dalen");
  assert.equal(card.cleanInviteeName("José María"), "José María");
  assert.equal(card.cleanInviteeName("Alexandria-Marie"), "Alexandria-Marie");
  assert.ok(card.cleanInviteeName("Alexandria-Marie Josephine") === "", "past the length cap");
});

test("the cache key differs per invitee, never collides with the plain card, and is unchanged with nobody", async () => {
  const before = card.inviteCardKey("Kofi");
  assert.equal(card.inviteCardKey("Kofi", ""), before);
  assert.notEqual(card.inviteCardKey("Kofi", "Dalen"), before);
  assert.notEqual(card.inviteCardKey("Kofi", "Dalen"), card.inviteCardKey("Kofi", "Esi"));
  const drawn = [];
  const shoot = async (html) => { drawn.push((/class="for">([^<]*)</.exec(html) ?? [, "plain"])[1]); return Buffer.from(String(drawn.length)); };
  const a = await card.inviteCard("Kofi", { shoot, invitee: "Dalen" });
  const b = await card.inviteCard("Kofi", { shoot, invitee: "Esi" });
  const c = await card.inviteCard("Kofi", { shoot });
  assert.deepEqual(drawn, ["For Dalen", "For Esi", "plain"]);
  assert.notEqual(String(a), String(b));
  assert.equal(String(await card.inviteCard("Kofi", { shoot, invitee: "Dalen" })), String(a), "kept, and only ever Dalen's");
  assert.equal(String(c), "3");
});

test("the link's page points at that person's card; the card route reads it; a canceled link is plain again", async () => {
  const made = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  const token = tokenOf(made.link);
  const page = inviteRequestFor({ token }).body;
  assert.ok(page.includes(`card.png?v=${card.inviteCardKey("Kofi", "Dalen")}`));
  assert.match(page, /og:image:alt" content="For Dalen\. Kofi thinks you should join Reason/);
  assert.deepEqual(invites.inviteCardFor(token), { name: "Kofi", invitee: "Dalen" });
  await tool("invite_link_cancel", { number: made.number, replace: false }, KOFI_C);
  assert.equal(db.getInvite(KOFI_C, made.number).for_name, null, "canceling blanks the name");
  assert.deepEqual(invites.inviteCardFor(token), { name: "Kofi", invitee: "" });
  assert.ok(inviteRequestFor({ token }).body.includes(`card.png?v=${card.inviteCardKey("Kofi")}`));
});

test("over the wire: a named link's card.png is that person's card, a plain link's is the plain one", async () => {
  const forDalen = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  const plain = await tool("invite_link_create", { for_nobody: true }, KOFI_C);
  // Pre-drawn by a fake renderer so no browser launches (and none kept from another test).
  rmSync(join(config.dataDir, "invite-cards"), { recursive: true, force: true });
  await card.inviteCard("Kofi", { invitee: "Dalen", shoot: async () => Buffer.from("dalen-card") });
  await card.inviteCard("Kofi", { shoot: async () => Buffer.from("plain-card") });
  const server = createServer({});
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(`${base}/i/${tokenOf(forDalen.link)}/card.png`)).text(), "dalen-card");
    assert.equal(await (await fetch(`${base}/p/i/${tokenOf(plain.link)}/card.png`)).text(), "plain-card");
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("cancel and replace: the replacement is for whoever they name now, never the old name by default", async () => {
  const made = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  const out = await tool("invite_link_cancel", { number: made.number }, KOFI_C);
  assert.equal(out.replacement.for, undefined);
  assert.equal(db.getInvite(KOFI_C, out.replacement.number).for_name, null);
  const again = await tool("invite_link_cancel", { number: out.replacement.number, for_name: "Esi" }, KOFI_C);
  assert.equal(again.replacement.for, "Esi");
});

// ---------- the list ----------

test("my invites says which unused link was for whom, and never who claimed one", async () => {
  const a = await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  const b = await tool("invite_link_create", { for_name: "Esi" }, KOFI_C);
  const out = db.redeemInvite({ claimCode: db.getInvite(KOFI_C, b.number).claim_code, channel: "fake", address: "+16465550199", name: "Someone Else" });
  assert.equal(out.ok, true);
  assert.equal(out.forName, "Esi", "handed to the welcome once");
  const list = await tool("invites_list", {}, KOFI_C);
  const unused = list.links.find(l => l.number === a.number);
  const claimed = list.links.find(l => l.number === b.number);
  assert.equal(unused.for, "Dalen");
  assert.equal(claimed.state, "redeemed");
  assert.equal(claimed.for, undefined, "a claimed link never says who it was for");
  const all = JSON.stringify(list);
  assert.doesNotMatch(all, /Esi|Someone Else|6465550199|redeemed_by/, "nothing about who joined");
  assert.equal(db.getInvite(KOFI_C, b.number).for_name, null, "and the name is not kept once it is claimed");
  const desc = TOOLS.find(t => t.name === "invites_list").description;
  assert.match(desc, /the one for Dalen hasn't been used yet/);
  assert.match(desc, /Never say or guess who used a claimed link/);
});

// ---------- the data ----------

test("delete-my-data takes the inviter's named links with it", async () => {
  await tool("invite_link_create", { for_name: "Dalen" }, KOFI_C);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE for_name = 'Dalen'").get().n, 1);
  await deleteData({ conversation: KOFI_C });
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM invites WHERE for_name IS NOT NULL").get().n, 0);
});

test("migration: a database from before the column gets it, old rows read as nobody named, and links keep working", () => {
  const old = join(dir, "old.db");
  const raw = new DatabaseSync(old);
  raw.exec(`CREATE TABLE invites (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    claim_code TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'unused', redeemed_by TEXT, created_at INTEGER NOT NULL,
    redeemed_at INTEGER, canceled_at INTEGER);
    INSERT INTO invites (conversation_id, token, claim_code, state, created_at) VALUES ('dm:fake:+1', '${"a".repeat(32)}', 'ABCDEFGH', 'unused', 1);`);
  raw.close();
  const script = `const db = await import(${JSON.stringify(new URL("../src/db.js", import.meta.url).href)});
    const cols = db.db.prepare("PRAGMA table_info(invites)").all().map(c => c.name);
    const row = db.inviteByToken("${"a".repeat(32)}");
    console.log(JSON.stringify({ has: cols.includes("for_name"), for_name: row.for_name, state: row.state }));`;
  const outp = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, REASON_DB_PATH: old, REASON_DATA_DIR: join(dir, "old-data"), ANTHROPIC_API_KEY: "" }, encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(outp.trim().split("\n").at(-1)), { has: true, for_name: null, state: "unused" });
});
