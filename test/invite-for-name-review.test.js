// Review of the invite card name (who a link is for): real names keep their spelling, things that
// are not a name stay off the card however they are disguised, the name never reaches whoever joins
// by any of the ways in, and the offer is made once per go even when several links are asked for.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-invite-for-review-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = join(dir, "data");
process.env.REASON_OWNER_NAME = "Yaa";
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
const { cleanInviteeName, inviteCardHtml } = card;
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const KOFI = "+14155559876";
const KOFI_C = `dm:fake:${KOFI}`;
const NONAME_C = "dm:fake:+14155550111";

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  invites._resetAskedFor();
  db.db.exec("DELETE FROM accounts; DELETE FROM invites; DELETE FROM invite_allowances; DELETE FROM invite_requests;");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Yaa", isOperator: true });
  db.upsertAccount({ conversationId: KOFI_C, channel: "fake", address: KOFI, name: "Kofi" });
  db.upsertAccount({ conversationId: NONAME_C, channel: "fake", address: "+14155550111", name: "" });
  db.backfillInviteAllowances();
});

const tool = (name, input, c, extra = {}) => runTool(name, input, { conversationId: c, messages: [], ...extra });

test("real names keep their spelling, whatever they start with and whatever script they are in", () => {
  const kept = {
    Sonia: "Sonia", Mateo: "Mateo", Brooke: "Brooke", Mumtaz: "Mumtaz", Momo: "Momo", Palmer: "Palmer", Bronwyn: "Bronwyn",
    "Big Sean": "Big Sean", "Ji-won": "Ji-Won", "Seung-won": "Seung-Won", Win: "Win", "An Nguyen": "An Nguyen", "So Yeon": "So Yeon",
    "O'Brien": "O'Brien", "Nadia's": "Nadia's", "Mary-Kate": "Mary-Kate", José: "José", "Nguyễn An": "Nguyễn An",
    محمد: "محمد", 王伟: "王伟", 김지원: "김지원", प्रिया: "प्रिया", Иван: "Иван", Θεόδωρος: "Θεόδωρος", Łukasz: "Łukasz",
    "for my sister Ama": "Ama", "my friend, Kofi": "Kofi", "its for Kofi": "Kofi",
  };
  for (const [said, drawn] of Object.entries(kept)) assert.equal(cleanInviteeName(said), drawn, said);
});

test("not a name, however it is spelled: lookalike letters, small capitals, stacked marks, slurs, brands, a sentence in one word", () => {
  const refused = [
    "Ρay Νow", // Greek Rho and Nu inside Latin: "Pay Now"
    "Рау", // all Cyrillic, reads "Pay"
    "Sсam", "Idiоt", "ᴘᴀʏ ɴᴏᴡ", "ʎɐd",
    "Z̶̷̸a̶̷̸l̶̷̸g̶̷̸o",
    "Nigger", "Faggot", "Chink", "Niggerman",
    "Paypal", "Customer Service", "Text Back", "Visit Site", "Police", "Wells Fargo", "Coinbase", "Fedex", "Apple Support", "Your Bank",
    "Call Me", "Pay Now", "Free Money", "Five Five", "Nine One One", "A​ma", "Ama.com",
    "免费领取现金请点击", // nine Chinese characters: a sentence, not a name
  ];
  for (const s of refused) assert.equal(cleanInviteeName(s), "", JSON.stringify(s));
  for (const s of refused) assert.doesNotMatch(inviteCardHtml("Kofi", s), /class="for"/, JSON.stringify(s));
});

test("by the web setup or a texted code, the joiner's side never sees who the link was for", async () => {
  const RARE = "Zephyrine";
  const scan = () => {
    const hits = [];
    for (const { name } of db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      let rows;
      try { rows = db.db.prepare(`SELECT * FROM "${name}"`).all(); } catch { continue; }
      if (new RegExp(RARE, "i").test(JSON.stringify(rows))) hits.push(name);
    }
    return hits;
  };
  // The web setup: what it reads before the claim, and the claim itself.
  const a = invites.makeLink(KOFI_C, { forName: RARE });
  assert.equal(a.for, RARE);
  assert.deepEqual(scan(), ["invites"], "before a claim it is on the inviter's link row and nowhere else");
  const token = a.link.split("/").pop();
  const seen = invites.inviteForSetup(token);
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(RARE, "i"), "the setup screens are never handed it");
  const web = invites.claimForSetup({ inviteId: seen.id, channel: "fake", address: "+13475550001", name: "Dale" });
  assert.equal(web.joined, true);
  assert.doesNotMatch(JSON.stringify(web), new RegExp(RARE, "i"));
  assert.deepEqual(scan(), [], "gone from every table once claimed");
  // A texted code.
  const b = invites.makeLink(KOFI_C, { forName: RARE });
  const inv = db.getInvite(KOFI_C, b.number);
  const byText = invites.claimByText({ channel: "fake", address: "+13475550002", text: invites.joinText(inv.claim_code) });
  assert.equal(byText.joined, true);
  assert.doesNotMatch(JSON.stringify(byText), new RegExp(RARE, "i"), "nor the welcome or the inviter's note");
  assert.deepEqual(scan(), []);
  // A claimed link's card and page are plain, and "my invites" shows no name on it.
  assert.equal(invites.inviteCardFor(token).invitee, "");
  assert.doesNotMatch(JSON.stringify(invites.myInvites(KOFI_C)), new RegExp(RARE, "i"));
});

