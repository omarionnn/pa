// The home page and the privacy policy, over a real socket.
//
// Google will not publish a consent screen without both of these at addresses anybody can open, so
// what is under test is narrow and worth being exact about:
//
//   1. **They answer 200 to a stranger**, with no link, no code and no cookie.
//   2. **They have not shadowed anything.** Two exact paths were added to a server whose other routes
//      are prefixes and regexes, and a `/` that swallowed `/p/{id}` or a webhook would break Reason
//      quietly. Every existing route is checked to still answer as it did.
//   3. **The privacy page says the things that are true and easy to leave out.** Mail text being in
//      the transcript, and the conversation going to Anthropic, are the two facts somebody would
//      assume are not true — and the Limited Use sentence is what Google's policy asks for.
//   4. **Nothing of anybody's is on either page.** They are the same for every reader.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-site-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_DATA_DIR = dir;
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_SITE_URL = "https://site.example.test/";

const { createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const db = await import("../src/db.js");
const { config } = await import("../src/config.js");

const C = config.ownerConversation;
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

let server;
let base;
before(async () => {
  server = createServer({ router: new Router({ log: () => {} }), runtime: null, log: () => {} });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const get = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text(), headers: res.headers };
};

// ---------- they answer ----------

test("a stranger with no link and no code gets the home page", async () => {
  const out = await get("/");
  assert.equal(out.status, 200);
  assert.match(out.type, /text\/html/);
  assert.match(out.body, /Reason/);
  assert.match(out.body, /Your personal concierge/);
  assert.doesNotMatch(out.body, /lives in your texts/i);
  // The two promises the home page is for: nobody hands over a password, and nothing reaches
  // somebody else without being asked.
  assert.match(out.body, /never asks for a password/i);
  assert.match(out.body, /stops and asks/i);
  assert.match(out.body, /\/privacy/, "and it points at the policy, which Google needs linked");
});

test("the privacy page answers too, and is a real page rather than a stub", async () => {
  const out = await get("/privacy");
  assert.equal(out.status, 200);
  assert.match(out.type, /text\/html/);
  assert.ok(out.body.length > 4000, "a privacy policy that fits in a tweet is not one");
  assert.match(out.body, /Privacy/);
});

test("both are public and say they may be indexed, unlike everything made for one person", async () => {
  for (const p of ["/", "/privacy"]) {
    const out = await get(p);
    assert.match(out.body, /<meta name="robots" content="index,follow">/, p);
    assert.match(out.headers.get("cache-control") ?? "", /public/, p);
  }
  // A page made for somebody is still kept out of search engines.
  const { renderPage } = await import("../src/pages/render.js");
  const made = renderPage({ title: "Gift ideas", blocks: [], revision: 1, created_at: Date.now(), shared: false }, {});
  assert.match(made, /noindex/);
});

test("HEAD works, which is what a reviewer's checker may send", async () => {
  for (const p of ["/", "/privacy"]) {
    const res = await fetch(`${base}${p}`, { method: "HEAD" });
    assert.equal(res.status, 200, p);
  }
});

// ---------- the policy is true to the code ----------

test("the policy names what is really stored, from the tables that really exist", async () => {
  const { body } = await get("/privacy");
  for (const [what, pattern] of [
    ["the transcript", /transcript/i],
    ["the 60-message window", /60 messages/],
    ["plans and reminders", /Plans, reminders/i],
    ["the action ledger", /receipt for every action/i],
    ["connected accounts and their tokens", /tokens that make them work/i],
    ["call recordings on disk", /recordings as files/i],
  ]) {
    assert.match(body, pattern, what);
  }
  // And the window it names is the window the code uses.
  // Both backends keep the window src/thread.js names (the CLI path kept everything until 2026-10-18).
  const { THREAD_KEEP } = await import("../src/thread.js");
  assert.equal(THREAD_KEEP, 60, "if this changes, the number on the privacy page has to change with it");
});

test("the policy admits the two things somebody would assume were not true", async () => {
  const { body } = await get("/privacy");
  // Mail text is in the transcript, because tool results are saved with it.
  assert.match(body, /the text of that email or event is in the transcript/i);
  // And the conversation goes to the model provider, because that is how it is read at all.
  assert.match(body, /sends your conversation to Anthropic/i);
  assert.match(body, /There is no model on the machine/i);
});

test("the policy carries Google's Limited Use statement word for word", async () => {
  const { body } = await get("/privacy");
  assert.match(body, /Reason(?:'|&#39;)s use and transfer of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements\./);
  // And the four things that commitment actually means, in words somebody can check.
  assert.match(body, /never sold/i);
  assert.match(body, /never used for advertising/i);
  assert.match(body, /never used to train or improve any AI model/i);
  assert.match(body, /no human reads it/i);
});

test("the Google user data section says what is accessed, why, storage, retention and how to leave (2026-11-11)", async () => {
  const { body } = await get("/privacy");
  assert.match(body, /Google user data/);
  // What: calendar, Drive files Reason made or they opened with it, identity — and Gmail only when asked.
  assert.match(body, /Reason asks for your calendar, for the Google Drive files it makes for you or that you open with it, and for your Google email address and name/);
  assert.match(body, /It does not ask for your whole Drive/);
  assert.match(body, /Gmail is asked for separately, on its own Google screen, and only the first time you ask Reason to do something with your mail/);
  assert.match(body, /cannot create, share or delete a whole calendar/i);
  assert.match(body, /cannot delete mail permanently/i);
  assert.match(body, /It cannot see or open the rest of your Drive/);
  // Sign-in codes, only when asked.
  assert.match(body, /reads a sign-in code from your Gmail only when you ask it to sign you in somewhere/);
  // Why, storage, retention, disconnect and delete.
  assert.match(body, /Only to do what you asked for/);
  assert.match(body, /not read for any other purpose/);
  assert.match(body, /encrypted at rest/);
  assert.match(body, /No access token or refresh token ever leaves that machine/i);
  assert.match(body, /Retention\./);
  assert.match(body, /myaccount\.google\.com\/permissions/);
  assert.match(body, /does not copy your mailbox or your Drive/i);
  assert.match(body, /never as an instruction/i);
  // And nothing claims the scopes it no longer asks for.
  assert.doesNotMatch(body, /five Google permissions/i);
  assert.doesNotMatch(body, /find and read your files/i);
});

// The paragraph that replaced "Attachments are never downloaded or opened", which stopped being true
// the day Reason could read a PDF. Every sentence pinned here is a claim about what the code does, so
// if one of them stops being true this test is where it is caught — a privacy page that overclaims is
// worse than one that promises less.
test("the policy says how a PDF is read, and that the document goes nowhere", async () => {
  const { body } = await get("/privacy");
  // That it can be read at all, and in both places it can be read from.
  assert.match(body, /A PDF — in your Drive, or attached to an email — can be read/i);
  // Reading an email is still not downloading what is attached to it: google.js lists the parts from
  // the message metadata, and only `attachments.get` fetches bytes, only for the one asked about.
  assert.match(body, /Reading an email does not download what is attached to it/i);
  assert.match(body, /only fetched when you ask about that particular file/i);
  // The whole decision in src/pdf.js: text out locally, through macOS's own PDFKit.
  assert.match(body, /pulled out on the machine Reason runs on/i);
  assert.match(body, /PDF reader macOS already has/i);
  assert.match(body, /not sent to any model, any service or anybody else/i);
  // And the temp file both written and removed, which is pdfText's `finally`.
  assert.match(body, /deleted straight afterwards/i);
  // What survives is text in the transcript, cleared by a disconnect like every other read.
  assert.match(body, /a disconnect clears it/i);
  // The one PDF it still cannot read, said as what it is rather than as a failure.
  assert.match(body, /A PDF that is a scan has no text in it to pull out/i);
});

test("the policy says how to disconnect and how to get or delete everything", async () => {
  const { body } = await get("/privacy");
  assert.match(body, /ask it to disconnect/i);
  assert.match(body, /google\.com\/permissions/, "and that they can take it away from their own side");
  assert.match(body, /data:export/);
  assert.match(body, /data:delete/);
  // Reason keeps encrypted backups (a rolling copy on the server, daily encrypted off-site), and the
  // page says so and says what a delete means for them, instead of the old "no backups" line.
  assert.doesNotMatch(body, /no backups/i);
  assert.doesNotMatch(body, /no other copy/i);
  assert.match(body, /encrypted backups/i);
  assert.match(body, /off-site/i);
  assert.match(body, /delete[^.]*backups?/i, "what a delete means for the backups");
});

test("neither page has anybody's data on it", async () => {
  db.upsertAccount({ conversationId: "dm:fake:+13475550000", channel: "fake", address: "+13475550000", name: "Ama", isOperator: false });
  for (const p of ["/", "/privacy"]) {
    const { body } = await get(p);
    assert.ok(!body.includes("3475550000"), p);
    assert.ok(!body.includes("Ama"), p);
    assert.ok(!body.includes("2025551234"), p);
  }
});

// ---------- nothing was shadowed ----------

test("the routes that existed before still answer exactly as they did", async () => {
  // /health is still JSON, not a page.
  const h = await get("/health");
  assert.equal(h.status, 200);
  assert.match(h.type, /application\/json/);
  assert.equal(JSON.parse(h.body).ok, true);

  // A page id is still a page id, and is not shadowed by the public site. An unknown one answers
  // the code gate rather than "Not found", because a missing page has to be indistinguishable from
  // a private one — see the note at the top of src/http.js.
  const page = await get("/p/abcdefgh12345678");
  assert.equal(page.status, 401);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /Private page/);

  // A /s/ address that is neither a sign-in link nor a share is the stamps' 404 page, not the home page.
  const signin = await get("/s/short");
  assert.equal(signin.status, 404);
  assert.match(signin.body, /isn’t here/);

  // Webhooks are untouched: a GET on one is still not found rather than a page.
  const hook = await get("/channels/sendblue/webhook");
  assert.equal(hook.status, 404);
  assert.match(hook.type, /application\/json/);

  // And anything else is still a JSON 404 rather than being swept up by the home page.
  for (const p of ["/privacy/", "/privacyy", "/nope", "/p", "/index.html", "/favicon.ico"]) {
    const out = await get(p);
    assert.equal(out.status, 404, p);
    assert.match(out.type, /application\/json/, p);
  }
});

test("the public pages answer only GET and HEAD", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const p of ["/", "/privacy"]) {
      const res = await fetch(`${base}${p}`, { method });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  }
});

