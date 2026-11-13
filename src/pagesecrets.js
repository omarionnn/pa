// What is typed into a secret box never leaves the page it was typed into.
//
// Reason drives its own browser, and a page it reads can be holding a password, a one-time code or
// a card number: typed by the person through the sign-in link, prefilled by the site, or left there
// by the profile. The promise is "i never keep or see your password" (src/amazonconnect.js) and "No
// password ever reaches Reason" (src/signin.js). Until 2026-11-13 the page reading returned the first
// 80 characters of every box, password boxes included (found by the account-access design review;
// the live log held no such reading). So a reading says a secret box EXISTS and whether it is FILLED,
// and never what is in it.
//
// Two layers, one rule:
//   1. In the page (secretRules, joined to every reading function by `inPage`): a secret box's value
//      is never read out of the page at all, and any copy of it the site printed into its own text,
//      an element's name, another box or an address is cut before the reading leaves the page.
//   2. In this process (scrubPageSecrets): the one scrubber every record of a tool's result passes
//      through (the model's copy, the tool log line, the action ledger), so a reading function that
//      forgets layer 1 still cannot put the contents of a secret box anywhere they are kept.
//
// The rule (secretWords.kindOf) prefers withholding to leaking: a box wrongly called secret costs a
// read-back of something the model typed itself; a box wrongly called plain is somebody's password
// in a prompt, a log and a ledger row.

/** What stands where a secret was. */
export const HIDDEN = "[hidden]";

/**
 * The words that make a box secret. Pure and self-contained: it is used here on what a reading
 * returned, and serialized into the page to decide what a reading may return. No outside names.
 *
 *   kindOf({ tag, type, autocomplete, own: [name, id], said: [each label source], context, cardForm })
 *     → "" (an ordinary box) or the kind: password | code | card | csc | expiry | id | secret
 */
