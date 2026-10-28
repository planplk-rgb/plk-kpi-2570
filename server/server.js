#!/usr/bin/env node
/* PLK KPI — self-hosted server.
   Zero npm dependencies: Node.js 22+ (built-in node:sqlite, node:http, node:crypto).
   Environment:
     PORT=8080                 port to listen on
     DATA_DIR=./data           where plk-kpi.db is kept (back this folder up)
     ADMIN_USERNAME=admin      first administrator, created on first start only
     ADMIN_PASSWORD=...        if unset on first start, a random password is printed to the log
     PUBLIC_READ=1             1 = anyone on the network can view the dashboard without logging in
     ALLOW_REGISTER=1          1 = staff can create their own account (an admin still grants permissions)
     COOKIE_SECURE=0           set 1 when the site is served over HTTPS
     TRUST_PROXY=0             set 1 behind nginx/Apache so the client IP comes from X-Forwarded-For
*/
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const Rules = require("../public/rules.js");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const PORT = +(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const PUBLIC_READ = (process.env.PUBLIC_READ ?? "1") === "1";
const ALLOW_REGISTER = (process.env.ALLOW_REGISTER ?? "1") === "1";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESSION_DAYS = 14;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "plk-kpi.db"));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, coll TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT, updated_by TEXT);
  CREATE INDEX IF NOT EXISTS docs_coll ON docs(coll);
  CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT, email TEXT, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', salt TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, by TEXT, op TEXT, path TEXT, data TEXT);
