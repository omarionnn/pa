// The outcome sheet: everything one task is carrying, in one validated object.
//
// "Find me an apartment" is not a request for links. It is a budget, a move-in date, whether fees
// are in the number, the people involved, the two places already turned down and why — and all of
// that has to survive a restart, a wake four hours later, and the model's own context being trimmed
// to sixty messages. So it is a column on the task, not something the model is trusted to remember,
// and this file is the only thing that writes it.
//
// What code owns here, and what it costs the model to work around (nothing: it cannot):
//
//   - **A rejected option is never offered again.** `sheetView` filters them out by id before the
//     model sees `options`. They come back under `rejected_options` with the person's own words, so
//     the model knows the ground it has already covered without being handed it as a candidate.
//   - **A constraint they stated is theirs.** Once a value is on the sheet with `source: "them"`,
//     nothing Reason found or assumed can overwrite it. The only thing that can is a NEW thing they
//     said, quoted — which is why that path needs `said`. Reason cannot decide the budget went up.
//   - **An assumption is marked as one.** `source: "assumed"` is carried through to the view with an
//     instruction to state it once rather than ask, which is what "ask only what changes the
//     result" looks like from the inside.
//
// Nothing in here reads the person's words to decide what they meant. The model does the reading and
// writes down what it read; this file checks the shape and enforces who may change what.

export const SOURCES = ["them", "found", "assumed"];
export const OPTION_STATES = ["open", "rejected", "chosen"];
/** The model's one-word reading of why they turned something down. A fixed list, so "too dear",
 * "bit much" and "over budget" all end up comparable later. */
export const READINGS = ["price", "vibe", "timing", "location", "other"];

/** Which side of a collision won. Two answers, because there are only ever two. */
export const KEEPS = ["ask", "existing"];

/**
 * How much care this job is worth. A lunch suggestion does not need an interview; a lease does.
 *
 * Three marks, and the line between them is what it costs to be wrong. `low` — a lunch spot, a
 * quick fact; being wrong costs a minute. `money` — anything that spends or commits time; being
 * wrong costs money or somebody's afternoon. `binding` — a lease, a contract, a flight; being
 * wrong is hard or impossible to undo.
 *
 * An unmarked sheet is treated as `money` everywhere this is read. That is deliberate: the cost of
 * over-checking a lunch spot is a wasted second, and the cost of under-checking a lease is a lease.
 */
export const STAKES = ["low", "money", "binding"];
export const DEFAULT_STAKES = "money";
export const stakesOf = (sheet) => parseSheet(sheet).stakes ?? DEFAULT_STAKES;

const LIMITS = {
  constraints: 24, options: 40, decisions: 40, steers: 40, routes: 40, waiting: 12, left: 20,
  conflicts: 20, prices: 20,
  key: 40, value: 300, label: 300, words: 400, text: 400, url: 2000,
};

export function emptySheet() {
  return {
    constraints: {}, options: [], decisions: [], waiting: [], steers: [], routes: [], left: [],
    conflicts: [], prices: [],
    stakes: null, document: null,
    needs: null, blocked: null,
  };
}

const str = (v, max) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

const list = (v) => (Array.isArray(v) ? v : []);

