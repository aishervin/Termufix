import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { createLocalD1, type D1Database, type D1Row } from './src/d1.ts';
import {
  clip,
  joinScript,
  now,
  randomHex,
  safeEqual,
  sessionPage,
  sha256hex,
  slugify,
} from './src/termufix-core.ts';

dotenv.config();

const PORT = 3000;
const HOST = '0.0.0.0';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS join_tokens (
  token TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  enrolls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  session_key_hash TEXT NOT NULL,
  join_token TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  android TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  termux TEXT NOT NULL DEFAULT '',
  packages TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  cmd_id INTEGER NOT NULL DEFAULT 0,
  ack INTEGER NOT NULL DEFAULT 0,
  command TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created DESC);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_sid ON events (sid, id);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  sid TEXT,
  session_key TEXT,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_claims_created ON claims (created DESC);
CREATE TABLE IF NOT EXISTS starts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_starts_ip_ts ON starts (ip, ts);
`;

const db: D1Database = createLocalD1();
db.exec(SCHEMA);

function bearer(req: Request): string {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function adminOk(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN || '';
  return expected.length > 0 && safeEqual(bearer(req), expected);
}

function getOrigin(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = (forwardedProto ? forwardedProto.split(',')[0] : req.protocol || 'http').trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function readBody(req: Request): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) {
    return b as Record<string, unknown>;
  }
  if (typeof b === 'string') {
    const trimmed = b.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through to raw command body
    }
    return { cmd: b };
  }
  return {};
}

async function getSession(sid: string): Promise<D1Row | null> {
  return db.prepare('SELECT * FROM sessions WHERE sid = ?').bind(sid).first();
}

async function validateJoinToken(token: string): Promise<D1Row | null> {
  const row = await db.prepare('SELECT * FROM join_tokens WHERE token = ?').bind(token).first();
  if (!row) return null;
  if (Number(row.expires) !== 0 && Number(row.expires) <= now()) return null;
  return row;
}

async function sessionByKey(sid: string, key: string): Promise<D1Row | null> {
  const s = await getSession(sid);
  if (!s) return null;
  const hash = await sha256hex(key);
  return safeEqual(String(s.session_key_hash), hash) ? s : null;
}

async function touch(sid: string): Promise<void> {
  const t = now();
  await db.prepare('UPDATE sessions SET last_seen = ?, updated = ? WHERE sid = ?').bind(t, t, sid).run();
}

async function logEvent(sid: string, type: string, data: string): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO events (sid, ts, type, data) VALUES (?, ?, ?, ?)')
      .bind(sid, now(), type, clip(data, 4000))
      .run();
  } catch {
    // logging is best-effort
  }
}

function resolveIndexHtml(): string {
  const distPath = path.join(process.cwd(), 'dist', 'index.html');
  if (process.env.NODE_ENV === 'production' && fs.existsSync(distPath)) {
    return distPath;
  }
  const rootPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(rootPath)) return rootPath;
  return path.join(process.cwd(), 'src', 'index.html');
}

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.text({ type: '*/*', limit: '2mb' }));

app.use('/assets', express.static(path.join(process.cwd(), 'assets')));

app.use((_req, res, next) => {
  res.setHeader('cache-control', 'no-store');
  next();
});

app.head(['/', '/index.html'], (_req: Request, res: Response) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.status(200).end();
});

app.get(['/', '/index.html'], (_req: Request, res: Response) => {
  const file = resolveIndexHtml();
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('x-content-type-options', 'nosniff');
  res.sendFile(file);
});

app.get('/health', (_req: Request, res: Response) => {
  res.type('text/plain; charset=utf-8').send('ok');
});

app.get('/favicon.ico', (_req: Request, res: Response) => {
  res.status(204).end();
});

app.get('/join/:token', async (req: Request, res: Response) => {
  let token = decodeURIComponent(String(req.params.token || ''));
  if (token.endsWith('.sh')) token = token.slice(0, -3);
  if (!/^(?:tfx_[a-f0-9]{24,64}|[a-z0-9][a-z0-9_-]{2,31})$/.test(token)) {
    res.status(404).type('text/plain; charset=utf-8').send('invalid link\n');
    return;
  }
  const row = await validateJoinToken(token);
  if (!row) {
    res.status(404).type('text/plain; charset=utf-8').send('This link is invalid or expired.\n');
    return;
  }
  const claim = String(req.query.claim || '');
  if (claim) {
    if (!/^[a-f0-9]{32}$/.test(claim)) {
      res.status(404).type('text/plain; charset=utf-8').send('invalid claim\n');
      return;
    }
    const c = await db.prepare('SELECT * FROM claims WHERE claim_id = ?').bind(claim).first();
    if (!c || Number(c.expires) <= now()) {
      res.status(404).type('text/plain; charset=utf-8').send('This link is invalid or expired.\n');
      return;
    }
  }
  const relay = getOrigin(req);
  res
    .status(200)
    .setHeader('content-type', 'text/x-shellscript; charset=utf-8')
    .setHeader('x-content-type-options', 'nosniff')
    .send(joinScript(relay, token, claim));
});

app.post('/api/start', async (req: Request, res: Response) => {
  const body = readBody(req);
  const name = clip(body.name, 60).trim();
  if (!name) {
    res.status(400).json({ ok: false, error: 'نام کوچک را وارد کن' });
    return;
  }
  const ip = req.get('cf-connecting-ip') || req.ip || 'unknown';
  const t = now();
  const count = await db
    .prepare('SELECT COUNT(*) AS n FROM starts WHERE ip = ? AND ts > ?')
    .bind(ip, t - 3600)
    .first<{ n: number }>();
  if (Number(count?.n || 0) >= 30) {
    res.status(429).json({ ok: false, error: 'تعداد درخواست‌ها زیاد است؛ بعداً تلاش کن' });
    return;
  }
  await db.prepare('INSERT INTO starts (ip, ts) VALUES (?, ?)').bind(ip, t).run();

  const slug = slugify(name);
  await db
    .prepare(
      `INSERT INTO join_tokens (token, label, created, expires)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(token) DO UPDATE SET label = excluded.label, expires = 0`
    )
    .bind(slug, name, t)
    .run();

  const claim = randomHex(16);
  const claimExpires = t + 86400;
  await db
    .prepare('INSERT INTO claims (claim_id, name, created, expires, last_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(claim, name, t, claimExpires, t)
    .run();

  const joinUrl = `${getOrigin(req)}/join/${slug}?claim=${claim}`;
  res.json({
    ok: true,
    claim_id: claim,
    name,
    slug,
    expires: claimExpires,
    command: `curl -fsSL ${joinUrl} | bash`,
  });
});

app.get('/api/claim/:claim', async (req: Request, res: Response) => {
  const claim = decodeURIComponent(String(req.params.claim || ''));
  if (!/^[a-f0-9]{32}$/.test(claim)) {
    res.status(404).json({ ok: false });
    return;
  }
  const c = await db.prepare('SELECT * FROM claims WHERE claim_id = ?').bind(claim).first();
  if (!c) {
    res.status(404).json({ ok: false, error: 'not found' });
    return;
  }
  if (c.sid && c.session_key) {
    res.json({
      ok: true,
      connected: true,
      name: c.name,
      sid: c.sid,
      url: `${getOrigin(req)}/s/${c.sid}/${c.session_key}`,
    });
    return;
  }
  if (Number(c.expires) <= now()) {
    res.status(410).json({ ok: false, error: 'expired' });
    return;
  }
  res.json({ ok: true, connected: false, name: c.name });
});

app.post('/api/enroll', async (req: Request, res: Response) => {
  const token = bearer(req);
  const row = await validateJoinToken(token);
  if (!row) {
    res.status(401).type('text/plain; charset=utf-8').send('invalid or expired token\n');
    return;
  }
  const body = readBody(req);
  const claim = clip(body.claim, 64);
  let claimRow: D1Row | null = null;
  if (claim) {
    claimRow = await db.prepare('SELECT * FROM claims WHERE claim_id = ?').bind(claim).first();
    if (!claimRow || Number(claimRow.expires) <= now()) {
      res.status(400).type('text/plain; charset=utf-8').send('claim expired\n');
      return;
    }
  }
  const sid = 's_' + randomHex(8);
  const key = randomHex(32);
  const t = now();
  const keyHash = await sha256hex(key);
  await db
    .prepare(
      `INSERT INTO sessions
       (sid, session_key_hash, join_token, label, model, android, arch, termux, packages, note,
        created, last_seen, status, cmd_id, ack, command, output, exit_code, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, '', '', NULL, ?)`
    )
    .bind(
      sid,
      keyHash,
      token,
      clip(row.label, 120),
      clip(body.model, 120),
      clip(body.android, 40),
      clip(body.arch, 40),
      clip(body.termux, 40),
      clip(body.packages, 40),
      clip(body.note, 200),
      t,
      t,
      t
    )
    .run();
  await db.prepare('UPDATE join_tokens SET enrolls = enrolls + 1 WHERE token = ?').bind(token).run();
  if (claimRow) {
    await db
      .prepare('UPDATE claims SET sid = ?, session_key = ?, last_seen = ? WHERE claim_id = ?')
      .bind(sid, key, t, claim)
      .run();
  }
  await logEvent(sid, 'enroll', JSON.stringify({ model: body.model, android: body.android, arch: body.arch }));
  res
    .status(200)
    .type('text/plain; charset=utf-8')
    .send(`sid=${sid}\nkey=${key}\nurl=${getOrigin(req)}/s/${sid}/${key}\n`);
});

app.get('/api/next', async (req: Request, res: Response) => {
  const sid = String(req.query.sid || '');
  const token = bearer(req);
  if (!sid || !token) {
    res.status(401).type('text/plain; charset=utf-8').send('missing credentials\n');
    return;
  }
  const s = await getSession(sid);
  if (!s) {
    res.status(404).type('text/plain; charset=utf-8').send('session not found\n');
    return;
  }
  if (!safeEqual(String(s.join_token), token)) {
    res.status(403).type('text/plain; charset=utf-8').send('forbidden\n');
    return;
  }
  await touch(sid);
  if (s.status === 'closed') {
    res.status(200).setHeader('x-tfx-closed', '1').send('');
    return;
  }
  if (Number(s.cmd_id) > Number(s.ack)) {
    res
      .status(200)
      .setHeader('content-type', 'text/plain; charset=utf-8')
      .setHeader('x-tfx-id', String(s.cmd_id))
      .send(String(s.command || ''));
    return;
  }
  res.status(204).end();
});

app.post('/api/output', async (req: Request, res: Response) => {
  const token = bearer(req);
  const body = readBody(req);
  const sid = String(body.sid || '');
  const id = Number(body.id || 0);
  const exitCode = Number(body.exit || 0);
  if (!sid || !token || !id) {
    res.status(401).type('text/plain; charset=utf-8').send('missing credentials\n');
    return;
  }
  const s = await getSession(sid);
  if (!s) {
    res.status(404).type('text/plain; charset=utf-8').send('session not found\n');
    return;
  }
  if (!safeEqual(String(s.join_token), token)) {
    res.status(403).type('text/plain; charset=utf-8').send('forbidden\n');
    return;
  }
  const t = now();
  const output = clip(body.output, 180000);
  await db
    .prepare(
      `UPDATE sessions
       SET output = ?, exit_code = ?, ack = ?, updated = ?,
           status = CASE WHEN cmd_id = ? THEN 'idle' ELSE status END
       WHERE sid = ?`
    )
    .bind(output, exitCode, id, t, id, sid)
    .run();
  await logEvent(sid, 'output', JSON.stringify({ id, exit: exitCode, len: output.length }));
  res.type('text/plain; charset=utf-8').send('ok\n');
});

app.post('/api/heartbeat', async (req: Request, res: Response) => {
  const token = bearer(req);
  const body = readBody(req);
  const sid = String(body.sid || '');
  if (!sid || !token) {
    res.status(401).type('text/plain; charset=utf-8').send('missing credentials\n');
    return;
  }
  const s = await getSession(sid);
  if (!s || !safeEqual(String(s.join_token), token)) {
    res.status(403).type('text/plain; charset=utf-8').send('forbidden\n');
    return;
  }
  await touch(sid);
  res.type('text/plain; charset=utf-8').send('ok\n');
});

app.get('/s/:sid/:key', async (req: Request, res: Response) => {
  const sid = String(req.params.sid || '');
  const key = String(req.params.key || '');
  const s = await sessionByKey(sid, key);
  if (!s) {
    res.status(404).type('text/plain; charset=utf-8').send('session not found or key invalid\n');
    return;
  }
  res
    .status(200)
    .setHeader('content-type', 'text/html; charset=utf-8')
    .setHeader('x-content-type-options', 'nosniff')
    .send(sessionPage(sid, key));
});

app.get('/s/:sid/:key/state', async (req: Request, res: Response) => {
  const sid = String(req.params.sid || '');
  const key = String(req.params.key || '');
  const s = await sessionByKey(sid, key);
  if (!s) {
    res.status(404).type('text/plain; charset=utf-8').send('session not found or key invalid\n');
    return;
  }
  res.json({
    ok: true,
    sid,
    status: s.status,
    online: now() - Number(s.last_seen) < 15,
    cmd_id: Number(s.cmd_id),
    ack: Number(s.ack),
    command: s.command,
    output: s.output,
    exit_code: s.exit_code,
    created: Number(s.created),
    last_seen: Number(s.last_seen),
    model: s.model,
    android: s.android,
    arch: s.arch,
    termux: s.termux,
    packages: s.packages,
    note: s.note,
  });
});

app.post('/s/:sid/:key/cmd', async (req: Request, res: Response) => {
  const sid = String(req.params.sid || '');
  const key = String(req.params.key || '');
  const s = await sessionByKey(sid, key);
  if (!s) {
    res.status(404).type('text/plain; charset=utf-8').send('session not found or key invalid\n');
    return;
  }
  if (s.status === 'closed') {
    res.status(409).type('text/plain; charset=utf-8').send('session is closed\n');
    return;
  }
  const body = readBody(req);
  const force = String(body.force || '') === '1' || body.force === true;
  if (s.status === 'running' && !force) {
    res.status(409).json({ ok: false, error: 'busy', command: s.command, cmd_id: Number(s.cmd_id) });
    return;
  }
  const cmd = clip(body.cmd, 20000).trim();
  if (!cmd) {
    res.status(400).type('text/plain; charset=utf-8').send('empty command\n');
    return;
  }
  const id = Number(s.cmd_id) + 1;
  const t = now();
  await db
    .prepare(
      `UPDATE sessions SET cmd_id = ?, command = ?, status = 'running', output = '', exit_code = NULL, updated = ?
       WHERE sid = ?`
    )
    .bind(id, cmd, t, sid)
    .run();
  await logEvent(sid, 'cmd', cmd);
  res.json({ ok: true, id });
});

app.post('/s/:sid/:key/close', async (req: Request, res: Response) => {
  const sid = String(req.params.sid || '');
  const key = String(req.params.key || '');
  const s = await sessionByKey(sid, key);
  if (!s) {
    res.status(404).type('text/plain; charset=utf-8').send('session not found or key invalid\n');
    return;
  }
  const t = now();
  await db.prepare("UPDATE sessions SET status = 'closed', updated = ? WHERE sid = ?").bind(t, sid).run();
  await logEvent(sid, 'close', '');
  res.json({ ok: true });
});

app.post('/admin/token', async (req: Request, res: Response) => {
  if (!adminOk(req)) {
    res.status(403).type('text/plain; charset=utf-8').send('forbidden\n');
    return;
  }
  const body = readBody(req);
  const alias = clip(body.alias, 40).trim().toLowerCase();
  const permanent = body.forever === true || String(body.forever || '') === '1' || Number(body.hours) === 0;
  const label = clip(body.label || alias || 'user', 120);
  let token: string;
  let expires: number;
  if (alias) {
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(alias)) {
      res.status(400).type('text/plain; charset=utf-8').send('invalid alias\n');
      return;
    }
    token = alias;
    expires = permanent ? 0 : now() + Math.max(1, Math.min(72, Number(body.hours || 24))) * 3600;
    await db
      .prepare(
        `INSERT INTO join_tokens (token, label, created, expires)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET label = excluded.label, expires = excluded.expires`
      )
      .bind(token, label, now(), expires)
      .run();
  } else {
    const hours = Math.max(1, Math.min(72, Number(body.hours || 12)));
    token = 'tfx_' + randomHex(24);
    expires = now() + hours * 3600;
    await db
      .prepare('INSERT INTO join_tokens (token, label, created, expires) VALUES (?, ?, ?, ?)')
      .bind(token, label, now(), expires)
      .run();
  }
  const joinUrl = `${getOrigin(req)}/join/${token}`;
  res.json({
    ok: true,
    token,
    label,
    expires,
    permanent: expires === 0,
    url: joinUrl,
    command: `curl -fsSL ${joinUrl} | bash`,
  });
});

app.get('/admin/sessions', async (req: Request, res: Response) => {
  if (!adminOk(req)) {
    res.status(403).type('text/plain; charset=utf-8').send('forbidden\n');
    return;
  }
  const rows = await db
    .prepare(
      `SELECT sid, label, model, android, arch, created, last_seen, status, cmd_id, ack, exit_code
       FROM sessions ORDER BY created DESC LIMIT 50`
    )
    .all();
  res.json({ ok: true, sessions: rows.results || [] });
});

app.post('/admin/revoke', async (req: Request, res: Response) => {
  if (!adminOk(req)) {
    res.status(403).type('text/plain; charset=utf-8').send('forbidden\n');
    return;
  }
  const body = readBody(req);
  const token = String(body.token || '');
  if (!token) {
    res.status(400).type('text/plain; charset=utf-8').send('missing token\n');
    return;
  }
  await db.prepare('DELETE FROM join_tokens WHERE token = ?').bind(token).run();
  res.json({ ok: true });
});

app.use((_req: Request, res: Response) => {
  res.status(404).type('text/plain; charset=utf-8').send('not found\n');
});

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).type('text/plain; charset=utf-8').send('internal error\n');
});

app.listen(PORT, HOST, () => {
  console.log(`Termufix server listening on http://${HOST}:${PORT}`);
});
