// Finding what somebody pays for, and helping them stop paying for it.
//
// The split in this file is the same one the rest of Reason keeps, and it is worth stating before
// any of the code: **code pulls the facts, the model decides what they mean.**
//
//   Code does: run a fixed set of Gmail searches; group what comes back by who sent it; pull the
//   money and the dates out of the words with a regex, because a receipt is a document being
//   parsed and $17.99 is $17.99; work out a monthly total; refuse to write "cancelled" without a
//   confirmation; find a confirmation number in a page or an email.
//
//   The model does: decide which of those groups is a real recurring subscription and which is a
//   one-off order, a bill, a donation or a free newsletter; decide what somebody meant by "cancel
//   hulu"; decide whether a group of three receipts from one sender is one subscription or two.
//
// There is no regex anywhere in Reason that reads what a PERSON said in order to decide what they
// want. The regexes here read receipts and web pages, which is the other thing entirely.
//
// The one rule that matters most in this file: **nothing is "cancelled" until a confirmation
// exists.** A cancel flow that has been walked and not confirmed is `cancelling`, and
// `subscription_list` says so out loud. That is not caution for its own sake — a person told their
// subscription is cancelled stops watching their bank, and a retention flow that quietly kept them
// is exactly the thing they asked for help with.
import { clock, config } from "./config.js";
import * as db from "./db.js";
import * as cancelRoutes from "./cancel-routes.js";
import { signature } from "./represent.js";

// ---------- what to search for ----------
//
// A fixed set, written down rather than improvised per turn, for two reasons. A scan has to be the
// same scan every time, or "you missed one" has no answer; and these are the words a receipt
// actually uses, which is a different list from the words a person would type. Each query carries
// what it is for, because a query nobody can explain is a query nobody will maintain.
//
// Gmail's own search syntax, the same thing somebody would type into the box. `newer_than` is not
// used: the months window becomes an `after:` date so the result is reproducible from the clock
// rather than from when Google feels the day started.
export const SEARCHES = [
  { label: "receipts", q: 'subject:(receipt OR invoice OR "payment received" OR "your payment")', why: "the ordinary monthly receipt, which is most of them" },
  { label: "subscription", q: '"your subscription" OR "subscription confirmation" OR "subscription renewal"', why: "anything that calls itself a subscription in so many words" },
  { label: "renewal", q: 'subject:(renewal OR renewed OR "auto-renew" OR "will renew")', why: "the warning before a yearly plan takes the money again" },
  { label: "trials", q: '"trial ends" OR "trial will end" OR "free trial" OR "trial period"', why: "a trial about to turn into a charge, which is the one worth catching early" },
  { label: "app_stores", q: 'from:(apple.com OR itunes.com OR googleplay-noreply@google.com OR payments-noreply@google.com)', why: "App Store and Google Play receipts, which bundle several subscriptions into one email" },
  { label: "billers", q: 'from:(netflix.com OR spotify.com OR hulu.com OR disneyplus.com OR hbomax.com OR max.com OR amazon.com OR youtube.com OR adobe.com OR audible.com OR onepeloton.com OR nytimes.com OR openai.com OR planetfitness.com)', why: "the services in the cancel-route registry, by their own sending domains" },
  { label: "charges", q: '"you have been charged" OR "we have charged" OR "payment successful" OR "thanks for your payment"', why: "a charge that does not call itself a receipt" },
  { label: "cards", q: '"card ending in" OR "your card was charged" OR "billed to"', why: "the line a payment processor writes, which catches billers nobody thought of" },
];