`);

/* ---------------- helpers ---------------- */
const now = () => new Date().toISOString();
const newId = () => "u_" + crypto.randomBytes(12).toString("base64url");
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
function makeAccount({ username, password, name, email, role }) {
  const salt = crypto.randomBytes(16).toString("hex");
  const id = newId();
  db.prepare("INSERT INTO accounts(id,username,name,email,role,status,salt,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, String(username).toLowerCase(), name || username, email || "", role || "user", "active", salt, hashPw(password, salt), now());
  return id;
}
const getDocRow = (p) => db.prepare("SELECT data, version FROM docs WHERE path=?").get(p);
const store = { get: (p) => { const r = getDocRow(p); return r ? JSON.parse(r.data) : null; } };
function audit(by, op, p, data) { db.prepare("INSERT INTO audit(at,by,op,path,data) VALUES(?,?,?,?,?)").run(now(), by || null, op, p, data == null ? null : JSON.stringify(data).slice(0, 4000)); }

/* ---------------- first start ---------------- */
if (!db.prepare("SELECT COUNT(*) n FROM docs").get().n) {
  const seedFile = path.join(PUBLIC, "seed.json");
  if (fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    const ins = db.prepare("INSERT INTO docs(path,coll,data,version,updated_at) VALUES(?,?,?,1,?)");
    for (const [p, d] of Object.entries(seed.docs || {})) ins.run(p, p.split("/")[0], JSON.stringify(d), now());
    console.log(`[plk-kpi] loaded ${Object.keys(seed.docs || {}).length} documents from seed.json`);
  }
}
if (!db.prepare("SELECT COUNT(*) n FROM accounts WHERE role='admin'").get().n) {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString("base64url");
  makeAccount({ username, password, name: "ผู้ดูแลระบบ", role: "admin" });
  console.log(`[plk-kpi] created administrator "${username}"${process.env.ADMIN_PASSWORD ? "" : ` with password: ${password}  (change it after logging in)`}`);
}

/* ---------------- sessions ---------------- */
function parseCookies(req) { const o = {}; for (const c of (req.headers.cookie || "").split(";")) { const i = c.indexOf("="); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); } return o; }
function currentUser(req) {
  const t = parseCookies(req).plk_sid; if (!t) return null;
  const s = db.prepare("SELECT account_id, expires_at FROM sessions WHERE token=?").get(t);
  if (!s || s.expires_at < Date.now()) return null;
  const a = db.prepare("SELECT id, username, name, email, role, status FROM accounts WHERE id=?").get(s.account_id);
  return a && a.status === "active" ? a : null;
}
function setSession(res, accountId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token,account_id,expires_at) VALUES(?,?,?)").run(token, accountId, Date.now() + SESSION_DAYS * 864e5);
  res.setHeader("Set-Cookie", `plk_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? "; Secure" : ""}`);
}
setInterval(() => db.prepare("DELETE FROM sessions WHERE expires_at<?").run(Date.now()), 3600e3).unref();

const fails = new Map(); // ip -> [timestamps]
function ipOf(req) { return (TRUST_PROXY && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?"; }
function tooMany(ip) { const t = (fails.get(ip) || []).filter((x) => x > Date.now() - 10 * 60e3); fails.set(ip, t); return t.length >= 8; }

/* ---------------- realtime (Server-Sent Events) ---------------- */
const clients = new Set();
function broadcast(p) { const msg = `data: ${JSON.stringify({ path: p })}\n\n`; for (const r of clients) r.write(msg); }
setInterval(() => { for (const r of clients) r.write(": ping\n\n"); }, 25e3).unref();

/* ---------------- http ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };
function send(res, code, body, type) {
  res.writeHead(code, { "content-type": type || "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(Object.assign(new Error("bad json"), { status: 400 })); } });
    req.on("error", reject);
  });
}
const pub = (a) => a && { id: a.id, username: a.username, name: a.name, email: a.email, role: a.role, status: a.status };
const deny = (res, msg, code) => send(res, code || 403, { error: msg || "not allowed" });
function mergeDeep(a, b) { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? mergeDeep(o[k], v) : v; return o; }
function matchWhere(d, filters) {
  return filters.every(([f, op, v]) => { const x = d ? d[f] : undefined;
    switch (op) { case "==": return x === v; case "!=": return x !== v; case "in": return Array.isArray(v) && v.includes(x); case "not-in": return Array.isArray(v) && !v.includes(x);
      case "array-contains": return Array.isArray(x) && x.includes(v); case "<": return x < v; case "<=": return x <= v; case ">": return x > v; case ">=": return x >= v; default: return false; } });
}

async function api(req, res, url, user) {
  const p = url.pathname.replace(/^\/api\//, "");
  const isAdmin = !!user && user.role === "admin";

  if (p === "session") return send(res, 200, { user: pub(user), publicRead: PUBLIC_READ, allowRegister: ALLOW_REGISTER });

  if (p === "login" && req.method === "POST") {
    const ip = ipOf(req); if (tooMany(ip)) return deny(res, "ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 10 นาที", 429);
    const b = await readBody(req, 10e3);
    const a = db.prepare("SELECT * FROM accounts WHERE username=?").get(String(b.username || "").trim().toLowerCase());
    const ok = a && a.status === "active" && crypto.timingSafeEqual(Buffer.from(hashPw(b.password || "", a.salt), "hex"), Buffer.from(a.hash, "hex"));
    if (!ok) { fails.get(ip).push(Date.now()); return deny(res, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง", 401); }
    setSession(res, a.id); audit(a.id, "login", "accounts/" + a.id); return send(res, 200, { ok: true });
  }
  if (p === "register" && req.method === "POST") {
    if (!ALLOW_REGISTER) return deny(res, "ปิดการสมัครใช้งาน ติดต่อผู้ดูแลระบบ");
    const b = await readBody(req, 10e3);
    const username = String(b.username || "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return deny(res, "ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3–40 ตัว", 400);
    if (String(b.password || "").length < 8) return deny(res, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร", 400);
    if (!String(b.name || "").trim()) return deny(res, "กรอกชื่อ-สกุล", 400);
    if (db.prepare("SELECT 1 FROM accounts WHERE username=?").get(username)) return deny(res, "ชื่อผู้ใช้นี้มีผู้ใช้แล้ว", 409);
    const id = makeAccount({ username, password: b.password, name: String(b.name).trim().slice(0, 120), email: String(b.email || "").trim().slice(0, 200) });
    setSession(res, id); audit(id, "register", "accounts/" + id); return send(res, 200, { ok: true });
  }
  if (p === "logout" && req.method === "POST") {
    const t = parseCookies(req).plk_sid; if (t) db.prepare("DELETE FROM sessions WHERE token=?").run(t);
    res.setHeader("Set-Cookie", "plk_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"); return send(res, 200, { ok: true });
  }
  if (p === "me/password" && req.method === "POST") {
    if (!user) return deny(res, "login required", 401);
    const b = await readBody(req, 10e3); const a = db.prepare("SELECT * FROM accounts WHERE id=?").get(user.id);
    if (hashPw(b.oldPassword || "", a.salt) !== a.hash) return deny(res, "รหัสผ่านเดิมไม่ถูกต้อง", 400);
    if (String(b.newPassword || "").length < 8) return deny(res, "รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร", 400);
    const salt = crypto.randomBytes(16).toString("hex");
    db.prepare("UPDATE accounts SET salt=?, hash=? WHERE id=?").run(salt, hashPw(b.newPassword, salt), user.id);
    db.prepare("DELETE FROM sessions WHERE account_id=? AND token<>?").run(user.id, parseCookies(req).plk_sid || "");
    audit(user.id, "password", "accounts/" + user.id); return send(res, 200, { ok: true });
  }

  if (p === "events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": hello\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (p === "doc") {
    const dp = url.searchParams.get("path") || "";
    try { if (!Rules.canRead(user, dp, PUBLIC_READ)) return send(res, 200, { exists: false }); } catch (e) { return deny(res, "bad path", 400); }
    const r = getDocRow(dp); return send(res, 200, r ? { exists: true, data: JSON.parse(r.data), version: r.version } : { exists: false });
  }
  if (p === "query") {
    const coll = url.searchParams.get("coll") || ""; let where = [];
    try { where = JSON.parse(url.searchParams.get("where") || "[]"); Rules.split(coll); } catch (e) { return deny(res, "bad query", 400); }
    const rows = db.prepare("SELECT path, data FROM docs WHERE coll=?").all(coll.split("/")[0]);
    const out = [];
    for (const r of rows) { if (r.path.split("/").length !== coll.split("/").length + 1 || !r.path.startsWith(coll + "/")) continue;
      if (!Rules.canRead(user, r.path, PUBLIC_READ)) continue; const d = JSON.parse(r.data); if (matchWhere(d, where)) out.push({ id: r.path.split("/").pop(), data: d }); }
    return send(res, 200, out);
  }
  if (p === "write" && req.method === "POST") {
    const b = await readBody(req, 2e6); const { op, path: dp } = b;
    if (!["set", "update", "delete"].includes(op)) return deny(res, "bad op", 400);
    try { Rules.split(dp); } catch (e) { return deny(res, "bad path", 400); }
    const prev = store.get(dp);
    if (op === "update" && !prev) return deny(res, "document does not exist", 400);
    const body = op === "update" ? mergeDeep(prev, b.data) : b.data;
    if (op !== "delete" && (!body || typeof body !== "object" || Array.isArray(body))) return deny(res, "bad data", 400);
    const chk = Rules.checkWrite(user, dp, body, op, store);
    if (!chk.ok) return deny(res, chk.reason, user ? 403 : 401);
    if (op === "delete") db.prepare("DELETE FROM docs WHERE path=?").run(dp);
    else db.prepare(`INSERT INTO docs(path,coll,data,version,updated_at,updated_by) VALUES(?,?,?,1,?,?)
      ON CONFLICT(path) DO UPDATE SET data=excluded.data, version=docs.version+1, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(dp, dp.split("/")[0], JSON.stringify(chk.data), now(), user.id);
    audit(user.id, op, dp, op === "delete" ? prev : chk.data); broadcast(dp); return send(res, 200, { ok: true });
  }
  if (p === "profiles") {
    const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200); const out = {};
    for (const id of ids) { const a = user || PUBLIC_READ ? db.prepare("SELECT name FROM accounts WHERE id=?").get(id) : null; out[id] = { name: a ? a.name : "" }; }
    return send(res, 200, out);
  }
  if (p === "search") {
    if (!user) return send(res, 200, []);
    const q = "%" + String(url.searchParams.get("q") || "").toLowerCase() + "%";
    return send(res, 200, db.prepare("SELECT id, name, email FROM accounts WHERE status='active' AND (lower(name) LIKE ? OR username LIKE ? OR lower(email) LIKE ?) ORDER BY name LIMIT 8").all(q, q, q));
  }

  /* ---- admin only ---- */
  if (!isAdmin) return deny(res, "admin only", user ? 403 : 401);
  if (p === "accounts" && req.method === "GET") return send(res, 200, db.prepare("SELECT id, username, name, email, role, status, created_at FROM accounts ORDER BY created_at").all());
  if (p.startsWith("accounts/") && req.method === "POST") {
    const id = decodeURIComponent(p.slice(9)); const b = await readBody(req, 10e3);
    const a = db.prepare("SELECT * FROM accounts WHERE id=?").get(id); if (!a) return deny(res, "no account", 404);
    const admins = db.prepare("SELECT COUNT(*) n FROM accounts WHERE role='admin' AND status='active'").get().n;
    const losingAdmin = a.role === "admin" && a.status === "active" && ((b.role && b.role !== "admin") || b.status === "disabled");
    if (losingAdmin && admins <= 1) return deny(res, "ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน", 400);
    if (b.role && ["admin", "user"].includes(b.role)) db.prepare("UPDATE accounts SET role=? WHERE id=?").run(b.role, id);
    if (b.status && ["active", "disabled"].includes(b.status)) { db.prepare("UPDATE accounts SET status=? WHERE id=?").run(b.status, id); if (b.status === "disabled") db.prepare("DELETE FROM sessions WHERE account_id=?").run(id); }
    if (b.name) db.prepare("UPDATE accounts SET name=? WHERE id=?").run(String(b.name).slice(0, 120), id);
    if (b.password) { if (String(b.password).length < 8) return deny(res, "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร", 400); const salt = crypto.randomBytes(16).toString("hex"); db.prepare("UPDATE accounts SET salt=?, hash=? WHERE id=?").run(salt, hashPw(b.password, salt), id); db.prepare("DELETE FROM sessions WHERE account_id=?").run(id); }
    audit(user.id, "account", "accounts/" + id, { ...b, password: b.password ? "***" : undefined }); return send(res, 200, { ok: true });
  }
  if (p === "audit") { const n = Math.min(1000, +(url.searchParams.get("limit") || 200)); return send(res, 200, db.prepare("SELECT at, by, op, path FROM audit ORDER BY id DESC LIMIT ?").all(n)); }
  if (p === "backup") {
    const docs = {}; for (const r of db.prepare("SELECT path, data FROM docs").all()) docs[r.path] = JSON.parse(r.data);
    audit(user.id, "backup", "*"); return send(res, 200, { version: 1, exportedAt: now(), docs, accounts: db.prepare("SELECT * FROM accounts").all() });
  }
  if (p === "restore" && req.method === "POST") {
    const b = await readBody(req, 200e6); if (!b || typeof b.docs !== "object") return deny(res, "bad backup", 400);
    db.exec("BEGIN"); try {
      db.exec("DELETE FROM docs"); const ins = db.prepare("INSERT INTO docs(path,coll,data,version,updated_at,updated_by) VALUES(?,?,?,1,?,?)");
      for (const [dp, d] of Object.entries(b.docs)) { Rules.split(dp); ins.run(dp, dp.split("/")[0], JSON.stringify(d), now(), user.id); }
      if (Array.isArray(b.accounts) && b.accounts.length && b.accounts.some((a) => a.role === "admin")) {
        db.exec("DELETE FROM accounts"); const ia = db.prepare("INSERT INTO accounts(id,username,name,email,role,status,salt,hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
        for (const a of b.accounts) ia.run(a.id, a.username, a.name, a.email || "", a.role, a.status, a.salt, a.hash, a.created_at || now());
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); return deny(res, "restore failed: " + e.message, 400); }
    audit(user.id, "restore", "*"); broadcast("*"); return send(res, 200, { ok: true });
  }
  return deny(res, "not found", 404);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/config.js") return send(res, 200, `window.PLK_CONFIG={mode:"server",publicRead:${PUBLIC_READ},allowRegister:${ALLOW_REGISTER}};`, MIME[".js"]);
  const fp = path.normalize(path.join(PUBLIC, rel));
  if (!fp.startsWith(PUBLIC + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return send(res, 404, "Not found", MIME[".txt"]);
  res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream", "cache-control": rel.startsWith("/vendor/") ? "public, max-age=604800" : "no-cache", "x-content-type-options": "nosniff" });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "POST" && req.headers.origin && req.headers.host && !req.headers.origin.endsWith("//" + req.headers.host)) return deny(res, "cross-site request blocked");
      return await api(req, res, url, currentUser(req));
    }
    serveStatic(req, res, url);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : "server error" }); }
});
server.listen(PORT, () => console.log(`[plk-kpi] listening on http://localhost:${PORT}  (data: ${DATA_DIR}, public read: ${PUBLIC_READ})`));
