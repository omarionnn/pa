// The step machine (src/socialsignin.js stepOf): which screen a provider sign-in is on, read off the
// page, so Reason's own branded page can show the right native control and a plain live line while it
// drives the real pages behind. Pure reads only — no browser, no site, no provider is touched.
import { test } from "node:test";
import assert from "node:assert/strict";

const social = await import("../src/socialsignin.js");
const G = (url, text, fields = []) => social.stepOf({ url, text }, { provider: "google", fields });

test("the provider chooser, when the page only offers Continue-with", () => {
  const s = social.stepOf({ url: "https://www.notion.so/login", text: "Continue with Google\nContinue with Apple\nContinue with email" }, {});
  assert.equal(s.step, "chooser");
});

test("the email step, from a box the reader named", () => {
  const s = G("https://accounts.google.com/signin/v3/identifier", "Sign in\nUse your Google Account\nEmail or phone", [{ k: "email" }]);
  assert.equal(s.step, "email");
  assert.match(s.say, /email/i);
});

test("the password step", () => {
  const s = G("https://accounts.google.com/signin/v3/pwd", "Welcome\nomari@example.com\nEnter your password", [{ k: "password" }]);
  assert.equal(s.step, "password");
  assert.match(s.say, /on Google'?s own page/i, "says the password stays on the provider's page");
});

test("the account picker", () => {
  const s = G("https://accounts.google.com/signin/oauth/id", "Choose an account\nto continue to Notion\nOmari N\nUse another account", []);
  assert.equal(s.step, "account");
});

test("phone-tap: check your phone", () => {
  const s = G("https://accounts.google.com/signin/challenge", "2-Step Verification\nCheck your phone\nGoogle sent a notification to your phone. Tap Yes to sign in.", []);
  assert.equal(s.step, "phone_tap");
  assert.match(s.say, /phone/i);
});

test("number match: the number to tap is read out big", () => {
  const s = G("https://accounts.google.com/signin/challenge", "2-Step Verification\nOpen the Gmail app and tap the number you see below to sign in.\n47", []);
  assert.equal(s.step, "number_match");
  assert.equal(s.number, "47");
  assert.match(s.say, /47/);
});

test("code entry, by a numeric box or by its words", () => {
  assert.equal(G("https://accounts.google.com/signin/challenge/ipp", "Enter the code\nA text message with a 6-digit code was sent", []).step, "code");
  assert.equal(G("https://accounts.google.com/x", "whatever", [{ k: "otp" }]).step, "code");
});

test("consent is a step the person taps, never Reason", () => {
  const s = social.stepOf({ url: "https://accounts.google.com/signin/oauth/consent", text: "Notion wants access to your Google Account\nThis will allow Notion to see your name and email address.\nContinue\nCancel" }, { provider: "google" });
  assert.equal(s.step, "consent");
  assert.match(s.say, /I won'?t grant it for you/i);
});

test("captcha / verify-it's-you falls to the streamed page", () => {
  assert.equal(G("https://accounts.google.com/x", "To help keep your account safe, verify it's you. I'm not a robot", []).step, "captcha");
  assert.equal(G("https://x.com/challenge", "Checking your browser before you continue. Cloudflare", []).step, "captcha");
});

test("refusal is read before any form", () => {
  const s = G("https://accounts.google.com/signin", "Couldn't sign you in\nThis browser or app may not be secure. Try using a different browser.", [{ k: "username" }]);
  assert.equal(s.step, "refused");
  assert.equal(s.provider, "google");
});

test("a page it cannot place is unknown, so the page shows the real view for that step", () => {
  const s = G("https://accounts.google.com/weird", "", []);
  assert.equal(s.step, "unknown");
});

// The native page builds for every step, light and dark, without throwing — the mockup renderer and
// the live page both go through setupNativePage.
import { setupNativePage } from "../src/pages/setupsignin.js";
test("the native page renders for every step the machine can return", () => {
  const entry = { site: "notion", label: "Notion", signin_url: "https://www.notion.so/login", signin_blocked: false };
  for (const step of ["chooser", "email", "password", "phone_tap", "number_match", "code", "account", "consent", "signed_in", "refused", "captcha", "unknown"]) {
    const html = setupNativePage({ entry, step: { step, provider: "google", number: step === "number_match" ? "47" : "", say: "x" } });
    const body = typeof html === "string" ? html : html.body;
    assert.ok(body.includes("reason") || body.includes("Reason"), `${step} renders the brand`);
    if (step === "number_match") assert.ok(body.includes("47"), "the match number shows big");
    // The steps Reason can't drive open the streamed page by default; the rest tuck it away.
    const forced = ["account", "consent", "captcha", "unknown"].includes(step);
    assert.equal(/id="np-page"[^>]* open/.test(body), forced, `${step}: page ${forced ? "open" : "tucked away"}`);
  }
});

test("Google's own email page ('Sign in to continue to Notion') is the email step, never consent", () => {
  const s = social.stepOf({ url: "https://accounts.google.com/v3/signin/identifier", text: "Sign in to continue to Notion Email or phone Forgot email? Next" }, { provider: "google", fields: [{ k: "email" }] });
  assert.equal(s.step, "email");
  const c = social.stepOf({ url: "https://accounts.google.com/signin/oauth/id", text: "Sign in to Notion. By continuing, Google will share your name, email address and profile picture with Notion. Cancel Continue" }, { provider: "google", fields: [] });
  assert.equal(c.step, "consent");
});

test("the site's own page with buttons AND an email box is the chooser; Google's own page with a box is its email step", () => {
  const n = social.stepOf({ url: "https://www.notion.so/login", text: "Log in to Notion Continue with Google Continue with Apple Continue with Microsoft Email Continue" }, { fields: [{ k: "email" }] });
  assert.equal(n.step, "chooser");
  assert.deepEqual(n.offered, ["apple", "microsoft"], "Google is never offered");
  // A site page whose only provider is Google, with an email box: its email step, not a chooser.
  const only = social.stepOf({ url: "https://www.example-shop.com/login", text: "Log in Continue with Google Email Continue" }, { fields: [{ k: "email" }] });
  assert.equal(only.step, "email");
  // Google only and no box: the chooser, with nothing offered (the email route is the one choice).
  const bare = social.stepOf({ url: "https://www.example-shop.com/login", text: "Log in Continue with Google" }, { fields: [] });
  assert.equal(bare.step, "chooser");
  assert.deepEqual(bare.offered, []);
  const g = social.stepOf({ url: "https://accounts.google.com/v3/signin/identifier", text: "Sign in with Google Continue to Notion Email or phone" }, { provider: "google", fields: [{ k: "email" }] });
  assert.equal(g.step, "email");
});

// Seen live on the server, 2026-11-10: Notion's own login page (bare "Google" / "Apple" / "Microsoft"
// buttons, an email box, the word "password" in its small print) was read as GOOGLE's password step.
test("a site's own login page that names Google and 'password' is the chooser, never a provider step", () => {
  const raw = {
    url: "https://www.notion.so/login",
    text: "Think it. Make it. Log in to your Notion account Google Apple Microsoft Single sign-on (SSO) Email Enter your email address... Continue You can also continue with SAML SSO. By continuing, you acknowledge that you understand and agree to the Terms & Conditions and Privacy Policy. Forgot password?",
    buttons: ["Google", "Apple", "Microsoft", "Single sign-on (SSO)", "Continue"],
  };
  const s = social.stepOf(raw, { provider: "google", fields: [{ k: "email" }] });
  assert.equal(s.step, "chooser");
  assert.deepEqual(s.offered, ["apple", "microsoft"], "Google is never offered");
  // and with nothing to go on off the provider's host: never Google's password/code/phone step
  for (const text of ["Check your phone and tap Yes", "Enter your password to sign in", "Enter the verification code"]) {
    const x = social.stepOf({ url: "https://www.notion.so/login", text }, { provider: "google", fields: [] });
    assert.ok(!["password", "code", "phone_tap", "number_match"].includes(x.step), `${text} → ${x.step}`);
  }
  assert.doesNotMatch(social.stepOf({ url: "https://x.example/", text: "hello there" }, {}).say, /the the/);
});

test("Notion's real first page (email box AND a password box for password managers, bare provider buttons) is the chooser", () => {
  const raw = { url: "https://app.notion.com/login", text: "Log in to your Notion account Google Apple Microsoft Email Continue", buttons: ["Google", "Apple", "Microsoft", "Continue"] };
  assert.equal(social.stepOf(raw, { fields: [{ k: "email" }, { k: "password" }] }).step, "chooser");
});

test("a password box with a provider button but no email box is the password step, not the chooser", () => {
  const raw = { url: "https://site.example/login/password", text: "Enter your password Continue with Google", buttons: ["Continue with Google", "Sign in"] };
  assert.equal(social.stepOf(raw, { fields: [{ k: "password" }] }).step, "password");
});
