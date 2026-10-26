#!/usr/bin/env node
// The tagline is "Your personal concierge" (owner copy 10-25) on the two pages a stranger sees:
// the home page (GET /) and an invite page (GET /i/{token}), including the invite's link-preview
// og:description. The old "…lives in your texts" line must be gone from both.
//
//   node bin/tagline.mjs [--out <dir>]           # in-process, throwaway DB, fake channel; --out writes home.html + invite.html
//   node bin/tagline.mjs --live <base-url>       # read-only GET / against a running install
//
// Sends nothing to anybody: the in-process run mints one invite in its own temp database.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../../../", import.meta.url);
let fails = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) fails++; };
const OLD = /lives in your texts/i;
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

const live = arg("--live");
if (live) {
  const r = await fetch(live.replace(/\/+$/, "") + "/");
  const body = await r.text();
  check(r.status === 200, `GET / → ${r.status}`);
  check(/Your personal concierge/.test(body), `GET /: says "Your personal concierge"`);
  check(!OLD.test(body), `GET /: old tagline gone`);
} else {
  for (const k of ["SENDBLUE_API_KEY_ID", "SENDBLUE_API_KEY", "SENDBLUE_API_SECRET_KEY", "LINQ_API_KEY"]) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "reason-tagline-"));
  Object.assign(process.env, {
    REASON_DB_PATH: join(dir, "reason.db"), REASON_OWNER_NAME: "Omari", REASON_CONVERSATION: "dm:owner",
    REASON_MASTER_NUMBER: "+12025551234", REASON_PUBLIC_URL: "https://reason.example.test", REASON_INVITES_OPEN: "1",
  });
  const imp = (p) => import(new URL(p, root));
  const { homePage } = await imp("src/pages/site.js");
  const invites = await imp("src/invites.js");
  const db = await imp("src/db.js");
  const { Runtime } = await imp("src/runtime.js");
  const { Router } = await imp("src/channels/router.js");
  const { FakeChannel } = await imp("src/channels/fake.js");
  const { inviteRequestFor } = await imp("src/http.js");
  const { config } = await imp("src/config.js");
  db.upsertAccount({ conversationId: config.ownerConversation, channel: "fake", address: "+12025551234", name: "Omari", isOperator: true });
  db.upsertAccount({ conversationId: "dm:fake:+14155559876", channel: "fake", address: "+14155559876", name: "Kofi" });
  db.backfillInviteAllowances();
  const router = new Router({ runtime: new Runtime({ runTurn: async () => "ok" }), judge: async () => ({ verdict: "unclear" }), log: () => {} });
  router.register(new FakeChannel({ number: "+16562167455" }));

  const home = homePage();
  const homeBody = home.body ?? String(home);
  check(/Your personal concierge/.test(homeBody), `home page: says "Your personal concierge"`);
  check(!OLD.test(homeBody), "home page: old tagline gone");

  const link = invites.makeLink("dm:fake:+14155559876");
  check(link.ok, `minted a throwaway invite (${link.ok ? "ok" : JSON.stringify(link)})`);
  const inv = db.getInvite("dm:fake:+14155559876", link.number);
  const page = inviteRequestFor({ token: inv.token, router });
  check(page.status === 200, `invite page → ${page.status}`);
  check(/Reason is your personal concierge\./.test(page.body), `invite page: "Reason is your personal concierge."`);
  check(/og:description" content="Your personal concierge\./.test(page.body), "invite page: og:description is the new line");
  check(!OLD.test(page.body), "invite page: old tagline gone");

  const out = arg("--out");
  if (out) { writeFileSync(join(out, "home.html"), homeBody); writeFileSync(join(out, "invite.html"), page.body); }
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `${fails} FAIL` : "all ok");
process.exit(fails ? 1 : 0);
