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
  `CLAUDE_CODE_USER_EMAIL`. It signs in with `CLAUDE_CODE_OAUTH_TOKEN` (the server's `.env`);
  with no token and a `~/.claude/.credentials.json`, that file is symlinked into the sealed config
  (`prepareSealedCli`). A profile stripped out of the sealed `.claude.json` is written aside and
  renamed over (72df026), so a child never reads half a file. `REASON_CLI_HOME` moves the whole
  sealed root (default `~/.reason-cli`).

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

3. **On this Mac** (no server, no subscription spent): the Mac's login is in the Keychain, not a
   credentials file, so a sealed child here has no auth and the probe says `no request reached the
   stand-in: nothing proven`. Give it a dummy bearer — it only ever reaches the loopback stand-in —
   and a throwaway sealed root:

   ```bash
   cd <checkout> && export REASON_CLI_HOME=$(mktemp -d)/rc
   node .agents/skills/verify-reason/bin/cli-seal-probe.mjs --unsealed          # control: operator_email true
   CLAUDE_CODE_OAUTH_TOKEN=probe-not-a-key node .agents/skills/verify-reason/bin/cli-seal-probe.mjs
   ```

   The dummy login has to be `CLAUDE_CODE_OAUTH_TOKEN`: since #346 the child's env is an allowlist
   (`CHILD_ENV_KEEP` in `src/backends/cli.js`), and `ANTHROPIC_AUTH_TOKEN` is not on it. With the old
   `ANTHROPIC_AUTH_TOKEN` dummy the sealed run gives `run_ok: false`, `requests: 0`, "no request reached
   the stand-in" (2026-11-07 at `8a1fe18`); with `CLAUDE_CODE_OAUTH_TOKEN` it is `run_ok: true`,
   1 request, every field false. #346 also gives a tool turn `--tools ToolSearch` only and makes the
   tool bridge answer only this turn's Bearer secret (`src/backends/mcp-http.js`);
   `bin/cli-tools-probe.mjs` is its wire probe.

   2026-11-06 at `c6ce172` (worktree, no AGENTS.md in it): control → `any_email: 1`,
   `operator_email`, `user_email_block`, `git_repository_true`, `repo_path` all true; sealed →
   `run_ok: true`, 1 request, every field false, `working_dir` = `$REASON_CLI_HOME/cwd`.
   `node --test test/cli-sealed.test.js` 4/4. Re-run 2026-11-07 at `8113bcf` (sealed run only,
   `env -i HOME PATH REASON_CLI_HOME=$(mktemp -d)/rc CLAUDE_CODE_OAUTH_TOKEN=probe-not-a-key`):
   `run_ok: true`, 1 request, every field false; test 4/4.

Evidence 2026-11-06 (branch code on the box, CLI 2.1.296): control → 1 email (the operator's),
userEmail block, AGENTS.md, repo path; sealed → 0 emails, none of the rest, run ok.

## The operator's city stays in the operator's turn (`capabilities`)

The same seal on the tool side. `whoLine` (`src/agent.js`) names `config.ownerCity`
(`REASON_OWNER_CITY`, default "New York") only for the operator; everyone else's prompt says never
assume a city. Until audit lead 24 (2026-11-07) the `capabilities` result (`src/tools.js`, case
`"capabilities"`) returned `city: config.ownerCity` in every conversation, labelled beside the
caller's own `owner` name, and non-operator onboarding is told to call capabilities. Now `city` is
only in the result when `accounts.ownerOf(c).isOperator`; a non-operator (or a conversation with no
account row) gets no `city` key at all.

Prove it: `node --test test/capabilities-city.test.js` (2 of its 3 tests fail on the code before
the fix). Drive 2 against the cage, `REASON_OWNER_CITY=Testville`: upsert a non-operator account,
`runTool("capabilities", {}, { conversationId, messages: [] })` for it and for
`config.ownerConversation`. 2026-11-07 at `2874b92` (cage on 8864): non-operator →
`owner: "Kofi"`, no `city`, "Testville" nowhere in the result; operator → `owner: "Omari"`,
`city: "Testville"`.
