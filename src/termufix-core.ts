const BANNER = 'SHΞN™𝙵𝙸𝚇';
const enc = new TextEncoder();

export interface JoinTokenRecord {
  token: string;
  label: string;
  created: number;
  expires: number;
  enrolls: number;
}

export interface ClaimRecord {
  claim_id: string;
  name: string;
  created: number;
  expires: number;
  sid: string | null;
  session_key: string | null;
  last_seen: number;
}

export interface SessionRecord {
  sid: string;
  session_key_hash: string;
  join_token: string;
  label: string;
  model: string;
  android: string;
  arch: string;
  termux: string;
  packages: string;
  note: string;
  created: number;
  last_seen: number;
  status: string;
  cmd_id: number;
  ack: number;
  command: string;
  output: string;
  exit_code: number | null;
  updated: number;
}

export interface EventRecord {
  sid: string;
  ts: number;
  type: string;
  data: string;
}

export interface TermufixStore {
  getJoinToken(token: string): Promise<JoinTokenRecord | null>;
  upsertJoinToken(record: { token: string; label: string; created: number; expires: number }): Promise<void>;
  incrementJoinTokenEnrolls(token: string): Promise<void>;
  deleteJoinToken(token: string): Promise<void>;

  getClaim(claimId: string): Promise<ClaimRecord | null>;
  putClaim(record: ClaimRecord): Promise<void>;

  getSession(sid: string): Promise<SessionRecord | null>;
  putSession(record: SessionRecord): Promise<void>;
  listSessions(limit: number): Promise<SessionRecord[]>;

  appendEvent(event: EventRecord): Promise<void>;

