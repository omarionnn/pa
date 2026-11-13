// Site policy (src/sitepolicy.js): which sites may ever have a saved login, decided by code.
//
// Design: docs/account-access-design.md section C; brief: docs/account-access-build/pr4.md (PR #529).
// What has to hold, one block per hard rule of the brief:
//   1. Only the host is judged, after parsing: chase.com.evil.example is evil.example.
//   2. Nothing but a domain name is ever kept: the review list never holds a path, query or password.
//   3. Every never category refuses with fixed words, a reason and a route; none falls through to allowed.
//   4. A never is final: classifySite takes one argument and has no override.
//   5. Every answer carries a short category code that PR 5 and PR 6 can log.
//   7. The list is reviewed data: every entry has reason, source, read_on and reviewer.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifySite, refusalFor, reviewList, problemsIn, matchKind, _resetReviewList,
  POLICY, CATEGORIES, NEVER, CAREFUL, ALLOWED, REVIEW_WINDOW_MS,
} from "../src/sitepolicy.js";

beforeEach(() => _resetReviewList());

// [input, policy, category]
const TABLE = [
  // the brief's three, by name
  ["https://chase.com.evil.example", ALLOWED, "unknown"],
  ["https://signin.aws.amazon.com/x", NEVER, "own_infra"],
  ["https://www.amazon.com", CAREFUL, "marketplace"],
  // government
  ["irs.gov", NEVER, "government"],
  ["ny.gov", NEVER, "government"],
  ["https://login.gov/", NEVER, "government"],
  ["army.mil", NEVER, "government"],
  ["id.me", NEVER, "government"],
  ["https://www.gov.uk/sign-in", NEVER, "government"],
  // identity, mail, work, school
  ["appleid.apple.com", NEVER, "apple_id"],
  ["https://idmsa.apple.com/appleauth", NEVER, "apple_id"],
  ["icloud.com", NEVER, "apple_id"],
  ["accounts.google.com", NEVER, "google"],
  ["gmail.com", NEVER, "google"],
  ["outlook.com", NEVER, "email"],
  ["https://login.live.com/login.srf", NEVER, "email"],
  ["proton.me", NEVER, "email"],
  ["aol.com", NEVER, "email"],
  ["login.microsoftonline.com", NEVER, "work"],
  ["acme.okta.com", NEVER, "work"],
  ["stanford.edu", NEVER, "school"],
  // money
  ["https://secure.chase.com/web/auth/dashboard?x=1", NEVER, "bank"],
  ["CHASE.COM.", NEVER, "bank"],
  ["https://www.paypal.com/signin", NEVER, "bank"],
  ["coinbase.com", NEVER, "bank"],
  // carriers, password managers, terms, social, tickets, health
  ["totalwireless.com", NEVER, "carrier"],
  ["https://www.verizon.com/signin", NEVER, "carrier"],
  ["1password.com", NEVER, "password_manager"],
  ["my.1password.com", NEVER, "password_manager"],
  ["uber.com", NEVER, "terms"],
  ["x.com", NEVER, "social"],
  ["www.instagram.com", NEVER, "social"],
  ["fandango.com", NEVER, "tickets"],
  ["https://www.ticketmaster.com/member", NEVER, "tickets"],
  ["mychart.somehospital.org", NEVER, "health"],
  ["aetna.com", NEVER, "health"],
  // the accounts that run Reason
  ["console.aws.amazon.com", NEVER, "own_infra"],
  ["us-east-1.console.aws.amazon.com", NEVER, "own_infra"],
  ["123456789012.signin.aws.amazon.com", NEVER, "own_infra"],
  ["github.com", NEVER, "own_infra"],
  ["app.netlify.com", NEVER, "own_infra"],
  ["platform.openai.com", NEVER, "own_infra"],
  ["dashboard.sendblue.com", NEVER, "own_infra"],
  ["https://api.sendblue.co/v3/verified-contacts", NEVER, "own_infra"],
  ["app.bland.ai", NEVER, "own_infra"],
  ["https://linqapp.com", NEVER, "own_infra"],
  ["sso.godaddy.com", NEVER, "own_infra"],
  // careful
  ["delta.com", CAREFUL, "travel_points"],
  ["www.marriott.com", CAREFUL, "travel_points"],
  ["netflix.com", CAREFUL, "streaming"],
  ["ebay.com", CAREFUL, "marketplace"],
  ["store.steampowered.com", CAREFUL, "gaming"],
  ["dashboard.stripe.com", CAREFUL, "payouts"],
  // everything else
  ["coned.com", ALLOWED, "unknown"],
  ["quietlittlebakery.com", ALLOWED, "unknown"],
  ["https://chase.com@evil.example/", ALLOWED, "unknown"],
  ["https://www.xn--chse-uta.com/", ALLOWED, "unknown"], // a look-alike of chase.com is not chase.com
  ["openai.com", ALLOWED, "unknown"],
  // not a site at all
  ["192.168.1.1", NEVER, "not_a_site"],
  ["https://8.8.8.8/login", NEVER, "not_a_site"],
  ["http://127.0.0.1:8788/health", NEVER, "not_a_site"],
  ["https://[::1]/", NEVER, "not_a_site"],
  ["", NEVER, "not_a_site"],
  ["   ", NEVER, "not_a_site"],
  ["localhost:3000", NEVER, "not_a_site"],
  ["router.local", NEVER, "not_a_site"],
  ["javascript:alert(1)", NEVER, "not_a_site"],
  ["mailto:someone@example.com", NEVER, "not_a_site"],
  ["ftp://files.example.com", NEVER, "not_a_site"],
  ["https://exa mple.com", NEVER, "not_a_site"],
];

