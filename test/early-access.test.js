// REASON_EARLY_ACCESS (src/accounts.js featureOwner): a listed conversation gets ONLY the features in
// EARLY_ACCESS_FEATURES (paid events) while their flag says "owner" — no other owner-only feature and
// nothing the operator has. A random conversation gets none of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

const dir = mkdtempSync(pathJoin(tmpdir(), "reason-early-access-"));
process.env.REASON_DB_PATH = pathJoin(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_CONVERSATION = "dm:owner";
process.env.REASON_ONBOARDING = "off";
process.env.REASON_EVENTS = "on";
process.env.REASON_PAID_EVENTS = "owner";
process.env.REASON_SOCIAL_SIGNIN = "owner";
process.env.REASON_DIRECTIONS = "owner";
process.env.REASON_IOS_API = "owner";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_for_tests";
const EARLY = "dm:sendblue:+15555550147";
const RANDOM = "dm:sendblue:+15555550199";
process.env.REASON_EARLY_ACCESS = ` ${EARLY} , ,dm:sendblue:+15555550148`;

const accounts = await import("../src/accounts.js");
const { toolsFor, INVITE_MASTER_TOOLS } = await import("../src/tools.js");
const eventpay = await import("../src/eventpay.js");
const social = await import("../src/socialsignin.js");
const { tripsOnFor } = await import("../src/trips.js");
const { iosAllowedFor } = await import("../src/ios/session.js");
const plan = await import("../src/plan.js");

const names = (c) => new Set(toolsFor(c).map(t => t.name));
const PAID_TOOLS = ["event_price", "event_payouts", "event_refund"];
const OTHER_OWNER_TOOLS = ["signin_provider", "directions"];
const FEATURE_TOOLS = [...PAID_TOOLS, ...OTHER_OWNER_TOOLS];

test("the owner sees every owner-only feature tool (baseline)", () => {
  const n = names("dm:owner");
  for (const t of FEATURE_TOOLS) assert.ok(n.has(t), t);
});

test("an early-access id gets paid events and NO other owner-only feature", () => {
  const n = names(EARLY);
  for (const t of PAID_TOOLS) assert.ok(n.has(t), t);
  for (const t of OTHER_OWNER_TOOLS) assert.ok(!n.has(t), `not early access: ${t}`);
  assert.equal(eventpay.canPrice(EARLY), true);
  assert.equal(social.socialAllowedFor(EARLY), false);
  assert.equal(tripsOnFor(EARLY), false);
  assert.equal(iosAllowedFor(EARLY), false);
  assert.equal(accounts.featureOwner(EARLY, "paidEvents"), true);
  assert.equal(accounts.featureOwner(EARLY), false, "a gate that names no feature stays operator-only");
  assert.equal(accounts.featureOwner(EARLY, "directions"), false);
});

test("a random id gets none of them", () => {
  const n = names(RANDOM);
  for (const t of FEATURE_TOOLS) assert.ok(!n.has(t), t);
  assert.equal(eventpay.canPrice(RANDOM), false);
  assert.equal(social.socialAllowedFor(RANDOM), false);
  assert.equal(tripsOnFor(RANDOM), false);
  assert.equal(iosAllowedFor(RANDOM), false);
  assert.equal(accounts.featureOwner(RANDOM), false);
  assert.equal(accounts.featureOwner(""), false);
  assert.equal(accounts.featureOwner(undefined), false);
});

test("an early-access id never gets operator powers", () => {
  assert.equal(accounts.ownerOf(EARLY).isOperator, false);
  const n = names(EARLY);
  for (const t of INVITE_MASTER_TOOLS) assert.ok(!n.has(t), `operator tool ${t}`);
  assert.ok(names("dm:owner").has([...INVITE_MASTER_TOOLS][0]), "baseline: the owner has them");
  // The paywall's owner-only mode exempts the operator, never an early-access id.
  process.env.REASON_PAYWALL = "owner";
  try { assert.equal(plan.appliesTo(EARLY), false); } finally { delete process.env.REASON_PAYWALL; }
});

test("ids match exactly: no prefix, no substring, empty list is nobody", () => {
  assert.equal(accounts.earlyAccess("dm:sendblue:+1555555014"), false);
  assert.equal(accounts.earlyAccess(`${EARLY}x`), false);
  const was = process.env.REASON_EARLY_ACCESS;
  process.env.REASON_EARLY_ACCESS = "";
  try { assert.equal(accounts.featureOwner(EARLY, "paidEvents"), false); assert.equal(eventpay.canPrice(EARLY), false); }
  finally { process.env.REASON_EARLY_ACCESS = was; }
});