  countRecentStarts(ip: string, sinceTs: number): Promise<number>;
  recordStart(ip: string, ts: number): Promise<void>;
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function clip(value: unknown, max: number): string {
  const s = value == null ? '' : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

export function slugify(name: string): string {
  let s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  if (s.length < 2) s = 'user-' + randomHex(2);
  if (s.startsWith('tfx_')) s = 'u-' + s;
  return s;
}

export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function joinScript(relay: string, token: string, claim: string): string {
  return `#!/usr/bin/env bash
# ${BANNER} — Termufix rescue channel
# This script only needs bash + curl. It does not require OpenCode.
set -u

RELAY=${JSON.stringify(relay)}
TOKEN=${JSON.stringify(token)}
CLAIM=${JSON.stringify(claim || '')}

say() { printf '%s\\n' "$*"; }
die() { printf '\\n[termufix] %s\\n' "$*" >&2; exit 1; }

printf '\\n'
printf '  ============================================\\n'
printf '   ${BANNER}\\n'
printf '   Termufix rescue channel\\n'
printf '  ============================================\\n\\n'

command -v curl >/dev/null 2>&1 || die "curl is not installed. In Termux run: pkg install curl"
command -v bash >/dev/null 2>&1 || die "bash is not installed."

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock >/dev/null 2>&1 || true
fi

MODEL="$(getprop ro.product.model 2>/dev/null || echo unknown)"
ANDROID="$(getprop ro.build.version.release 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
TERMUX="\${TERMUX_VERSION:-unknown}"
if command -v pkg >/dev/null 2>&1; then
  PACKAGES="$(pkg list-installed 2>/dev/null | wc -l | tr -d ' ')"
else
  PACKAGES="unknown"
fi
NOTE="Termux rescue"

say "[termufix] enrolling..."
ENROLL="$(curl -fsS -X POST "$RELAY/api/enroll" \\
  -H "Authorization: Bearer $TOKEN" \\
  --data-urlencode "model=$MODEL" \\
  --data-urlencode "android=$ANDROID" \\
  --data-urlencode "arch=$ARCH" \\
  --data-urlencode "termux=$TERMUX" \\
  --data-urlencode "packages=$PACKAGES" \\
  --data-urlencode "note=$NOTE" \\
  --data-urlencode "claim=$CLAIM" 2>/dev/null)" || die "could not reach the relay."

SID="$(printf '%s\\n' "$ENROLL" | sed -n 's/^sid=//p' | head -n1)"
KEY="$(printf '%s\\n' "$ENROLL" | sed -n 's/^key=//p' | head -n1)"
URL="$(printf '%s\\n' "$ENROLL" | sed -n 's/^url=//p' | head -n1)"

[ -n "$SID" ] && [ -n "$KEY" ] || {
  printf '\\n[termufix] enrollment failed. Relay said:\\n%s\\n' "$ENROLL" >&2
  exit 1
}

printf '\\n'
printf '  ============================================\\n'
printf '   Connected. Send this link to SHΞN:\\n'
printf '\\n'
printf '   %s\\n' "$URL"
printf '\\n'
printf '   Keep this window open. Ctrl-C to stop.\\n'
printf '  ============================================\\n\\n'

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t termufix)"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

while :; do
  HDR="$TMP/h"
  BODY="$TMP/b"
  OUT="$TMP/o"
  CODE="$(curl -sS -D "$HDR" -o "$BODY" -w '%{http_code}' \\
    "$RELAY/api/next?sid=$SID" \\
    -H "Authorization: Bearer $TOKEN" 2>/dev/null || true)"
  [ -n "$CODE" ] || CODE="000"

  if [ "$CODE" = "204" ]; then
    sleep 2
    continue
  fi

  if [ "$CODE" = "404" ]; then
    say ""
    say "[termufix] session no longer exists. Ask SHΞN for a new link."
    break
  fi

  if [ "$CODE" != "200" ]; then
    printf '[termufix] relay status %s; retrying in 5s...\\n' "$CODE"
    sleep 5
    continue
  fi

  if grep -qi '^x-tfx-closed:[[:space:]]*1' "$HDR"; then
    say ""
    say "[termufix] channel closed by SHΞN."
    break
  fi

  CMD_ID="$(awk 'tolower($1)=="x-tfx-id:"{print $2}' "$HDR" | tr -d '\\r' | head -n1)"
  if [ -z "$CMD_ID" ]; then
    sleep 2
    continue
  fi

  CMD="$(cat "$BODY")"
  printf '\\n[%s] $ %s\\n' "$(date +%H:%M:%S 2>/dev/null || echo now)" "$CMD"

  if command -v timeout >/dev/null 2>&1; then
    timeout 900 bash -lc "$CMD" >"$OUT" 2>&1
  else
    bash -lc "$CMD" >"$OUT" 2>&1
  fi
  EXIT=$?

  tail -c 4000 "$OUT"
  tail -c 120000 "$OUT" >"$OUT.t"
  mv "$OUT.t" "$OUT"
  printf '\\n[termufix] exit=%s\\n' "$EXIT"

  curl -fsS -X POST "$RELAY/api/output" \\
    -H "Authorization: Bearer $TOKEN" \\
    --data-urlencode "sid=$SID" \\
    --data-urlencode "id=$CMD_ID" \\
    --data-urlencode "exit=$EXIT" \\
    --data-urlencode "output@$OUT" >/dev/null 2>&1 \\
    || printf '[termufix] warning: could not send output\\n'
done

printf '\\n[termufix] stopped.\\n'
`;
}

export function sessionPage(sid: string, key: string): string {
  const s = JSON.stringify(sid);
  const k = JSON.stringify(key);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${BANNER} — session</title>
<style>
*{box-sizing:border-box}body{background:#0b0d10;color:#d7dde5;font:15px/1.5 ui-monospace,monospace;margin:0;padding:1rem}
header{display:flex;gap:1rem;align-items:baseline;flex-wrap:wrap;margin-bottom:1rem}h1{font-size:1.1rem;margin:0}
.badge{padding:.15rem .5rem;border-radius:1rem;background:#1b2430;color:#9fe3b3}
.err{color:#f87171;font-size:.85rem;margin-top:.5rem;min-height:1.2rem}
pre{white-space:pre-wrap;word-break:break-word;background:#11161d;border:1px solid #26313d;border-radius:.5rem;padding:1rem;min-height:40vh;max-height:65vh;overflow:auto}
form{display:flex;gap:.5rem;margin-top:1rem}textarea{flex:1;min-height:3.5rem;background:#11161d;color:inherit;border:1px solid #26313d;border-radius:.5rem;padding:.6rem;font:inherit}
button{background:#2a6f4e;color:white;border:0;border-radius:.5rem;padding:.6rem 1rem;font:inherit;cursor:pointer}
.muted{color:#8b96a5}
</style></head><body>
<header><h1>${BANNER}</h1><span id=status class=badge>loading</span><span id=info class=muted></span></header>
<pre id=out></pre>
<form id=form><textarea id=cmd placeholder="command (runs as the Termux user)"></textarea><button>Send</button></form>
<div id=err class=err></div>
<script>
const sid=${s}, key=${k};
const out=document.getElementById('out'), statusEl=document.getElementById('status'), info=document.getElementById('info'), errEl=document.getElementById('err');
async function tick(){
  try{
    const r=await fetch('/s/'+sid+'/'+key+'/state',{cache:'no-store'});
    if(!r.ok){statusEl.textContent='gone';return;}
    const j=await r.json();
    statusEl.textContent=j.status+(j.online?' · online':' · offline');
    info.textContent=[j.model,j.android,j.arch].filter(Boolean).join(' · ');
    out.textContent=j.output||'(no output yet)';
    document.getElementById('form').style.opacity=j.status==='closed'?'.35':'1';
  }catch(e){statusEl.textContent='offline';}
}
document.getElementById('form').onsubmit=async(e)=>{
  e.preventDefault();
  errEl.textContent='';
  const c=document.getElementById('cmd');
  if(!c.value.trim())return;
  const r=await fetch('/s/'+sid+'/'+key+'/cmd',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({cmd:c.value})});
  if(!r.ok){errEl.textContent=await r.text();}
  c.value=''; tick();
};
tick(); setInterval(tick,2000);
</script></body></html>`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function bearer(request: Request): string {
  const h = request.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const protoHeader = request.headers.get('x-forwarded-proto');
  const proto = (protoHeader ? protoHeader.split(',')[0].trim() : url.protocol.replace(/:$/, '')) || 'https';
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0].trim() ||
    request.headers.get('host')?.split(',')[0].trim() ||
    url.host;
  return host ? `${proto}://${host}` : url.origin;
}

async function readWebBody(request: Request): Promise<Record<string, unknown>> {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      const parsed = await request.json();
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    try {
      const raw = await request.text();
      return Object.fromEntries(new URLSearchParams(raw).entries());
    } catch {
      return {};
    }
  }
  if (ct.includes('multipart/form-data')) {
    try {
      const fd = await request.formData();
      const out: Record<string, unknown> = {};
      fd.forEach((v, k) => {
        out[k] = typeof v === 'string' ? v : '';
      });
      return out;
    } catch {
      return {};
    }
  }
  const raw = await request.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { cmd: raw };
  } catch {
    return { cmd: raw };
  }
}

async function validateJoinToken(store: TermufixStore, token: string): Promise<JoinTokenRecord | null> {
  const row = await store.getJoinToken(token);
  if (!row) return null;
  if (Number(row.expires) !== 0 && Number(row.expires) <= now()) return null;
  return row;
}

async function sessionByKey(store: TermufixStore, sid: string, key: string): Promise<SessionRecord | null> {
  const s = await store.getSession(sid);
  if (!s) return null;
  const hash = await sha256hex(key);
  return safeEqual(String(s.session_key_hash), hash) ? s : null;
}

export async function handleTermufixApi(
  request: Request,
  opts: { store: TermufixStore; adminToken: string; clientIp: string }
): Promise<Response> {
  const { store, adminToken, clientIp } = opts;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = getRequestOrigin(request);

  if (method === 'GET' && path === '/health') return text('ok');
  if (method === 'GET' && path === '/favicon.ico') return new Response(null, { status: 204 });

  // Join script: /join/<token> or /join/<token>.sh
  if (method === 'GET' && path.startsWith('/join/')) {
    let token = decodeURIComponent(path.slice('/join/'.length));
    if (token.endsWith('.sh')) token = token.slice(0, -3);
    if (!/^(?:tfx_[a-f0-9]{24,64}|[a-z0-9][a-z0-9_-]{2,31})$/.test(token)) {
      return text('invalid link\n', 404);
    }
    const row = await validateJoinToken(store, token);
    if (!row) return text('This link is invalid or expired.\n', 404);
    const claim = url.searchParams.get('claim') || '';
    if (claim) {
      if (!/^[a-f0-9]{32}$/.test(claim)) return text('invalid claim\n', 404);
      const c = await store.getClaim(claim);
      if (!c || Number(c.expires) <= now()) return text('This link is invalid or expired.\n', 404);
    }
    return new Response(joinScript(origin, token, claim), {
      status: 200,
      headers: {
        'content-type': 'text/x-shellscript; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // Public: create a named link + a 24h claim for the self-service page
  if (method === 'POST' && path === '/api/start') {
    const body = await readWebBody(request);
    const name = clip(body.name, 60).trim();
    if (!name) return json({ ok: false, error: 'نام کوچک را وارد کن' }, 400);
    const t = now();
    const recent = await store.countRecentStarts(clientIp, t - 3600);
    if (recent >= 30) {
      return json({ ok: false, error: 'تعداد درخواست‌ها زیاد است؛ بعداً تلاش کن' }, 429);
    }
    await store.recordStart(clientIp, t);

    const slug = slugify(name);
    await store.upsertJoinToken({ token: slug, label: name, created: t, expires: 0 });

    const claim = randomHex(16);
    const claimExpires = t + 86400;
    await store.putClaim({
      claim_id: claim,
      name,
      created: t,
      expires: claimExpires,
      sid: null,
      session_key: null,
      last_seen: t,
    });

    const joinUrl = `${origin}/join/${slug}?claim=${claim}`;
    return json({
      ok: true,
      claim_id: claim,
      name,
      slug,
      expires: claimExpires,
      command: `curl -fsSL ${joinUrl} | bash`,
    });
  }

  // Public: the page polls this until the Termux script enrolls
  if (method === 'GET' && path.startsWith('/api/claim/')) {
    const claim = decodeURIComponent(path.slice('/api/claim/'.length));
    if (!/^[a-f0-9]{32}$/.test(claim)) return json({ ok: false }, 404);
    const c = await store.getClaim(claim);
    if (!c) return json({ ok: false, error: 'not found' }, 404);
    if (c.sid && c.session_key) {
      return json({
        ok: true,
        connected: true,
        name: c.name,
        sid: c.sid,
        url: `${origin}/s/${c.sid}/${c.session_key}`,
      });
    }
    if (Number(c.expires) <= now()) return json({ ok: false, error: 'expired' }, 410);
    return json({ ok: true, connected: false, name: c.name });
  }

  // Device: enroll
  if (method === 'POST' && path === '/api/enroll') {
    const token = bearer(request);
    const row = await validateJoinToken(store, token);
    if (!row) return text('invalid or expired token\n', 401);
    const body = await readWebBody(request);
    const claim = clip(body.claim, 64);
    let claimRow: ClaimRecord | null = null;
    if (claim) {
      claimRow = await store.getClaim(claim);
      if (!claimRow || Number(claimRow.expires) <= now()) return text('claim expired\n', 400);
    }
    const sid = 's_' + randomHex(8);
    const key = randomHex(32);
    const t = now();
    const keyHash = await sha256hex(key);
    await store.putSession({
      sid,
      session_key_hash: keyHash,
      join_token: token,
      label: clip(row.label, 120),
      model: clip(body.model, 120),
      android: clip(body.android, 40),
      arch: clip(body.arch, 40),
      termux: clip(body.termux, 40),
      packages: clip(body.packages, 40),
      note: clip(body.note, 200),
      created: t,
      last_seen: t,
      status: 'idle',
      cmd_id: 0,
      ack: 0,
      command: '',
      output: '',
      exit_code: null,
      updated: t,
    });
    await store.incrementJoinTokenEnrolls(token);
    if (claimRow) {
      await store.putClaim({
        ...claimRow,
        sid,
        session_key: key,
        last_seen: t,
      });
    }
    await store.appendEvent({
      sid,
      ts: t,
      type: 'enroll',
      data: clip(JSON.stringify({ model: body.model, android: body.android, arch: body.arch }), 4000),
    });
    return text(`sid=${sid}\nkey=${key}\nurl=${origin}/s/${sid}/${key}\n`, 200);
  }

  // Device: poll for a command
  if (method === 'GET' && path === '/api/next') {
    const sid = url.searchParams.get('sid') || '';
    const token = bearer(request);
    if (!sid || !token) return text('missing credentials\n', 401);
    const s = await store.getSession(sid);
    if (!s) return text('session not found\n', 404);
    if (!safeEqual(String(s.join_token), token)) return text('forbidden\n', 403);
    const t = now();
    await store.putSession({ ...s, last_seen: t, updated: t });
    if (s.status === 'closed') {
      return new Response('', { status: 200, headers: { 'x-tfx-closed': '1', 'cache-control': 'no-store' } });
    }
    if (Number(s.cmd_id) > Number(s.ack)) {
      return new Response(String(s.command || ''), {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-tfx-id': String(s.cmd_id),
          'cache-control': 'no-store',
        },
      });
    }
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }

  // Device: send output
  if (method === 'POST' && path === '/api/output') {
    const token = bearer(request);
    const body = await readWebBody(request);
    const sid = String(body.sid || '');
    const id = Number(body.id || 0);
    const exitCode = Number(body.exit || 0);
    if (!sid || !token || !id) return text('missing credentials\n', 401);
    const s = await store.getSession(sid);
    if (!s) return text('session not found\n', 404);
    if (!safeEqual(String(s.join_token), token)) return text('forbidden\n', 403);
    const t = now();
    const output = clip(body.output, 180000);
    await store.putSession({
      ...s,
      output,
      exit_code: exitCode,
      ack: id,
      updated: t,
      status: Number(s.cmd_id) === id ? 'idle' : s.status,
    });
    await store.appendEvent({
      sid,
      ts: t,
      type: 'output',
      data: clip(JSON.stringify({ id, exit: exitCode, len: output.length }), 4000),
    });
    return text('ok\n');
  }

  // Device: heartbeat (optional)
  if (method === 'POST' && path === '/api/heartbeat') {
    const token = bearer(request);
    const body = await readWebBody(request);
    const sid = String(body.sid || '');
    if (!sid || !token) return text('missing credentials\n', 401);
    const s = await store.getSession(sid);
    if (!s || !safeEqual(String(s.join_token), token)) return text('forbidden\n', 403);
    const t = now();
    await store.putSession({ ...s, last_seen: t, updated: t });
    return text('ok\n');
  }

  // Session capability routes: /s/<sid>/<key>[/state|/cmd|/close]
  const m = path.match(/^\/s\/([^/]+)\/([^/]+)(?:\/(state|cmd|close))?$/);
  if (m) {
    const [, sid, key, action] = m;
    const s = await sessionByKey(store, sid, key);
    if (!s) return text('session not found or key invalid\n', 404);

    if (!action && method === 'GET') return html(sessionPage(sid, key));

    if (action === 'state' && method === 'GET') {
      return json({
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
    }

    if (action === 'cmd' && method === 'POST') {
      if (s.status === 'closed') return text('session is closed\n', 409);
      const body = await readWebBody(request);
      const force = String(body.force || '') === '1' || body.force === true;
      if (s.status === 'running' && !force) {
        return json({ ok: false, error: 'busy', command: s.command, cmd_id: Number(s.cmd_id) }, 409);
      }
      const cmd = clip(body.cmd, 20000).trim();
      if (!cmd) return text('empty command\n', 400);
      const id = Number(s.cmd_id) + 1;
      const t = now();
      await store.putSession({
        ...s,
        cmd_id: id,
        command: cmd,
        status: 'running',
        output: '',
        exit_code: null,
        updated: t,
      });
      await store.appendEvent({ sid, ts: t, type: 'cmd', data: clip(cmd, 4000) });
      return json({ ok: true, id });
    }

    if (action === 'close' && method === 'POST') {
      const t = now();
      await store.putSession({ ...s, status: 'closed', updated: t });
      await store.appendEvent({ sid, ts: t, type: 'close', data: '' });
      return json({ ok: true });
    }

    return text('method not allowed\n', 405);
  }

  // Admin: create a join token, optionally a permanent named alias
  const isAdmin = adminToken.length > 0 && safeEqual(bearer(request), adminToken);

  if (method === 'POST' && path === '/admin/token') {
    if (!isAdmin) return text('forbidden\n', 403);
    const body = await readWebBody(request);
    const alias = clip(body.alias, 40).trim().toLowerCase();
    const permanent = body.forever === true || String(body.forever || '') === '1' || Number(body.hours) === 0;
    const label = clip(body.label || alias || 'user', 120);
    let token: string;
    let expires: number;
    if (alias) {
      if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(alias)) return text('invalid alias\n', 400);
      token = alias;
      expires = permanent ? 0 : now() + Math.max(1, Math.min(72, Number(body.hours || 24))) * 3600;
      await store.upsertJoinToken({ token, label, created: now(), expires });
    } else {
      const hours = Math.max(1, Math.min(72, Number(body.hours || 12)));
      token = 'tfx_' + randomHex(24);
      expires = now() + hours * 3600;
      await store.upsertJoinToken({ token, label, created: now(), expires });
    }
    const joinUrl = `${origin}/join/${token}`;
    return json({
      ok: true,
      token,
      label,
      expires,
      permanent: expires === 0,
      url: joinUrl,
      command: `curl -fsSL ${joinUrl} | bash`,
    });
  }

  // Admin: list recent sessions
  if (method === 'GET' && path === '/admin/sessions') {
    if (!isAdmin) return text('forbidden\n', 403);
    const rows = await store.listSessions(50);
    return json({
      ok: true,
      sessions: rows.map((r) => ({
        sid: r.sid,
        label: r.label,
        model: r.model,
        android: r.android,
        arch: r.arch,
        created: r.created,
        last_seen: r.last_seen,
        status: r.status,
        cmd_id: r.cmd_id,
        ack: r.ack,
        exit_code: r.exit_code,
      })),
    });
  }

  // Admin: revoke a join token
  if (method === 'POST' && path === '/admin/revoke') {
    if (!isAdmin) return text('forbidden\n', 403);
    const body = await readWebBody(request);
    const token = String(body.token || '');
    if (!token) return text('missing token\n', 400);
    await store.deleteJoinToken(token);
    return json({ ok: true });
  }

  return text('not found\n', 404);
}
