// Which sites may ever have a saved login. Code decides: never the AI, never a person's insistence.
//
// Three answers: `never` (no saved login, fixed words that say why and offer the route instead),
// `careful` (allowed, but Face ID every time, an extra warning line, no standing permission) and
// `allowed` (everything else; the domain goes on the owner's weekly review list).
// Design: docs/account-access-design.md section C (PR #529). Brief: docs/account-access-build/pr4.md.
//
// Nothing calls this yet. PR 5 asks it before a save link exists and PR 6 asks again before every
// sign-in, both behind REASON_SAVED_LOGINS. Pure on purpose: no imports, no database, no network,
// no config. The only state is the review list, in memory, cleared on restart.
//
// Only a host is ever judged and only a registrable domain is ever kept: a path, a query string
// or a user:password@ part is dropped by the parse before anything is looked at.

export const NEVER = "never";
export const CAREFUL = "careful";
export const ALLOWED = "allowed";

/** How long an unknown domain stays on the review list. */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The review list never grows past this; the oldest domain goes first. */
export const REVIEW_LIST_MAX = 1000;

// ---------------------------------------------------------------- categories and their words
// `say` is the fixed refusal, `why` the short reason for a log or a follow-up question, `route`
// a code for what Reason offers instead ("none" when there is nothing). Words marked NEW are not
// in section C; they are this PR's proposal for the owner to read.
const BANK_WITH_PLAID = "I don't keep bank logins. For your bank I use a read-only connection where you sign in on the bank's own page and I never see the password. Want the link?";
const BANK_BEFORE_PLAID = "I can't work inside bank accounts yet. I can call the bank with you, or remind you.";
const GOV_OR_HEALTH = "I don't sign in to government or health sites. I can call them for you, or walk you through it.";

export const CATEGORIES = Object.freeze({
  bank: { policy: NEVER, route: "plaid_read_only", say: BANK_BEFORE_PLAID, sayWithPlaid: BANK_WITH_PLAID,
    why: "Banks, brokerages, retirement, lenders, payment apps, crypto: under Regulation E a transfer by someone the person gave the login to is not unauthorized, so the person is fully liable." },
  apple_id: { policy: NEVER, route: "none",
    say: "I don't sign in to Apple accounts. That password unlocks your devices and every password you've saved, so it stays with you.",
    why: "The Apple ID unlocks the person's devices and every password they have saved." },
  google: { policy: NEVER, route: "google_permission_page",
    say: "Google only lets me in through its own permission page, so I never need your Google password. Here's that page:",
    why: "Google stops sign-ins from browsers controlled by software; its own permission page is the way in." },
  email: { policy: NEVER, route: "official_connect",
    say: "I don't keep email passwords. Your email can reset everything else you own.",
    why: "A mailbox resets every other account the person has." },
  password_manager: { policy: NEVER, route: "none",
    say: "I don't keep password manager logins: that one account opens all the others.", // NEW
    why: "One password manager login opens every other account." },
  government: { policy: NEVER, route: "phone_or_walkthrough", say: GOV_OR_HEALTH,
    why: "Government portals and identity checks: identity and legal exposure." },
  health: { policy: NEVER, route: "phone_or_walkthrough", say: GOV_OR_HEALTH,
    why: "Health portals and insurers hold health records." },
  work: { policy: NEVER, route: "none",
    say: "That account belongs to your employer, so I can't hold it.",
    why: "Work sign-in belongs to the employer; it is not the person's to share." },
  school: { policy: NEVER, route: "none",
    say: "That account belongs to your school, so I can't hold it.", // NEW
    why: "School sign-in belongs to the school; it is not the person's to share." },
  carrier: { policy: NEVER, route: "guest_pay_or_phone",
    say: "I don't keep your phone carrier's login: that account controls your number. I can pay the bill without signing in, or call them.",
    why: "The carrier account controls the number that guards everything else, Reason included." },
  terms: { policy: NEVER, route: "official_connect",
    say: "{site}'s rules don't let me hold your login. I'll use its official connection instead.", // NEW
    why: "The site's terms forbid giving an agent the login." },
  social: { policy: NEVER, route: "none",
    say: "I don't sign in to social networks with a password. Their rules ban it and they close accounts for it.", // NEW
    why: "Social networks ban automated access and close accounts for it." },
  tickets: { policy: NEVER, route: "none",
    say: "I don't sign in to ticket sites.", // NEW
    why: "The BOTS Act makes getting round a ticket seller's controls unlawful, and ticket sites ban bots." },
  own_infra: { policy: NEVER, route: "none",
    say: "I don't keep logins for the accounts that run me.", // NEW
    why: "A login there would let a stolen server reach the controls that are meant to sit outside it." },
  not_a_site: { policy: NEVER, route: "none",
    say: "I can only keep a login for a site's own web address, and that isn't one.", // NEW
    why: "No saved login for an empty, unreadable, private or bare-number address." },
  travel_points: { policy: CAREFUL, route: null, why: "Airline and hotel points hold value a lockout can lose; Delta says a third-party agent is used at your own risk." },
  marketplace: { policy: CAREFUL, route: null, why: "Marketplaces hold cards and orders and punish automation." },
  streaming: { policy: CAREFUL, route: null, why: "Streaming holds a paid plan and its terms punish automation." },
  gaming: { policy: CAREFUL, route: null, why: "Gaming accounts hold purchases and punish automation." },
  payouts: { policy: CAREFUL, route: null, why: "Seller and payout dashboards move money but are not a bank or a payment app." },
});
for (const c of Object.values(CATEGORIES)) Object.freeze(c);

