#!/usr/bin/env node
// grill-with-ui server. Plain Node, no dependencies, no build step.
//
//   new      --topic T [--doc P]                    create a session folder under GRILL_HOME, print {session,key,project,id,doc}
//   serve    --session DIR [--port N]               serve the page; append each Send to events.jsonl AND print the same
//                                                   line to stdout (this process is the agent's Monitor command).
//                                                   Without --port it retries the port it used last time, then falls
//                                                   back to an ephemeral one, so an open tab survives a restart.
//   sessions [--all]                                list this project's sessions (newest first; --all adds finished ones)
//   pending  --session DIR                          print every Send past agent.handled (replay on resume)
//   wait     --session DIR [--after N] [--timeout S] block until a Send newer than seq N lands, print it, exit 0
//                                                   (exit 3 on timeout) — for agents without a Monitor tool
//   url      --session DIR [--timeout S]            print the running server's url (from server.json)
//
// Files (per session folder): state.json  — written only by the agent
//                             events.jsonl — appended only by this server, one line per Send
//                             server.json  — url, port, pid of the running server
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.GRILL_HOME || path.join(os.homedir(), ".grill-with-ui");

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
  }
  return o;
}
const print = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const die = (msg, code = 2) => { process.stderr.write(`grill: ${msg}\n`); process.exit(code); };
function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
function mustSession(o) {
  if (!o.session || o.session === true) die("--session <dir> is required");
  const dir = path.resolve(o.session);
  if (!fs.existsSync(dir)) die(`no such session folder: ${dir}`);
  return dir;
}

// ---- session key: git common root (all worktrees share it), cwd outside git ----
function projectRoot(cwd) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return fs.realpathSync(path.dirname(common));
  } catch { return fs.realpathSync(cwd); }
}
const keyOf = (root) => root.replace(/^[\\/]+/, "").replace(/[\\/:]+/g, "-");
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cmdNew(o) {
  const project = projectRoot(process.cwd());
  const key = keyOf(project);
  const dir = path.join(HOME, "sessions", key);
  fs.mkdirSync(dir, { recursive: true });
  const id = stamp();
  let session = path.join(dir, id);
  for (let n = 2; fs.existsSync(session); n++) session = path.join(dir, `${id}-${n}`);
  fs.mkdirSync(session);
  const now = new Date().toISOString();
  writeJson(path.join(session, "state.json"), {
    topic: typeof o.topic === "string" ? o.topic : "", doc: typeof o.doc === "string" ? o.doc : "",
    project, created: now, agent: { status: "working", since: now }, terms: [], questions: [],
  });
  fs.writeFileSync(path.join(session, "events.jsonl"), "");
  print({ session, key, project, id: path.basename(session), doc: typeof o.doc === "string" ? o.doc : "" });
}

// ---- events.jsonl helpers ----
function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push({ line, ev: JSON.parse(line) }); } catch { /* partial or corrupt line: skip */ }
  }
  return out;
}
const lastSeq = (file) => readEvents(file).reduce((m, { ev }) => Math.max(m, Number(ev.seq) || 0), 0);
function readState(session) {
  try { return JSON.parse(fs.readFileSync(path.join(session, "state.json"), "utf8")); } catch { return null; }
}
const isOpen = (q) => q.status === "open" || q.status === "reopened";

// ---- sessions (for resume) ----
function cmdSessions(o) {
  const dir = path.join(HOME, "sessions", keyOf(projectRoot(process.cwd())));
  if (!fs.existsSync(dir)) return;
  const rows = [];
  for (const id of fs.readdirSync(dir)) {
    const session = path.join(dir, id);
    const st = readState(session);
    if (!st) continue;
    const qs = Array.isArray(st.questions) ? st.questions : [];
    rows.push({
      session, id, topic: st.topic || "", created: st.created || "", finished: st.finished || null,
      open: qs.filter(isOpen).length, answered: qs.filter((q) => q.status === "answered").length,
      handled: Number(st.agent && st.agent.handled) || 0, lastSeq: lastSeq(path.join(session, "events.jsonl")),
    });
  }
  rows.sort((a, b) => (b.created < a.created ? -1 : b.created > a.created ? 1 : b.id.localeCompare(a.id)));
  for (const r of rows) if (o.all || !r.finished) print(r);
}

// ---- pending (replay on resume) ----
function cmdPending(o) {
  const session = mustSession(o);
  const st = readState(session);
  const handled = Number(st && st.agent && st.agent.handled) || 0;
  for (const { line, ev } of readEvents(path.join(session, "events.jsonl"))) {
    if ((Number(ev.seq) || 0) > handled) process.stdout.write(line + "\n");
  }
}