/** Whatever is in the column, as a sheet. A row from before this column existed reads as empty. */
export function parseSheet(raw) {
  let o = raw;
  if (typeof raw === "string") {
    try { o = JSON.parse(raw || "{}"); } catch { o = {}; }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
  const s = emptySheet();
  if (o.constraints && typeof o.constraints === "object" && !Array.isArray(o.constraints)) {
    for (const [k, v] of Object.entries(o.constraints)) {
      if (!v || typeof v !== "object") continue;
      const value = str(v.value, LIMITS.value);
      if (!value) continue;
      s.constraints[String(k).slice(0, LIMITS.key)] = {
        value,
        source: SOURCES.includes(v.source) ? v.source : "assumed",
        said: str(v.said, LIMITS.words),
        said_at: Number.isFinite(v.said_at) ? v.said_at : null,
      };
    }
  }
  s.options = list(o.options).filter(x => x && typeof x === "object" && str(x.id, LIMITS.key)).map(x => ({
    id: str(x.id, LIMITS.key),
    label: str(x.label, LIMITS.label) ?? "",
    where: str(x.where, LIMITS.url),
    status: OPTION_STATES.includes(x.status) ? x.status : "open",
    rejected_because: x.rejected_because && typeof x.rejected_because === "object"
      ? { words: str(x.rejected_because.words, LIMITS.words) ?? "", reading: READINGS.includes(x.rejected_because.reading) ? x.rejected_because.reading : "other" }
      : null,
    at: Number.isFinite(x.at) ? x.at : null,
  }));
  s.decisions = list(o.decisions).filter(x => x && str(x.what, LIMITS.text)).map(x => ({ what: str(x.what, LIMITS.text), at: Number.isFinite(x.at) ? x.at : null }));
  s.waiting = list(o.waiting).filter(x => x && str(x.on, LIMITS.label)).map(x => ({
    on: str(x.on, LIMITS.label), for: str(x.for, LIMITS.text) ?? "",
    since: Number.isFinite(x.since) ? x.since : null,
    next_check: Number.isFinite(x.next_check) ? x.next_check : null,
  }));
  s.steers = list(o.steers).filter(x => x && str(x.said, LIMITS.words)).map(x => ({
    said: str(x.said, LIMITS.words), changed: str(x.changed, LIMITS.text) ?? "", at: Number.isFinite(x.at) ? x.at : null,
  }));
  s.routes = list(o.routes).filter(x => x && str(x.tried, LIMITS.text)).map(x => ({
    tried: str(x.tried, LIMITS.text), failed_because: str(x.failed_because, LIMITS.text) ?? "", at: Number.isFinite(x.at) ? x.at : null,
  }));
  s.left = list(o.left).map(x => str(x, LIMITS.text)).filter(Boolean).slice(0, LIMITS.left);
  s.stakes = STAKES.includes(o.stakes) ? o.stakes : null;
  // Where a price was actually seen. Two of them, on two different sites, is what "a second source
  // for any price" means in practice — and it is checkable, because a host is a host.
  s.prices = list(o.prices).filter(x => x && str(x.what, LIMITS.label) && str(x.amount, LIMITS.value) && str(x.where, LIMITS.url)).map(x => ({
    what: str(x.what, LIMITS.label), amount: str(x.amount, LIMITS.value), where: str(x.where, LIMITS.url),
    at: Number.isFinite(x.at) ? x.at : null,
  })).slice(-LIMITS.prices);
  // The actual terms, read rather than assumed. Only `binding` jobs need one, and they may not
  // finish without it.
  if (o.document && typeof o.document === "object" && str(o.document.where, LIMITS.url) && str(o.document.says, LIMITS.text)) {
    s.document = {
      what: str(o.document.what, LIMITS.label) ?? "the terms",
      where: str(o.document.where, LIMITS.url),
      says: str(o.document.says, LIMITS.text),
      could_not: str(o.document.could_not, LIMITS.text),
      at: Number.isFinite(o.document.at) ? o.document.at : null,
    };
  }
  // Collisions between what they are asking for now and what they already told Reason. Not
  // writable through applyPatch — see addConflict — because a model that could mark its own
  // conflict resolved would have a gate it can open from the inside.
  s.conflicts = list(o.conflicts).filter(x => x && Number.isFinite(x.id) && str(x.ask, LIMITS.text)).map(x => ({
    id: x.id,
    ask: str(x.ask, LIMITS.text),
    against: str(x.against, LIMITS.key) ?? "",
    they_said: str(x.they_said, LIMITS.words),
    tradeoff: str(x.tradeoff, LIMITS.text) ?? "",
    at: Number.isFinite(x.at) ? x.at : null,
    resolved_at: Number.isFinite(x.resolved_at) ? x.resolved_at : null,
    keep: KEEPS.includes(x.keep) ? x.keep : null,
    said: str(x.said, LIMITS.words),
    now_means: str(x.now_means, LIMITS.text),
  })).slice(-LIMITS.conflicts);
  if (o.needs && typeof o.needs === "object" && str(o.needs.question, LIMITS.text)) {
    s.needs = {
      question: str(o.needs.question, LIMITS.text),
      tradeoff: str(o.needs.tradeoff, LIMITS.text) ?? "",
      asked_at: Number.isFinite(o.needs.asked_at) ? o.needs.asked_at : null,
      reminded_at: Number.isFinite(o.needs.reminded_at) ? o.needs.reminded_at : null,
    };
  }
  if (o.blocked && typeof o.blocked === "object" && str(o.blocked.what, LIMITS.text)) {
    s.blocked = { what: str(o.blocked.what, LIMITS.text), unblock: str(o.blocked.unblock, LIMITS.text) ?? "", at: Number.isFinite(o.blocked.at) ? o.blocked.at : null };
  }
  return s;
}

const refuse = (error, extra = {}) => ({ ok: false, status: "needs_them", error, ...extra });
const bad = (error) => ({ ok: false, error });

/**
 * Merge one patch into a sheet. Returns `{ ok: true, sheet }`, or a refusal the tool hands back as
 * it is. Nothing is written when anything is refused: half a correction is worse than none.
 *
 * The refusal that matters is `status: "needs_them"`. It means Reason tried to move something only
 * they can move — the budget, the date, the place, who is involved — and the honest next step is a
 * question with the tradeoff on it, not a quiet substitution.
 */
export function applyPatch(sheet, patch, { now = Date.now() } = {}) {
  const s = parseSheet(sheet);
  if (patch === undefined || patch === null) return { ok: true, sheet: s, changed: false };
  if (typeof patch !== "object" || Array.isArray(patch)) return bad("sheet must be an object.");
  let changed = false;

  if (patch.constraints !== undefined) {
    if (!patch.constraints || typeof patch.constraints !== "object" || Array.isArray(patch.constraints)) {
      return bad("sheet.constraints must be an object of named constraints.");
    }
    for (const [rawKey, v] of Object.entries(patch.constraints)) {
      const key = str(rawKey, LIMITS.key);
      if (!key) return bad("every constraint needs a name.");
      if (!v || typeof v !== "object") return bad(`constraint '${key}' must be an object with value and source.`);
      const value = str(v.value, LIMITS.value);
      if (!value) return bad(`constraint '${key}' needs a value.`);
      if (!SOURCES.includes(v.source)) return bad(`constraint '${key}' needs source: one of ${SOURCES.join(", ")}.`);
      const said = str(v.said, LIMITS.words);
      const existing = s.constraints[key];
      // The one rule that is not about shape. Theirs stays theirs.
      if (existing && existing.source === "them" && existing.value !== value) {
        if (v.source !== "them") {
          return refuse(
            `'${key}' is ${existing.value} because they said so${existing.said ? ` ("${existing.said}")` : ""}, and you are trying to make it ${value} from something you ${v.source === "found" ? "found" : "assumed"}.`
            + ` That is theirs to change, not yours. Keep looking within what they asked for; if it genuinely cannot be done, set the task to waiting_on_you and ask ONE question with the tradeoff in it`
            + ` ("nothing under ${existing.value} has come up — go to ${value}, or drop something else?").`,
            { constraint: key, theirs: existing.value, you_wanted: value },
          );
        }
        if (!said) {
          return refuse(
            `'${key}' is ${existing.value} because they said so. To change it you have to quote the new thing they said: pass said with their own words.`,
            { constraint: key, theirs: existing.value, you_wanted: value },
          );
        }
      }
      s.constraints[key] = { value, source: v.source, said, said_at: now };
      changed = true;
    }
    if (Object.keys(s.constraints).length > LIMITS.constraints) return bad(`a sheet holds at most ${LIMITS.constraints} constraints.`);
  }

  if (patch.options !== undefined) {
    if (!Array.isArray(patch.options)) return bad("sheet.options must be an array.");
    for (const raw of patch.options) {
      if (!raw || typeof raw !== "object") return bad("every option must be an object.");
      const id = str(raw.id, LIMITS.key);
      if (!id) return bad("every option needs a short stable id of your own choosing.");
      const status = raw.status === undefined ? "open" : raw.status;
      if (!OPTION_STATES.includes(status)) return bad(`option '${id}' has status '${status}'; use one of ${OPTION_STATES.join(", ")}.`);
      const at = s.options.findIndex(o => o.id === id);
      const existing = at === -1 ? null : s.options[at];
      // Turned down once is turned down. Nothing re-opens an option they said no to except them
      // saying so, and that is a new option with a new id and a reason on it.
      if (existing && existing.status === "rejected" && status !== "rejected") {
        return refuse(
          `'${existing.label || id}' was already turned down${existing.rejected_because?.words ? ` — they said "${existing.rejected_because.words}"` : ""}, so it is not back on the table.`
          + ` Do not offer it again. If they have changed their mind, that is them saying so, and it goes on as a new option.`,
          { option: id },
        );
      }
      let rejected = existing?.rejected_because ?? null;
      if (status === "rejected") {
        const rb = raw.rejected_because;
        const words = str(rb?.words, LIMITS.words);
        if (!words) return bad(`option '${id}' is rejected, so rejected_because.words needs their own words for why, verbatim.`);
        if (!READINGS.includes(rb?.reading)) return bad(`option '${id}' needs rejected_because.reading: one of ${READINGS.join(", ")}.`);
        rejected = { words, reading: rb.reading };
      }
      const row = {
        id,
        label: str(raw.label, LIMITS.label) ?? existing?.label ?? "",
        where: str(raw.where, LIMITS.url) ?? existing?.where ?? null,
        status,
        rejected_because: rejected,
        at: existing?.at ?? now,
      };
      if (at === -1) s.options.push(row); else s.options[at] = row;
      changed = true;
    }
    if (s.options.length > LIMITS.options) return bad(`a sheet holds at most ${LIMITS.options} options.`);
  }

  for (const [field, shape] of [["decisions", (x) => ({ what: str(x.what, LIMITS.text), at: now })], ["routes", (x) => ({ tried: str(x.tried, LIMITS.text), failed_because: str(x.failed_because, LIMITS.text) ?? "", at: now })]]) {
    if (patch[field] === undefined) continue;
    if (!Array.isArray(patch[field])) return bad(`sheet.${field} must be an array.`);
    for (const raw of patch[field]) {
      if (!raw || typeof raw !== "object") return bad(`every entry in ${field} must be an object.`);
      const row = shape(raw);
      const first = Object.values(row)[0];
      if (!first) return bad(`every entry in ${field} needs ${field === "decisions" ? "what" : "tried"}.`);
      s[field].push(row);
      changed = true;
    }
    if (s[field].length > LIMITS[field]) s[field] = s[field].slice(-LIMITS[field]);
  }

  if (patch.waiting !== undefined) {
    if (!Array.isArray(patch.waiting)) return bad("sheet.waiting must be an array.");
    const out = [];
    for (const raw of patch.waiting) {
      if (!raw || typeof raw !== "object") return bad("every entry in waiting must be an object.");
      const on = str(raw.on, LIMITS.label);
      if (!on) return bad("every entry in waiting needs 'on': who or what it is waiting on.");
      const forWhat = str(raw.for, LIMITS.text);
      if (!forWhat) return bad(`waiting on '${on}' needs 'for': what exactly is owed.`);
      let next = null;
      if (raw.next_check !== undefined && raw.next_check !== null && raw.next_check !== "") {
        next = typeof raw.next_check === "number" ? raw.next_check : Date.parse(raw.next_check);
        if (!Number.isFinite(next)) return bad(`waiting on '${on}' has a next_check that is not a date. Use ISO 8601 with an offset.`);
      }
      const was = s.waiting.find(w => w.on === on && w.for === forWhat);
      out.push({ on, for: forWhat, since: was?.since ?? now, next_check: next });
    }
    if (out.length > LIMITS.waiting) return bad(`a sheet tracks at most ${LIMITS.waiting} things it is waiting on.`);
    s.waiting = out;
    changed = true;
  }

  if (patch.left !== undefined) {
    if (!Array.isArray(patch.left)) return bad("sheet.left must be an array of short lines.");
    const out = patch.left.map(x => str(x, LIMITS.text)).filter(Boolean);
    if (out.length > LIMITS.left) return bad(`at most ${LIMITS.left} lines in what is left.`);
    s.left = out;
    changed = true;
  }

  if (patch.stakes !== undefined) {
    if (!STAKES.includes(patch.stakes)) {
      return bad(`stakes must be one of ${STAKES.join(", ")}: 'low' for a lunch spot or a quick fact, 'money' for anything that spends or commits time, 'binding' for a lease, a contract, a flight — anything hard to undo.`);
    }
    s.stakes = patch.stakes;
    changed = true;
  }

  if (patch.prices !== undefined) {
    if (!Array.isArray(patch.prices)) return bad("sheet.prices must be an array of places you actually saw a price.");
    for (const raw of patch.prices) {
      if (!raw || typeof raw !== "object") return bad("every entry in prices must be an object.");
      const what = str(raw.what, LIMITS.label);
      const amount = str(raw.amount, LIMITS.value);
      const where = str(raw.where, LIMITS.url);
      if (!what || !amount || !where) return bad("every price needs what it is for, the amount, and where you saw it — the actual page, as a link. A price with no source is a price you cannot check.");
      try { new URL(where); } catch { return bad(`'${where}' is not a link. A price source is a page you really read, not a description of one.`); }
      s.prices.push({ what, amount, where, at: now });
      changed = true;
    }
    if (s.prices.length > LIMITS.prices) s.prices = s.prices.slice(-LIMITS.prices);
  }

  if (patch.document !== undefined) {
    if (patch.document === null) { s.document = null; changed = true; }
    else {
      if (typeof patch.document !== "object") return bad("sheet.document is the terms you actually read: where, and what they say.");
      const where = str(patch.document.where, LIMITS.url);
      const says = str(patch.document.says, LIMITS.text);
      if (!where) return bad("document.where is the link to the actual terms — the lease, the fare rules, the contract. Not a summary page about them.");
      try { new URL(where); } catch { return bad(`'${where}' is not a link.`); }
      if (!says) return bad("document.says is what the terms actually say about the things that bite: cancellation, fees, dates. In their terms, read off the document, not what you expect it to say.");
      s.document = {
        what: str(patch.document.what, LIMITS.label) ?? "the terms",
        where, says,
        could_not: str(patch.document.could_not, LIMITS.text),
        at: now,
      };
      changed = true;
    }
  }

  if (patch.needs !== undefined) {
    if (patch.needs === null) { s.needs = null; changed = true; }
    else {
      if (typeof patch.needs !== "object") return bad("sheet.needs must be an object with question and tradeoff.");
      const question = str(patch.needs.question, LIMITS.text);
      const tradeoff = str(patch.needs.tradeoff, LIMITS.text);
      if (!question) return bad("needs.question is the ONE thing you need from them, phrased so they can answer in a word or two.");
      if (!tradeoff) return bad("needs.tradeoff is one line on what each answer costs them. A question without it makes them do the thinking.");
      const was = s.needs && s.needs.question === question ? s.needs : null;
      s.needs = { question, tradeoff, asked_at: was?.asked_at ?? now, reminded_at: was?.reminded_at ?? null };
      changed = true;
    }
  }

  if (patch.blocked !== undefined) {
    if (patch.blocked === null) { s.blocked = null; changed = true; }
    else {
      if (typeof patch.blocked !== "object") return bad("sheet.blocked must be an object with what and unblock.");
      const what = str(patch.blocked.what, LIMITS.text);
      const unblock = str(patch.blocked.unblock, LIMITS.text);
      if (!what) return bad("blocked.what is what actually stopped it.");
      if (!unblock) return bad("blocked.unblock is what would get it going again, said plainly.");
      s.blocked = { what, unblock, at: now };
      changed = true;
    }
  }

  return { ok: true, sheet: s, changed };
}

/**
 * What a conflict is allowed to be against, and whether the sheet really carries it.
 *
 * A conflict Reason can invent is a conflict Reason can hide behind — "I didn't book it because
 * there might be a problem" is not a report, it is a stall. So the thing being collided with has to
 * be something already written down: a constraint on this sheet, or an option they turned down.
 * (A saved preference is the third kind and is checked by the tool, which can see the memory rows.)
 */
export function conflictAgainst(sheet, against) {
  const s = parseSheet(sheet);
  const ref = String(against ?? "").trim();
  const [kind, ...rest] = ref.split(":");
  const key = rest.join(":").trim();
  if (kind === "constraint") {
    const c = s.constraints[key];
    if (!c) {
      return { ok: false, error: `There is no constraint called '${key}' on this sheet, so there is nothing for the new ask to collide with. The sheet has: ${Object.keys(s.constraints).join(", ") || "nothing yet"}. If they told you this and you never wrote it down, write it down first (task_update, sheet.constraints, source 'them', with their words) — and then it is a real conflict.` };
    }
    return { ok: true, ref, kind, key, says: c.value, they_said: c.said };
  }
  if (kind === "rejected") {
    const o = s.options.find(x => x.id === key && x.status === "rejected");
    if (!o) return { ok: false, error: `No option '${key}' on this sheet has been turned down, so there is nothing for the new ask to collide with.` };
    return { ok: true, ref, kind, key, says: `${o.label || o.id} — turned down${o.rejected_because?.reading ? ` on ${o.rejected_because.reading}` : ""}`, they_said: o.rejected_because?.words ?? null };
  }
  if (kind === "remembered") return { ok: true, ref, kind, key, says: null, they_said: null, needs_memory_check: true };
  return { ok: false, error: `'${against}' is not something a conflict can be against. Use 'constraint:<name>' for something on this job's sheet, 'rejected:<option id>' for something they turned down, or 'remembered:<who>' for a saved preference.` };
}

/**
 * They are asking for something that collides with something they already said. Written down, with
 * the one line that asks them which wins.
 *
 * Reason does not get to pick. "Cheapest flight" against a standing "never basic economy" has two
 * defensible answers and they are not Reason's to choose between — quietly honouring either one is
 * the same failure wearing different clothes, and the person only finds out at the gate. So the
 * collision becomes a row, the row blocks anything that would commit, and the way out is them
 * answering a question that fits in one line.
 */
export function addConflict(sheet, { ask, against, they_said = null, tradeoff }, { now = Date.now() } = {}) {
  const s = parseSheet(sheet);
  const what = str(ask, LIMITS.text);
  if (!what) return bad("a conflict needs the ask that caused it, in their words.");
  const line = str(tradeoff, LIMITS.text);
  if (!line) return bad("a conflict needs the tradeoff: ONE line with what each side costs them, so the question can be answered in a word.");
  const ref = str(against, LIMITS.key);
  if (!ref) return bad("a conflict needs what it is against.");
  const open = s.conflicts.find(x => !x.resolved_at && x.against === ref);
  if (open) return { ok: true, sheet: s, conflict: open, already: true };
  const id = (s.conflicts.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
  const row = { id, ask: what, against: ref, they_said: str(they_said, LIMITS.words), tradeoff: line, at: now, resolved_at: null, keep: null, said: null, now_means: null };
  s.conflicts.push(row);
  if (s.conflicts.length > LIMITS.conflicts) s.conflicts = s.conflicts.slice(-LIMITS.conflicts);
  return { ok: true, sheet: s, conflict: row };
}

/**
 * They answered. Which side won, in their own words, and what it means from here.
 *
 * The resolution is written as a constraint with `source: "them"`, which is what makes it stick:
 * it comes back on every wake like everything else on the sheet, it cannot be overwritten by
 * anything Reason finds, and `conflict_check` refuses to raise the same collision twice.
 */
export function resolveConflict(sheet, { id, keep, said, now_means }, { now = Date.now() } = {}) {
  const s = parseSheet(sheet);
  const row = s.conflicts.find(x => x.id === Number(id));
  if (!row) return bad(`No conflict #${id} on this job.`);
  if (row.resolved_at) return bad(`Conflict #${id} was already settled: ${row.now_means}.`);
  if (!KEEPS.includes(keep)) return bad(`keep must be one of ${KEEPS.join(", ")}: 'ask' if what they just asked for wins, 'existing' if the thing they told you before still stands.`);
  const words = str(said, LIMITS.words);
  if (!words) return bad("a resolution needs their own words, verbatim. This is them deciding, not you reading a tea leaf — if they have not answered yet, do not resolve it.");
  const means = str(now_means, LIMITS.text);
  if (!means) return bad("now_means is one line on what this means for the rest of the job, in plain words: what you will do differently from here.");
  row.resolved_at = now;
  row.keep = keep;
  row.said = words;
  row.now_means = means;
  s.constraints[`settled_${row.id}`] = { value: means, source: "them", said: words, said_at: now };
  return { ok: true, sheet: s, conflict: row };
}

/** The collisions still waiting on an answer. Anything that would commit is held while this is not empty. */
export function openConflicts(sheet) {
  return parseSheet(sheet).conflicts.filter(x => !x.resolved_at);
}

/** A collision they have already settled, so the same question is never asked twice. */
export function settledConflict(sheet, against) {
  return parseSheet(sheet).conflicts.find(x => x.resolved_at && x.against === String(against ?? "").trim()) ?? null;
}

/** A steer: their words, and what it changed. Appended, never edited, so a correction is auditable. */
export function addSteer(sheet, { said, changed }, { now = Date.now() } = {}) {
  const s = parseSheet(sheet);
  const words = str(said, LIMITS.words);
  if (!words) return bad("a steer needs their own words, verbatim.");
  const what = str(changed, LIMITS.text);
  if (!what) return bad("a steer needs what it changed on the sheet, in one line.");
  s.steers.push({ said: words, changed: what, at: now });
  if (s.steers.length > LIMITS.steers) s.steers = s.steers.slice(-LIMITS.steers);
  return { ok: true, sheet: s };
}

const FROM = { them: "they said it", found: "you found it", assumed: "you assumed it" };

/**
 * The sheet as the model is allowed to see it.
 *
 * Two differences from the stored object, and both are the point. Rejected options are not in
 * `options` — they are in `rejected_options`, which is the record of ground already covered rather
 * than a list of candidates. And anything assumed is pulled out into `assumptions` with the
 * instruction attached, because an assumption stated once is help and an assumption asked about is
 * one more question they did not need.
 */
export function sheetView(sheet, { progress = [], tastes = [], stamp = (t) => (t ? new Date(t).toISOString() : null) } = {}) {
  const s = parseSheet(sheet);
  const constraints = {};
  const assumptions = [];
  for (const [k, v] of Object.entries(s.constraints)) {
    constraints[k] = {
      value: v.value, from: FROM[v.source] ?? v.source,
      ...(v.said ? { their_words: v.said } : {}),
      ...(v.said_at ? { since: stamp(v.said_at) } : {}),
    };
    if (v.source === "assumed") assumptions.push(`${k}: ${v.value}`);
  }
  const rejected = s.options.filter(o => o.status === "rejected");
  return {
    constraints,
    ...(assumptions.length ? {
      assumptions,
      assumptions_note: "You assumed these; nobody told you. Say them out loud ONCE in your next message so they can correct you, and do not turn one into a question.",
    } : {}),
    options: s.options.filter(o => o.status !== "rejected").map(o => ({ id: o.id, label: o.label, where: o.where ?? undefined, status: o.status })),
    rejected_options: rejected.map(o => ({ id: o.id, label: o.label, their_words: o.rejected_because?.words ?? "", reading: o.rejected_because?.reading ?? "other" })),
    ...(rejected.length ? { rejected_note: "These are off the table for good. Never put one in front of them again, and do not spend a step re-checking it." } : {}),
    // Everything they have ever turned down, on any task, with the category and their own words.
    // Handed in rather than read here so this file stays pure — see `listPreferences` in src/db.js.
    // This is the half of "rejected" that is worth more than the ids: a person who said "too dear
    // for a tuesday" once should not be shown the same price bracket on the next thing either.
    ...(tastes.length ? {
      their_taste: tastes,
      taste_note: "Things they have turned down before, on this and on anything else, with their own words."
        + " Use them when you pick what to put in front of them: a price they balked at, a part of town they will not go"
        + " to, an hour that never works. They are preferences, NOT permission — nothing here lets you spend, send or"
        + " book anything. And none of them is a rule: if the best option breaks one, say so in the line that offers it"
        + " ('a bit over what you said last time, but') rather than hiding it or dropping it silently.",
    } : {}),
    decisions: s.decisions.map(d => ({ what: d.what, at: stamp(d.at) })),
    waiting: s.waiting.map(w => ({ on: w.on, for: w.for, since: stamp(w.since), next_check: w.next_check ? stamp(w.next_check) : null })),
    steers: s.steers.map(x => ({ they_said: x.said, so_you_changed: x.changed, at: stamp(x.at) })),
    routes_that_failed: s.routes.map(r => ({ tried: r.tried, failed_because: r.failed_because, at: stamp(r.at) })),
    left: s.left,
    stakes: s.stakes ?? `${DEFAULT_STAKES} (you have not marked this job, so it is being treated as money — mark it)`,
    stakes_note: s.stakes === "low"
      ? "Low stakes: one research pass is enough, and closing it only needs the links to open. Do not interview them about a lunch spot,"
        + " and do not go looking for a price source you do not need. If it turns out this one spends money or commits them to something, change the mark."
      : s.stakes === "binding"
        ? "Binding: this is hard or impossible to undo, so it gets everything. Read the ACTUAL document — the lease, the fare rules, the contract, the policy —"
          + " and put it on the sheet (sheet.document) with what it says about the things that bite: cancellation, fees, dates. In its words, not what you expect it to say."
          + " You cannot close this job as done without it, and you cannot close it on a price that has no page behind it on the sheet (sheet.prices)."
          + " On a number this hard to undo, get a second site for it."
        : "Money: this spends or commits somebody's time, so the total you put in front of them has to be the real one, fees and all."
          + " Put every price on the sheet with the page you actually saw it on (sheet.prices, with the link) — it is what lets anybody check the number later."
          + " If this turns out to be something they cannot walk away from, mark it binding instead.",
    ...(s.prices.length ? { prices_seen: s.prices.map(p => ({ what: p.what, amount: p.amount, where: p.where })) } : {}),
    ...(s.document ? { document_read: { what: s.document.what, where: s.document.where, says: s.document.says, ...(s.document.could_not ? { could_not: s.document.could_not } : {}) } } : {}),
    ...(s.conflicts.filter(c => !c.resolved_at).length ? {
      open_conflicts: s.conflicts.filter(c => !c.resolved_at).map(c => ({
        conflict_id: c.id, they_now_want: c.ask, collides_with: c.against,
        ...(c.they_said ? { their_words_before: c.they_said } : {}),
        tradeoff: c.tradeoff, since: stamp(c.at),
      })),
      open_conflicts_note: "Ask which one wins, in ONE line with the tradeoff in it, and wait. Nothing that spends, books, sends or commits will go through until conflict_resolve has their answer — and you must not pick for them, even when one side looks obviously right.",
    } : {}),
    ...(s.conflicts.filter(c => c.resolved_at).length ? {
      settled: s.conflicts.filter(c => c.resolved_at).map(c => ({
        was: c.ask, against: c.against, they_said: c.said, so: c.now_means, at: stamp(c.resolved_at),
      })),
      settled_note: "They already decided these. Act on them and never raise one again — asking somebody the same question twice is how they learn you were not listening the first time.",
    } : {}),
    needs_from_them: s.needs ? { question: s.needs.question, tradeoff: s.needs.tradeoff, asked: stamp(s.needs.asked_at), reminded: s.needs.reminded_at ? stamp(s.needs.reminded_at) : null } : null,
    blocked_by: s.blocked ? { what: s.blocked.what, unblock: s.blocked.unblock, at: stamp(s.blocked.at) } : null,
    done_so_far: progress,
  };
}

/**
 * Preference rows as the model is allowed to see them, for `sheetView`'s `tastes`.
 *
 * Here rather than in src/db.js so the shape of a taste is defined once, next to the readings it is
 * categorised by — and taking rows as an argument keeps this file free of the database. `id` is on
 * every one because every row is theirs to correct or drop, and the model needs the number to say so.
 */
export function tasteView(rows = [], { stamp = (t) => (t ? new Date(t).toISOString() : null) } = {}) {
  return rows.map(r => ({
    id: r.id,
    category: r.category,
    they_said: r.words,
    ...(r.turned_down ? { turned_down: r.turned_down } : {}),
    ...(r.note ? { means: r.note } : {}),
    learned: stamp(r.learned_at),
    ...(r.corrected_at ? { corrected: stamp(r.corrected_at) } : {}),
  }));
}

/** Every person named anywhere on the sheet, for the recipient check (src/verify.js). */
export function peopleOn(sheet) {
  const s = parseSheet(sheet);
  const out = new Set();
  for (const [k, v] of Object.entries(s.constraints)) {
    if (/person|people|who|recipient|contact|name|landlord|agent|number|email/i.test(k)) out.add(v.value);
  }
  for (const w of s.waiting) out.add(w.on);
  return [...out].filter(Boolean);
}
