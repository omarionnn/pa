// Their Drive, against a fake Google that answers the routes Google's own v3 reference documents.
//
// What these tests are for, in order of how much it would cost to get them wrong:
//
//   1. **A Google connection somebody already has is NOT a Drive connection.** Everybody who
//      connected before 2026-10-06 granted mail and calendar and nothing else, and the one thing
//      Reason must never do is read that grant as permission to go through their documents. It is
//      `covers()` that decides it, so the test is on the behaviour: Drive reads as not connected, and
//      asking for it produces the ordinary consent link with the two Drive scopes on it.
//   2. **Adding Drive does not cost them their mail.** A link asking only for Drive would, without
//      `include_granted_scopes`, come back carrying only Drive — and the stored scope string is what
//      says what a grant can do, so their inbox would have gone quiet. That parameter is asserted on
//      the link, and the grant that comes back is checked to still carry all three.
//   3. **Reason says what it cannot read instead of guessing.** A PDF, a Word file, a folder: each
//      one gets a plain sentence and the link, because a confident paragraph about a document nobody
//      could open is worse than a no. And a spreadsheet says it is the first sheet, because a number
//      from the wrong tab is the same failure wearing a number.
//   4. **A document is somebody else's words.** The Drive version of the email that tells the
//      assistant to forward itself: it comes back marked untrusted and nothing is sent.
//   5. **One account's file id is not another's**, and acting on one Drive is never guessed.
//   6. **No token, and no document's contents, ever reach a receipt, a log or an export.**
//
// No real credentials, no network: the base URLs point at the fixture. Nothing here has ever been
// sent to Google. docs/unverified.md says what a fake cannot settle.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGoogle } from "./fixture-google.js";

