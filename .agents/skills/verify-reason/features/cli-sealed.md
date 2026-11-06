# Sealed CLI turns (no operator email, no foreign workspace file)

**What it is.** Every person's Reason is sealed: nothing about one person reaches another, and the
operator is a person too. On the claude-cli backend, every model call is a `claude -p` child. Until
2026-11-06 each child ran in `/opt/reason` with the CLI's own config, so every person's turn carried
(a) the AGENTS.md in the repo root (an OpenClaw workspace template whose rules contradict Reason's:
bold text, "ask before anything leaves the machine", quiet hours, "commit and push"), next to
"Is a git repository" and the server path, and (b) a `userEmail` block with the **operator's own
account email**, which the CLI adds from its login profile (`oauthAccount` in `~/.claude.json`).
Found by the 2026-10-31 prompt audit; confirmed on a non-owner transcript.

**The fix** (`sealedCliHome` / `prepareSealedCli` / `childEnvFor`, `src/backends/cli.js`). Every child:
- runs in `~/.reason-cli/cwd`, an empty directory outside any repository;
- has `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (no CLAUDE.md / AGENTS.md from anywhere);
- has `CLAUDE_CONFIG_DIR=~/.reason-cli/config`, a config with no login profile in it (an
  `oauthAccount` that ever turns up there is removed before the next run), and no
  `CLAUDE_CODE_USER_EMAIL`. It signs in with `CLAUDE_CODE_OAUTH_TOKEN` (the server's `.env`).

The API backend never had either leak: `src/agent.js` builds the whole request and loads no
workspace file. `systemFor` for a non-owner carries no operator name or email.

## Prove it

1. Offline: `node --test test/cli-sealed.test.js` — a fake `claude` that loads context the way
   2.1.296 does (cwd ancestors, config dir, login profile, `CLAUDE_CODE_USER_EMAIL`) against a
   polluted HOME + project; the sealed run carries none of it, the control run (old way) does.
   Three of its four tests fail on the code before the fix.
2. The real CLI, on the wire, no model: `bin/cli-seal-probe.mjs` starts the real `claude` through
   Reason's own `runClaudeCli` for a non-owner system prompt, with `ANTHROPIC_BASE_URL` on a loopback
   stand-in that records the request and answers "ok". Nothing reaches Anthropic, nothing is billed,
   nothing is sent to anyone. Run it on Hetzner as `reason` from `/opt/reason`:

   ```bash
   ssh root@100.100.152.2 'cd /opt/reason && sudo -u reason -H node --env-file-if-exists=.env \
     .agents/skills/verify-reason/bin/cli-seal-probe.mjs --unsealed; \
     sudo -u reason -H node --env-file-if-exists=.env .agents/skills/verify-reason/bin/cli-seal-probe.mjs'
   ```

   `--unsealed` is the control and must show `operator_email: true`, `agents_or_claude_md: true`
   (exit 0 = leak reproduced). The sealed run must show every field false, `any_email: 0`, and
   `working_dir: /home/reason/.reason-cli/cwd` (exit 0 = clean).

Evidence 2026-11-06 (branch code on the box, CLI 2.1.296): control → 1 email (the operator's),
userEmail block, AGENTS.md, repo path; sealed → 0 emails, none of the rest, run ok.