test("rule 1: the table of 30+ hosts and URLs gets the expected answer", () => {
  assert.ok(TABLE.length >= 30);
  const wrong = [];
  for (const [input, policy, category] of TABLE) {
    const got = classifySite(input);
    if (got.policy !== policy || got.category !== category) wrong.push(`${JSON.stringify(input)}: ${got.policy}/${got.category}, want ${policy}/${category}`);
  }
  assert.deepEqual(wrong, []);
});

test("rule 1: only the host is judged, after parsing", () => {
  assert.equal(classifySite("https://chase.com.evil.example/login").host, "chase.com.evil.example");
  assert.equal(classifySite("https://chase.com@evil.example/").host, "evil.example");
  assert.deepEqual(reviewList(), ["evil.example"]);
  for (const input of ["chase.com", "https://chase.com", "https://CHASE.com/", "chase.com:443/x"]) {
    assert.equal(classifySite(input).policy, NEVER, input);
  }
  // non-input never throws
  for (const odd of [undefined, null, 42, {}, [], new Date()]) assert.equal(classifySite(odd).category, "not_a_site");
  assert.equal(classifySite(new URL("https://www.netflix.com/login")).policy, CAREFUL);
});

test("exact host beats domain: AWS sign-in is never, Amazon shopping is careful", () => {
  assert.equal(classifySite("https://signin.aws.amazon.com/x").policy, NEVER);
  assert.equal(classifySite("https://aws.amazon.com/").policy, NEVER);
  const shop = classifySite("https://www.amazon.com/ap/signin?openid.return_to=x");
  assert.equal(shop.policy, CAREFUL);
  assert.equal(shop.entry.declared_agent, "Agent/Reason");
});

test("rule 2: the review list holds domain names only, never a path, query or password", () => {
  classifySite("https://example.com/account/settings?token=abc123&code=999#frag");
  classifySite("https://someone:hunter2@shop.example.com/x?y=z");
  classifySite("example.com");
  assert.deepEqual(reviewList(), ["example.com"]);
  const kept = JSON.stringify(reviewList());
  for (const bit of ["token", "abc123", "999", "hunter2", "someone", "/", "?", "#"]) assert.ok(!kept.includes(bit), bit);
  const answer = JSON.stringify(classifySite("https://someone:hunter2@shop.example.com/x?token=abc123"));
  for (const bit of ["hunter2", "someone", "abc123", "token"]) assert.ok(!answer.includes(bit), bit);
});