/** `after:YYYY/MM/DD`, which is the format Gmail's own search box takes. */
export function afterDate(months, now = clock.now()) {
  const d = new Date(now);
  d.setMonth(d.getMonth() - Math.max(1, Math.min(60, Number(months) || 12)));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/**
 * The queries one scan runs, in order, newest mail first.
 *
 * Every one is bounded by the same `after:` date, so a scan covers exactly the window it was asked
 * for and the result can be quoted as such: "the last twelve months of your mail", not "some mail".
 */
export function queriesFor({ months = 12, now = clock.now() } = {}) {
  const after = afterDate(months, now);
  return SEARCHES.map(s => ({ label: s.label, why: s.why, query: `(${s.q}) after:${after}` }));
}

// ---------- pulling the facts out of a receipt ----------
//
// Regexes, and the right place for them: this is a document being parsed, not a person being read.

// Dollars, pounds and euros, written the three ways a receipt writes them. Deliberately NOT a bare
// number: "ending in 4242" and "order 1899" are both numbers, and guessing a currency from a bare
// one is how $40 becomes ¥40.
const MONEY = /(?:(?<sym>US\$|\$|£|€)\s?(?<a>\d[\d,]*(?:\.\d{1,2})?))|(?:(?<b>\d[\d,]*(?:\.\d{1,2})?)\s?(?<code>USD|GBP|EUR|dollars|pounds|euros))/gi;

const CURRENCY_OF = {
  "$": "USD", "us$": "USD", "usd": "USD", dollars: "USD",
  "£": "GBP", gbp: "GBP", pounds: "GBP",
  "€": "EUR", eur: "EUR", euros: "EUR",
};

/**
 * Every amount in some text, as `{ cents, currency, as_written }`, in the order they appear.
 *
 * Returned in order rather than sorted, because on a receipt the order carries meaning — the first
 * amount is usually the charge and a later one is usually a tax line or a total — and deciding which
 * is which is the model's call, not this function's.
 */
export function moneyIn(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(MONEY)) {
    const g = m.groups ?? {};
    const raw = (g.a ?? g.b ?? "").replace(/,/g, "");
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const marker = String(g.sym ?? g.code ?? "").toLowerCase();
    out.push({
      cents: Math.round(n * 100),
      currency: CURRENCY_OF[marker] ?? "USD",
      as_written: m[0].trim(),
    });
  }
  return out;
}

// Dates, in the shapes a receipt writes them. Only real-looking ones: a four-digit year, or a named
// month. "12/10" with no year is left alone, because nobody can tell whether that is December or
// October and a renewal date off by eleven months is worse than no renewal date.
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const DATES = new RegExp(
  "\\b(?:"
  + "\\d{4}-\\d{2}-\\d{2}"                                     // 2026-10-12
  + `|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}` // October 12, 2026
  + `|\\d{1,2}\\s+(?:${MONTHS})\\.?\\s+\\d{4}`                   // 12 October 2026
  + "|\\d{1,2}/\\d{1,2}/\\d{2,4}"                                // 10/12/2026
  + ")\\b", "gi");

/** Every date-looking string in some text, as written, de-duplicated and in order. */
export function datesIn(text) {
  return [...new Set((String(text ?? "").match(DATES) ?? []).map(s => s.trim()))];
}

// The phrases that say WHICH date a date is. A receipt is full of dates and only one of them is the
// renewal; the sentence around it is what says so, which is why this looks at the words before the
// number rather than at the number.
const RENEWAL_NEAR = /\b(?:renews?(?:\s+on)?|renewal\s+date|next\s+(?:payment|billing|charge|renewal)|will\s+(?:renew|be\s+charged)|auto-?renews?(?:\s+on)?|trial\s+ends?(?:\s+on)?|next\s+bill)\b[^.\n]{0,60}/gi;
const CHARGED_NEAR = /\b(?:charged|paid|payment\s+(?:received|date)|billed(?:\s+on)?|receipt\s+date|date\s+of\s+(?:charge|purchase))\b[^.\n]{0,60}/gi;

/** The renewal date a receipt names, if the words around a date say that is what it is. */
export function renewalDateIn(text) {
  for (const phrase of String(text ?? "").match(RENEWAL_NEAR) ?? []) {
    const hit = datesIn(phrase);
    if (hit.length) return hit[0];
  }
  return "";
}

/** The date a receipt says the money went, same idea. */
export function chargedDateIn(text) {
  for (const phrase of String(text ?? "").match(CHARGED_NEAR) ?? []) {
    const hit = datesIn(phrase);
    if (hit.length) return hit[0];
  }
  return "";
}