test("the pages name the website first, and the server's own address only when there is no website", async () => {
  const was = { publicUrl: config.publicUrl, siteUrl: config.siteUrl };
  config.publicUrl = "https://reason.example.ts.net";
  try {
    // A website is set (REASON_SITE_URL above): a person reads that, never the server's address (2026-11-01).
    let { body } = await get("/privacy");
    assert.match(body, /site\.example\.test/);
    assert.doesNotMatch(body, /reason\.example\.ts\.net/);
    config.siteUrl = "";
    ({ body } = await get("/privacy"));
    assert.match(body, /reason\.example\.ts\.net/);
  } finally {
    config.publicUrl = was.publicUrl;
    config.siteUrl = was.siteUrl;
  }
});

test("the home page links to the privacy policy, the terms and the fuller website, and only to real addresses", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /<a href="\/privacy">Privacy policy<\/a>/);
  assert.match(html, /<a href="\/terms">Terms of service<\/a>/);
  assert.match(html, /<a href="https:\/\/site\.example\.test\/" rel="noopener">See the good-looking version<\/a>/);
  // The policy and the terms point at each other and back home, so a reviewer landing on either
  // can find the rest.
  const privacy = await (await fetch(`${base}/privacy`)).text();
  assert.match(privacy, /<a href="\/terms">Terms of service<\/a>/);
  assert.match(privacy, /<a href="\/">Home<\/a>/);
  const terms = await (await fetch(`${base}/terms`)).text();
  assert.match(terms, /<a href="\/privacy">Privacy policy<\/a>/);

  const { renderNotice } = await import("../src/pages/render.js");
  const odd = renderNotice({ title: "x", links: [
    { label: "script", href: "javascript:alert(1)" },
    { label: "bare", href: "example.com" },
    { label: "elsewhere", href: "//evil.example" },
    { label: "", href: "/privacy" },
  ] });
  assert.doesNotMatch(odd, /<ul class="links">/, "nothing that is not a path or a web address becomes a link");
  assert.doesNotMatch(odd, /javascript:/);
});

