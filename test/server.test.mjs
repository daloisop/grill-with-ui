// Spike tests for server.mjs: session creation, serve (page/state/send), wait, url.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..", "server.mjs");
const home = mkdtempSync(join(tmpdir(), "grill-home-"));
const env = { ...process.env, GRILL_HOME: home };
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const run = (args, opts = {}) => execFileSync(process.execPath, [SERVER, ...args], { encoding: "utf8", env, ...opts }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) => fetch(url + "send", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function lineReader(stream) {
  const lines = []; const waiters = []; let buf = "";
  stream.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.splice(0).forEach((w) => w()); } });
  const nth = (n) => new Promise((res) => { const check = () => (lines.length >= n ? res(lines[n - 1]) : waiters.push(check)); check(); });
  return { lines, nth };
}
async function startServe(session, extra = []) {
  const child = spawn(process.execPath, [SERVER, "serve", "--session", session, ...extra], { env, stdio: ["ignore", "pipe", "inherit"] });
  const out = lineReader(child.stdout);
  const ready = JSON.parse(await out.nth(1));
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.on("exit", res); child.kill(); });
  return { child, ready, out, stop };
}
const newSession = (cwd, topic = "Fonts") => JSON.parse(run(["new", "--topic", topic], { cwd }));

test("new: outside git the key comes from the cwd; state.json skeleton is written", () => {
  const cwd = tmp("grill-nogit-");
  const out = newSession(cwd);
  const real = realpathSync(cwd);
  assert.equal(out.project, real);
  assert.equal(out.key, real.replace(/^\//, "").replace(/\//g, "-"));
  assert.ok(out.session.startsWith(join(home, "sessions", out.key) + "/"), out.session);
  const state = JSON.parse(readFileSync(join(out.session, "state.json"), "utf8"));
  assert.equal(state.topic, "Fonts");
  assert.deepEqual(state.questions, []);
  assert.equal(state.agent.status, "working");
  assert.match(state.created, /^\d{4}-\d{2}-\d{2}T/);
});

test("new: a git repo and one of its worktrees share one key; two sessions never collide", () => {
  const repo = tmp("grill-repo-");
  const git = (args, cwd) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
  git(["init", "-q", "-b", "main"], repo);
  git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
  const wt = join(tmp("grill-wt-"), "wt");
  git(["worktree", "add", "-q", wt, "-b", "side"], repo);
  const a = newSession(repo), b = newSession(wt), c = newSession(repo);
  assert.equal(a.key, b.key);
  assert.equal(a.project, realpathSync(repo));
  assert.equal(b.project, realpathSync(repo));
  assert.notEqual(a.session, c.session);
});

test("serve: ready line + server.json, page, state, send appends the same line it prints, bad bodies are 400, seq survives restart", async (t) => {
  const { session } = newSession(tmp("grill-s-"));
  const s = await startServe(session); t.after(s.stop);
  assert.equal(s.ready.type, "ready");
  assert.match(s.ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(s.ready.session, session);
  assert.equal(JSON.parse(readFileSync(join(session, "server.json"), "utf8")).url, s.ready.url);

  const html = await (await fetch(s.ready.url)).text();
  assert.match(html, /<textarea/);
  const state = await (await fetch(s.ready.url + "state")).json();
  assert.equal(state.topic, "Fonts");

  const actions = [{ q: "q1", type: "answer", kind: "text", text: "B, bundle them" }];
  const r1 = await post(s.ready.url, { actions });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, seq: 1 });
  const ev = JSON.parse(await s.out.nth(2));
  assert.equal(ev.type, "send"); assert.equal(ev.seq, 1); assert.equal(ev.session, session);
  assert.deepEqual(ev.actions, actions);
  assert.match(ev.at, /^\d{4}-\d{2}-\d{2}T/);
  const fileLines = readFileSync(join(session, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(fileLines.length, 1);
  assert.equal(fileLines[0], s.out.lines[1]);

  assert.equal((await post(s.ready.url, "nope")).status, 400);
  assert.equal((await post(s.ready.url, { actions: [] })).status, 400);
  assert.equal((await post(s.ready.url, { actions: "x" })).status, 400);
  await sleep(100);
  assert.equal(s.out.lines.length, 2, "bad bodies print nothing");
  assert.equal(readFileSync(join(session, "events.jsonl"), "utf8").trim().split("\n").length, 1);

  await s.stop();
  const s2 = await startServe(session); t.after(s2.stop);
  const r2 = await post(s2.ready.url, { actions: [{ q: "q1", type: "thread", text: "why not C?" }] });
  assert.deepEqual(await r2.json(), { ok: true, seq: 2 });
  assert.equal(JSON.parse(await s2.out.nth(2)).seq, 2);
});

test("serve: /send rejects a mismatched Origin, allows same-origin and no-Origin requests", async (t) => {
  const { session } = newSession(tmp("grill-o-"));
  const s = await startServe(session); t.after(s.stop);
  const actions = [{ q: "q1", type: "defer" }];
  const withOrigin = (origin, contentType = "application/json") =>
    fetch(s.ready.url + "send", { method: "POST", headers: { "content-type": contentType, origin }, body: JSON.stringify({ actions }) });

  assert.equal((await post(s.ready.url, { actions })).status, 200, "no Origin header (curl, wait mode, tests) is allowed");
  assert.equal((await withOrigin(s.ready.url.slice(0, -1))).status, 200, "the page's own origin is allowed");
  assert.equal((await withOrigin("https://evil.example", "text/plain")).status, 403, "a foreign origin is rejected even as a no-preflight content-type");
  assert.equal((await withOrigin("null")).status, 403, "the sandboxed visual iframe's opaque origin is rejected too");

  assert.equal(readFileSync(join(session, "events.jsonl"), "utf8").trim().split("\n").length, 2, "only the two accepted sends landed");
});

test("wait: blocks for a seq newer than --after (default: current last), prints it, exits 0; exit 3 on timeout", async (t) => {
  const { session } = newSession(tmp("grill-w-"));
  const s = await startServe(session); t.after(s.stop);
  await post(s.ready.url, { actions: [{ q: "q1", type: "defer" }] });
  await s.out.nth(2);

  const w = spawn(process.execPath, [SERVER, "wait", "--session", session, "--after", "1", "--timeout", "5"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const wo = lineReader(w.stdout);
  await sleep(400);
  assert.equal(wo.lines.length, 0, "nothing printed before a new send");
  await post(s.ready.url, { actions: [{ q: "q1", type: "answer", kind: "option", option: "A" }] });
  const code = await new Promise((res) => w.on("exit", res));
  assert.equal(code, 0);
  assert.equal(wo.lines.length, 1);
  assert.equal(JSON.parse(wo.lines[0]).seq, 2);

  const w2 = spawn(process.execPath, [SERVER, "wait", "--session", session, "--timeout", "5"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const wo2 = lineReader(w2.stdout);
  await sleep(300);
  await post(s.ready.url, { actions: [{ q: "q1", type: "reopen" }] });
  assert.equal(await new Promise((res) => w2.on("exit", res)), 0);
  assert.equal(JSON.parse(wo2.lines[0]).seq, 3, "default --after skips everything already on disk");

  const w3 = spawn(process.execPath, [SERVER, "wait", "--session", session, "--timeout", "0.5"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const wo3 = lineReader(w3.stdout);
  assert.equal(await new Promise((res) => w3.on("exit", res)), 3);
  assert.equal(wo3.lines.length, 0);
});

test("serve: /visual serves the session's visual.html (no-store), 404 JSON when absent", async (t) => {
  const { session } = newSession(tmp("grill-v-"));
  const s = await startServe(session); t.after(s.stop);
  const miss = await fetch(s.ready.url + "visual");
  assert.equal(miss.status, 404);
  assert.deepEqual(await miss.json(), { error: "no visual" });
  const html = "<!doctype html><title>v</title><h1>Prototype</h1>";
  writeFileSync(join(session, "visual.html"), html);
  const hit = await fetch(s.ready.url + "visual?v=1");
  assert.equal(hit.status, 200);
  assert.match(hit.headers.get("content-type"), /^text\/html/);
  assert.equal(hit.headers.get("cache-control"), "no-store");
  assert.equal(await hit.text(), html);
});

test("url: prints the running server's url; fails fast when there is none", async (t) => {
  const { session } = newSession(tmp("grill-u-"));
  assert.throws(() => run(["url", "--session", session, "--timeout", "0.3"]));
  const s = await startServe(session); t.after(s.stop);
  assert.equal(run(["url", "--session", session]), s.ready.url);
});

test("serve: reuses the last port from server.json, falls back to ephemeral when it is taken; --port wins", async (t) => {
  const { session } = newSession(tmp("grill-p-"));
  const s1 = await startServe(session); t.after(s1.stop);
  const port = Number(new URL(s1.ready.url).port);
  assert.equal(JSON.parse(readFileSync(join(session, "server.json"), "utf8")).port, port);
  await s1.stop();
  const s2 = await startServe(session); t.after(s2.stop);
  assert.equal(s2.ready.url, s1.ready.url, "same port after restart");
  await s2.stop();
  const blocker = createServer(); await new Promise((r) => blocker.listen(port, "127.0.0.1", r)); t.after(() => blocker.close());
  const s3 = await startServe(session); t.after(s3.stop);
  assert.notEqual(new URL(s3.ready.url).port, String(port), "falls back when the port is taken");
  assert.equal((await fetch(s3.ready.url + "state")).status, 200);
  await s3.stop(); await new Promise((r) => blocker.close(r));
  const s4 = await startServe(session, ["--port", "0"]); t.after(s4.stop);
  assert.notEqual(new URL(s4.ready.url).port, String(port), "explicit --port 0 skips reuse");
});

test("sessions: lists this project's sessions newest first, unfinished by default, --all includes finished", async () => {
  const cwd = tmp("grill-ls-");
  const a = newSession(cwd, "First topic");
  await sleep(20);
  const b = newSession(cwd, "Second topic");
  await sleep(20);
  const c = newSession(cwd, "Finished topic");
  const stateOf = (dir) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const write = (dir, st) => writeFileSync(join(dir, "state.json"), JSON.stringify(st));
  const sb = stateOf(b.session);
  sb.agent = { status: "waiting", since: "x", handled: 2 };
  sb.questions = [
    { id: "q1", round: 1, status: "answered" }, { id: "q2", round: 1, status: "open" },
    { id: "q3", round: 2, status: "deferred" }, { id: "q4", round: 2, status: "reopened" },
  ];
  write(b.session, sb);
  writeFileSync(join(b.session, "events.jsonl"), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
  const sc = stateOf(c.session); sc.finished = { doc: "docs/x.md", at: "y" }; write(c.session, sc);

  const lines = run(["sessions"], { cwd }).split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.session), [b.session, a.session]);
  assert.deepEqual(lines[0], { session: b.session, id: b.id, topic: "Second topic", created: sb.created, finished: null, open: 2, answered: 1, handled: 2, lastSeq: 3 });
  assert.deepEqual(lines[1], { session: a.session, id: a.id, topic: "First topic", created: stateOf(a.session).created, finished: null, open: 0, answered: 0, handled: 0, lastSeq: 0 });
  const all = run(["sessions", "--all"], { cwd }).split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(all.map((l) => l.session), [c.session, b.session, a.session]);
  assert.deepEqual(all[0].finished, { doc: "docs/x.md", at: "y" });
  assert.equal(run(["sessions"], { cwd: tmp("grill-empty-") }), "");
});

test("pending: prints the events past agent.handled, nothing when caught up", async (t) => {
  const { session } = newSession(tmp("grill-pd-"));
  const s = await startServe(session); t.after(s.stop);
  for (const k of ["A", "B", "C"]) await post(s.ready.url, { actions: [{ q: "q1", type: "answer", kind: "option", option: k }] });
  await s.out.nth(4);
  const st = JSON.parse(readFileSync(join(session, "state.json"), "utf8"));
  st.agent.handled = 1; writeFileSync(join(session, "state.json"), JSON.stringify(st));
  const out = run(["pending", "--session", session]).split("\n");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((l) => JSON.parse(l).seq), [2, 3]);
  assert.equal(out[0], s.out.lines[2], "prints the exact stored lines");
  st.agent.handled = 3; writeFileSync(join(session, "state.json"), JSON.stringify(st));
  assert.equal(run(["pending", "--session", session]), "");
  delete st.agent.handled; writeFileSync(join(session, "state.json"), JSON.stringify(st));
  assert.equal(run(["pending", "--session", session]).split("\n").length, 3, "no handled means everything is pending");
});
