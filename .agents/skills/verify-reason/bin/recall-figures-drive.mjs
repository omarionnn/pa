#!/usr/bin/env node
// The 11-07 release, in process, no model, no network: recall ranking + the "nothing saved" filter
// (src/recallindex.js), forget clearing recall (src/db.js forgetFromRecall), the figures gate on the
// reply and on message_send (src/offers.js guardReply/sendBack, src/tools.js message_send), receipts
// that never name the operator (src/trust.js receiptFor), and own-files-only (src/ownfiles.js).
//
//   cd <repo> && eval "$(.agents/skills/verify-reason/bin/caged.sh env | sed 's/^/export /')" \
//     && REASON_DB_PATH=$(mktemp -d)/rf.db OPENAI_API_KEY= REASON_OWNER_NAME=Omari \
//        node .agents/skills/verify-reason/bin/recall-figures-drive.mjs        # "all ok"
//
// OPENAI_API_KEY blank on purpose: memory_search then answers by words (keywordHistory), which runs
// the same rankAndCut as the meaning search. Prints one line per step; exit 1 on any FAIL.
if (!process.env.REASON_DB_PATH || !/\/(tmp|var\/folders|private)\//.test(process.env.REASON_DB_PATH)) {
  console.error("refusing: set REASON_DB_PATH to a throwaway path (mktemp -d)"); process.exit(2);
}
if (process.env.OPENAI_API_KEY) { console.error("refusing: blank OPENAI_API_KEY (word search, no spend)"); process.exit(2); }
delete process.env.ANTHROPIC_API_KEY;
const { resolve } = await import("node:path");
const R = (p) => resolve(process.cwd(), p);
const db = await import(R("src/db.js"));
const { runTool } = await import(R("src/tools.js"));
const offers = await import(R("src/offers.js"));
const trust = await import(R("src/trust.js"));
const ownfiles = await import(R("src/ownfiles.js"));

let bad = 0;
const step = (name, ok, detail = "") => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const C = "dm:owner", OTHER = "dm:+15550001111";
const at0 = Date.now() - 3 * 86_400_000;
const call = (c, label, goal, summary = "") => Number(db.db.prepare(`INSERT INTO calls (conversation_id, provider, to_number, goal, state, outcome, summary, label, created_at, updated_at, ended_at)
  VALUES (?, 'gptlive', '+16462582221', ?, 'completed', 'they answered', ?, ?, ?, ?, ?)`).run(c, goal, summary, label, at0, at0, at0 + 60_000).lastInsertRowid);
const said = (c, role, content, at) => Number(db.db.prepare("INSERT INTO event_log (conversation_id, role, content, at) VALUES (?, ?, ?, ?)").run(c, role, content, at).lastInsertRowid);

