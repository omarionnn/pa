// No credential ever goes on a command line (2026-11-08): a call-quality drive on the Hetzner box ran
// `sudo -u reason env -i … OPENAI_API_KEY=<key> CLAUDE_CODE_OAUTH_TOKEN=<token> node …`, copied from a
// drive's own header, so `ps` showed both to every user on the box. `env`, `sudo`, `ssh host "…"` and
// `docker -e` all turn an inline NAME=value into argv. Drives read keys from an env file instead:
// `node --env-file=<0600 file> …` (see verify-reason SKILL.md, "Keys for a drive"). This test fails
// when any skill script, script, doc or shell file shows a credential-named variable set inline to a
// value — even a placeholder like `…`, because placeholders are what builders fill in. Empty
// assignments (`OPENAI_API_KEY=` to blank a key) are fine. REASON_* names are throwaway values the
// harness generates per run (caged.sh), not credentials, so they are out of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
// `export NAME=…` is a shell builtin (no process, no argv) and is how caged.sh env hands over fakes.
const SECRET = /(?<![A-Z0-9_]|export )((?!REASON_)[A-Z0-9_]*(?:API_KEY|OAUTH_TOKEN|AUTH_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|WEBHOOK_SECRET|SECRET_KEY|PRIVATE_KEY|JWT_KEY))=(?!$|"$|[\s\\`)}]|""|'')(["']?)([^\s"'`]*)/g;
const DUMMY = /^(cage(-fake)?|fake[\w-]*|probe-not-a-key|dummy|x|y|%s.*)$/;
// The local cage's own per-run random secrets (made fresh by caged.sh, never a real credential).
const ALLOW = { ".agents/skills/verify-reason/bin/caged.sh": ["LINQ_WEBHOOK_SECRET", "SENDBLUE_WEBHOOK_SECRET"] };

export function inlineSecrets(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(SECRET)) if (!DUMMY.test(m[3])) hits.push({ line: i + 1, name: m[1] });
  });
  return hits;
}

test("the pattern: inline values flagged, blanks and env-file runs not", () => {
  for (const bad of ["sudo -u reason env -i OPENAI_API_KEY=… node x.mjs", "CLAUDE_CODE_OAUTH_TOKEN=\"$(get X)\" node y",
    "ssh root@h 'LINQ_API_KEY=abc node z'", "docker run -e TWILIO_AUTH_TOKEN=$T img", "OPENAI_API_KEY=sk-x node a",
    "env -i CLAUDE_CODE_OAUTH_TOKEN=\"$(security find-generic-password -w)\" node b"])
    assert.equal(inlineSecrets(bad).length, 1, bad);
  for (const ok of ["ANTHROPIC_API_KEY= node --test", "    BLAND_API_KEY= \\", "node --env-file=$ENVF drive.mjs",
    "REASON_TOKEN_KEY=$(openssl rand -hex 32)", "const k = process.env.OPENAI_API_KEY;", "OPENAI_API_KEY=\"\" node a",
    "KEY=(ANTHROPIC_API_KEY=)", "${LQ[0]#LINQ_WEBHOOK_SECRET=}", "export SENDBLUE_API_SECRET_KEY=cage-fake",
    "GITHUB_OAUTH_CLIENT_SECRET=cage node d", "CLAUDE_CODE_OAUTH_TOKEN=probe-not-a-key node e", "LINQ_API_KEY=x node f",
    "export CLAUDE_CODE_OAUTH_TOKEN=$(security find-generic-password -w)"])
    assert.equal(inlineSecrets(ok).length, 0, ok);
});

test("no skill script, script, doc or shell file puts a credential on a command line", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--", ".agents", "scripts", "docs", "README.md", "*.sh"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(f => f && !/\.env(\.|$)|node_modules\//.test(f) && !f.endsWith("test/no-secrets-on-argv.test.js"));
  const found = [];
  for (const f of files) {
    let text; try { text = readFileSync(new URL(f, root), "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    for (const h of inlineSecrets(text)) if (!ALLOW[f]?.includes(h.name)) found.push(`${f}:${h.line} ${h.name}=`);
  }
  assert.deepEqual(found, [], "credential set inline (shows in ps / shell history); read it from an env file with node --env-file:\n" + found.join("\n"));
});