test("every way a claim can go, won or lost: nothing said or kept for the joiner carries the name, and the page names them only on the card", () => {
  const RARE = "Quillon";
  const has = (x) => new RegExp(RARE, "i").test(typeof x === "string" ? x : JSON.stringify(x ?? null));
  const tableHits = () => db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map(t => t.name).filter(t => { try { return has(db.db.prepare(`SELECT * FROM "${t}"`).all()); } catch { return false; } });
  const a = invites.makeLink(KOFI_C, { forName: RARE });
  const token = a.link.split("/").pop();
  // The page before a claim: the name is on the card picture (and its alt text) and nowhere in what the page says.
  const page = invites.inviteRequest({ token }).body;
  const [headPart, bodyPart] = page.split(/<\/head>/i);
  assert.ok(has(headPart), "the card's alt text says who it is for");
  assert.equal(has(bodyPart), false, "the page itself never names them");
  assert.equal(has(headPart.replace(/<meta property="og:image:alt"[^>]*>/, "")), false, "only the card's alt text does");
  const code = db.getInvite(KOFI_C, a.number).claim_code;
  // Somebody who already has an account texting the code: not spent, nothing named.
  db.upsertAccount({ conversationId: "dm:fake:+13475550009", channel: "fake", address: "+13475550009", name: "Mo" });
  const member = invites.claimByText({ channel: "fake", address: "+13475550009", text: invites.joinText(code) });
  assert.equal(has(member), false);
  assert.equal(has(invites.memberLine(db.getInvite(KOFI_C, a.number), "dm:fake:+13475550009")), false);
  // The winner, then a second person with the same code.
  const won = invites.claimByText({ channel: "fake", address: "+13475550010", text: invites.joinText(code) });
  assert.equal(won.joined, true);
  const lost = invites.claimByText({ channel: "fake", address: "+13475550011", text: invites.joinText(code) });
  assert.equal(lost.joined, false);
  assert.equal(has([won, lost, invites.inviteCardFor(token), invites.inviteRequest({ token }).body]), false);
  // A canceled named link, claimed by text and by the web setup.
  const c = invites.makeLink(KOFI_C, { forName: RARE });
  const cCode = db.getInvite(KOFI_C, c.number).claim_code;
  invites.cancelLink(KOFI_C, c.number, { replace: false });
  const byText = invites.claimByText({ channel: "fake", address: "+13475550012", text: invites.joinText(cCode) });
  const byWeb = invites.claimForSetup({ inviteId: c.number, channel: "fake", address: "+13475550013" });
  assert.equal(byText.joined, false);
  assert.equal(has([byText, byWeb, invites.myInvites(KOFI_C)]), false);
  assert.deepEqual(tableHits(), [], "no table keeps it once each link is claimed or canceled");
});

test("the card's cache key: an inviter name with a newline never reads as another inviter's card for somebody", () => {
  const { inviteCardKey } = card;
  assert.notEqual(inviteCardKey("Kofi\nfor:Ama"), inviteCardKey("Kofi", "Ama"));
  assert.notEqual(inviteCardKey("Kofi", "Ama"), inviteCardKey("Kofi", "Esi"));
  assert.notEqual(inviteCardKey("Kofi", "Ama"), inviteCardKey("Ama", "Kofi"));
});

test("their own name missing, the friend's given up front: one question, and the retry never adds the card offer", async () => {
  const first = await tool("invite_link_create", { for_name: "Dalen" }, NONAME_C);
  assert.equal(first.needs_name, true);
  assert.equal(first.needs_for, undefined);
  db.upsertAccount({ conversationId: NONAME_C, channel: "fake", address: "+14155550111", name: "Esi" });
  // The model forgot the for_name on the retry: a link anyway, never a second question.
  const again = await tool("invite_link_create", {}, NONAME_C);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.ok(again.link);
});

test("several links asked for in one reply: the offer once, and no plain links minted beside it until they answer", async () => {
  const turn1 = [];
  const one = await tool("invite_link_create", {}, KOFI_C, { turnActs: turn1 });
  assert.equal(one.needs_for, true);
  const two = await tool("invite_link_create", {}, KOFI_C, { turnActs: turn1 });
  assert.equal(two.already_offered, true);
  assert.equal(two.link, undefined);
  assert.equal(db.unusedInviteCount(KOFI_C), 0, "nothing made while the offer is out");
  // Their answer, in the next reply: one link per name, and a call without one is plain, never a second offer.
  const turn2 = [];
  const named = await tool("invite_link_create", { for_name: "Ama" }, KOFI_C, { turnActs: turn2 });
  assert.equal(named.for, "Ama");
  const plain = await tool("invite_link_create", {}, KOFI_C, { turnActs: turn2 });
  assert.equal(plain.ok, true, JSON.stringify(plain));
  assert.equal(plain.for, undefined);
});

test("after a restart forgets the offer: at most one more light offer, then a link, never a loop", async () => {
  const one = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(one.needs_for, true);
  invites._resetAskedFor(); // the process restarted
  const two = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(two.needs_for, true, "one more offer is the worst case");
  const three = await tool("invite_link_create", {}, KOFI_C);
  assert.equal(three.ok, true, "and the next call is a link");
});

test("two people on one link is a plain link with nothing stored", async () => {
  const out = await tool("invite_link_create", { for_name: "Kofi and Ama" }, KOFI_C);
  assert.equal(out.ok, true);
  assert.equal(out.for, undefined);
  assert.equal(out.plain_card, undefined);
  assert.equal(db.getInvite(KOFI_C, out.number).for_name, null);
});
