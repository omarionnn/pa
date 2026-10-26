#!/usr/bin/env node
// Reason's contact card is content-addressed: every sender texts /reason-<sha8>.vcf, where sha8 is
// the first 8 hex of the sha256 of the card as served, so a new photo is a new URL and no
// Sendblue/iMessage copy of an old one can be reused. /reason.vcf stays as an alias.
//
//   node bin/contact-card.mjs                     # in-process, under `caged.sh env` (fake channel)
//   node bin/contact-card.mjs --live <base-url>   # read-only GETs against a running install
//
// Checks: the sent URL's hash = sha8 of the served bytes; the hashed path and the alias serve the
// same card; PHOTO is the orange photo (sha pinned in test/contact-card-orange.test.js); a REV:
// line; NOTE = "Your personal concierge" (10-25); no long cache. Sends nothing to anybody.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../../../../", import.meta.url);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ORANGE = /const ORANGE = "([0-9a-f]{64})"/.exec(readFileSync(new URL("test/contact-card-orange.test.js", root), "utf8"))[1];
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };

function checkCard(body, cache, label) {
  const photo = /\r\nPHOTO;ENCODING=b;TYPE=JPEG:([\s\S]*?)\r\n(?! )/.exec(body)?.[1]?.replace(/\r\n /g, "");
  check(!!photo && sha(Buffer.from(photo, "base64")) === ORANGE, `${label}: PHOTO is the orange photo`);
  check(/\r\nNOTE:Your personal concierge\r\n/.test(body), `${label}: NOTE is "Your personal concierge"`);
  check(/\r\nREV:\d{4}-\d\d-\d\dT[\d:]+Z\r\n/.test(body), `${label}: has a REV: line`);
  check(!/max-age=[1-9]/.test(cache ?? ""), `${label}: no long cache (${cache})`);
}

const live = process.argv.indexOf("--live");
if (live > 0) {
  const base = (process.argv[live + 1] ?? "").replace(/\/+$/, "");
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, cache: r.headers.get("cache-control"), body: await r.text() }; };
  const alias = await get("/reason.vcf");
  check(alias.status === 200, `GET /reason.vcf → ${alias.status}`);
  const hashed = `/reason-${sha(alias.body).slice(0, 8)}.vcf`;
  const r = await get(hashed);
  check(r.status === 200, `GET ${hashed} → ${r.status}`);
  check(r.body === alias.body, "hashed path and alias serve the same card");
  checkCard(r.body, r.cache, hashed);
} else {
  for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY"]) {
    if (process.env[k]) { console.error(`refusing: ${k} is set — run under caged.sh env`); process.exit(2); }
  }
  process.env.REASON_PUBLIC_URL ||= "https://reason.example.test";
  const imp = (p) => import(new URL(p, root));
  const { Runtime } = await imp("src/runtime.js");
  const { Router } = await imp("src/channels/router.js");
  const { FakeChannel } = await imp("src/channels/fake.js");
  const { assetRequest } = await imp("src/http.js");
  const { offerContactCard } = await imp("src/contact.js");
  const router = new Router({ runtime: new Runtime({ runTurn: async () => "ok" }), judge: async () => ({ verdict: "no" }), log: () => {} });
  const ch = router.register(new FakeChannel({ number: "+16562167455" }));
  const out = await offerContactCard({ router, account: { conversation_id: "dm:fake:+14155550100", channel: "fake", address: "+14155550100" } });
  check(out.outcome === "sent", `offerContactCard → ${out.outcome}`);
  const url = ch.sent.find(m => m.media?.url)?.media.url ?? "";
  const path = new URL(url || "http://x/").pathname;
  check(/^\/reason-[0-9a-f]{8}\.vcf$/.test(path), `sent URL is content-addressed (${path})`);
  const res = assetRequest({ pathname: path, router });
  check(res?.status === 200, `GET ${path} → ${res?.status}`);
  check(path === `/reason-${sha(res.body).slice(0, 8)}.vcf`, "URL hash = sha8 of the served card");
  check(assetRequest({ pathname: "/reason.vcf", router })?.body === res.body, "/reason.vcf is an alias");
  checkCard(res.body, res.headers["Cache-Control"], path);
}
console.log(fails ? `${fails} failed` : "contact-card ok");
process.exit(fails ? 1 : 0);
