// A request whose URL will not parse (a scanner's `//%2e%2e%2f%2eenv`, or a Host header like
// `[bad`) gets a 400, and the server keeps answering. Before, handleRequest built `new URL(...)`
// outside its try, the async handler rejected, and with no unhandledRejection handler Node took
// the whole process down with every reply in flight.
//
// The server runs in a child process so a crash is seen as the child dying, not as this test
// runner dying. Requests go out over a raw socket because fetch would clean the URL first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "reason-bad-url-"));
const httpJs = fileURLToPath(new URL("../src/http.js", import.meta.url));

const CHILD = `
const { createServer, logUnhandledRejections } = await import(${JSON.stringify(httpJs)});
logUnhandledRejections?.((o) => process.stderr.write(JSON.stringify(o) + "\\n"));
const server = createServer({ router: { channels: [], list: () => [] }, runtime: { say() {}, interval: {}, on() {} } });
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + server.address().port + "\\n"));
`;

let child, port, exited = null, stderr = "";

before(async () => {
  child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    env: { ...process.env, REASON_DB_PATH: join(dir, "reason.db"), REASON_DATA_DIR: dir, REASON_TZ: "America/New_York", REASON_CALL_VOICE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  child.stderr.on("data", (d) => { stderr += d; });
  port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (d) => { out += d; const m = /PORT (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    child.on("exit", () => reject(new Error(`server exited before listening: ${stderr}`)));
  });
});
after(() => { child?.kill(); rmSync(dir, { recursive: true, force: true }); });

// One raw HTTP/1.1 request; resolves with the status code, or null if the socket closed without one.
function raw(path, host) {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    const done = () => { const m = /^HTTP\/1\.1 (\d{3})/.exec(got); resolve(m ? Number(m[1]) : null); };
    s.setTimeout(3000, () => { s.destroy(); done(); });
    s.on("data", (d) => { got += d; if (/\r\n\r\n/.test(got)) { s.destroy(); done(); } });
    s.on("error", done);
    s.on("close", done);
    s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 300));

test("the scanner probe //%2e%2e%2f%2eenv gets a 400 and /health still answers after", async () => {
  assert.equal(await raw("//%2e%2e%2f%2eenv", "localhost"), 400);
  await settle();
  assert.equal(exited, null, `server died: ${stderr}`);
  assert.equal(await raw("/health", "localhost"), 200);
});

test("a Host header that will not parse gets a 400 and /health still answers after", async () => {
  assert.equal(await raw("/health", "[bad"), 400);
  await settle();
  assert.equal(exited, null, `server died: ${stderr}`);
  assert.equal(await raw("/health", "localhost"), 200);
});

test("a stray rejected promise is logged and the process keeps running", async () => {
  // Its own process, so the rejection cannot touch this test runner.
  const script = `
    const { logUnhandledRejections } = await import(${JSON.stringify(httpJs)});
    logUnhandledRejections((o) => process.stdout.write("LOG " + JSON.stringify(o) + "\\n"));
    Promise.reject(new Error("nobody caught this"));
    setTimeout(() => process.stdout.write("ALIVE\\n"), 200);
  `;
  const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, REASON_DB_PATH: join(dir, "r2.db"), REASON_DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => p.on("exit", r));
  assert.equal(code, 0, err);
  assert.match(out, /LOG .*unhandled_rejection.*nobody caught this/);
  assert.match(out, /ALIVE/);
});