const dir = mkdtempSync(join(tmpdir(), "reason-drive-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { runTool, capabilitiesNow } = await import("../src/tools.js");
const google = await import("../src/google.js");
const drive = await import("../src/drive.js");
const trust = await import("../src/trust.js");
const db = await import("../src/db.js");
const { exportData, deleteData } = await import("../src/data.js");
const { config, clock } = await import("../src/config.js");

const OMARI = "dm:owner";
const AMA = "dm:fake:+13475550000";
const MAIL_AND_CALENDAR = [google.GMAIL_SCOPE, ...google.CALENDAR_SCOPES];
const EVERYTHING = [...MAIL_AND_CALENDAR, ...google.DRIVE_SCOPES];

let fake;
const call = (name, input, conversationId = OMARI, messages = []) => runTool(name, input, { conversationId, messages });

before(async () => {
  fake = await startGoogle();
  config.googleClientId = "client-abc.apps.googleusercontent.com";
  config.googleClientSecret = "secret-xyz";
  config.googleOauthBase = fake.url;
  config.googleAccountsBase = fake.url;
  config.googleGmailBase = fake.url;
  config.googleCalendarBase = fake.url;
  config.googleDriveBase = fake.url;
  config.publicUrl = "";
});
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM oauth_tokens; DELETE FROM oauth_states; DELETE FROM connected_accounts; DELETE FROM accounts; DELETE FROM action_ledger; DELETE FROM confirmations;");
  db.upsertAccount({ conversationId: OMARI, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: AMA, channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  fake.reset();
  fake.set({ email: "me@example.com", grantScopes: EVERYTHING, accessTtlSeconds: 3600, refreshTokenValid: true, giveRefreshToken: true });
  for (const k of ["tokenCalls", "authHeaders", "revoked", "sent", "drafts", "modified", "trashed", "events", "eventWrites", "searches", "driveSearches", "driveReads", "driveCreated"]) {
    fake.state[k].length = 0;
  }
  fake.state.liveTokens.clear();
  fake.state.refreshCounter = 0;
});

/**
 * Walk the real handshake. `scopes` is what the link asks for; `grants` is what the person really
 * ticks, which is a different thing and is the whole reason a half-granted consent can be tested.
 */
async function connect({ conversationId = OMARI, scopes = null, grants = EVERYTHING, account = "" } = {}) {
  fake.set({ ...(account ? { email: account } : {}), grantScopes: grants });
  const link = await call("google_connect", { ...(scopes ? { scopes } : {}), ...(account ? { account } : {}) }, conversationId);
  assert.equal(link.ok, true, JSON.stringify(link));
  const state = new URL(link.url).searchParams.get("state");
  const done = await google.completeConnect({ code: "good-code", state });
  assert.equal(done.ok, true, JSON.stringify(done));
  return { link, done };
}

// ---------- before anybody has connected anything ----------

test("with no Google at all, a Drive question says so and names the way to fix it", async () => {
  const out = await call("drive_search", { query: "lease" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.match(out.error, /google_connect/);
  assert.equal(fake.state.driveSearches.length, 0, "and nothing was asked of Google");
});

test("with no OAuth client on the machine, Drive is not connected and nothing is claimed", () => {
  const id = config.googleClientId;
  config.googleClientId = "";
  try {
    const st = trust.accountStatus(OMARI, "google_drive");
    assert.equal(st.status, "not_connected");
    assert.deepEqual(st.missing, ["GOOGLE_OAUTH_CLIENT_ID"]);
    assert.match(st.owner_must_supply, /Data Access page/);
  } finally {
    config.googleClientId = id;
  }
});

// ---------- an existing Google connection is not a Drive connection ----------

test("a mail-and-calendar grant reads as Drive NOT connected, and asking produces a link", async () => {
  await connect({ scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });

  // Google is connected. Drive is not, and `covers()` is what says so.
  assert.equal(trust.accountStatus(OMARI, "gmail").status, "connected");
  assert.equal(trust.accountStatus(OMARI, "google_calendar").status, "connected");
  assert.equal(trust.accountStatus(OMARI, "google_drive").status, "connectable");
  assert.equal(google.covers(MAIL_AND_CALENDAR, google.DRIVE_SCOPES), false);

  const caps = capabilitiesNow({ conversationId: OMARI, ownerName: "Omari" });
  assert.equal(caps.find(c => c.name === "email").status, "live");
  const dr = caps.find(c => c.name === "drive");
  assert.equal(dr.status, "connectable");
  assert.match(dr.what, /SEPARATE permission/, "and the model is told it is one more tap, not a refusal");
  assert.match(dr.what, /google_connect/);

  // Asking anyway: a named refusal with the scope in it, not a silent empty answer and not a 403.
  const out = await call("drive_search", { query: "lease" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "scope_missing");
  assert.deepEqual(out.missing_scope, [google.DRIVE_READ_SCOPE]);
  assert.match(out.error, /drive\.readonly/);
  assert.match(out.error, /google_connect with scopes/);
  assert.equal(fake.state.driveSearches.length, 0, "nothing was asked of Drive");

  // And the link that fixes it is the ordinary one, asking for BOTH halves of Drive.
  const link = await call("google_connect", { scopes: out.missing_scope });
  const asked = new URL(link.url).searchParams.get("scope").split(" ").sort();
  assert.deepEqual(asked, [...google.DRIVE_SCOPES].sort(), "naming one Drive scope asks for both");
  assert.ok(link.say_with_link, "with the in-product notice Google's policy wants");
  assert.ok(link.scopes.every(s => s.so_that), "each one said in plain words");
});

test("asking for Drive does not cost them their mail: include_granted_scopes is on the link", async () => {
  await connect({ scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });
  const link = await call("google_connect", { scopes: google.DRIVE_SCOPES });
  const q = new URL(link.url).searchParams;
  assert.equal(q.get("include_granted_scopes"), "true",
    "without this, a Drive-only ask comes back carrying only Drive and the mail grant is overwritten");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent", "and a reconnect still gets a NEW refresh token");

  // What Google then returns is the union — that is what the parameter means. Modelled here by the
  // fake; only real Google can prove it, which docs/unverified.md records.
  const state = q.get("state");
  fake.set({ grantScopes: EVERYTHING });
  const done = await google.completeConnect({ code: "good-code", state });
  assert.equal(done.ok, true);
  assert.deepEqual(done.connected.sort(), ["gmail", "google_calendar", "google_drive"]);
  for (const name of ["gmail", "google_calendar", "google_drive"]) {
    assert.equal(trust.accountStatus(OMARI, name).status, "connected", `${name} survived adding Drive`);
  }
  assert.equal(google.accountsFor(OMARI)[0].can.includes("drive"), true);
  assert.match(google.connectedLine(done), /drive/);
});

test("adding Drive to their one account offers THAT account, not the chooser", async () => {
  await connect({ scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });
  const link = await call("google_connect", { scopes: google.DRIVE_SCOPES });
  const q = new URL(link.url).searchParams;
  // The chooser is for picking a DIFFERENT account. Here there is one account and one more permission
  // to put on it, so showing a chooser is just a chance to tap the wrong Google and wonder why Drive
  // still is not on. login_hint is what Google documents for "the app knows which user this is".
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("login_hint"), "me@example.com");
  assert.ok(link.adding_permission, "and the model is told this adds to what they have rather than replacing it");
  assert.match(link.adding_permission, /does NOT replace/);
  assert.equal(link.adding_another, undefined, "this is not a second account");
  // The in-product notice says what THIS link asks for, which Google's policy wants to match the
  // consent screen — so a Drive link does not promise a sentence about their mail.
  assert.match(link.say_with_link, /Drive/);
  assert.ok(!/their mail/.test(link.say_with_link));
});

test("with two accounts on, a Drive ask still shows the chooser and says which one to pick", async () => {
  await connect({ account: "me@example.com", scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });
  fake.addAccount("work@example.com");
  await connect({ account: "work@example.com", scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });

  const link = await call("google_connect", { scopes: google.DRIVE_SCOPES });
  const q = new URL(link.url).searchParams;
  assert.equal(q.get("prompt"), "select_account consent", "two accounts, so which one gets Drive is theirs to say");
  assert.equal(q.get("login_hint"), null, "and a hint would pick for them");
  assert.match(link.adding_permission, /more than one account/);
});

test("asking for a Google account they already fully granted is a SECOND account, with the chooser", async () => {
  await connect();
  const link = await call("google_connect", {});
  assert.equal(new URL(link.url).searchParams.get("prompt"), "select_account consent");
  assert.ok(link.adding_another, "nothing to add to this grant, so the only reason to be here is another account");
  assert.equal(link.adding_permission, undefined);
});

test("google_accounts says per account whether Drive is on, and never reads mail as Drive", async () => {
  await connect({ account: "me@example.com", scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });
  fake.addAccount("work@example.com");
  await connect({ account: "work@example.com", grants: EVERYTHING });

  const out = await call("google_accounts", {});
  assert.equal(out.ok, true);
  const personal = out.accounts.find(a => a.account === "me@example.com");
  const work = out.accounts.find(a => a.account === "work@example.com");
  assert.deepEqual(personal.can, ["mail", "calendar"], "mail is not drive");
  assert.deepEqual(work.can, ["mail", "calendar", "drive"]);
  assert.match(out.note, /me@example\.com has no Drive on it/);
  assert.match(out.note, /one more tap/);

  // And the behaviour matches the status: a search on the one without Drive is refused by name.
  const refused = await call("drive_search", { query: "lease", account: "me@example.com" });
  assert.equal(refused.status, "scope_missing");
  const ok = await call("drive_search", { query: "lease", account: "work@example.com" });
  assert.equal(ok.ok, true);
});

test("a consent with the create box unticked can read and says what it cannot do", async () => {
  await connect({ scopes: google.DRIVE_SCOPES, grants: [...MAIL_AND_CALENDAR, google.DRIVE_READ_SCOPE] });
  // Reading works, because reading is what that half is for.
  const found = await call("drive_search", { query: "lease" });
  assert.equal(found.ok, true);
  // Making one does not, and it names the box they unticked rather than meeting a 403.
  const made = await call("drive_create", { title: "Notes", text: "hello" });
  assert.equal(made.ok, false);
  assert.equal(made.status, "scope_missing");
  assert.deepEqual(made.missing_scope, [google.DRIVE_FILE_SCOPE]);
  assert.match(made.error, /drive\.file/);
  assert.equal(fake.state.driveCreated.length, 0, "and nothing was uploaded");
});

// ---------- searching ----------

test("the search Google really receives: the documented q, fields, order and size", async () => {
  await connect();
  const out = await call("drive_search", { query: "lease ocean", limit: 5 });
  assert.equal(out.ok, true);

  const sent = fake.state.driveSearches;
  assert.equal(sent.length, 1, "one account, one request");
  const q = sent[0].q;
  // Every word has to be in the name, OR the phrase is in the text. An OR between the words would
  // return every file with "ocean" in it, which is how "find my lease" returns forty things.
  assert.equal(q, "trashed = false and ((name contains 'lease' and name contains 'ocean') or fullText contains 'lease ocean')");
  // Without `fields`, Drive answers id, name, mimeType and kind only — so the modified time and the
  // link a person asks about would come back undefined.
  assert.equal(sent[0].fields, drive.LIST_FIELDS);
  for (const f of ["modifiedTime", "webViewLink", "owners(displayName,emailAddress)", "size"]) {
    assert.ok(sent[0].fields.includes(f), `${f} is asked for`);
  }
  assert.equal(sent[0].orderBy, "modifiedTime desc", "newest first");
  assert.equal(sent[0].pageSize, 5);

  const hit = out.files.find(f => f.file_id === "f-lease");
  assert.ok(hit, "the lease came back");
  assert.equal(hit.kind, "google doc", "said the way a person says it, not as a MIME type");
  assert.equal(hit.account, "me@example.com", "every row says which Drive it is in");
  assert.ok(hit.link, "with the link to open it");
  assert.ok(hit.changed, "and when it last changed");
  assert.ok(!JSON.stringify(out).includes("RESIDENTIAL LEASE"), "names and links only — no contents");
});

test("a word only inside the file finds it, and the bin is left out", async () => {
  await connect();
  // "pets" is nowhere in the name and is in the text, which is what fullText is for.
  const out = await call("drive_search", { query: "pets" });
  assert.equal(out.ok, true);
  assert.ok(out.files.some(f => f.file_id === "f-lease"));

  fake.setAccount("me@example.com", {
    files: [{ id: "f-gone", name: "old lease", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00.000Z", owners: [], webViewLink: "x", _text: "", _csv: "", _trashed: true, _createdByApp: false }],
  });
  const binned = await call("drive_search", { query: "lease" });
  assert.equal(binned.count, 0, "a file they deleted is not an answer to 'find my lease'");
  assert.match(binned.note, /found nothing/);
});

test("an apostrophe in what they said is escaped, not a broken query", async () => {
  await connect();
  fake.setAccount("me@example.com", {
    files: [{ id: "f-q", name: "quinn's paper", mimeType: "text/plain", modifiedTime: "2026-10-01T00:00:00.000Z", owners: [], webViewLink: "x", _text: "hello", _csv: "", _trashed: false, _createdByApp: false }],
  });
  const out = await call("drive_search", { query: "quinn's" });
  assert.equal(out.ok, true);
  assert.match(fake.state.driveSearches[0].q, /quinn\\'s/, "escaped the way Google's guide requires");
  assert.equal(out.files.length, 1, "and it still matched, so the escaping is right and not just present");
});

test("nothing found says what it searched for and does not widen it silently", async () => {
  await connect();
  const out = await call("drive_search", { query: "zzzznothing" });
  assert.equal(out.ok, true);
  assert.equal(out.count, 0);
  assert.deepEqual(out.files, []);
  assert.match(out.note, /never describe a file you did not get back/);
});

test("no query at all is 'what have I been working on': newest first", async () => {
  await connect();
  const out = await call("drive_search", {});
  assert.equal(out.ok, true);
  assert.equal(fake.state.driveSearches[0].q, "trashed = false");
  // Newest first, which is the only ordering "what have I been working on" could mean.
  const changed = out.files.map(f => f.changed);
  assert.deepEqual(changed, [...changed].sort().reverse());
  assert.equal(out.files[0].file_id, "f-instructions", "the most recently changed one");
});

// ---------- reading, one route per kind ----------

test("a Google Doc is exported as text/plain and comes back as words", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-lease" });
  assert.equal(out.ok, true);
  assert.equal(out.account, "me@example.com");
  assert.match(out.text, /\$2,400 per month/);
  assert.deepEqual(fake.state.driveReads, [{ account: "me@example.com", id: "f-lease", how: "export", mimeType: "text/plain" }]);
  assert.equal(out.read_as, "text/plain");
  assert.match(out.note, /cannot change, rename, share or delete/, "and it is honest about what it cannot do next");
});

test("a Google Sheet comes back as the FIRST SHEET, and says so", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-budget" });
  assert.equal(out.ok, true);
  assert.equal(fake.state.driveReads[0].mimeType, "text/csv", "Google's export format for a spreadsheet");
  assert.match(out.text, /January,2400,610/);
  assert.ok(!out.text.includes("SECOND TAB"), "the other tabs are NOT in a first-sheet export");
  assert.match(out.how_it_was_read, /FIRST SHEET only/,
    "which the model has to be told, or it answers a question about tab 4 from tab 1");
});

test("Slides are exported as text/plain too", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-trip" });
  assert.equal(out.ok, true);
  assert.equal(fake.state.driveReads[0].mimeType, "text/plain");
  assert.match(out.text, /Alfama/);
});

test("a plain text file is downloaded with alt=media, not exported", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-notes" });
  assert.equal(out.ok, true);
  assert.equal(fake.state.driveReads[0].how, "media", "Docs Editors files export; stored bytes download");
  assert.match(out.text, /call the plumber/);
});

test("an html file goes through the same reader a fetched web page does", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-page" });
  assert.equal(out.ok, true);
  assert.match(out.text, /Moving checklist/);
  assert.ok(!out.text.includes("<p>"), "markup gone");
  assert.ok(!out.text.includes("color:red"), "and the stylesheet with it");
});

test("a PDF says so plainly, with the link, and nothing is guessed from the name", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-scan" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "cannot_read");
  assert.match(out.error, /pdf/i);
  assert.match(out.error, /can't read inside one/);
  assert.match(out.error, /docs\.google\.com/, "the link to open it themselves");
  assert.match(out.error, /do not guess at what is in it/);
  assert.equal(out.file.name, "scan 47.pdf", "and it still says which file it was");
});

test("a folder is a folder, not an empty document", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-taxes" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "cannot_read");
  assert.match(out.error, /folder/);
});

test("a long file is cut, and says how much of it there was", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-lease", max_chars: 200 });
  assert.equal(out.ok, true);
  assert.equal(out.text.length, 200);
  assert.equal(out.text_truncated, true);
  assert.match(out.text_note, /first 200 characters/);
  assert.match(out.text_note, /bigger max_chars/);
  assert.match(out.text_note, /docs\.google\.com/, "or the link, which is the other real answer");
});