// 1. Recall: the real spa call outranks Reason's own "nothing saved" reply, which is never handed back.
const spa = call(C, "Renew Body Spa", "Ask Renew Body Spa about a massage on Saturday");
said(C, "user", "do you remember the spa place you called?", at0 + 86_400_000);
said(C, "assistant", "I don't have any spa place saved.", at0 + 86_400_000 + 1000);
let s = await runTool("memory_search", { query: "spa place" }, { conversationId: C, messages: [] });
step("memory_search by words (no key)", s.ok && /words only/.test(s.searched ?? ""), s.searched);
step("the spa call is first", s.history?.[0]?.kind === "call" && s.history[0].id === spa, JSON.stringify(s.history?.[0]?.text));
step("the 'nothing saved' reply is not handed back", (s.history ?? []).every(h => !/don't have any spa place saved/.test(h.text)), `${s.history?.length} hit(s)`);

// 2. Forget clears recall: the call naming Yaw and the exchange naming Yaw leave recall; rows stay; sealed.
const yaw = call(C, "Yaw", "Ask Yaw about the spa deposit", "Yaw said the massage deposit is $40");
said(C, "user", "Yaw owes me for the spa massage", at0 + 2 * 86_400_000);
said(C, "assistant", "noted, Yaw and the spa massage", at0 + 2 * 86_400_000 + 1000);
const theirs = call(OTHER, "Yaw", "Ask Yaw about the spa massage");
s = await runTool("memory_search", { query: "Yaw spa deposit" }, { conversationId: C, messages: [] });
step("Yaw found before the forget", (s.history ?? []).some(h => /Yaw/.test(h.text)));
const f = await runTool("forget", { about: "Yaw" }, { conversationId: C, messages: [] });
step("forget Yaw (no fact saved) still clears recall", f.ok && f.forgot === 0 && f.recall_cleared?.calls === 1 && f.recall_cleared.exchanges >= 1, JSON.stringify(f.recall_cleared));
s = await runTool("memory_search", { query: "Yaw spa deposit" }, { conversationId: C, messages: [] });
step("Yaw gone from recall", (s.history ?? []).every(h => !/Yaw/.test(h.text)), `${s.history?.length} hit(s) left`);
step("recall_forgotten rows, their messages kept", db.db.prepare("SELECT COUNT(*) n FROM recall_forgotten WHERE conversation_id = ?").get(C).n >= 2
  && db.db.prepare("SELECT COUNT(*) n FROM event_log WHERE conversation_id = ? AND content LIKE '%Yaw%'").get(C).n === 2 && !!db.db.prepare("SELECT 1 FROM calls WHERE id = ?").get(yaw));
s = await runTool("memory_search", { query: "Yaw spa massage" }, { conversationId: OTHER, messages: [] });
step("sealed: the other person's Yaw call is untouched", (s.history ?? []).some(h => h.id === theirs));
const none = await runTool("forget", { about: "Zanele" }, { conversationId: C, messages: [] });
step("forget of nobody → nothing on record", none.ok === false && /Nothing is on record/.test(none.error ?? ""), none.error);

// 3. The figures gate on the turn's reply: an unchecked price is sent back once, then dropped; theirs counts.
offers.beginTurn(C, "what does a massage there cost?", "user");
let g = offers.guardReply(C, "A 60-minute massage there is $95.", { turnReply: true });
step("unchecked price → one rewrite, nothing labelled", !!g.recompose && g.flags.some(x => x.rule === "dollar_unsourced") && !/unverified/i.test(g.text), g.recompose?.slice(0, 60));
offers.beginTurn(C, "", "user", { carry: true });
g = offers.guardReply(C, "A 60-minute massage there is $95.", { turnReply: true });
step("the rewrite still unchecked → the price is dropped", g.flags.some(x => x.rule === "dollar_dropped") && !g.text.includes("$95") && !/unverified/i.test(g.text), JSON.stringify(g.text));
offers.beginTurn(C, "the bill was $84, what's an 18% tip?", "user");
g = offers.guardReply(C, "18% of $84 is $15.12, so $99.12 all in.", { turnReply: true });
step("their own money + arithmetic counts", !g.recompose && !g.changed, JSON.stringify(g.flags));
offers.beginTurn(C, "I'm 30 and have 2 kids, any spa deals?", "user");
g = offers.guardReply(C, "Renew Body Spa has a $30 off code for new clients.", { turnReply: true });
step("a non-money number of theirs never backs a price; an unseen deal is sent back", !!g.recompose && g.flags.some(x => x.rule === "discount_unsourced"), g.flags.map(x => x.rule).join(","));

// 4. message_send to their own person: an unchecked price is refused, every time, nothing sent.
offers.beginTurn(C, "text me the price", "user");
const router = { list: () => [{ name: "sendblue" }], send: async () => { throw new Error("must not send"); } };
for (const n of [1, 2]) {
  const m = await runTool("message_send", { to: "owner", text: "It's $95 for the hour." }, { conversationId: C, messages: [], channels: router });
  step(`message_send unchecked price, try ${n} → not sent`, m.ok === false && m.blocked === "unchecked_figures" && /never a bracketed tag/.test(m.error ?? ""), m.error?.slice(0, 50));
}

// 5. Receipts say "them", never the operator's name.
const owner = process.env.REASON_OWNER_NAME || "Omari";
const rec = [
  trust.receiptFor("call_recording", { call_id: 73 }, { ok: true, seconds: 40, bytes: 4096, format: "m4a", file: "/x/call-73.m4a" }),
  trust.receiptFor("vault_enroll", {}, { ok: true, already_enrolled: true, card: "a Visa" }),
  trust.receiptFor("notice_send", { key: "k" }, { ok: true, what: "rain at 5" }),
];
step("receipts never name the operator", rec.every(r => !r.includes(owner)) && /Sent them the recording/.test(rec[0]) && /they already have/.test(rec[1]), rec.join(" | "));

// 6. Own files only: the shared database and an unknown file are nobody's to send.
const dbFile = process.env.REASON_DB_PATH;
const o = ownfiles.ownFile(C, dbFile);
step("ownFile(database) → not_theirs", o.ok === false && o.status === "not_theirs");
const v = await runTool("voice_note_send", { to: "owner", file: dbFile }, { conversationId: C, messages: [], channels: router });
step("voice_note_send of the database → refused, nothing sent", v.ok === false && (v.status === "not_theirs" || /not a file Reason made/.test(v.error ?? "")), v.status ?? v.error?.slice(0, 60));

console.log(bad ? `${bad} FAIL` : "all ok");
process.exit(bad ? 1 : 0);
