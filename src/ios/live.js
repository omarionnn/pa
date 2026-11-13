// The Page, live (GET /ios/v1/live). Server-Sent Events: the flow is one way (the app's writes are plain
// requests), it runs over the plain HTTP path Caddy already serves, carries the bearer header, and reconnecting
// needs no resume protocol because every connection starts with the whole Page.
//
// State changes reach the database from dozens of places (tools, webhooks, sweeps), most with no event to listen
// for, so each stream polls a small fingerprint (feed.js) and only redraws when it moves. That is what makes the
// 1 s bound hold for every write path, without touching any of them.
import * as db from "../db.js";
import { clock } from "../config.js";
import { pageFeed, fingerprint } from "./feed.js";
import { iosAccount } from "./session.js";
import { messageOut, turnDoneOut } from "./messages.js";
import { WEB } from "../web.js";
import { progressEvents } from "../progress.js";

export const TICK_MS = 400;
export const PING_MS = 15_000;
export const STREAM_MS = 30 * 60_000;
/** Open streams per person. A new one past this closes the oldest, so a reconnect is never refused. */
export const MAX_STREAMS = 3;

const open = new Map(); // conversation → Set of { end }

export function liveRequest({ account, token, headers, query = {}, router = null, log = () => {}, tickMs = TICK_MS, pingMs = PING_MS, streamMs = STREAM_MS }) {
  const conv = account.conversation_id;
  // Reconnecting says where it got to; a fresh connection starts from now, and history is GET /messages.
  const named = [headers?.["last-event-id"], query.after].find(v => /^\d{1,15}$/.test(String(v ?? "")));
  let lastRow = named != null ? Number(named) : (db.latestMessagesFor(conv, { limit: 1 })[0]?.id ?? 0);
  return {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", Connection: "keep-alive" },
    stream(res, req) {
      let closed = false, lastPrint = null, lastSections = null, sinceAuth = 0;
      const me = { end: null };
      const write = (s) => { if (!closed) res.write(s); };
      const end = (why) => {
        if (closed) return;
        closed = true;
        clearInterval(tick); clearInterval(beat); clearTimeout(stop);
        db.historyBus.off("row", onRow);
        db.historyBus.off("turn", onTurn);
        progressEvents.off("say", onProgress);
        webCh?.events?.off?.("typing", onTyping);
        const set = open.get(conv); set?.delete(me); if (set && !set.size) open.delete(conv);
        log({ ios_stream_end: why });
        try { res.end(); } catch { /* already gone */ }
      };
      me.end = end;
      const signedOut = () => { write("event: signedout\ndata: {}\n\n"); end("signed_out"); };
      const draw = () => {
        const page = pageFeed(conv, clock.now());
        const sections = JSON.stringify(page.sections);
        if (sections === lastSections) return;
        lastSections = sections;
        write(`event: page\ndata: ${JSON.stringify(page)}\n\n`);
      };
      const flush = () => {
        for (const r of db.messagesFor(conv, { after: lastRow, limit: 200 })) {
          lastRow = Math.max(lastRow, r.id);
          write(`id: ${r.id}\nevent: message\ndata: ${JSON.stringify(messageOut(r, conv))}\n\n`);
        }
      };
      const onRow = (e) => { if (e?.conversationId !== conv || closed) return; try { if (!db.pageSessionExists(token)) return signedOut(); flush(); } catch { end("failed"); } };
      // A turn ended: its replies first (so `done` never arrives before the reply it names), then `done`.
      const onTurn = (e) => {
        if (e?.conversationId !== conv || closed) return;
        try { if (!db.pageSessionExists(token)) return signedOut(); flush(); write(`event: done\ndata: ${JSON.stringify(turnDoneOut(e))}\n\n`); } catch { end("failed"); }
      };
      // A tool started in a turn of theirs (src/progress.js): the line, and the message the turn answers.
      // Their own message goes first, so `reply_to` always names a message the app already has.
      const onProgress = (e) => {
        if (e?.conversationId !== conv || closed) return;
        try {
          if (!db.pageSessionExists(token)) return signedOut();
          flush();
          write(`event: progress\ndata: ${JSON.stringify(progressOut(e, conv))}\n\n`);
        } catch { end("failed"); }
      };
      const webCh = router?.get?.(WEB) ?? null;
      const onTyping = (e) => { if (e?.to === account.address && !closed && db.pageSessionExists(token)) write(`event: typing\ndata: ${JSON.stringify({ on: !!e.on, until: e.until || 0 })}\n\n`); };
      const check = () => {
        if (closed) return;
        try {
          // The row itself every tick, so a sign-out elsewhere lands inside the same second; the full gate every 5 s.
          if (!db.pageSessionExists(token)) return signedOut();
          if ((sinceAuth += tickMs) >= 5_000) { sinceAuth = 0; if (iosAccount(headers)?.account.conversation_id !== conv) return signedOut(); }
          const print = fingerprint(conv);
          if (print !== lastPrint) { lastPrint = print; draw(); }
          flush();
        } catch (e) { log({ ios_stream_failed: (e?.message ?? String(e)).split("\n")[0] }); end("failed"); }
      };
      const tick = setInterval(check, tickMs);
      // The ping also redraws, for what changes with the clock alone (an item leaving the 72-hour window).
      const beat = setInterval(() => { write("event: ping\ndata: {}\n\n"); try { draw(); } catch { /* the ping still went */ } }, pingMs);
      const stop = setTimeout(() => end("cycle"), streamMs);
      for (const t of [tick, beat, stop]) t.unref?.();
      req?.on?.("close", () => end("closed"));
      res.on?.("close", () => end("closed"));
      const set = open.get(conv) ?? new Set();
      open.set(conv, set);
      set.add(me);
      while (set.size > MAX_STREAMS) [...set][0].end("replaced");
      write("retry: 1500\n\n");
      db.historyBus.on("row", onRow);
      db.historyBus.on("turn", onTurn);
      progressEvents.on("say", onProgress);
      webCh?.events?.on?.("typing", onTyping);
      check();
    },
  };
}

/** The `progress` event's data: { reply_to, text, tool, at } (docs/ios-api.md). */
export function progressOut(e, conv) {
  return { reply_to: db.userRowIdOf(conv, e.handle), text: e.text, tool: e.tool, at: e.at };
}