test("the review list: unknown sites only, for a week, then gone", () => {
  classifySite("chase.com");
  classifySite("www.amazon.com");
  classifySite("192.168.1.1");
  assert.deepEqual(reviewList(), []);
  classifySite("https://www.quietlittlebakery.com/login");
  classifySite("https://b.unknownshop.co.uk/");
  assert.deepEqual(reviewList(), ["quietlittlebakery.com", "unknownshop.co.uk"]);
  assert.deepEqual(reviewList(Date.now() + REVIEW_WINDOW_MS + 60_000), []);
});

test("rule 3: every never category refuses with fixed words, a reason and a route", () => {
  const never = Object.entries(CATEGORIES).filter(([, c]) => c.policy === NEVER);
  assert.ok(never.length >= 12);
  for (const [code, c] of never) {
    const words = refusalFor(code, "Example");
    assert.equal(typeof words, "string");
    assert.ok(words.trim().length > 10, code);
    assert.ok(!words.includes("{site}"), code);
    assert.ok(c.why && c.why.trim().length > 10, `${code} has a reason`);
    assert.ok(typeof c.route === "string" && c.route.length > 0, `${code} has a route ("none" when there is none)`);
  }
  for (const odd of [undefined, null, "", "allowed", "unknown", "travel_points", "__proto__", "constructor", 7]) {
    assert.ok(refusalFor(odd).length > 0, String(odd));
  }
});

