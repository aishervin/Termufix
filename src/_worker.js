/**
 * Termufix — SHΞN™𝙵𝙸𝚇
 * A tiny, dependency-free rescue relay for Termux.
 *
 * This file is deployed as a Cloudflare Pages advanced-mode worker
 * (/_worker.js) and uses a D1 binding named DB.
 */

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

const BANNER = "SHΞN™𝙵𝙸𝚇";
const enc = new TextEncoder();
let schemaReady = null;

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function clip(value, max) {
  const s = value == null ? "" : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function slugify(name) {
  let s = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  if (s.length < 2) s = "user-" + randomHex(2);
  if (s.startsWith("tfx_")) s = "u-" + s;
  return s;
}

function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function adminOk(request, env) {
  const expected = env.ADMIN_TOKEN || "";
  return expected.length > 0 && safeEqual(bearer(request), expected);
}

async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      const statements = SCHEMA.split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const sql of statements) {
        await env.DB.prepare(sql).run();
      }
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function readBody(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    try {
      const fd = await request.formData();
      return Object.fromEntries(fd.entries());
    } catch {
      return {};
    }
  }
  const raw = await request.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { cmd: raw };
  }
}

async function getSession(env, sid) {
  return env.DB.prepare("SELECT * FROM sessions WHERE sid = ?").bind(sid).first();
}

async function validateJoinToken(env, token) {
  const row = await env.DB.prepare("SELECT * FROM join_tokens WHERE token = ?").bind(token).first();
  if (!row) return null;
  // expires === 0 means a named, non-expiring alias such as /join/shervin
  if (Number(row.expires) !== 0 && Number(row.expires) <= now()) return null;
  return row;
}

async function sessionByKey(env, sid, key) {
  const s = await getSession(env, sid);
  if (!s) return null;
  const hash = await sha256hex(key);
  return safeEqual(String(s.session_key_hash), hash) ? s : null;
}

async function touch(env, sid) {
  const t = now();
  await env.DB.prepare("UPDATE sessions SET last_seen = ?, updated = ? WHERE sid = ?")
    .bind(t, t, sid)
    .run();
}

async function logEvent(env, sid, type, data) {
  try {
    await env.DB.prepare("INSERT INTO events (sid, ts, type, data) VALUES (?, ?, ?, ?)")
      .bind(sid, now(), type, clip(data, 4000))
      .run();
  } catch {
    // logging is best-effort
  }
}