// How often, from the words a receipt uses for it. `unknown` whenever nothing says, which is most
// of the time on a single receipt — two receipts a month apart from the same sender is what really
// says "monthly", and noticing that is the model's job.
const CADENCE = [
  ["yearly", /\b(?:annual(?:ly)?|per\s+year|\/\s*year|\/yr|a\s+year|12\s+months?|yearly)\b/i],
  ["monthly", /\b(?:monthly|per\s+month|\/\s*month|\/mo\b|a\s+month|each\s+month)\b/i],
  ["weekly", /\b(?:weekly|per\s+week|\/\s*week|a\s+week)\b/i],
];

export function cadenceIn(text) {
  const s = String(text ?? "");
  for (const [name, re] of CADENCE) if (re.test(s)) return name;
  return "unknown";
}

/** The sender's bare address out of a From header, lowercased. `"Netflix <info@netflix.com>"` → the address. */
export function addressOf(from) {
  const s = String(from ?? "");
  const angled = /<([^>]+)>/.exec(s);
  const addr = (angled ? angled[1] : s).trim().toLowerCase();
  return /@/.test(addr) ? addr : "";
}

/** The human name out of a From header, or the address when there is no name. */
export function nameOf(from) {
  const s = String(from ?? "").trim();
  const angled = s.indexOf("<");
  const name = (angled > 0 ? s.slice(0, angled) : "").replace(/^["']|["']$/g, "").trim();
  return name || addressOf(s) || s;
}

/** The sending domain, which is what groups two addresses at one company together. */
export function domainOf(from) {
  const addr = addressOf(from);
  if (!addr) return "";
  const host = addr.split("@")[1] ?? "";
  // Keep the registrable-looking tail: no-reply@email.netflix.com and info@netflix.com are Netflix.
  const bits = host.split(".").filter(Boolean);
  return bits.length > 2 ? bits.slice(-2).join(".") : host;
}

/**
 * Candidate messages grouped by who sent them, each with whatever money and dates the code could
 * pull out of the words it has.
 *
 * Grouped by sending DOMAIN rather than by exact address, because one company sends receipts from
 * four addresses and a list with Netflix on it four times is a list nobody can read.
 *
 * What this deliberately does NOT do is decide anything. Every group comes back, including the ones
 * that are obviously a shop confirming an order, because "obviously" is a judgement and the judge is
 * the model. The fields are facts; `subscription_record` is where a decision gets written down.
 */
export function groupBySender(messages = []) {
  const groups = new Map();
  for (const m of messages) {
    const from = m.from ?? "";
    const key = domainOf(from) || addressOf(from) || nameOf(from) || "(no sender)";
    if (!groups.has(key)) {
      groups.set(key, {
        sender: nameOf(from),
        sender_domain: domainOf(from),
        addresses: new Set(),
        accounts: new Set(),
        count: 0,
        messages: [],
        amounts: [],
        dates: [],
      });
    }
    const g = groups.get(key);
    const words = [m.subject ?? "", m.snippet ?? "", m.text ?? ""].join("\n");
    const amounts = moneyIn(words);
    const renewal = renewalDateIn(words);
    const charged = chargedDateIn(words);
    g.count++;
    if (addressOf(from)) g.addresses.add(addressOf(from));
    if (m.account) g.accounts.add(m.account);
    for (const a of amounts) g.amounts.push(a.as_written);
    for (const d of datesIn(words)) g.dates.push(d);
    g.messages.push({
      id: m.id ?? "",
      account: m.account ?? "",
      subject: m.subject ?? "",
      date: m.date ?? "",
      snippet: m.snippet ?? "",
      ...(amounts.length ? { amounts: amounts.map(a => ({ ...a, shown: money(a.cents, a.currency) })) } : {}),
      ...(renewal ? { renewal_date: renewal } : {}),
      ...(charged ? { charged_date: charged } : {}),
      ...(cadenceIn(words) !== "unknown" ? { cadence: cadenceIn(words) } : {}),
      found_by: m.found_by ?? [],
    });
    g.matched = cancelRoutes.match(`${nameOf(from)} ${domainOf(from)}`)?.service ?? "";
  }
  return [...groups.values()]
    .map(g => ({
      sender: g.sender,
      ...(g.sender_domain ? { sender_domain: g.sender_domain } : {}),
      addresses: [...g.addresses],
      ...(g.accounts.size ? { in_accounts: [...g.accounts] } : {}),
      messages_found: g.count,
      amounts_seen: [...new Set(g.amounts)].slice(0, 8),
      dates_seen: [...new Set(g.dates)].slice(0, 8),
      ...(g.matched ? { known_cancel_route: g.matched } : {}),
      messages: bestMessages(g.messages, 3),
    }))
    .sort((a, b) => b.messages_found - a.messages_found);
}

function messageSignal(m) {
  let s = 0;
  if (m.amounts?.length) s += 2;
  if (m.renewal_date) s += 3;
  if (m.cadence && m.cadence !== "unknown") s += 2;
  s += (m.found_by?.length ?? 1) - 1;
  return s;
}

function bestMessages(msgs, cap) {
  if (msgs.length <= cap) return msgs;
  return msgs.slice().sort((a, b) => messageSignal(b) - messageSignal(a)).slice(0, cap);
}

export function scoreGroup(g) {
  let s = 0;
  if (g.amounts_seen?.length) s += 2;
  if (g.known_cancel_route) s += 5;
  const msgs = g.messages ?? [];
  if (msgs.some(m => m.renewal_date)) s += 3;
  if (msgs.some(m => m.cadence && m.cadence !== "unknown")) s += 2;
  if (g.messages_found >= 2) s += 1;
  if (g.messages_found >= 4) s += 1;
  const allFoundBy = new Set(msgs.flatMap(m => m.found_by ?? []));
  if (allFoundBy.size >= 2) s += 1;
  if (allFoundBy.size >= 4) s += 2;
  return s;
}

// ---------- the money, said out loud ----------

const SYMBOL = { USD: "$", GBP: "£", EUR: "€" };

export function money(cents, currency = "USD") {
  if (cents == null) return "";
  const sym = SYMBOL[currency] ?? "";
  const n = (Math.abs(cents) / 100).toFixed(2);
  return sym ? `${sym}${n}` : `${n} ${currency}`;
}

/** A yearly or weekly price as what it costs a month, so a total means something. */
export function perMonthCents(row) {
  if (row.amount_cents == null) return null;
  switch (row.cadence) {
    case "monthly": return row.amount_cents;
    case "yearly": return Math.round(row.amount_cents / 12);
    case "weekly": return Math.round((row.amount_cents * 52) / 12);
    default: return null;
  }
}

/**
 * What this costs a month, and — just as important — what could not be counted.
 *
 * A total that silently left out the three subscriptions with no price on them would be a smaller,
 * friendlier, wrong number. So the ones that could not be counted come back by name and the tool
 * that shows the total says so.
 *
 * Mixed currencies are counted separately rather than added: there is no exchange rate here and
 * inventing one would be inventing the answer.
 */
export function monthlyTotal(rows = []) {
  const live = rows.filter(r => r.status === "active" || r.status === "cancelling");
  const byCurrency = new Map();
  const uncounted = [];
  for (const r of live) {
    const per = perMonthCents(r);
    if (per == null) {
      uncounted.push({ merchant: r.merchant, why: r.amount_cents == null ? "no price found" : `cadence is ${r.cadence}` });
      continue;
    }
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + per);
  }
  return {
    counted: live.length - uncounted.length,
    totals: [...byCurrency.entries()].map(([currency, cents]) => ({ currency, cents, shown: money(cents, currency) })),
    uncounted,
  };
}

// ---------- the overview page ----------

/** One row on the page: the merchant bold, the cadence and renewal grey, the amount on the right. */
function rowFor(r) {
  const detail = [
    r.cadence === "unknown" ? "how often is not known" : r.cadence,
    r.next_renewal ? `renews ${r.next_renewal}` : (r.last_charged ? `last charged ${r.last_charged}` : ""),
    r.status === "cancelling" ? "cancelling — no confirmation yet" : "",
    r.status === "cancelled" ? `cancelled${r.confirmation ? "" : " (no confirmation on record)"}` : "",
    r.status === "kept" ? "keeping it" : "",
  ].filter(Boolean).join(" · ");
  return {
    name: r.merchant,
    detail,
    value: r.amount_cents == null ? "?" : money(r.amount_cents, r.currency),
  };
}

/**
 * The blocks for "what am I paying for", as a page.
 *
 * Built in code rather than left to the model to lay out, so the numbers on the page are the numbers
 * in the table and a page cannot quietly disagree with `subscription_list`. The model supplies the
 * one thing code cannot know — which of these look forgotten — and that goes in a callout whose
 * title says it is a guess, because it is one: a mailbox says what somebody is paying for and
 * nothing at all about what they are using.
 *
 * `forgotten` is `[{ merchant, why }]` in the model's own words.
 */
export function overviewBlocks(rows = [], { forgotten = [], months = 12, accounts = [] } = {}) {
  const live = rows.filter(r => r.status === "active" || r.status === "cancelling" || r.status === "unknown");
  const closed = rows.filter(r => r.status === "cancelled" || r.status === "kept");
  const total = monthlyTotal(rows);
  const blocks = [];

  if (!live.length) {
    blocks.push({ type: "text", text: `Nothing is on this list yet. It fills up from receipts in ${accounts.length ? accounts.join(" and ") : "the connected mailbox"}, and only what a receipt actually said goes on it.` });
  } else {
    blocks.push({ type: "rows", title: "Going out", items: live.map(rowFor) });
  }

  if (total.totals.length) {
    const sums = total.totals.map(t => t.shown).join(" + ");
    blocks.push({
      type: "callout",
      tone: "note",
      title: "A month",
      text: `${sums} a month across ${total.counted} of them.`
        + (total.uncounted.length
          ? ` Not in that number: ${total.uncounted.map(u => `${u.merchant} (${u.why})`).join(", ")} — so the real figure is higher.`
          : ""),
    });
  } else if (live.length) {
    blocks.push({
      type: "callout",
      tone: "note",
      title: "A month",
      text: "No monthly total: none of these has both a price and a billing period on record yet.",
    });
  }

  if (forgotten.length) {
    blocks.push({
      type: "callout",
      tone: "warning",
      title: "A guess, not a fact",
      text: `These look forgotten to me: ${forgotten.map(f => `${f.merchant}${f.why ? ` — ${f.why}` : ""}`).join("; ")}.`
        + ` That is a guess off your receipts. Receipts say what you pay for and nothing about what you use, so check before cancelling anything.`,
    });
  }

  if (closed.length) {
    blocks.push({ type: "rows", title: "Done with", items: closed.map(rowFor) });
  }

  blocks.push({
    type: "text",
    text: `Read off the last ${months} months of receipts${accounts.length ? ` in ${accounts.join(" and ")}` : ""}.`
      + ` Anything billed to a card and never emailed about is not here, and neither is anything from before that window.`,
  });
  return blocks;
}

// ---------- the confirmation ----------
//
// The whole point of the `cancelling` state is that this function, or the person's own eyes, has to
// come back with something before a subscription is called cancelled.

// A confirmation number, as the services write it. The label is required: a bare number on a
// cancellation page is as likely to be a price or an order from last week.
const CONFIRM_NUMBER = /\b(?:confirmation|reference|cancellation|case|ticket|request)\s*(?:number|no\.?|#|code|id)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i;
// The other kind of proof: the date it stops. "Your membership ends on October 31, 2026".
const ENDS_ON = new RegExp(
  `\\b(?:ends?|expires?|access\\s+(?:ends|runs)|through|until|final\\s+day|last\\s+day|runs\\s+(?:to|until))\\b`
  + `[^.\\n]{0,40}?(\\d{4}-\\d{2}-\\d{2}|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}/\\d{1,2}/\\d{2,4})`, "i");
// And the plainest one: the page saying it in words.
const SAYS_CANCELLED = /\b(?:has been|is now|successfully|been)\s+(?:cancell?ed|canceled)\b|\byour\s+(?:membership|subscription|plan)\s+(?:has been|is)\s+(?:cancell?ed|canceled)\b|\bcancellation\s+(?:complete|confirmed)\b/i;

/**
 * A confirmation out of page text or an email, or null.
 *
 * Strongest first: a reference number is the best thing to put on a record, an end date is the next
 * best, and "it says cancelled" is the weakest and is reported as exactly that rather than dressed
 * up. Null means there is nothing, and null is what keeps a subscription at `cancelling`.
 */
export function confirmationIn(text) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  const num = CONFIRM_NUMBER.exec(s);
  if (num) return { kind: "number", value: num[1], as_written: num[0].trim() };
  const ends = ENDS_ON.exec(s);
  if (ends) return { kind: "ends_on", value: ends[1], as_written: ends[0].trim() };
  const says = SAYS_CANCELLED.exec(s);
  if (says) return { kind: "says_cancelled", value: says[0].trim(), as_written: says[0].trim() };
  return null;
}

/**
 * The Gmail query that would find a cancellation confirmation from one merchant.
 *
 * Built from the merchant's own sending domain where the row has one, falling back to its name.
 * Narrow on purpose: this runs on a wake-up, and a wide query would hand the model a mailbox to
 * sift rather than an answer.
 */
export function confirmationQuery(row, { months = 1, now = clock.now(), routes = cancelRoutes } = {}) {
  const entry = row.service ? routes.route(row.service) : routes.match(row.merchant);
  const host = entry?.hosts?.[0] ?? "";
  const who = host ? `from:${host}` : `"${String(row.merchant).replace(/"/g, "")}"`;
  return `${who} (cancel OR cancelled OR canceled OR cancellation OR "your membership" OR "has ended" OR "will end") after:${afterDate(months, now)}`;
}

// ---------- the written cancellation ----------

/**
 * The body of a cancellation request, written for a person to read and approve.
 *
 * Code writes it rather than the model, for the same reason code writes the announcement at the top
 * of a phone call: it has to say the true things every time. It names who is asking, what they want,
 * that it is an assistant writing on their behalf and not them — Reason is never the person it works
 * for — and it asks for the one thing that makes this rail work at all, which is a reply confirming
 * it. The model can still show it, and the person can still change it before it goes.
 */
export function cancellationEmail({ merchant, ownerName = config.ownerName, accountRef = "", lastCharged = "", reason = "" }) {
  const who = ownerName || "the account holder";
  const lines = [
    `Hello,`,
    ``,
    `I'm writing on behalf of ${who} to cancel their ${merchant} subscription, effective at the end of the current billing period.`,
    accountRef ? `The account is ${accountRef}.` : ``,
    lastCharged ? `The most recent charge we have a record of was ${lastCharged}.` : ``,
    reason ? `${reason}` : ``,
    ``,
    `Please confirm in a reply that the subscription is cancelled, and include a cancellation or reference number and the date access ends. We will treat it as still active until that confirmation arrives.`,
    ``,
    `Thank you,`,
    // The whole sign-off, from the one place it is written (src/represent.js). It used to be
    // "<name>'s assistant", which reads like a human employee — and the check that refuses an
    // outside email with no sign-off on it refuses that one too, so the two had to agree. They agree
    // by sharing the string rather than by both happening to be right.
    signature(who),
  ];
  return {
    subject: `Cancellation request — ${merchant}`,
    body: lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n").trim() + "\n",
    note: "Written by code, not improvised: it says who is asking, that an assistant is writing for them rather than as them, and it asks for a confirmation with a reference number — which is the thing that lets this be recorded as really cancelled.",
  };
}

// ---------- the rails ----------

/**
 * Which rail a merchant's cancellation runs on, and everything needed to walk it.
 *
 * Reads the registry, not the row: a row's `cancel_route` is a copy of what the registry said when
 * it was written down, and the registry is the thing that gets corrected. The row's own route is
 * still returned when there is no registry entry at all, because somebody may have told Reason how
 * their gym works and that is better than nothing.
 */
export function railFor(row, { service = "", routes = cancelRoutes } = {}) {
  const named = service ? routes.route(service) : null;
  const entry = named ?? (row?.service ? routes.route(row.service) : null) ?? routes.match(row?.merchant ?? "");
  if (!entry) {
    const route = row?.cancel_route && row.cancel_route !== "unknown" ? row.cancel_route : "unknown";
    return {
      rail: route,
      from: "the record, not the registry",
      entry: null,
      ...(row?.cancel_url ? { cancel_url: row.cancel_url } : {}),
      ...(row?.cancel_email ? { cancel_email: row.cancel_email } : {}),
    };
  }
  return { rail: entry.route, from: "the cancel-route registry", entry, cancel_url: entry.cancel_url ?? "", cancel_email: entry.cancel_email ?? "" };
}

/** Which rails a tool may actually walk today, and the honest refusal for the rest. */
export const WALKABLE = new Set(["web", "email"]);

/**
 * Reason's capability line for subscriptions, written from what is really connected.
 *
 * Finding them needs Gmail. Cancelling on the web needs the browser and a sign-in the person did
 * themselves. Cancelling by phone needs a rail that is not built. Those are three different answers
 * and a capability list that gave one would be wrong about two of them.
 */
// ---------- renewal date parsing ----------

const MONTH_MAP = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseRenewalDate(text, now = clock.now()) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  // "Month Day" without year — before the direct parse, because `new Date("Nov 9")`
  // produces 2001 in some runtimes rather than failing.
  const monthDay = s.match(new RegExp(`^(${Object.keys(MONTH_MAP).join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$`, "i"));
  if (monthDay) {
    const month = MONTH_MAP[monthDay[1].toLowerCase().slice(0, 3)];
    const day = Number(monthDay[2]);
    const today = new Date(now);
    let year = today.getFullYear();
    const candidate = new Date(year, month, day);
    if (candidate.getTime() < now) candidate.setFullYear(year + 1);
    return candidate.getTime();
  }
  const direct = new Date(s);
  if (!isNaN(direct.getTime()) && direct.getFullYear() >= 2020) return direct.getTime();
  return null;
}

