// Can this run somewhere that is not the operator's laptop?
//
// Not "does it deploy" — nothing here deploys anything. These are the properties a hosted install
// needs, each one testable without a container:
//
//   - **one data directory.** Everything Reason keeps goes under it, so a host can mount one
//     volume. State split between a volume and the container filesystem is state that vanishes.
//   - **config from the environment only.** No config file to forget to copy.
//   - **the address it is told to use**, because a page link has to work from a phone.
//   - **a stop that loses nothing.** A task mid-step must not be left asleep for good.
//   - **a health check that reads something real.**
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reason-deploy-"));
process.env.REASON_DB_PATH = join(dir, "reason.db");
process.env.REASON_OWNER_NAME = "Omari";
process.env.REASON_TZ = "America/New_York";
process.env.REASON_CONVERSATION = "dm:owner";

const { Runtime } = await import("../src/runtime.js");
const { health, createServer } = await import("../src/http.js");
const { Router } = await import("../src/channels/router.js");
const { runTool } = await import("../src/tools.js");
const db = await import("../src/db.js");
const { clock, config } = await import("../src/config.js");

const C = config.ownerConversation;
db.upsertAccount({ conversationId: C, channel: "test", address: "+12025551234", name: "Omari", isOperator: true });

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  clock.reset();
  db.db.exec("DELETE FROM tasks; DELETE FROM task_log; DELETE FROM timers;");
});

// ---------- one directory ----------