const SAFE_LABEL = /[^\p{L}\p{N} .&'+-]/gu;

/**
 * The fixed words for a never category. Never empty: an unknown code still refuses.
 * `label` names the site where the words need it (terms); it is cleaned, never trusted.
 * `opts.plaid`: true once the read-only bank connection (PR #520) is live for this person.
 */
export function refusalFor(category, label, opts) {
  const c = typeof category === "string" && Object.hasOwn(CATEGORIES, category) ? CATEGORIES[category] : null;
  if (!c || c.policy !== NEVER) return "I don't keep a login for that site.";
  if (category === "bank") return opts?.plaid === true ? c.sayWithPlaid : c.say;
  const site = String(label ?? "").replace(SAFE_LABEL, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return c.say.replace("{site}", site || "That site");
}

// ---------------------------------------------------------------- the reviewed data
// Each entry: { match, category, policy, reason, basis, source, read_on, reviewer } (+ label,
// route, declared_agent where they apply). `match` is a registrable domain ("chase.com": it and
// every host under it), an exact host ("accounts.google.com"), a suffix rule (".gov") or a
// first-label rule ("mychart.*"). `basis` is "rule" (a category row of section C), "review"
// (someone read the site's own terms; `source` is that page) or "proposed" (this PR's proposal,
// owner to confirm). When several entries match, the stricter policy wins, then the narrower match.
const DESIGN_C = "PR #529 docs/account-access-design.md section C";
const PROPOSED = "PR #529 docs/account-access-build/pr4.md, proposed for owner review";
const REG_E = "https://www.consumerfinance.gov/rules-policy/regulations/1005/2/";
const BOTS_ACT = "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section45c&num=0&edition=prelim";

const byRule = (category, reason, matches, extra = {}) => matches.map((match) => ({
  match, category, policy: CATEGORIES[category].policy, reason, basis: "rule",
  source: DESIGN_C, read_on: "2026-11-12", reviewer: "design-529", ...extra,
}));
const byReview = (category, match, reason, source, extra = {}) => ({
  match, category, policy: CATEGORIES[category].policy, reason, basis: "review",
  source, read_on: "2026-11-12", reviewer: "design-529", ...extra,
});
const proposed = (category, reason, matches, extra = {}) => matches.map((match) => ({
  match, category, policy: CATEGORIES[category].policy, reason, basis: "proposed",
  source: PROPOSED, read_on: "2026-11-13", reviewer: "proposed-pr4", ...extra,
}));

const RAW = [
  // ---- never, by rule
  ...byRule("government", "Government: identity and legal exposure.", [".gov", ".mil", "id.me"]),
  ...proposed("government", "Government outside the US: same rule as .gov.", [".gov.uk", ".gc.ca", ".gov.au"]),
  ...byRule("bank", "Bank, credit union, brokerage, retirement, lender, payment app or crypto exchange (Regulation E: the person is fully liable for what someone they gave the login to does).", [
    "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com", "usbank.com", "pnc.com", "truist.com",
    "capitalone.com", "td.com", "tdbank.com", "ally.com", "discover.com", "americanexpress.com", "synchrony.com",
    "mysynchrony.com", "barclaysus.com", "marcus.com", "goldmansachs.com", "citizensbank.com", "fifththird.com",
    "keybank.com", "huntington.com", "regions.com", "mtb.com", "santanderbank.com", "bmo.com", "hsbc.com", "usaa.com",
    "navyfederal.org", "penfed.org", "becu.org", "alliantcreditunion.org", "sofi.com", "chime.com", "varomoney.com",
    "schwab.com", "fidelity.com", "vanguard.com", "etrade.com", "morganstanley.com", "merrilledge.com", "ml.com",
    "robinhood.com", "webull.com", "tiaa.org", "empower.com", "principal.com", "voya.com", "transamerica.com",
    "salliemae.com", "navient.com", "nelnet.com", "mohela.com", "aidvantage.com", "rocketmortgage.com", "mrcooper.com",
    "affirm.com", "klarna.com", "afterpay.com", "lendingclub.com", "upstart.com", "creditkarma.com",
    "paypal.com", "venmo.com", "cash.app", "zellepay.com", "wise.com", "remitly.com", "westernunion.com", "moneygram.com",
    "revolut.com", "coinbase.com", "kraken.com", "gemini.com", "binance.com", "binance.us", "crypto.com",
    "bitstamp.net", "okx.com", "kucoin.com", "bybit.com",
  ], { source: REG_E }),
  byReview("bank", "chase.com", "Chase's terms (effective 2026-10-27) forbid \"External AI, automated tools, or data aggregators\" from using the login.",
    "https://www.chase.com/content/dam/legal-agreements/library/en/dsa_la/versions/dsa_la.pdf", { label: "Chase" }),
  ...byRule("apple_id", "Apple ID: it unlocks the person's devices and every password they have saved.", [
    "appleid.apple.com", "idmsa.apple.com", "apple.com", "icloud.com", "me.com", "mac.com",
  ], { label: "Apple" }),
  ...byRule("google", "Google account: \"Google might stop sign-ins from browsers that\" ... \"are being controlled through software automation rather than a human\".", [
    "accounts.google.com", "google.com", "gmail.com", "googlemail.com", "youtube.com",
  ], { source: "https://support.google.com/accounts/answer/7675428", label: "Google" }),
  // Every mailbox in src/signinemail.js MAILBOX_DOMAINS (Apple's and Google's sit above), plus a few.
  ...byRule("email", "A main mailbox: it resets everything else.", [
    "outlook.com", "hotmail.com", "live.com", "msn.com", "microsoft.com", "yahoo.com", "ymail.com", "proton.me",
    "protonmail.com", "pm.me", "aol.com", "gmx.com", "mail.com", "zoho.com", "fastmail.com", "yandex.com", "hey.com",
  ]),
  ...byRule("password_manager", "Password manager: one login opens all the others.", [
    "1password.com", "1password.ca", "1password.eu", "bitwarden.com", "bitwarden.eu", "lastpass.com", "dashlane.com",
    "keepersecurity.com", "keepersecurity.eu",
  ]),
  ...byRule("work", "Work sign-in: it belongs to the employer.", [
    "microsoftonline.com", "okta.com", "okta-emea.com", "oktapreview.com", "onelogin.com", "duosecurity.com",
    "pingone.com", "pingidentity.com", "jumpcloud.com", "myworkday.com",
  ]),
  ...proposed("school", "School sign-in: it belongs to the school (section C: work or school accounts).", [
    ".edu", "instructure.com", "schoology.com", "blackboard.com", "clever.com", "powerschool.com",
  ]),
  ...byRule("carrier", "Phone carrier: the account controls the number that guards everything else.", [
    "verizon.com", "verizonwireless.com", "vzw.com", "att.com", "t-mobile.com", "totalwireless.com", "totalbyverizon.com",
    "mintmobile.com", "cricketwireless.com", "metrobyt-mobile.com", "visible.com", "boostmobile.com", "tracfone.com",
    "straighttalk.com", "uscellular.com",
  ]),
  ...byRule("health", "Health portal or insurer: health records.", [
    "mychart.com", "mychart.*", "followmyhealth.com", "unitedhealthcare.com", "uhc.com", "myuhc.com", "optum.com",
    "optumrx.com", "anthem.com", "aetna.com", "cigna.com", "humana.com", "kp.org", "kaiserpermanente.org", "bcbs.com",
    "centene.com", "ambetterhealth.com", "molinahealthcare.com", "wellcare.com", "hioscar.com", "caremark.com",
    "express-scripts.com", "deltadental.com", "vsp.com", "questdiagnostics.com", "labcorp.com", "teladoc.com", "zocdoc.com",
  ]),
  // ---- never, by review (each with the sentence and its source) or by the section C category row
  byReview("terms", "uber.com", "Uber's terms: users \"may not share them with any Agent or Agent provider unless Uber has authorized that Agent\".",
    "https://www.uber.com/legal/en/document/?name=general-terms-of-use&country=united-states&lang=en", { label: "Uber" }),
  byReview("terms", "ubereats.com", "Same Uber account and terms: \"may not share them with any Agent or Agent provider unless Uber has authorized that Agent\".",
    "https://www.uber.com/legal/en/document/?name=general-terms-of-use&country=united-states&lang=en", { label: "Uber" }),
  byReview("social", "instagram.com", "Terms ban automated access and allow closing the account (second reader, not re-checked).",
    "https://help.instagram.com/581066165581870", { label: "Instagram" }),
  ...byRule("social", "Same Instagram account.", ["threads.net", "threads.com"], { label: "Threads" }),
  byReview("social", "linkedin.com", "Terms ban automated access and allow closing the account (second reader, not re-checked).",
    "https://www.linkedin.com/legal/user-agreement", { label: "LinkedIn" }),
  ...byRule("social", "Social network (section C row); X has an official connect.", ["x.com", "twitter.com"], { label: "X", route: "official_connect" }),
  ...byRule("social", "Social network (section C row).", ["facebook.com", "fb.com", "messenger.com"], { label: "Facebook" }),
  ...byRule("social", "Social network (section C row).", ["reddit.com"], { label: "Reddit" }),
  ...byRule("social", "Social network (section C row).", ["tiktok.com"], { label: "TikTok" }),
  byReview("tickets", "ticketmaster.com", "Ticketmaster bans \"bot technology\" (second reader, not re-checked); the BOTS Act backs it.",
    "https://legal.ticketmaster.com/terms-of-use/", { label: "Ticketmaster" }),
  byReview("tickets", "livenation.com", "Live Nation runs Ticketmaster: same \"bot technology\" ban.",
    "https://legal.ticketmaster.com/terms-of-use/", { label: "Live Nation" }),
  ...byRule("tickets", "Ticket buying: the BOTS Act makes getting round a ticket seller's controls unlawful.", [
    "axs.com", "stubhub.com", "seatgeek.com", "fandango.com",
  ], { source: BOTS_ACT }),
  // ---- never, proposed here: the accounts that run Reason itself (owner to confirm)
  ...proposed("own_infra", "AWS holds the vault's key and its outside record; covers sign-in, the console and every region's console.", [".aws.amazon.com", "awsapps.com"], { label: "AWS" }),
  ...proposed("own_infra", "Netlify serves the save page.", ["netlify.com"], { label: "Netlify" }),
  ...proposed("own_infra", "OVH runs the server.", ["ovh.com", "ovhcloud.com", "ovh.us"], { label: "OVH" }),
  ...proposed("own_infra", "GitHub holds the code that runs.", ["github.com"], { label: "GitHub" }),
  ...proposed("own_infra", "An AI provider's console holds the keys Reason runs on.", ["console.anthropic.com", "platform.claude.com", "platform.openai.com"]),
  ...proposed("own_infra", "Tailscale carries the private address the server is reached on.", ["tailscale.com"], { label: "Tailscale" }),
  // ---- careful
  byReview("travel_points", "delta.com", "Delta: a third-party agent is used \"at your own risk\".", "https://www.delta.com/us/en/legal/terms-of-use", { label: "Delta" }),
  ...byRule("travel_points", "Airline or hotel points: value a lockout or a bad booking can lose.", [
    "united.com", "aa.com", "southwest.com", "alaskaair.com", "jetblue.com", "marriott.com", "hilton.com", "ihg.com", "hyatt.com",
  ]),
  byReview("marketplace", "amazon.com", "Amazon's terms (2026-08-14) allow an agent that puts \"Agent/[agent name]\" in every request, does not copy human typing, never touches a CAPTCHA and stops when asked. Signed in only as a declared agent, or not at all.",
    "https://www.amazon.com/gp/help/customer/display.html?nodeId=GLSBYFE9MGKKQXXM", { label: "Amazon", declared_agent: "Agent/Reason" }),
  ...byRule("marketplace", "Marketplace: cards on file, orders, and automation punished.", ["ebay.com", "etsy.com"]),
  byReview("marketplace", "doordash.com", "Terms forbid automated access without written permission (read for section A).",
    "https://help.doordash.com/legal/document?type=cx-terms-and-conditions&region=US&locale=en-US", { label: "DoorDash" }),
  byReview("streaming", "netflix.com", "Terms forbid automated access without written permission (read for section A).", "https://help.netflix.com/legal/termsofuse", { label: "Netflix" }),
  byReview("streaming", "spotify.com", "User guidelines forbid automated access (read for section A); Spotify also has an official connect.", "https://www.spotify.com/us/legal/user-guidelines/", { label: "Spotify" }),
  ...byRule("streaming", "Streaming: a paid plan, and automation punished.", [
    "hulu.com", "disneyplus.com", "max.com", "hbomax.com", "peacocktv.com", "paramountplus.com", "primevideo.com",
  ]),
  ...byRule("gaming", "Gaming: purchases on the account, and automation punished.", [
    "steampowered.com", "steamcommunity.com", "epicgames.com", "playstation.com", "xbox.com", "nintendo.com", "ea.com",
    "battle.net", "blizzard.com", "riotgames.com", "roblox.com",
  ]),
  ...byRule("payouts", "Seller or payout dashboard: money moves out, but it is not a bank or a payment app.", [
    "shopify.com", "stripe.com", "squareup.com", "gumroad.com", "patreon.com", "upwork.com", "fiverr.com", "poshmark.com", "mercari.com",
  ]),
];

export const POLICY = Object.freeze(RAW.map((e) => Object.freeze({ ...e })));

// ---------------------------------------------------------------- matching
/** The last two labels, or three for a two-letter country second level (co.uk). Same rule as src/signinemail.js. */
export function registrableOf(host) {
  const parts = String(host ?? "").toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const two = parts.slice(-2).join(".");
  return /^(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join(".") : two;
}

/** "prefix" (mychart.*), "suffix" (.gov), "domain" (chase.com and under) or "host" (exactly that host). */
export function matchKind(match) {
  const m = String(match ?? "");
  if (m.endsWith(".*")) return "prefix";
  if (m.startsWith(".")) return "suffix";
  return registrableOf(m) === m ? "domain" : "host";
}

function covers(match, kind, host) {
  if (kind === "host") return host === match;
  if (kind === "domain") return host === match || host.endsWith(`.${match}`);
  if (kind === "suffix") return host === match.slice(1) || host.endsWith(match);
  return host.startsWith(match.slice(0, -1)) && host.length > match.length - 1;
}
const labels = (m) => m.split(".").filter((p) => p && p !== "*").length;
const STRICTNESS = { [NEVER]: 2, [CAREFUL]: 1 };
const narrowness = (kind, m) => (kind === "prefix" ? 0 : labels(m) * 2 + (kind === "host" ? 1 : 0));

const COMPILED = POLICY.map((entry) => ({ entry, kind: matchKind(entry.match) }));

/** Private names and loopback: never a site's own public address. */
const NOT_PUBLIC = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/** The host a string or URL names, lowercased and punycoded, or "" when it names none. */
function hostOf(input) {
  let s = input instanceof URL ? input.href : typeof input === "string" ? input.trim() : "";
  if (!s || s.length > 2048) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // "mailto:", "javascript:" and friends name no site; "example.com:8443/x" is a host and a port.
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:?#]+:\d+(?:[/?#]|$)/.test(s)) return "";
    s = `https://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  return u.hostname.replace(/\.$/, "");
}

function notASite(host) {
  if (!host || !host.includes(".")) return true; // empty, "localhost", "intranet"
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // a bare address
  return NOT_PUBLIC.some((s) => host === s.slice(1) || host.endsWith(s));
}

// ---------------------------------------------------------------- the review list
const unknownSeen = new Map(); // registrable domain -> last seen, ms

function noteUnknown(domain, now) {
  unknownSeen.delete(domain);
  unknownSeen.set(domain, now);
  while (unknownSeen.size > REVIEW_LIST_MAX) unknownSeen.delete(unknownSeen.keys().next().value);
}

/** Unknown domains seen in the last week, sorted. Domain names only; in memory; for the owner. */
export function reviewList(now = Date.now()) {
  for (const [d, at] of unknownSeen) if (now - at > REVIEW_WINDOW_MS) unknownSeen.delete(d);
  return [...unknownSeen.keys()].sort();
}

/** Tests only. */
export function _resetReviewList() { unknownSeen.clear(); }

// ---------------------------------------------------------------- the classifier
const answer = (policy, category, reason, route, entry, host) => Object.freeze({ policy, category, reason, route, entry, host });

/**
 * Whether the site at `hostOrUrl` may have a saved login. One argument, on purpose: there is no
 * override, and a `never` is final for the call. Judges the host after parsing, nothing else:
 * "https://chase.com.evil.example" is evil.example, "https://chase.com@evil.example" too.
 * @returns {{ policy: "never"|"careful"|"allowed", category: string, reason: string, route: string|null, entry: object|null, host: string }}
 */
export function classifySite(hostOrUrl) {
  const host = hostOf(hostOrUrl);
  if (notASite(host)) {
    const c = CATEGORIES.not_a_site;
    return answer(NEVER, "not_a_site", c.why, c.route, null, host);
  }
  let best = null;
  for (const { entry, kind } of COMPILED) {
    if (!covers(entry.match, kind, host)) continue;
    const rank = STRICTNESS[entry.policy] * 1000 + narrowness(kind, entry.match);
    if (!best || rank > best.rank) best = { entry, rank };
  }
  if (best) {
    const { entry } = best;
    const route = entry.route ?? CATEGORIES[entry.category].route;
    return answer(entry.policy, entry.category, entry.reason, route, entry, host);
  }
  noteUnknown(registrableOf(host), Date.now());
  return answer(ALLOWED, "unknown", "Not on the never or careful list; on this week's review list.", null, null, host);
}

// ---------------------------------------------------------------- review of the data itself
const BASES = new Set(["rule", "review", "proposed"]);

/** What is wrong with a list of entries ([] when nothing). The test runs it on POLICY. */
export function problemsIn(list) {
  const out = [];
  const seen = new Set();
  for (const [i, e] of (Array.isArray(list) ? list : []).entries()) {
    const at = `entry ${i} (${e?.match ?? "?"})`;
    if (!e || typeof e !== "object") { out.push(`${at}: not an object`); continue; }
    if (typeof e.match !== "string" || !e.match || e.match !== e.match.toLowerCase().trim()) out.push(`${at}: match must be a lowercase host, domain, .suffix or label.*`);
    else if (seen.has(e.match)) out.push(`${at}: duplicate match`);
    else seen.add(e.match);
    const cat = Object.hasOwn(CATEGORIES, e.category) ? CATEGORIES[e.category] : null;
    if (!cat || e.category === "not_a_site") out.push(`${at}: unknown category ${e.category}`);
    else if (e.policy !== cat.policy) out.push(`${at}: policy ${e.policy} does not match category ${e.category} (${cat.policy})`);
    for (const k of ["reason", "source", "read_on", "reviewer"]) {
      if (typeof e[k] !== "string" || !e[k].trim()) out.push(`${at}: missing ${k}`);
    }
    if (typeof e.read_on === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(e.read_on)) out.push(`${at}: read_on must be YYYY-MM-DD`);
    if (!BASES.has(e.basis)) out.push(`${at}: basis must be rule, review or proposed`);
    if (e.basis === "review" && !/^https:\/\/\S+$/.test(String(e.source ?? ""))) out.push(`${at}: a review entry needs the https address of what was read`);
  }
  return out;
}