// ---- serve ----
function cmdServe(o) {
  const session = mustSession(o);
  const events = path.join(session, "events.jsonl");
  const stateFile = path.join(session, "state.json");
  const serverFile = path.join(session, "server.json");
  const page = path.join(HERE, "page.html");
  let seq = lastSeq(events);
  let lastGoodState = null;
  let selfOrigin = "";

  const send = (res, code, body, type) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
  const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");
  const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });

  const srv = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://x");
    if (req.method === "GET" && pathname === "/") return send(res, 200, fs.readFileSync(page), "text/html; charset=utf-8");
    if (req.method === "GET" && pathname === "/state") {
      // The agent rewrites state.json whole; if we catch it mid-write, serve the last parse that worked.
      try { const raw = fs.readFileSync(stateFile, "utf8"); JSON.parse(raw); lastGoodState = raw; } catch { /* keep lastGoodState */ }
      if (lastGoodState === null) return json(res, 404, { error: "no state" });
      return send(res, 200, lastGoodState, "application/json");
    }
    if (req.method === "GET" && pathname === "/events") return send(res, 200, fs.existsSync(events) ? fs.readFileSync(events) : "", "application/x-ndjson");
    if (req.method === "GET" && pathname === "/visual") {
      const visual = path.join(session, "visual.html"); // written only by the agent; shown by the page in a sandboxed iframe
      if (!fs.existsSync(visual)) return json(res, 404, { error: "no visual" });
      return send(res, 200, fs.readFileSync(visual), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && pathname === "/send") {
      // Browsers set Origin on every POST, same-origin or not; reject a mismatch so another
      // tab (or the sandboxed visual iframe, whose Origin is "null") can't forge a send. No
      // Origin at all — curl, wait mode, this project's own tests — is still allowed.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== selfOrigin) return json(res, 403, { error: "cross-origin request rejected" });
      let parsed;
      try { parsed = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "body must be JSON" }); }
      if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) return json(res, 400, { error: "actions must be a non-empty array" });
      const line = JSON.stringify({ type: "send", seq: ++seq, at: new Date().toISOString(), session, actions: parsed.actions });
      fs.appendFileSync(events, line + "\n");
      process.stdout.write(line + "\n"); // this is what wakes the agent
      return json(res, 200, { ok: true, seq });
    }
    json(res, 404, { error: "not found" });
  });
  // Port choice: an explicit --port wins; otherwise retry last time's port (so an open tab
  // just resumes polling after a restart) and fall back to ephemeral if it is taken.
  const explicit = o.port !== undefined && o.port !== true;
  let attempt = explicit ? Number(o.port) : rememberedPort(serverFile);
  srv.on("error", (e) => {
    if (!srv.listening && !explicit && attempt !== 0 && e.code === "EADDRINUSE") { attempt = 0; srv.listen(0, "127.0.0.1"); return; }
    die(`server error: ${e.message}`, 1);
  });
  srv.on("listening", () => {
    const { port } = srv.address();
    const url = `http://127.0.0.1:${port}/`;
    selfOrigin = `http://127.0.0.1:${port}`;
    writeJson(serverFile, { url, port, pid: process.pid, started: new Date().toISOString() });
    print({ type: "ready", url, session });
  });
  srv.listen(attempt, "127.0.0.1");
  // server.json stays on exit on purpose: it remembers the port for the next serve, and
  // `url` checks the pid before trusting it.
  const bye = () => process.exit(0);
  process.on("SIGINT", bye); process.on("SIGTERM", bye); process.on("SIGHUP", bye);
}

// ---- wait (blocking, for agents without a Monitor tool) ----
function cmdWait(o) {
  const session = mustSession(o);
  const events = path.join(session, "events.jsonl");
  const after = o.after !== undefined && o.after !== true ? Number(o.after) : lastSeq(events);
  const deadline = Date.now() + Number(o.timeout !== undefined && o.timeout !== true ? o.timeout : 480) * 1000;
  const tick = () => {
    for (const { line, ev } of readEvents(events)) {
      if ((Number(ev.seq) || 0) > after) { process.stdout.write(line + "\n"); process.exit(0); }
    }
    if (Date.now() >= deadline) process.exit(3);
    setTimeout(tick, 250);
  };
  tick();
}

function rememberedPort(serverFile) {
  try { const p = Number(JSON.parse(fs.readFileSync(serverFile, "utf8")).port); return Number.isInteger(p) && p > 0 ? p : 0; } catch { return 0; }
}

// ---- url ----
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function cmdUrl(o) {
  const session = mustSession(o);
  const serverFile = path.join(session, "server.json");
  const deadline = Date.now() + Number(o.timeout !== undefined && o.timeout !== true ? o.timeout : 5) * 1000;
  const tick = () => {
    try {
      const { url, pid } = JSON.parse(fs.readFileSync(serverFile, "utf8"));
      if (url && (!pid || alive(pid))) { process.stdout.write(url + "\n"); process.exit(0); }
    } catch { /* not there yet */ }
    if (Date.now() >= deadline) die(`no running server for ${session}`, 1);
    setTimeout(tick, 100);
  };
  tick();
}

const o = parseArgs(process.argv.slice(2));
({ new: cmdNew, serve: cmdServe, sessions: cmdSessions, pending: cmdPending, wait: cmdWait, url: cmdUrl }[o._[0]]
  || (() => die("usage: server.mjs new|serve|sessions|pending|wait|url [--session DIR] ...")))(o);