test("one env var puts every kind of state under one directory", async () => {
  // Checked in a child process, because config is read once at import.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["-e", `
    import("./src/config.js").then(({ config }) => {
      console.log(JSON.stringify({
        dataDir: config.dataDir, db: config.dbPath, rec: config.recordingRoot,
        prof: config.profileRoot, shots: config.shotRoot,
      }));
    })`], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, REASON_DATA_DIR: "/mnt/reason", REASON_DB_PATH: "", REASON_RECORDING_ROOT: "", REASON_PROFILE_ROOT: "", REASON_SHOT_ROOT: "" }, encoding: "utf8" });
  const paths = JSON.parse(out);

  assert.equal(paths.dataDir, "/mnt/reason");
  for (const [what, p] of Object.entries(paths)) {
    assert.ok(String(p).startsWith("/mnt/reason"), `${what} (${p}) must live under the data directory`);
  }
  // The four kinds of state a restart must not lose, all of them under it.
  assert.equal(paths.db, "/mnt/reason/reason.db");
  assert.equal(paths.rec, "/mnt/reason/recordings");
  assert.equal(paths.prof, "/mnt/reason/profiles");
  assert.equal(paths.shots, "/mnt/reason/shots");
});

test("each path can still be pointed somewhere else on its own", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["-e", `import("./src/config.js").then(({config})=>console.log(config.dbPath))`],
    { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, REASON_DATA_DIR: "/mnt/reason", REASON_DB_PATH: "/elsewhere/x.db" }, encoding: "utf8" });
  assert.equal(out.trim(), "/elsewhere/x.db");
});

test("the address it is told to use is the address it hands out", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["-e", `
    import("./src/pages/access.js").then(({ pageUrl, linksAreReachable }) => {
      console.log(JSON.stringify({ url: pageUrl("abc123"), reachable: linksAreReachable() }));
    })`], { cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, REASON_PUBLIC_URL: "https://reason.example.com/", REASON_HOST: "0.0.0.0", REASON_PORT: "9999" }, encoding: "utf8" });
  const r = JSON.parse(out);
  assert.equal(r.url, "https://reason.example.com/p/abc123", "no doubled slash, and the public name not the bind address");
  assert.equal(r.reachable, true);
});

test("config comes from the environment, with no config file to forget", () => {
  // If this ever starts reading a config file, a hosted install gets a surprise. The only files
  // src/config.js may touch are none.
  const src = readFileSync(resolve(import.meta.dirname, "../src/config.js"), "utf8");
  assert.equal(/readFileSync|readFile\(|require\(['"]\.\/|JSON\.parse\(read/.test(src), false,
    "config must be environment-only");
  assert.ok(src.includes("process.env.REASON_DATA_DIR"));
});

// ---------- a stop that loses nothing ----------

/** A task that has been woken and is therefore mid-step: open, with no wake time. */
async function taskMidStep(title = "chase the handyman") {
  const made = await runTool("task_start", { title, goal: "get them to call back" }, { conversationId: C });
  db.markTaskWoken(made.task.id);
  const row = db.getTaskAnywhere(made.task.id);
  assert.equal(row.next_wake_at, null, "mid-step means nothing will wake it");
  assert.equal(row.open, true);
  return made.task.id;
}

test("a task that was mid-step when the process stopped is not lost", async () => {
  const id = await taskMidStep();
  const rt = new Runtime({ runTurn: async () => null });

  const out = await rt.shutdown();
  assert.equal(out.rescued, 1, "shutdown gives it a wake time back");
  const after = db.getTaskAnywhere(id);
  assert.ok(after.next_wake_at, "so something will come back to it");
  assert.equal(after.open, true);
});

test("a task orphaned by a hard kill is rescued on the next start", async () => {
  // No graceful shutdown at all: the process just went away.
  const id = await taskMidStep();
  const logs = [];
  const rt = new Runtime({ runTurn: async () => null, log: (e) => logs.push(e) });
  rt.start(60_000);
  try {
    assert.ok(db.getTaskAnywhere(id).next_wake_at, "the new process picks it up");
    assert.ok(logs.some(l => l.rescued_tasks), "and says the last stop was not clean");
  } finally { rt.stop(); }
});

test("a finished task is not resurrected by the rescue", async () => {
  const made = await runTool("task_start", { title: "done thing", goal: "x" }, { conversationId: C });
  await runTool("task_finish", { task_id: made.task.id, state: "done", outcome: "sorted" }, { conversationId: C });
  const rescued = db.rescueOrphanedTasks(clock.now() + 1000);
  assert.deepEqual(rescued, [], "only open work is rescued");
  assert.equal(db.getTaskAnywhere(made.task.id).next_wake_at, null);
});

test("a task with a wake time already is left exactly as it is", async () => {
  const made = await runTool("task_start", { title: "later", goal: "x", wake_in_minutes: 30 }, { conversationId: C });
  const before = db.getTaskAnywhere(made.task.id).next_wake_at;
  assert.ok(before);
  db.rescueOrphanedTasks(clock.now() + 1000);
  assert.equal(db.getTaskAnywhere(made.task.id).next_wake_at, before, "not brought forward");
});

test("shutdown drains what is running before it rescues", async () => {
  const order = [];
  const rt = new Runtime({
    runTurn: async () => { await new Promise(r => setTimeout(r, 40)); order.push("turn finished"); return null; },
  });
  const turn = rt.inbound(C, "hello");
  await rt.shutdown();
  order.push("shutdown returned");
  await turn;
  assert.deepEqual(order, ["turn finished", "shutdown returned"], "the in-flight turn was not cut off");
});

// ---------- health ----------

test("health reads real state, not uptime", async () => {
  await runTool("task_start", { title: "open one", goal: "x", wake_in_minutes: 5 }, { conversationId: C });
  const rt = new Runtime({ runTurn: async () => null });
  const body = health({ router: new Router({}), runtime: rt });

  assert.equal(body.ok, true);
  assert.equal(body.sweeping, false, "it has not been started");
  assert.equal(body.open_tasks, 1, "read off the tasks table");
  assert.ok("channels" in body);
  assert.ok("pending_timers" in body);
  // Nothing about anybody's content.
  assert.equal(JSON.stringify(body).includes("open one"), false, "health is not a window into conversations");
});

test("health answers over a real socket, and an unknown path does not", async () => {
  const rt = new Runtime({ runTurn: async () => null });
  const server = createServer({ router: new Router({}), runtime: rt });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally { server.close(); }
});

// ---------- the Dockerfile, as far as it can be checked without Docker ----------

test("the Dockerfile matches the Playwright version actually installed", async () => {
  const root = resolve(import.meta.dirname, "..");
  assert.ok(existsSync(join(root, "Dockerfile")));
  const df = readFileSync(join(root, "Dockerfile"), "utf8");

  // A mismatch here fails at runtime, not at build time, which is the worst place to find it.
  const installed = JSON.parse(readFileSync(join(root, "node_modules/playwright/package.json"), "utf8")).version;
  assert.ok(df.includes(`playwright:v${installed}-noble`), `Dockerfile should use the playwright image for ${installed}`);

  // The things a hosted install depends on being right.
  assert.match(df, /ENV REASON_DATA_DIR=\/data/);
  assert.match(df, /VOLUME \["\/data"\]/, "without a volume a restart forgets everything");
  assert.match(df, /ENV REASON_HOST=0\.0\.0\.0/, "it has to listen on the container's interface");
  assert.match(df, /STOPSIGNAL SIGTERM/);
  assert.match(df, /CMD \["node", "src\/serve\.js"\]/, "node as PID 1, so it gets SIGTERM itself");
  // Only the CMD line: the comments above it mention npm precisely to explain why it is not used.
  const cmd = df.split("\n").filter(l => /^(CMD|ENTRYPOINT)/.test(l)).join(" ");
  assert.doesNotMatch(cmd, /npm/, "npm in front would swallow the signal");
  assert.match(df, /USER pwuser/, "not root");
  assert.match(df, /HEALTHCHECK/);

  // The data directory must not be baked into the image's own filesystem by accident.
  const ignore = readFileSync(join(root, ".dockerignore"), "utf8");
  assert.match(ignore, /^data$/m);
  assert.match(ignore, /^\.env$/m);
});

test("serve handles SIGTERM, which is what a host sends", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../src/serve.js"), "utf8");
  assert.match(src, /process\.on\("SIGTERM"/);
  assert.match(src, /process\.on\("SIGINT"/);
  assert.match(src, /runtime\.shutdown\(\)/);
});