export function advanceRenewal(renewalAtMs, cadence) {
  if (!renewalAtMs || !cadence || cadence === "unknown") return null;
  const d = new Date(renewalAtMs);
  switch (cadence) {
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    default: return null;
  }
  return d.getTime();
}

export function backfillRenewalDates(conversationId) {
  const rows = db.listSubscriptions(conversationId, { includeClosed: false });
  let filled = 0;
  for (const row of rows) {
    if (row.next_renewal_at) continue;
    if (!row.next_renewal) continue;
    const at = parseRenewalDate(row.next_renewal);
    if (at) { db.setRenewalAt(conversationId, row.id, at); filled++; }
  }
  return filled;
}

export function statusNow(conversationId, { gmailConnected = false } = {}) {
  const mid = db.cancellingSubscriptions(conversationId).length;
  const live = db.listSubscriptions(conversationId).length;
  return {
    status: gmailConnected ? "live" : "not connected",
    what: (gmailConnected
      ? "find what they are paying for by reading a year of receipts in their own mail, keep the list, and cancel on the web or by a written request — both behind their explicit yes"
      : "finding subscriptions reads their receipts, so it needs Google connected first. Say that rather than guessing at a list")
      + ". Nothing is ever called cancelled without a confirmation — a flow that has been walked and not confirmed reads as 'cancelling', and that is said out loud."
      + " Cancelling by phone is NOT built: for a service that only cancels over the phone, say so honestly and offer to ring them once calling exists."
      + " An App Store subscription is cancelled in Settings on their own phone, which Reason cannot tap — say the four taps instead."
      + (live ? ` There ${live === 1 ? "is" : "are"} ${live} on the list right now${mid ? `, ${mid} mid-cancel with no confirmation yet` : ""}.` : ""),
  };
}