// ---------- terms, and the Search Console tag (added 2026-10-06) ----------
//
// Google's brand verification wants terms next to the policy and the home page's domain proved in
// Search Console. The terms are a public page like the other two; the proof is a meta tag that only
// appears when this install has been given its token.

test("the terms page answers like the other two: public, indexable, cached, HEAD, GET only", async () => {
  const out = await get("/terms");
  assert.equal(out.status, 200);
  assert.match(out.type, /text\/html/);
  assert.match(out.body, /<meta name="robots" content="index,follow">/);
  assert.match(out.headers.get("cache-control") ?? "", /public/);
  assert.match(out.body, /Saafi Interactions Lab/);
  assert.match(out.body, /stops and asks you first/i);
  assert.match(out.body, /without warranty/i);
  assert.match(out.body, /13 or older/);
  assert.match(out.body, /have everything deleted/i);
  assert.equal((await fetch(`${base}/terms`, { method: "HEAD" })).status, 200);
  for (const method of ["POST", "PUT", "DELETE"]) {
    assert.equal((await fetch(`${base}/terms`, { method })).status, 404, method);
  }
  // Still exact: a trailing slash or a near miss is the same dull JSON 404 as before.
  for (const p of ["/terms/", "/termss"]) {
    const miss = await get(p);
    assert.equal(miss.status, 404, p);
    assert.match(miss.type, /application\/json/, p);
  }
});

