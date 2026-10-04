// One rule, and the code that keeps it: Reason never reads payment details down a phone line.
//
// This is not about trusting the model less than usual. It is that a phone call is the worst
// possible place for a card number — it is recorded (every call Reason places is), it may be
// transcribed by the provider, it may be stored on somebody else's server, and the person on the
// other end is unverified. "The restaurant asked for a card to hold the table" is exactly how it
// would happen, and it would sound reasonable at the time.
//
// So there are two halves, and neither one is a prompt:
//
//   1. The call request **cannot carry** payment details. Everything a call is allowed to say goes
//      through `facts`, and `facts` is scanned here before the dial. A hit refuses the call.
//   2. The call **carries a standing instruction** to decline if the other side asks for payment
//      by phone, ask for a pay link or another way, and report back. See `callRulesFor` in
//      provider.js — it is passed to the provider as its own argument, like the announcement.
//
// On false positives: this errs towards refusing. A refused call costs one turn and a rephrase,
// and the error says what to do instead. A card number read onto a recording cannot be taken back.

// Words that only really appear when somebody is handing over payment credentials. Deliberately
// not "card" or "pay" on their own — "pay at the door" and "do they take card" are normal things
// to say on a call to a restaurant, and blocking them would make the guard useless noise.
const CREDENTIAL_WORDS = [
  [/\bcard\s*(number|no\.?|#)\b/i, "a card number"],
  [/\b(cvv|cvc|cv2)\b/i, "a card security code"],
  [/\bsecurity\s*code\b/i, "a card security code"],
  [/\bexpir(y|ation)\s*(date)?\b/i, "a card expiry date"],
  [/\bexp\.?\s*\d{1,2}\s*\/\s*\d{2,4}\b/i, "a card expiry date"],
  [/\brouting\s*(number|no\.?|#)\b/i, "a bank routing number"],
  [/\bsort\s*code\b/i, "a bank sort code"],
  [/\biban\b/i, "an IBAN"],
  [/\b(bank|checking|account)\s*(number|no\.?|#)\b/i, "a bank account number"],
  [/\b(pin|passcode)\s*(number|code)?\b\s*(is|:)/i, "a PIN"],
  [/\b\d{3,4}\s*(is\s*(the|my)\s*)?(cvv|cvc|security code)\b/i, "a card security code"],
];

/** Luhn, so a 16-digit confirmation code is not mistaken for a card. */
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * What payment details, if any, are in this text. Returns a list of plain-language descriptions —
 * never the matched value itself, because the point is to keep it out of logs and ledger rows, and
 * a guard that echoes the card number into an error message has leaked it anyway.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findPaymentDetails(text) {
  const s = String(text ?? "");
  if (!s) return [];
  const found = new Set();

  for (const [re, what] of CREDENTIAL_WORDS) {
    if (re.test(s)) found.add(what);
  }

  // A run of 13–19 digits that passes Luhn, allowing the spaces and dashes people write them with.
  for (const m of s.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found.add("what looks like a card number");
      break;
    }
  }
  return [...found];
}

/**
 * Check everything a call is allowed to say. `ok: false` means do not dial.
 *
 * @param {{goal?: string, facts?: string[]}} _
 */
export function checkCallForPaymentDetails({ goal = "", facts = [] } = {}) {
  const hits = new Set();
  for (const d of findPaymentDetails(goal)) hits.add(d);
  for (const f of facts ?? []) for (const d of findPaymentDetails(f)) hits.add(d);
  if (!hits.size) return { ok: true };

  const what = [...hits].join(", ");
  return {
    ok: false,
    found: [...hits],
    error: `Refused: this call would have carried ${what}, and Reason never gives payment details by phone.`
      + ` Nothing was dialled. Take it out of the goal and the facts and call again, or do not call:`
      + ` if something needs paying, ask them for a pay link or another way to pay that is not read out loud.`
      + ` If this was a false alarm — a booking reference, say, not a card — reword it so it does not read as payment details.`,
  };
}