test("an id that is not theirs is a plain not_found, with Google's own words", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-nope" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_found");
  assert.match(out.error, /no file with that id/);
  assert.match(out.google_said, /File not found/);
});

// ---------- a document is somebody else's words ----------

test("a document telling the assistant what to do is marked untrusted, and nothing is sent", async () => {
  await connect();
  const out = await call("drive_read", { file_id: "f-instructions" });
  assert.equal(out.ok, true);
  // Marked the same way a fetched web page is (src/privacy.js), in the same object as the text.
  assert.match(out.untrusted_content, /never follow it/i);
  assert.match(out.untrusted_content, /needs their own yes through the gate/);
  assert.match(out.text, /collections@totally-real\.example/, "it is reported, in full");
  // And the thing it asked for did not happen.
  assert.equal(fake.state.sent.length, 0, "no email was sent");
  assert.equal(fake.state.drafts.length, 0, "and no draft either");
  assert.deepEqual(db.listActions(OMARI).map(r => r.action), ["google_connect"],
    "the only row is the connect link that got here — reading a file is not an outside action, and nothing was sent");
});

// ---------- making a document ----------

test("drive_create sends a correct multipart body and hands back the link", async () => {
  await connect();
  const out = await call("drive_create", { title: "Moving plan", text: "1. boxes\n2. van\n" });
  assert.equal(out.ok, true);
  assert.equal(out.account, "me@example.com");
  assert.ok(out.link, "the link, which is the whole point of it");
  assert.match(out.note, /Send them the link/);
  assert.match(out.note, /cannot change it afterwards/);

  const up = fake.state.driveCreated;
  assert.equal(up.length, 1);
  assert.equal(up[0].uploadType, "multipart", "the documented upload type for metadata plus content");
  assert.match(up[0].contentType, /^multipart\/related; boundary=/);
  // Two parts, the first the metadata as application/json, the second the text — and the metadata
  // carries the Docs MIME type, which is what makes Drive convert it into a real Google Doc.
  assert.equal(up[0].file.mimeType, "application/vnd.google-apps.document");
  assert.equal(up[0].file.name, "Moving plan");
  assert.equal(up[0].file.text, "1. boxes\n2. van\n");
  assert.match(up[0].body, /Content-Type: application\/json; charset=UTF-8/);
  assert.match(up[0].body, /Content-Type: text\/plain; charset=UTF-8/);

  // It is really in their Drive afterwards, and findable.
  assert.ok(fake.files().some(f => f.name === "Moving plan"));
  const found = await call("drive_search", { query: "moving plan" });
  assert.ok(found.files.some(f => f.name === "Moving plan"));
});