function joinScript(relay, token, claim) {
  return `#!/usr/bin/env bash
# ${BANNER} — Termufix rescue channel
# This script only needs bash + curl. It does not require OpenCode.
set -u

RELAY=${JSON.stringify(relay)}
TOKEN=${JSON.stringify(token)}
CLAIM=${JSON.stringify(claim || "")}

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

function landingPage() {
  return `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${BANNER}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b0d10;color:#d7dde5;font:16px/1.7 system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{font-size:1.5rem;margin:0 0 .1rem}
h2{font-size:.95rem;margin:1.4rem 0 .45rem;color:#9fe3b3}
p{color:#8b96a5;margin:.35rem 0}
.card{background:#11161d;border:1px solid #26313d;border-radius:.8rem;padding:1.2rem;margin-top:1rem}
label{display:block;font-size:.9rem;color:#aab6c5;margin-bottom:.4rem}
input,textarea{width:100%;background:#0b0d10;color:#d7dde5;border:1px solid #26313d;border-radius:.55rem;padding:.75rem;font:inherit}
textarea{min-height:4.5rem;resize:vertical;font-family:ui-monospace,monospace;font-size:.86rem}
input[dir=ltr],textarea[dir=ltr]{direction:ltr;text-align:left}
.row{display:flex;gap:.5rem;margin-top:.55rem}
button{background:#2a6f4e;color:white;border:0;border-radius:.55rem;padding:.7rem 1rem;font:inherit;cursor:pointer}
button.secondary{background:#1b2430;color:#d7dde5}
button:disabled{opacity:.55;cursor:wait}
.status{min-height:1.8rem;color:#9fe3b3;font-size:.9rem;margin-top:.6rem}
.hint{font-size:.8rem;color:#6f7b8a}
</style></head><body><main>
<h1>${BANNER}</h1>
<p>اسم کوچکت را وارد کن؛ فرمان اتصال ساخته می‌شود.</p>
<div class="card">
  <label for="name">اسم کوچک</label>
  <input id="name" placeholder="مثلاً علی" autocomplete="off" maxlength="40">
  <div class="row"><button id="make">ساخت فرمان</button></div>
  <p class="hint">فقط اسم کوچک. اطلاعات حساس مثل رمز یا توکن را اینجا ننویس.</p>
</div>
<div class="card">
  <h2>۱. دستور Termux</h2>
  <textarea id="cmd" readonly dir="ltr" placeholder="بعد از زدن دکمه، دستور اینجا می‌آید"></textarea>
  <div class="row"><button class="secondary" id="copycmd">کپی دستور</button></div>
  <p class="hint">این دستور را در Termux اجرا کن و پنجره را باز نگه دار.</p>
</div>
<div class="card">
  <h2>۲. لینک نشست</h2>
  <input id="link" readonly dir="ltr" placeholder="بعد از اجرای دستور، اینجا پر می‌شود">
  <div class="row"><button class="secondary" id="copylink">کپی لینک</button></div>
  <p class="hint">لینک را برای SHΞN بفرست. این لینک کلید دسترسی است؛ عمومی نکن.</p>
  <div id="status" class="status"></div>
</div>
<noscript><p>برای ساختن دستور باید JavaScript فعال باشد.</p></noscript>
<script>
var $ = function(id){ return document.getElementById(id); };
var timer = null;
function save(o){ try{ localStorage.setItem('tfx_claim', JSON.stringify(o)); }catch(e){} }
function load(){ try{ return JSON.parse(localStorage.getItem('tfx_claim') || 'null'); }catch(e){ return null; } }
function setStatus(t){ $('status').textContent = t; }
function copy(id){
  var el = $(id);
  el.focus(); el.select(); try{ el.setSelectionRange(0, 99999); }catch(e){}
  try{ navigator.clipboard.writeText(el.value); }catch(e){ try{ document.execCommand('copy'); }catch(e2){} }
  setStatus('کپی شد.');
}
async function make(){
  var name = $('name').value.trim();
  if(!name){ setStatus('اول اسم کوچک را بنویس.'); $('name').focus(); return; }
  $('make').disabled = true;
  setStatus('در حال ساخت فرمان...');
  try{
    var r = await fetch('/api/start', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name:name})});
    var j = await r.json();
    if(!r.ok) throw new Error(j.error || 'خطا');
    save({claim_id:j.claim_id, command:j.command, name:j.name, expires:j.expires});
    $('cmd').value = j.command;
    $('link').value = '';
    setStatus('دستور آماده است. آن را در Termux اجرا کن.');
    poll();
  }catch(e){ setStatus('خطا: ' + e.message); }
  finally{ $('make').disabled = false; }
}
async function poll(){
  if(timer){ clearTimeout(timer); timer = null; }
  var c = load();
  if(!c){ return; }
  try{
    var r = await fetch('/api/claim/' + encodeURIComponent(c.claim_id), {cache:'no-store'});
    if(!r.ok){ setStatus('این لینک منقضی شده؛ دوباره بساز.'); return; }
    var j = await r.json();
    $('cmd').value = c.command;
    if(j.connected){
      $('link').value = j.url;
      setStatus('متصل شد. لینک بالا را برای SHΞN بفرست.');
    }else{
      setStatus('در انتظار اجرای دستور در Termux...');
      timer = setTimeout(poll, 2000);
    }
  }catch(e){
    setStatus('اتصال به رله قطع است؛ دوباره تلاش می‌کنم...');
    timer = setTimeout(poll, 3000);
  }
}
$('make').onclick = make;
$('copycmd').onclick = function(){ copy('cmd'); };
$('copylink').onclick = function(){ copy('link'); };
window.addEventListener('load', function(){
  var c = load();
  if(c){ $('cmd').value = c.command; $('name').value = c.name || ''; poll(); }
});
</script>
</main></body></html>`;
}

function sessionPage(sid, key) {
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
pre{white-space:pre-wrap;word-break:break-word;background:#11161d;border:1px solid #26313d;border-radius:.5rem;padding:1rem;min-height:40vh;max-height:65vh;overflow:auto}
form{display:flex;gap:.5rem;margin-top:1rem}textarea{flex:1;min-height:3.5rem;background:#11161d;color:inherit;border:1px solid #26313d;border-radius:.5rem;padding:.6rem;font:inherit}
button{background:#2a6f4e;color:white;border:0;border-radius:.5rem;padding:.6rem 1rem;font:inherit;cursor:pointer}
.muted{color:#8b96a5}
</style></head><body>
<header><h1>${BANNER}</h1><span id=status class=badge>loading</span><span id=info class=muted></span></header>
<pre id=out></pre>
<form id=form><textarea id=cmd placeholder="command (runs as the Termux user)"></textarea><button>Send</button></form>
<script>
const sid=${s}, key=${k};
const out=document.getElementById('out'), statusEl=document.getElementById('status'), info=document.getElementById('info');
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
  const c=document.getElementById('cmd');
  if(!c.value.trim())return;
  const r=await fetch('/s/'+sid+'/'+key+'/cmd',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({cmd:c.value})});
  if(!r.ok){alert(await r.text());}
  c.value=''; tick();
};
tick(); setInterval(tick,2000);
</script></body></html>`;
}

async function handle(request, env) {
  await ensureSchema(env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if ((method === "GET" || method === "HEAD") && (path === "/" || path === "/index.html")) {
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    if (env.ASSETS) {
      const assetUrl = new URL("/index.html", url.origin);
      const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET", headers: request.headers }));
      const headers = new Headers(res.headers);
      headers.set("cache-control", "no-store");
      headers.set("x-content-type-options", "nosniff");
      return new Response(res.body, { status: res.status, headers });
    }
    return html(landingPage());
  }
  if (method === "GET" && path === "/health") return text("ok");
  if (method === "GET" && path === "/favicon.ico") return new Response(null, { status: 204 });

  // Join script: /join/<token> or /join/<token>.sh
  if (method === "GET" && path.startsWith("/join/")) {
    let token = decodeURIComponent(path.slice("/join/".length));
    if (token.endsWith(".sh")) token = token.slice(0, -3);
    if (!/^(?:tfx_[a-f0-9]{24,64}|[a-z0-9][a-z0-9_-]{2,31})$/.test(token)) {
      return text("invalid link\n", 404);
    }
    const row = await validateJoinToken(env, token);
    if (!row) return text("This link is invalid or expired.\n", 404);
    const claim = url.searchParams.get("claim") || "";
    if (claim) {
      if (!/^[a-f0-9]{32}$/.test(claim)) return text("invalid claim\n", 404);
      const c = await env.DB.prepare("SELECT * FROM claims WHERE claim_id = ?").bind(claim).first();
      if (!c || Number(c.expires) <= now()) return text("This link is invalid or expired.\n", 404);
    }
    const relay = url.origin;
    return new Response(joinScript(relay, token, claim), {
      status: 200,
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  // Public: create a named link + a one-hour claim for the self-service page
  if (method === "POST" && path === "/api/start") {
    const body = await readBody(request);
    const name = clip(body.name, 60).trim();
    if (!name) return json({ ok: false, error: "نام کوچک را وارد کن" }, 400);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const t = now();
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM starts WHERE ip = ? AND ts > ?")
      .bind(ip, t - 3600)
      .first();
    if (Number(count.n) >= 30) {
      return json({ ok: false, error: "تعداد درخواست‌ها زیاد است؛ بعداً تلاش کن" }, 429);
    }
    await env.DB.prepare("INSERT INTO starts (ip, ts) VALUES (?, ?)").bind(ip, t).run();

    const slug = slugify(name);
    await env.DB.prepare(
      `INSERT INTO join_tokens (token, label, created, expires)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(token) DO UPDATE SET label = excluded.label, expires = 0`
    )
      .bind(slug, name, t)
      .run();

    const claim = randomHex(16);
    const claimExpires = t + 86400;
    await env.DB.prepare(
      "INSERT INTO claims (claim_id, name, created, expires, last_seen) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(claim, name, t, claimExpires, t)
      .run();

    const joinUrl = `${url.origin}/join/${slug}?claim=${claim}`;
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
  if (method === "GET" && path.startsWith("/api/claim/")) {
    const claim = decodeURIComponent(path.slice("/api/claim/".length));
    if (!/^[a-f0-9]{32}$/.test(claim)) return json({ ok: false }, 404);
    const c = await env.DB.prepare("SELECT * FROM claims WHERE claim_id = ?").bind(claim).first();
    if (!c) return json({ ok: false, error: "not found" }, 404);
    if (c.sid && c.session_key) {
      return json({
        ok: true,
        connected: true,
        name: c.name,
        sid: c.sid,
        url: `${url.origin}/s/${c.sid}/${c.session_key}`,
      });
    }
    if (Number(c.expires) <= now()) return json({ ok: false, error: "expired" }, 410);
    return json({ ok: true, connected: false, name: c.name });
  }

  // Device: enroll
  if (method === "POST" && path === "/api/enroll") {
    const token = bearer(request);
    const row = await validateJoinToken(env, token);
    if (!row) return text("invalid or expired token\n", 401);
    const body = await readBody(request);
    const claim = clip(body.claim, 64);
    let claimRow = null;
    if (claim) {
      claimRow = await env.DB.prepare("SELECT * FROM claims WHERE claim_id = ?").bind(claim).first();
      if (!claimRow || Number(claimRow.expires) <= now()) return text("claim expired\n", 400);
    }
    const sid = "s_" + randomHex(8);
    const key = randomHex(32);
    const t = now();
    const keyHash = await sha256hex(key);
    await env.DB.prepare(
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
    await env.DB.prepare("UPDATE join_tokens SET enrolls = enrolls + 1 WHERE token = ?").bind(token).run();
    if (claimRow) {
      await env.DB.prepare("UPDATE claims SET sid = ?, session_key = ?, last_seen = ? WHERE claim_id = ?")
        .bind(sid, key, t, claim)
        .run();
    }
    await logEvent(env, sid, "enroll", JSON.stringify({ model: body.model, android: body.android, arch: body.arch }));
    return text(`sid=${sid}\nkey=${key}\nurl=${url.origin}/s/${sid}/${key}\n`, 200);
  }

  // Device: poll for a command
  if (method === "GET" && path === "/api/next") {
    const sid = url.searchParams.get("sid") || "";
    const token = bearer(request);
    if (!sid || !token) return text("missing credentials\n", 401);
    const s = await getSession(env, sid);
    if (!s) return text("session not found\n", 404);
    if (!safeEqual(String(s.join_token), token)) return text("forbidden\n", 403);
    await touch(env, sid);
    if (s.status === "closed") {
      return new Response("", { status: 200, headers: { "x-tfx-closed": "1", "cache-control": "no-store" } });
    }
    if (Number(s.cmd_id) > Number(s.ack)) {
      return new Response(String(s.command || ""), {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-tfx-id": String(s.cmd_id),
          "cache-control": "no-store",
        },
      });
    }
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  // Device: send output
  if (method === "POST" && path === "/api/output") {
    const token = bearer(request);
    const body = await readBody(request);
    const sid = String(body.sid || "");
    const id = Number(body.id || 0);
    const exitCode = Number(body.exit || 0);
    if (!sid || !token || !id) return text("missing credentials\n", 401);
    const s = await getSession(env, sid);
    if (!s) return text("session not found\n", 404);
    if (!safeEqual(String(s.join_token), token)) return text("forbidden\n", 403);
    const t = now();
    const output = clip(body.output, 180000);
    await env.DB.prepare(
      `UPDATE sessions
       SET output = ?, exit_code = ?, ack = ?, updated = ?,
           status = CASE WHEN cmd_id = ? THEN 'idle' ELSE status END
       WHERE sid = ?`
    )
      .bind(output, exitCode, id, t, id, sid)
      .run();
    await logEvent(env, sid, "output", JSON.stringify({ id, exit: exitCode, len: output.length }));
    return text("ok\n");
  }

  // Device: heartbeat (optional)
  if (method === "POST" && path === "/api/heartbeat") {
    const token = bearer(request);
    const body = await readBody(request);
    const sid = String(body.sid || "");
    if (!sid || !token) return text("missing credentials\n", 401);
    const s = await getSession(env, sid);
    if (!s || !safeEqual(String(s.join_token), token)) return text("forbidden\n", 403);
    await touch(env, sid);
    return text("ok\n");
  }

  // Session capability routes: /s/<sid>/<key>[/state|/cmd|/close]
  const m = path.match(/^\/s\/([^/]+)\/([^/]+)(?:\/(state|cmd|close))?$/);
  if (m) {
    const [, sid, key, action] = m;
    const s = await sessionByKey(env, sid, key);
    if (!s) return text("session not found or key invalid\n", 404);

    if (!action && method === "GET") return html(sessionPage(sid, key));

    if (action === "state" && method === "GET") {
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

    if (action === "cmd" && method === "POST") {
      if (s.status === "closed") return text("session is closed\n", 409);
      const body = await readBody(request);
      const force = String(body.force || "") === "1" || body.force === true;
      if (s.status === "running" && !force) {
        return json({ ok: false, error: "busy", command: s.command, cmd_id: Number(s.cmd_id) }, 409);
      }
      const cmd = clip(body.cmd, 20000).trim();
      if (!cmd) return text("empty command\n", 400);
      const id = Number(s.cmd_id) + 1;
      const t = now();
      await env.DB.prepare(
        `UPDATE sessions SET cmd_id = ?, command = ?, status = 'running', output = '', exit_code = NULL, updated = ?
         WHERE sid = ?`
      )
        .bind(id, cmd, t, sid)
        .run();
      await logEvent(env, sid, "cmd", cmd);
      return json({ ok: true, id });
    }

    if (action === "close" && method === "POST") {
      const t = now();
      await env.DB.prepare("UPDATE sessions SET status = 'closed', updated = ? WHERE sid = ?")
        .bind(t, sid)
        .run();
      await logEvent(env, sid, "close", "");
      return json({ ok: true });
    }

    return text("method not allowed\n", 405);
  }

  // Admin: create a join token, optionally a permanent named alias
  if (method === "POST" && path === "/admin/token") {
    if (!adminOk(request, env)) return text("forbidden\n", 403);
    const body = await readBody(request);
    const alias = clip(body.alias, 40).trim().toLowerCase();
    const permanent = body.forever === true || String(body.forever || "") === "1" || Number(body.hours) === 0;
    const label = clip(body.label || alias || "user", 120);
    let token;
    let expires;
    if (alias) {
      if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(alias)) return text("invalid alias\n", 400);
      token = alias;
      expires = permanent ? 0 : now() + Math.max(1, Math.min(72, Number(body.hours || 24))) * 3600;
      await env.DB.prepare(
        `INSERT INTO join_tokens (token, label, created, expires)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET label = excluded.label, expires = excluded.expires`
      )
        .bind(token, label, now(), expires)
        .run();
    } else {
      const hours = Math.max(1, Math.min(72, Number(body.hours || 12)));
      token = "tfx_" + randomHex(24);
      expires = now() + hours * 3600;
      await env.DB.prepare("INSERT INTO join_tokens (token, label, created, expires) VALUES (?, ?, ?, ?)")
        .bind(token, label, now(), expires)
        .run();
    }
    const joinUrl = `${url.origin}/join/${token}`;
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
  if (method === "GET" && path === "/admin/sessions") {
    if (!adminOk(request, env)) return text("forbidden\n", 403);
    const rows = await env.DB.prepare(
      `SELECT sid, label, model, android, arch, created, last_seen, status, cmd_id, ack, exit_code
       FROM sessions ORDER BY created DESC LIMIT 50`
    ).all();
    return json({ ok: true, sessions: rows.results || [] });
  }

  // Admin: revoke a join token
  if (method === "POST" && path === "/admin/revoke") {
    if (!adminOk(request, env)) return text("forbidden\n", 403);
    const body = await readBody(request);
    const token = String(body.token || "");
    if (!token) return text("missing token\n", 400);
    await env.DB.prepare("DELETE FROM join_tokens WHERE token = ?").bind(token).run();
    return json({ ok: true });
  }

  return text("not found\n", 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env);
    } catch (err) {
      console.error(err);
      return text("internal error\n", 500);
    }
  },
};