export function secretWords() {
  const norm = (s, max = 400) => String(s == null ? "" : s).slice(0, max * 2)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2").replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/#/g, " number ").replace(/[^a-zA-Z0-9À-ɏ]+/g, " ")
    .toLowerCase().replace(/\s+/g, " ").trim().slice(0, max);

  // What the browser itself is told a box holds.
  const AC_SECRET = ["current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year"];
  const AC_KIND = ["password", "password", "code", "card", "csc", "expiry", "expiry", "expiry"];
  const acKind = (ac) => {
    for (const t of String(ac == null ? "" : ac).toLowerCase().split(/\s+/)) {
      const i = AC_SECRET.indexOf(t);
      if (i >= 0) return AC_KIND[i];
    }
    return "";
  };

  const STRONG = [
    [/\bpass ?(word|wd|code|phrase)s?\b|\bpwd\b|\bpasswort\b|\bkennwort\b|\bcontrase[nñ]a\b|\bmot de passe\b|\bsenha\b|\bwachtwoord\b/, "password"],
    [/\b(card|cc) ?(number|num|no|nr)\b|\bccn\b/, "card"],
    [/\bsecurity ?code\b|\bcard ?(verification|security|validation) ?(code|value|number)\b|\bcv[vcn]\b|\bcsc\b/, "csc"],
    [/\bssn\b|\bsocial (security|insurance)\b|\btax ?payer ?id|\btax ?id\b|\bnational (id|insurance)\b/, "id"],
    [/\bone ?time (pass ?(word|code)|code|pin|token|key)\b|\b[th]?otp\b|\b2 ?fa\b|\bmfa\b|\b(two|2|multi) ?(factor|step)\b|\bverif(y|ication)? ?(code|pin)\b/, "code"],
    [/\b(auth|authentication|authenticator|authorization|login|log ?in|sign ?in|sms|text message|texted|e ?mail|e ?mailed|recovery|backup) ?(code|token)\b/, "code"],
    [/\b\d+ digit (code|pin|passcode)\b|\bcode (we|was|has been|that was|that we|i) ?(just )?(sent|texted|e ?mailed)\b|\b(sent|texted|e ?mailed) (you |to you )?(a|the|your) (\d+ digit )?code\b|\bcode from (your|the) (authenticator|auth|app|phone|e ?mail|text|sms)\b/, "code"],
    [/\b(security|secret) (answer|word|phrase|key)\b|\bmemorable (word|information|answer)\b|\bsecret\b|\b(api|private|access|client) ?(key|secret|token)\b|\b(recovery|seed) (key|phrase|words?)\b|\bmnemonic\b/, "secret"],
  ];
  // In India a "PIN code" is a postal code. A PIN beside the words of an address is that one.
  const POSTAL = /\b(zip|postal|post ?code|pincode|area|delivery|deliver|shipping|address|city|locality|district)\b/;
  const CARD = /\b(credit|debit|payment) ?card\b/;
  const NOT_THE_NUMBER = /\b(name|holder|type|brand|zip|postal|address|country|nick ?name)\b/;
  const EXP = /\b(exp|expiry|expiration|expires?|valid (thru|through|until)|mm ?yy(yy)?)\b/;
  const CARDISH = /\b(card|cc|credit|debit|payment)\b/;

  const byWords = (words) => {
    if (!words) return "";
    if (EXP.test(words) && CARDISH.test(words)) return "expiry";
    for (const [re, kind] of STRONG) if (re.test(words)) return kind;
    if (/\bpin\b/.test(words) && !POSTAL.test(words)) return "code";
    if (CARD.test(words) && !NOT_THE_NUMBER.test(words)) return "card";
    return "";
  };

  // A label is prose, and prose about an ordinary box can name a secret: "Phone number (we'll text
  // you a verification code)" is a phone box. What a box IS comes first in its label, so the head is
  // read before the rest: everything up to the first aside or joining word.
  const HEAD_END = /[([{:;,.!?–—/|]| - | (?:we|we'll|we’ll|so|to|for|where|that|which|and|or|if|will|must|should|is|are|was|not|never)\b/i;
  const headOf = (raw) => {
    const s = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
    const m = HEAD_END.exec(s.slice(1));
    return norm(m ? s.slice(0, m.index + 1) : s).split(" ").slice(0, 7).join(" ");
  };
  const SEARCHY = /\b(search|find|filter|look ?up)\b/;
  const PLAIN_HEAD = /\b(e ?mail|user ?(name|id)|login ?id|phone|mobile|telephone|name|address|street|city|zip|postal|post ?code|country|state|company|website|url|message|comment|subject|promo|coupon|discount|voucher|gift|referral|invite)\b/;
  const bySaid = (raw) => {
    const head = headOf(raw);
    if (!head || SEARCHY.test(head)) return "";
    const k = byWords(head);
    if (k) return k;
    return PLAIN_HEAD.test(head) ? "" : byWords(norm(raw));
  };

  // A box called only "code" (or a "confirmation code", which is an airline's booking reference as
  // often as it is a texted code) is secret when the form around it says a code was sent.
  const NAMED = /\b(confirmation|confirm|access|activation|text) ?(code|token)\b/;
  const BARE_STOP = /\b(enter|your|the|a|an|code|token|digits?|number|here|please|type|input|field|box|value|required|txt|text|id|form|inp|in|\d+)\b/g;
  const weakCode = (words) => !/\b(code|token)\b/.test(words) ? ""
    : NAMED.test(words) ? "named"
    : words.replace(BARE_STOP, "").replace(/[^a-z]+/g, "") === "" ? "bare" : "";
  const SENT = /\b(sent|texted|e ?mailed|messaged) .{0,40}\bcode\b|\bcode\b.{0,30}\b(sent|texted|e ?mailed)\b|\bcheck your (phone|e ?mail|texts|messages|inbox|device)\b|\bresend\b|\bdidn t (get|receive)\b|\bauthenticat\w*|\bone ?time (pass ?(word|code)|code|pin)\b|\b[th]?otp\b|\b(two|2|multi) ?(factor|step)\b|\b2 ?fa\b|\bmfa\b/;
  const VERIFY = /\bverif(y|ication|ying)\b|\bsecurity code\b|\b(log ?in|sign ?in) code\b/;

  const TYPED = /^(|text|password|tel|number|email|url|search|date|month)$/;
  const list = (v) => (Array.isArray(v) ? v : [v]).filter(x => typeof x === "string" && x.trim());

  const kindOf = ({ tag = "input", type = "", autocomplete = "", role = "", own = [], said = [], context = "", cardForm = false } = {}) => {
    tag = String(tag || "input").toLowerCase();
    type = String(type || "").toLowerCase();
    if (tag === "input" && type === "password") return "password";
    if (tag !== "textarea" && tag !== "select" && !(tag === "input" && TYPED.test(type))) return "";
    const ac = acKind(autocomplete);
    if (ac) return ac;
    // A search box and an email box are what they say they are, whatever the words around them.
    if (type === "search" || type === "email" || String(role || "").toLowerCase() === "searchbox") return "";
    const mine = norm(list(own).join(" "));
    let k = byWords(mine);
    if (k) return k;
    for (const s of list(said)) { k = bySaid(s); if (k) return k; }
    const all = norm(mine + " " + list(said).join(" "), 800);
    const weak = weakCode(all);
    if (weak) {
      const around = norm(typeof context === "function" ? context() : context, 3000);
      if (SENT.test(around) || (weak === "bare" && VERIFY.test(around))) return "code";
    }
    if (cardForm && EXP.test(all)) return "expiry";
    return "";
  };

  return { norm, acKind, byWords, bySaid, headOf, weakCode, kindOf };
}

/**
 * The rule, applied to a live page. Runs INSIDE the page, handed the words (secretWords()) as `W`.
 * Browser globals only.
 *
 *   kind(el)     "" or the kind of secret box this element is
 *   hide(text)   the text without any copy of what a secret box on this page holds
 *   hideUrl(u)   the same for an address, and without the value of a parameter named for a secret box
 *   nameOf(el)   a box's label, never falling back to what is typed in a secret one
 */
/* eslint-env browser */
export function secretRules(W) {
  const HIDDEN = "[hidden]";
  // A box that was ever a password box is one for the life of the page: a "show password" toggle
  // turns it into a text box, and its contents are no less a password for that. The memory is kept
  // on the page itself (watchPasswordBoxes fills it from the first moment; this reading adds to it).
  const KEY = Symbol.for("reason.secret-boxes");
  let mem = window[KEY];
  if (!(mem instanceof WeakSet)) {
    mem = new WeakSet();
    try { Object.defineProperty(window, KEY, { value: mem, configurable: true }); } catch { /* kept for this reading only */ }
  }
  const attr = (el, n) => el.getAttribute(n) || "";
  const typeOf = (el) => attr(el, "type").toLowerCase();
  const saidOf = (el) => {
    const out = [attr(el, "aria-label")];
    for (const id of attr(el, "aria-labelledby").split(/\s+/)) { const n = id && document.getElementById(id); if (n) out.push(n.textContent || ""); }
    if (el.id) { try { for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) out.push(l.textContent || ""); } catch { /* an id no selector can hold */ } }
    const wrap = el.closest("label");
    if (wrap) out.push(wrap.textContent || "");
    out.push(attr(el, "placeholder"), attr(el, "aria-placeholder"), attr(el, "title"));
    return out;
  };
  const around = (el) => {
    const box = el.form || el.closest("form, [role=form], dialog, [role=dialog], fieldset, main, section, article") || document.body;
    return box ? String(box.innerText || "").slice(0, 3000) : "";
  };
  const byRule = (el, cardForm) => W.kindOf({
    tag: el.tagName, type: typeOf(el), autocomplete: attr(el, "autocomplete"), role: attr(el, "role"),
    own: [attr(el, "name"), el.id || "", attr(el, "data-testid")], said: saidOf(el), context: () => around(el), cardForm,
  });
  // Four or more one-character boxes side by side are one code, a digit to a box.
  const digitBox = (el) => {
    if (el.tagName !== "INPUT" || el.maxLength !== 1 || !/^(|text|tel|number|password)$/.test(typeOf(el))) return false;
    let box = el.parentElement;
    for (let up = 0; box && up < 4; up++, box = box.parentElement) {
      let n = 0;
      for (const x of box.querySelectorAll("input")) if (x.maxLength === 1) n++;
      if (n >= 4) return true;
    }
    return false;
  };
  const formOf = (el) => el.form || document;
  let cardForms = null;
  const inCardForm = (el) => {
    if (!cardForms) {
      cardForms = new Set();
      for (const x of document.querySelectorAll("input, textarea")) if (byRule(x, false) === "card") cardForms.add(formOf(x));
    }
    return cardForms.has(formOf(el));
  };
  const seen = new Map();
  const kind = (el) => {
    if (!el || el.nodeType !== 1) return "";
    if (seen.has(el)) return seen.get(el);
    const tag = el.tagName;
    let k = "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (tag === "INPUT" && typeOf(el) === "password") mem.add(el);
      if (mem.has(el)) k = "password";
      else if (digitBox(el)) k = "digit";
      else k = byRule(el, false) || (inCardForm(el) ? byRule(el, true) : "");
    }
    seen.set(el, k);
    return k;
  };

  // Every copy of a secret box's contents, wherever the site put one: its own text (a card preview,
  // a "you typed" line), another box (a second, visible copy for "show password"), an address.
  let hider = null;
  let names = null;
  const build = () => {
    const whole = new Set();
    const tokens = new Set();
    names = new Set();
    const add = (v) => {
      v = String(v == null ? "" : v);
      const compact = v.replace(/[\s-]+/g, "");
      const forms = [v, v.trim(), compact];
      if (/^\d{12,19}$/.test(compact)) forms.push(compact.replace(/(.{4})(?=.)/g, "$1 "), compact.replace(/(.{4})(?=.)/g, "$1-"));
      for (const f of forms) {
        // Short runs of digits are cut only where they stand alone, so a three-digit card code
        // does not take the same digits out of a price.
        if (f.length >= 6 || (f.length >= 4 && !/^\d+$/.test(f))) {
          whole.add(f);
          try { whole.add(encodeURIComponent(f)); whole.add(encodeURIComponent(f).replace(/%20/g, "+")); } catch { /* not encodable: nothing to add */ }
        } else if (f.length >= 3) tokens.add(f);
      }
    };
    let run = "";
    for (const el of document.querySelectorAll("input, textarea, select")) {
      const k = kind(el);
      if (k === "digit") { run += String(el.value || ""); continue; }
      if (run) { add(run); run = ""; }
      if (!k) continue;
      const n = attr(el, "name");
      if (n) names.add(n);
      // A card's month or year is too common a number to cut from a page: "2027" is in every footer.
      if (k !== "expiry" && el.tagName !== "SELECT" && el.value) add(el.value);
    }
    if (run) add(run);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholes = [...whole].sort((a, b) => b.length - a.length);
    const toks = [...tokens].filter(t => !whole.has(t)).map((t) => {
      const digits = /^\d+$/.test(t);
      return new RegExp(`(?<![\\p{L}\\p{N}])${digits ? "(?<!\\d[.,])" : ""}${esc(t)}${digits ? "(?![.,]\\d)" : ""}(?![\\p{L}\\p{N}])`, "gu");
    });
    hider = (s) => {
      if (typeof s !== "string" || !s) return s;
      for (const w of wholes) if (s.includes(w)) s = s.split(w).join(HIDDEN);
      for (const re of toks) s = s.replace(re, HIDDEN);
      return s;
    };
  };
  const hide = (s) => { if (!hider) build(); return hider(s); };
  // A form sent with GET (a sign-in page whose script never loaded) puts every box in the address,
  // the password under its box's own name.
  const hideUrl = (u) => {
    u = hide(String(u == null ? "" : u));
    if (!names.size || !u.includes("?")) return u;
    try {
      const x = new URL(u, location.href);
      let cut = false;
      for (const k of [...x.searchParams.keys()]) if (names.has(k) && x.searchParams.get(k)) { x.searchParams.set(k, "hidden"); cut = true; }
      return cut ? x.href : u;
    } catch { return u; }
  };
  const nameOf = (el) => {
    const aria = attr(el, "aria-label").trim();
    if (aria) return aria;
    if (el.id) { try { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && l.innerText.trim()) return l.innerText.trim(); } catch { /* no such selector */ } }
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    return (attr(el, "placeholder") || attr(el, "title")).trim();
  };
  return { kind, hide, hideUrl, nameOf };
}

/**
 * A page function with the rules handed to it first: `inPage((S, arg) => ...)` is what goes to
 * `page.evaluate` (S, arg) or `locator.evaluate` (S, element, arg). The page gets the words and the
 * rules with the function, so a reading never depends on anything a page could have removed.
 */
export function inPage(fn) {
  return new Function("a", "b", `return (${fn})((${secretRules})((${secretWords})()), a, b);`);
}

/**
 * Runs in every page of every browser Reason starts, before the page's own scripts: remembers each
 * box that is, or stops being, a password box. Browser globals only.
 */
export function watchPasswordBoxes() {
  const KEY = Symbol.for("reason.secret-boxes");
  if (window[KEY] instanceof WeakSet) return;
  const mem = new WeakSet();
  try { Object.defineProperty(window, KEY, { value: mem, configurable: true }); } catch { return; }
  const isPassword = (n) => n.tagName === "INPUT" && String(n.getAttribute("type") || "").toLowerCase() === "password";
  const note = (n) => {
    if (!n || n.nodeType !== 1) return;
    if (isPassword(n)) mem.add(n);
    if (n.firstElementChild) for (const i of n.querySelectorAll("input[type=password i]")) mem.add(i);
  };
  try {
    new MutationObserver((changes) => {
      for (const m of changes) {
        if (m.type === "attributes") { if (String(m.oldValue || "").toLowerCase() === "password") mem.add(m.target); else note(m.target); }
        else for (const n of m.addedNodes) note(n);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["type"], attributeOldValue: true });
  } catch { /* no observer: the reading itself still remembers what it has seen */ }
}

/** Every browser context Reason starts gets the watcher (called from guardContext, src/browser.js). */
export async function rememberPasswordBoxes(context) {
  await context.addInitScript(watchPasswordBoxes);
}

// ---------- the scrubber ----------

const W = secretWords();
const BOX_TAGS = new Set(["input", "textarea", "select"]);
const VALUE_KEYS = ["value", "val", "text", "content", "typed"];
const str = (v) => (typeof v === "string" ? v : "");

/** Is this object one box of a page reading, and a secret one? */
function secretBox(o) {
  const tag = str(o.tag).toLowerCase();
  const type = str(o.type).toLowerCase();
  if (type === "password") return true;
  const ac = str(o.autocomplete) || str(o.ac);
  if (!BOX_TAGS.has(tag)) return !!ac && !!W.acKind(ac);
  if (o.secret === true) return true;
  return !!W.kindOf({ tag, type, autocomplete: ac, role: str(o.role), own: [str(o.id), str(o.name_attr)], said: [str(o.name), str(o.label), str(o.lb), str(o.placeholder), str(o.title)] });
}

/**
 * The one scrubber. Whatever a tool returned, on its way to the model, the tool log, the ledger or
 * anywhere else it is kept: any box of a page reading that is a secret box loses what it holds and
 * says only that it is filled. It changes nothing else, and it returns the same object when there
 * was nothing to cut, so it is safe on every tool's result.
 *
 * This is the second net. The first is that the reading never takes the value out of the page
 * (secretRules); this one is here for the reading function that has not been written yet.
 */
export function scrubPageSecrets(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 10) return value;
  if (Array.isArray(value)) {
    let out = value;
    for (let i = 0; i < value.length; i++) {
      const v = scrubPageSecrets(value[i], depth + 1);
      if (v !== value[i]) { if (out === value) out = value.slice(); out[i] = v; }
    }
    return out;
  }
  let out = value;
  const edit = () => { if (out === value) out = { ...value }; return out; };
  const box = (typeof value.tag === "string" || typeof value.type === "string" || value.secret === true || typeof value.autocomplete === "string" || typeof value.ac === "string") && secretBox(value);
  if (box) {
    let had = value.filled === true;
    for (const k of VALUE_KEYS) {
      if (!(k in value)) continue;
      if (value[k] !== "" && value[k] != null && value[k] !== false) had = true;
      delete edit()[k];
    }
    if (out !== value) { out.secret = true; out.filled = had; }
  }
  for (const [k, v] of Object.entries(out)) {
    const s = scrubPageSecrets(v, depth + 1);
    if (s !== v) edit()[k] = s;
  }
  return out;
}

/**
 * A credential somebody typed into the chat because there is no other way to hand it over yet (an
 * Apple app password, `apple_calendar_connect`): the tool needs it once, and no copy of the call
 * keeps it. The same list seals the tool log and the ledger (SECRET_TOOLS, src/privacy.js).
 */
export const TYPED_SECRET_ARGS = { apple_calendar_connect: ["password"] };
export const SEALED = "[sealed]";

const BOX_IN_JSON = /"(?:tag|type)"\s*:\s*"(?:input|textarea|select|password)"/i;

/**
 * A conversation as it is kept (db.saveConversation, the one writer of the thread): a typed
 * credential is sealed in the call that carried it, and a tool result is scrubbed the same way it
 * was when it was made, so a result saved before this existed, or by a writer that skipped runTool,
 * is cleaned the next time its thread is saved. Returns the same array when nothing changed.
 */
export function keepableMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let out = messages;
  const setBlock = (i, j, block) => {
    if (out === messages) out = messages.slice();
    if (out[i] === messages[i]) out[i] = { ...messages[i], content: messages[i].content.slice() };
    out[i].content[j] = block;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !Array.isArray(m.content)) continue;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use" && b.input && typeof b.input === "object") {
        const keys = TYPED_SECRET_ARGS[b.name];
        if (keys && keys.some(k => k in b.input && b.input[k] !== SEALED)) {
          const input = { ...b.input };
          for (const k of keys) if (k in input) input[k] = SEALED;
          setBlock(i, j, { ...b, input });
        }
      } else if (b.type === "tool_result") {
        const scrubText = (t) => {
          if (typeof t !== "string" || !BOX_IN_JSON.test(t)) return t;
          let parsed;
          try { parsed = JSON.parse(t); } catch { return t; }
          const clean = scrubPageSecrets(parsed);
          return clean === parsed ? t : JSON.stringify(clean);
        };
        if (typeof b.content === "string") {
          const t = scrubText(b.content);
          if (t !== b.content) setBlock(i, j, { ...b, content: t });
        } else if (Array.isArray(b.content)) {
          let parts = b.content;
          b.content.forEach((part, k) => {
            if (part?.type !== "text") return;
            const t = scrubText(part.text);
            if (t !== part.text) { if (parts === b.content) parts = b.content.slice(); parts[k] = { ...part, text: t }; }
          });
          if (parts !== b.content) setBlock(i, j, { ...b, content: parts });
        }
      }
    }
  }
  return out;
}

/**
 * An address in a sentence, without its query string or fragment. For anything that records where
 * a sign-in landed: a sign-in address can carry an email, a token, a redirect, or (a form sent with
 * GET) the password itself, and "it bounced to the sign-in page" needs none of them.
 */
export function withoutQueries(text) {
  if (typeof text !== "string" || !text) return text;
  return text.replace(/(\bhttps?:\/\/[^\s?#'"<>)\]]+)[?#][^\s'"<>)\]]*/gi, "$1");
}
