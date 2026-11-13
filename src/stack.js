// A set of pictures as ONE swipeable stack (owner, 2026-11-13): the way the welcome cards arrive
// (src/welcome.js), for any set of cards Reason sends in one go — today the option cards
// (src/choicecards.js, shopping and places).
//
// The mechanism is the welcome cards' own: one outbox row whose media is `{ carousel, pictures }`
// (src/outbox.js attempt, src/channels/router.js sendNow). The adapter sends it as one message:
//
//   sendblue   POST /api/send-carousel, 2–20 HTTPS addresses Sendblue fetches. V2 lines only.
//   linq       one message whose parts are the pictures as `{ type: "media", url }`, up to 40
//              by address, 10 MB each (src/channels/linq.js sendCarousel).
//   others     no stack (Web, console): the pictures go one by one, exactly as before.
//
// A stack that cannot go for good — a V1 Sendblue line, a refusal, out of tries — becomes its
// pictures one message each, in order, in its place (the outbox does that, as for the welcome cards).
// A set larger than the line's ceiling goes as several stacks, sizes as even as they can be
// (21 on a 20-ceiling line is 11 + 10, never 20 + 1); the numbers on the cards run across the
// whole set, because they were drawn that way.
//
//   REASON_PICTURE_STACKS=off   every set one by one again (default on)

export function stacksOn() {
  return !["0", "false", "off", "no"].includes(String(process.env.REASON_PICTURE_STACKS ?? "").trim().toLowerCase());
}

/** The most pictures one stack takes on this channel, or 0 when it has none. */
export function stackMax(router, channel) {
  const ch = router?.get?.(channel);
  if (!ch || typeof ch.sendCarousel !== "function") return 0;
  const n = Number(ch.stackMax ?? 20);
  return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 0;
}

/** Can a set of `n` pictures go as a stack here? Two at least: one picture is just a picture. */
export const canStack = (router, channel, n) => stacksOn() && n >= 2 && stackMax(router, channel) >= 2;

/**
 * `n` pictures split for a ceiling of `max`: as few stacks as fit, sizes as even as they can be,
 * the larger first. [] for nothing; one stack when it fits.
 */
export function stackSizes(n, max) {
  if (!(n > 0)) return [];
  if (!(max >= 2) || n <= max) return [n];
  const k = Math.ceil(n / max);
  const small = Math.floor(n / k);
  const big = n % k;
  return Array.from({ length: k }, (_, i) => small + (i < big ? 1 : 0));
}

/** "1 of 5": the label a card in a set carries. */
export const ofLabel = (n, total) => `${n} of ${total}`;

const isHttps = (u) => /^https:\/\/\S+$/.test(String(u ?? ""));

/**
 * Send `pictures` ([{ file, url?, mimeType, filename }], in order) to one thread: as stacks when the
 * channel has them and every picture has an HTTPS address, one by one otherwise. Never throws.
 *
 * Returns { sent, of, stacked, handles } — `handles[i]` is the message handle of picture i (a stack's
 * pictures share one, as they are one message), null where none came back.
 *
 * The one-by-one path is today's: each awaited before the next, `gapMs` between, idempotency keys
 * `${key}:1`, `${key}:2`…, stopped at the first that did not go so the numbers never arrive out of order.
 */
export async function sendPictureSet({
  router, channel, to, chatId = null, conversationId, toOwner = true, idempotencyKey, pictures,
  historyText = "", gapMs = 0, log = () => {}, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
}) {
  const all = (pictures ?? []).filter(Boolean);
  const handles = [];
  if (!all.length) return { sent: 0, of: 0, stacked: false, handles };

  if (canStack(router, channel, all.length) && all.every(p => isHttps(p.url)) && typeof router.sendCarousel === "function") {
    const sizes = stackSizes(all.length, stackMax(router, channel));
    let start = 0;
    let sent = 0;
    for (const [k, size] of sizes.entries()) {
      const part = all.slice(start, start + size);
      if (k) await sleep(gapMs);
      let r;
      try {
        r = await router.sendCarousel({
          channel, to, chatId, conversationId, toOwner,
          idempotencyKey: `${idempotencyKey}:stack${sizes.length > 1 ? k + 1 : ""}`,
          mediaUrls: part.map(p => p.url),
          pictures: part.map(p => ({ file: p.file, mimeType: p.mimeType ?? "image/jpeg", filename: p.filename ?? null })),
          historyText: historyText ? `(pictures, one swipeable set${sizes.length > 1 ? `, part ${k + 1} of ${sizes.length}` : ""}) ${historyText}` : "",
        });
      } catch (e) {
        r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
      }
      if (!r?.ok) {
        log({ picture_stack_failed: conversationId, part: k + 1, of: sizes.length, why: r?.error ?? "unknown", queued: !!r?.queued });
        break;
      }
      // Went as one stack, or — the outbox's fall-back — as its pictures one by one, in order. Either
      // way every picture of this part is in the thread; only a real stack shares one handle.
      const asStack = r.delivered?.media?.renders_as === "carousel" || Array.isArray(r.delivered?.carousel);
      const handle = asStack ? r.delivered?.message_id ?? null : null;
      for (let i = 0; i < size; i++) handles[start + i] = handle;
      sent += size;
      start += size;
      log({ picture_stack_sent: conversationId, part: k + 1, of: sizes.length, n: size, as: asStack ? "stack" : "pictures" });
    }
    return { sent, of: all.length, stacked: true, handles };
  }

  let sent = 0;
  for (const [i, p] of all.entries()) {
    if (i) await sleep(gapMs);
    let r;
    try {
      r = await router.sendMedia({
        channel, to, chatId, text: "",
        file: p.file, mimeType: p.mimeType ?? "image/jpeg", filename: p.filename ?? null,
        conversationId, toOwner, idempotencyKey: `${idempotencyKey}:${i + 1}`,
      });
    } catch (e) {
      r = { ok: false, error: (e?.message ?? String(e)).split("\n")[0] };
    }
    if (!r?.ok) {
      log({ picture_failed: conversationId, n: i + 1, why: r?.error ?? "unknown" });
      break;
    }
    handles[i] = r.delivered?.message_id ?? null;
    sent++;
  }
  return { sent, of: all.length, stacked: false, handles };
}