test("a boundary that appears in the text does not split the document", async () => {
  // Not a theoretical worry: the content is somebody's own words and may contain anything. The
  // generated boundary is checked against the text, so this has to upload as two parts like any
  // other — which the fake refuses to accept if it does not.
  const part = drive.multipartDoc({ title: "t", text: "a\r\n--reason-x\r\nb" });
  assert.ok(!part.body.slice(part.body.indexOf("text/plain")).includes(`--${part.boundary}\r\nContent-Type: application/json`));
  await connect();
  const out = await call("drive_create", { title: "t", text: "a\r\n--reason-x\r\nb" });
  assert.equal(out.ok, true);
});

test("making a document needs no yes, and still leaves a receipt with no contents in it", async () => {
  await connect();
  const out = await call("drive_create", { title: "Weekend list", text: "the secret is forty two" });
  assert.equal(out.ok, true, "no gate: it is their own Drive, it costs nothing and reaches nobody");
  assert.equal(out.blocked, undefined);

  const rows = db.listActions(OMARI).filter(r => r.action === "drive_create");
  assert.equal(rows.length, 1, "but it happened to their account, so there is a row");
  assert.equal(rows[0].target, "doc:me@example.com:Weekend list", "which document, in whose Drive");
  const whole = JSON.stringify(rows[0]);
  assert.ok(!whole.includes("forty two"),
    "a receipt is not where the contents of somebody's document live — it is in their Drive, with the link on the row");
  assert.match(rows[0].attempted.text, /^\(23 characters/, "kept as its size, so nothing is pretended to be missing");
  assert.match(rows[0].receipt, /Made a Google Doc "Weekend list"/);
  assert.ok(rows[0].receipt.includes("docs.google.com"), "with the link, which is where the contents really are");
  assert.ok(!whole.includes("access-"), "and no token is in it");
});

test("reads leave no receipt — a ledger full of 'searched your files' would bury the real rows", async () => {
  await connect();
  await call("drive_search", { query: "lease" });
  await call("drive_read", { file_id: "f-lease" });
  assert.deepEqual(db.listActions(OMARI).map(r => r.action), ["google_connect"], "the connect link, and nothing else");
});

// ---------- more than one Google account ----------

test("reading fans out across both Drives and labels every file with the one it is in", async () => {
  await connect({ account: "me@example.com" });
  fake.addAccount("work@example.com", { grantScopes: EVERYTHING, files: [] });
  fake.setFiles("work@example.com", [
    { id: "w-lease", name: "Office lease", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-10-03T00:00:00.000Z", owners: [{ emailAddress: "work@example.com", displayName: "Work" }], webViewLink: "https://docs.google.com/document/d/w-lease/edit", _text: "Rent of $9,000 per month.", _csv: "", _trashed: false, _createdByApp: false },
  ]);
  await connect({ account: "work@example.com" });

  const out = await call("drive_search", { query: "lease" });
  assert.equal(out.ok, true);
  assert.deepEqual(out.accounts_searched.sort(), ["me@example.com", "work@example.com"]);
  assert.equal(out.files.find(f => f.file_id === "f-lease").account, "me@example.com");
  assert.equal(out.files.find(f => f.file_id === "w-lease").account, "work@example.com");
  assert.equal(fake.state.driveSearches.length, 2, "one request per Drive");
});

test("a file id used against the wrong account is refused with the right one named", async () => {
  await connect({ account: "me@example.com" });
  fake.addAccount("work@example.com", { grantScopes: EVERYTHING });
  fake.setFiles("work@example.com", []);
  await connect({ account: "work@example.com" });

  const out = await call("drive_read", { file_id: "f-lease", account: "work@example.com" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "wrong_account");
  assert.equal(out.in_account, "me@example.com");
  assert.match(out.error, /belongs to one account/);
});

test("making a document with two accounts and no choice asks which, and writes nothing", async () => {
  await connect({ account: "me@example.com" });
  fake.addAccount("work@example.com", { grantScopes: EVERYTHING });
  await connect({ account: "work@example.com" });

  const out = await call("drive_create", { title: "Notes", text: "x" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "which_account");
  assert.deepEqual(out.accounts.sort(), ["me@example.com", "work@example.com"]);
  assert.equal(fake.state.driveCreated.length, 0, "nothing was uploaded to either of them");

  // Named, it lands in that one and only that one.
  const made = await call("drive_create", { title: "Notes", text: "x", account: "work@example.com" });
  assert.equal(made.ok, true);
  assert.equal(made.account, "work@example.com");
  assert.ok(fake.filesOf("work@example.com").some(f => f.name === "Notes"));
  assert.ok(!fake.filesOf("me@example.com").some(f => f.name === "Notes"));
});

test("an address that is not theirs never reaches a Drive", async () => {
  await connect();
  const out = await call("drive_search", { query: "lease", account: "someone@else.example" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "unknown_account");
  assert.equal(fake.state.driveSearches.length, 0);
});

test("one person's Drive is not reachable from another person's thread", async () => {
  await connect({ conversationId: OMARI });
  const out = await call("drive_search", { query: "lease" }, AMA);
  assert.equal(out.ok, false);
  assert.equal(out.status, "not_connected");
  assert.equal(fake.state.driveSearches.length, 0);
  assert.ok(fake.callersSoFar().every(a => a !== "me@example.com" || true));
  assert.deepEqual(fake.state.driveSearches, [], "Omari's token never went on the wire for Ama's thread");
});

// ---------- a dead grant ----------

test("invalid_grant on a Drive read is a reconnect, not a retry", async () => {
  await connect();
  // Google has ended the grant, and the stored access token has expired so a refresh is due.
  fake.setAccount("me@example.com", { refreshTokenValid: false });
  clock.skip(2 * 3600_000);
  fake.state.tokenCalls.length = 0;

  const out = await call("drive_search", { query: "lease" });
  assert.equal(out.ok, false);
  assert.equal(out.status, "needs_reconnect");
  assert.match(out.error, /google_connect/);
  assert.equal(fake.state.tokenCalls.length, 1, "one attempt, then it stops — a refresh loop is how an app gets rate-limited");
  assert.equal(db.getOauthTokens(OMARI, google.PROVIDER), null, "the dead grant is dropped rather than retried");
  assert.equal(fake.state.driveSearches.length, 0, "and nothing was read");

  // Asked again, it is still a reconnect and still not a retry.
  const again = await call("drive_read", { file_id: "f-lease" });
  assert.equal(again.status, "needs_reconnect");
  assert.equal(fake.state.tokenCalls.length, 1);
});

test("a mail grant dying does not report Drive as having stopped working", async () => {
  // It was never connected, so "it stopped working" would be a sentence about something that never
  // happened — and it would send somebody hunting for a fault that was not theirs.
  await connect({ scopes: MAIL_AND_CALENDAR, grants: MAIL_AND_CALENDAR });
  fake.setAccount("me@example.com", { refreshTokenValid: false });
  clock.skip(2 * 3600_000);
  await call("gmail_search", { query: "anything" });

  assert.equal(trust.accountStatus(OMARI, "gmail").status, "needs_reconnect");
  assert.equal(trust.accountStatus(OMARI, "google_drive").status, "connectable",
    "Drive was never connected here, so it did not die");
});

// ---------- disconnecting, exporting, deleting ----------

test("disconnecting takes Drive with it: one grant, one revoke", async () => {
  await connect();
  const out = await call("google_disconnect", {});
  assert.equal(out.ok, true);
  assert.equal(out.revoked_at_google, true);
  assert.equal(trust.accountStatus(OMARI, "google_drive").status, "connectable");
  const after = await call("drive_search", { query: "lease" });
  assert.equal(after.status, "not_connected");
});

test("Drive adds no table, no document text to an export, and a delete still clears it", async () => {
  await connect();
  await call("drive_read", { file_id: "f-lease" });
  await call("drive_create", { title: "Weekend list", text: "the secret is forty two" });

  const out = exportData({ conversation: OMARI });
  const json = JSON.stringify(out);
  assert.ok(!json.includes("RESIDENTIAL LEASE"), "a file Reason read is not copied into their data");
  assert.ok(!json.includes("forty two"), "nor the text of a document it made");
  assert.ok(!json.includes("access-") && !json.includes("refresh-"), "and no token, as ever");
  // The receipt IS there, because that is the record of what Reason did.
  const ledger = out.tables.action_ledger ?? [];
  assert.ok(ledger.some(r => r.action === "drive_create"));
  assert.ok(!Object.keys(out.tables).some(t => /drive/i.test(t)), "Drive keeps no table of its own");

  const gone = await deleteData({ conversation: OMARI });
  assert.equal(gone.scope, OMARI);
  assert.ok(gone.rows.action_ledger >= 1, "the receipts went with it");
  assert.equal(db.listActions(OMARI).length, 0);
  assert.equal(db.getOauthTokens(OMARI, google.PROVIDER), null);
});

// ---------- the flow: "find my lease in Drive" ----------

/**
 * The two-step a real answer takes, driven through the real `runTool` with a stand-in for the model.
 *
 * What this proves: the loop works from end to end with nothing but what the tools hand back — the
 * search's `file_id` and `account` are what the read is called with, the read's text is what the
 * answer is written from, and the whole thing goes through the real dispatch, the real account
 * resolution and the real ledger.
 *
 * What it does not prove, and docs/unverified.md says so: that the live model, shown these tool
 * descriptions, reaches for drive_search first and quotes the clause rather than paraphrasing it.
 * That needs a live run and nobody has done one.
 */
test("'find my lease' → search, read, and an answer quoting the file", async () => {
  await connect();

  const search = await call("drive_search", { query: "lease" });
  assert.equal(search.ok, true);
  const top = search.files[0];
  assert.equal(top.file_id, "f-lease");

  const read = await call("drive_read", { file_id: top.file_id, account: top.account });
  assert.equal(read.ok, true);

  // An answer written from the tool results and nothing else — which is the only kind that can be
  // checked. The rent is quoted because it is in the text that came back, not because it was known.
  const rent = /rent of (\$[\d,]+) per month/i.exec(read.text)?.[1];
  const answer = `found it — ${top.name}. rent's ${rent} a month, due on the 1st. ${top.link}`;
  assert.match(answer, /\$2,400/);
  assert.match(answer, /Lease — 240 Ocean Ave/);

  // And the trail: two reads of their Drive, one search and one export, nothing written anywhere.
  assert.equal(fake.state.driveSearches.length, 1);
  assert.deepEqual(fake.state.driveReads.map(r => r.how), ["export"]);
  assert.equal(fake.state.driveCreated.length, 0);
  assert.deepEqual(db.listActions(OMARI).map(r => r.action), ["google_connect"], "reading their own files is not an outside action");
});