test("the Search Console tag is on every public page when the install has a token, and nowhere when it does not", async () => {
  for (const p of ["/", "/privacy", "/terms"]) {
    assert.doesNotMatch((await get(p)).body, /google-site-verification/, `${p} without a token`);
  }
  const was = config.googleSiteVerification;
  config.googleSiteVerification = "AbC123_-xyz";
  try {
    for (const p of ["/", "/privacy", "/terms"]) {
      const { body } = await get(p);
      assert.match(body, /<meta name="google-site-verification" content="AbC123_-xyz">/, p);
      // In the head, before the title, where Google's checker reads it.
      assert.ok(body.indexOf("google-site-verification") < body.indexOf("<title>"), `${p}: tag is in the head`);
    }
    // A page made for one person never carries it: it is the public site's proof, not theirs.
    const { renderPage } = await import("../src/pages/render.js");
    const made = renderPage({ title: "Gift ideas", blocks: [], revision: 1, created_at: Date.now(), shared: false }, {});
    assert.doesNotMatch(made, /google-site-verification/);
  } finally {
    config.googleSiteVerification = was;
  }
});

test("the token is kept to the characters Google's tokens use, so it can never become markup", async () => {
  // config.js strips anything else at load; the same rule, applied to what an operator might paste.
  const clean = (v) => v.trim().replace(/[^A-Za-z0-9_-]/g, "");
  assert.equal(clean(' "><script>alert(1)</script>Ab_1-'), "scriptalert1scriptAb_1-");
  assert.equal(clean("AbC123_-xyz "), "AbC123_-xyz");
});

// ---------- identity (security run-3, 2026-11-10) ----------
//
// The maker appears only as Saafi Interactions Lab. The public pages (served on heyreason.com through the
// site's proxy) and the user-agent Reason sends to every website it reads carry no personal name, GitHub
// handle or repo link, and do not claim the code is public (the repo is private).
test("public pages and the web-lookup user-agent carry no personal name, handle or 'the code is public'", async () => {
  const { readFileSync } = await import("node:fs");
  const personal = /omari|nyarko|omarionnn|omariij|github\.com/i;
  for (const p of ["/", "/privacy", "/terms"]) {
    const out = await get(p);
    assert.equal(out.status, 200, p);
    assert.doesNotMatch(out.body, personal, p);
    assert.doesNotMatch(out.body, /free software|which is public|whole of it can be read|read the code|MIT licen/i, p);
    assert.match(out.body, /Saafi Interactions Lab/, p);
  }
  const src = readFileSync(new URL("../src/weblookup.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, personal);
  assert.match(src, /ReasonBot\/1\.0 \(\+https:\/\/heyreason\.com\)/);
});

// The owner's status page can't be framed by another site (security run-3 hardening, 2026-11-10).
test("/ops and /ops.json refuse to be framed (signed-out answer; the header is added to every /ops response)", async () => {
  for (const p of ["/ops", "/ops.json"]) {
    const out = await get(p);
    assert.equal(out.headers.get("x-frame-options"), "DENY", p);
    assert.match(out.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, p);
  }
});

test("the stranger-call facts sell signing up as one text, never 'no download' (an iPhone app is coming)", async () => {
  const { PUBLIC_FACTS } = await import("../src/calls/stranger.js");
  const all = PUBLIC_FACTS.join(" ");
  assert.doesNotMatch(all, /no download|no app|nothing to install/i);
  assert.match(all, /signing up is one text/i);
});

test("no user-facing pa copy says the website lists no price or that Reason is free for now (pricing is live)", async () => {
  const { PUBLIC_FACTS, strangerPrompt } = await import("../src/calls/stranger.js");
  const all = [...PUBLIC_FACTS, strangerPrompt()].join(" ");
  assert.doesNotMatch(all, /does(?:n't| not) list (?:a price|one)|no price|free for now/i);
  assert.match(all, /heyreason\.com\/pricing/);
});

test("/terms has the Paid events section and /privacy the Stripe line: who processes, the fee, what each kind of refund gives back and to which card", async () => {
  const terms = await get("/terms");
  assert.equal(terms.status, 200);
  const t = terms.body.replace(/&#39;/g, "'");
  assert.match(t, /Paid events/);
  assert.match(t, /Payments are processed by Stripe/);
  assert.match(t, /stripe\.com\/legal\/connect-account/);
  assert.match(t, /service fee is 2\.5% of the ticket price/);
  assert.match(t, /processing fee paid at checkout is not refundable/);
  // A ticket bought for a friend goes back to the card that paid, whoever gives it back.
  assert.match(t, /friend gives back a ticket that was bought for them, or the buyer gives back one nobody has claimed, the ticket price goes back to the card that paid for it/);
  assert.match(t, /If an event is cancelled, every guest is refunded in full/);
  assert.ok(t.indexOf("Paid events") > t.indexOf("What it does not promise") && t.indexOf("Paid events") < t.indexOf("Your data, and leaving"), "between the two sections it sits between");
  const privacy = await get("/privacy");
  const p = privacy.body.replace(/&#39;/g, "'");
  assert.match(p, /Stripe processes ticket payments/);
  assert.match(p, /go to Stripe and never to Reason/);
});