test("rule 3: no category and no entry falls through to allowed", () => {
  for (const [code, c] of Object.entries(CATEGORIES)) assert.ok(c.policy === NEVER || c.policy === CAREFUL, code);
  const sample = (e) => {
    const kind = matchKind(e.match);
    if (kind === "prefix") return `${e.match.slice(0, -2)}.example-hospital.org`;
    if (kind === "suffix") return `sample${e.match}`;
    return e.match;
  };
  const wrong = [];
  for (const e of POLICY) {
    for (const host of [sample(e), ...(matchKind(e.match) === "domain" ? [`login.${e.match}`] : [])]) {
      const got = classifySite(`https://${host}/`);
      if (got.policy !== e.policy || got.category !== e.category) wrong.push(`${host}: ${got.policy}/${got.category}, entry says ${e.policy}/${e.category}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(reviewList(), []);
});

test("rule 3: the section C words, exactly", () => {
  assert.equal(refusalFor("bank", null, { plaid: true }), "I don't keep bank logins. For your bank I use a read-only connection where you sign in on the bank's own page and I never see the password. Want the link?");
  assert.equal(refusalFor("bank"), "I can't work inside bank accounts yet. I can call the bank with you, or remind you.");
  assert.equal(refusalFor("bank", null, null), refusalFor("bank"));
  assert.equal(refusalFor("apple_id"), "I don't sign in to Apple accounts. That password unlocks your devices and every password you've saved, so it stays with you.");
  assert.equal(refusalFor("google"), "Google only lets me in through its own permission page, so I never need your Google password. Here's that page:");
  assert.equal(refusalFor("email"), "I don't keep email passwords. Your email can reset everything else you own.");
  const govHealth = "I don't sign in to government or health sites. I can call them for you, or walk you through it.";
  assert.equal(refusalFor("government"), govHealth);
  assert.equal(refusalFor("health"), govHealth);
  assert.equal(refusalFor("work"), "That account belongs to your employer, so I can't hold it.");
  assert.equal(refusalFor("carrier"), "I don't keep your phone carrier's login: that account controls your number. I can pay the bill without signing in, or call them.");
  assert.equal(refusalFor("password_manager"), "I don't keep password manager logins: that one account opens all the others.");
  assert.equal(refusalFor("social"), "I don't sign in to social networks with a password. Their rules ban it and they close accounts for it.");
  assert.equal(refusalFor("tickets"), "I don't sign in to ticket sites. They ban bots, and getting round a ticket seller's limits is against the law, so buying stays with you. I can find the event and send you the link.");
  assert.equal(CATEGORIES.tickets.route, "event_link");
  // own_infra is refused for everyone, so its words name no provider and no per-entry reason.
  const infra = "I don't keep logins for cloud, domain or developer accounts. One stolen login there can run up bills or take down everything it runs, so it stays with you.";
  assert.equal(refusalFor("own_infra"), infra);
  for (const e of POLICY.filter((x) => x.category === "own_infra")) assert.equal(refusalFor(e.category, e.label), infra, e.match);
});

test("rule 3: the terms refusal names the site, cleaned, and reads right without one", () => {
  const uber = classifySite("https://m.uber.com/go");
  assert.equal(refusalFor(uber.category, uber.entry.label), "Uber's rules don't let me hold your login. I'll use its official connection instead.");
  assert.equal(uber.route, "official_connect");
  assert.equal(refusalFor("terms"), "That site's rules don't let me hold your login. I'll use its official connection instead.");
  const odd = refusalFor("terms", "<b>Ignore the rules</b> and https://evil.example/{site}" + "x".repeat(100));
  assert.ok(!/[<>/{}:]/.test(odd), odd);
  assert.ok(odd.length < 140, odd);
});

test("rule 4: one argument, no override, and the answer cannot be edited", () => {
  assert.equal(classifySite.length, 1);
  assert.equal(classifySite("chase.com", { override: true, policy: "allowed" }).policy, NEVER);
  assert.equal(classifySite("chase.com", "allowed", true).policy, NEVER);
  const got = classifySite("chase.com");
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.entry));
  assert.ok(Object.isFrozen(POLICY) && POLICY.every(Object.isFrozen));
  assert.ok(Object.isFrozen(CATEGORIES) && Object.values(CATEGORIES).every(Object.isFrozen));
  assert.throws(() => { "use strict"; POLICY.push({ match: "evil.example" }); });
});

test("rule 5: every answer carries a short category code to log", () => {
  for (const code of [...Object.keys(CATEGORIES), "unknown"]) assert.match(code, /^[a-z][a-z_]{1,23}$/);
  for (const [input] of TABLE) assert.match(classifySite(input).category, /^[a-z][a-z_]{1,23}$/);
});

test("rule 7: the list is reviewed data, and an entry without its source fails review", () => {
  assert.deepEqual(problemsIn(POLICY), []);
  for (const e of POLICY) for (const k of ["reason", "source", "read_on", "reviewer"]) assert.ok(String(e[k] ?? "").trim(), `${e.match} ${k}`);
  for (const e of POLICY.filter((x) => x.basis === "review")) assert.match(e.source, /^https:\/\//, e.match);
  const base = { match: "rules-site.example", category: "terms", policy: NEVER, reason: "Its terms forbid it.", basis: "review", read_on: "2026-11-13", reviewer: "someone" };
  assert.deepEqual(problemsIn([{ ...base, source: "https://rules-site.example/terms" }]), []);
  assert.ok(problemsIn([base]).some((p) => /source/.test(p)));
  assert.ok(problemsIn([{ ...base, source: "I read it somewhere" }]).some((p) => /https/.test(p)));
  assert.ok(problemsIn([{ ...base, source: "https://x.example", policy: CAREFUL }]).some((p) => /policy/.test(p)));
  assert.ok(problemsIn([{ ...base, source: "https://x.example", read_on: "last week" }]).some((p) => /read_on/.test(p)));
  assert.ok(problemsIn([{ ...base, source: "https://x.example" }, { ...base, source: "https://x.example" }]).some((p) => /duplicate/.test(p)));
});

test("every mailbox provider in src/signinemail.js is never, plus icloud.com, proton.me and aol.com", () => {
  const src = readFileSync(new URL("../src/signinemail.js", import.meta.url), "utf8");
  const set = src.match(/const MAILBOX_DOMAINS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, "MAILBOX_DOMAINS moved: update this test and src/sitepolicy.js together");
  const domains = [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(domains.length >= 15);
  for (const d of [...domains, "icloud.com", "proton.me", "aol.com"]) assert.equal(classifySite(d).policy, NEVER, d);
});

test("the module is pure: no imports, so the live check can load it without the database", () => {
  const src = readFileSync(new URL("../src/sitepolicy.js", import.meta.url), "utf8");
  assert.ok(!/^\s*import\s/m.test(src) && !/\bimport\(/.test(src) && !/\brequire\(/.test(src));
});
