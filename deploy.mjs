#!/usr/bin/env node
/**
 * Termufix direct-upload deployer.
 *
 * Why not wrangler? Wrangler depends on workerd, which has no Android/arm64
 * build. This script uses the Cloudflare REST API directly so the project can
 * be deployed from Termux.
 *
 * Reads CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID from
 * ~/.config/termufix/env (or the process environment).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const API = "https://api.cloudflare.com/client/v4";
const PROJECT = "termufix";
const DB_NAME = "termufix";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const STATE_FILE = path.join(HERE, ".deploy-state.json");
const ENV_FILE = path.join(os.homedir(), ".config", "termufix", "env");

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = parseEnvFile(ENV_FILE);
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || fileEnv.CLOUDFLARE_API_TOKEN || "";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || fileEnv.CLOUDFLARE_ACCOUNT_ID || "";
if (!TOKEN || !ACCOUNT) {
  console.error("missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID");
  process.exit(2);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function saveAdminToken(token) {
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = current
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*(?:export\s+)?TERMUFIX_ADMIN_TOKEN=/.test(l));
  lines.push(`export TERMUFIX_ADMIN_TOKEN='${token}'`);
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
}

async function cf(pathname, { method = "GET", body, headers = {}, raw = false } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const txt = await res.text();
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    data = { success: false, errors: [{ code: res.status, message: txt.slice(0, 500) }] };
  }
  if (!res.ok || data.success === false) {
    const err = new Error(`${method} ${pathname} -> HTTP ${res.status}: ${JSON.stringify(data.errors || data).slice(0, 1500)}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return raw ? data : data.result;
}

async function ensureProject() {
  try {
    const project = await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}`);
    console.log(`project: exists (${project.name})`);
    return project;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const project = await cf(`/accounts/${ACCOUNT}/pages/projects`, {
    method: "POST",
    body: { name: PROJECT, production_branch: "main" },
  });
  console.log(`project: created (${project.name})`);
  return project;
}

async function ensureDatabase(state) {
  const list = await cf(`/accounts/${ACCOUNT}/d1/database`);
  let db = list.find((d) => d.name === DB_NAME);
  if (!db) {
    db = await cf(`/accounts/${ACCOUNT}/d1/database`, {
      method: "POST",
      body: { name: DB_NAME, primary_location_hint: "weur" },
    });
    console.log(`d1: created ${db.uuid}`);
  } else {
    console.log(`d1: exists ${db.uuid}`);
  }
  state.d1 = db.uuid;
  saveState(state);
  return db.uuid;
}

async function applySchema(uuid) {
  const sql = fs.readFileSync(path.join(HERE, "src", "schema.sql"), "utf8");
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await cf(`/accounts/${ACCOUNT}/d1/database/${uuid}/query`, {
      method: "POST",
      body: { sql: stmt },
    });
  }
  console.log(`d1: schema applied (${statements.length} statements)`);
}

async function configureProject(uuid, adminToken) {
  const binding = { d1_databases: { DB: { id: uuid } } };
  const envVars = { ADMIN_TOKEN: { type: "secret_text", value: adminToken } };
  const body = {
    deployment_configs: {
      production: {
        compatibility_date: "2026-11-20",
        ...binding,
        env_vars: envVars,
      },
      preview: {
        compatibility_date: "2026-11-20",
        ...binding,
        env_vars: envVars,
      },
    },
  };
  await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}`, { method: "PATCH", body });
  console.log("project: D1 binding + ADMIN_TOKEN configured");
}

function hash(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function uploadAssets(files) {
  const jwt = (await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/upload-token`)).jwt;
  const entries = files.map((f) => {
    const buf = fs.readFileSync(f.path);
    return {
      path: "/" + f.name,
      file: f,
      buf,
      hash: hash(buf),
      size: buf.length,
      contentType: contentType(f.name),
    };
  });
  const hashes = [...new Set(entries.map((e) => e.hash))];
  const missing = await cf(`/pages/assets/check-missing`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: { hashes },
  });
  const missingSet = new Set(missing);
  const toUpload = entries.filter((e) => missingSet.has(e.hash));
  if (toUpload.length) {
    const payload = toUpload.map((e) => ({
      key: e.hash,
      value: e.buf.toString("base64"),
      metadata: { contentType: e.contentType },
      base64: true,
    }));
    await cf(`/pages/assets/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      body: payload,
    });
  }
  await cf(`/pages/assets/upsert-hashes`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: { hashes },
  });
  console.log(`assets: uploaded ${toUpload.length}/${entries.length} (${hashes.length} unique)`);
  return Object.fromEntries(entries.map((e) => [e.path, e.hash]));
}

async function deploy(manifest) {
  const form = new FormData();
  const worker = fs.readFileSync(path.join(HERE, "src", "_worker.js"));
  form.append("_worker.js", new Blob([worker], { type: "text/javascript" }), "_worker.js");
  form.append(
    "_routes.json",
    new Blob([JSON.stringify({ version: 1, include: ["/*"], exclude: [] })], {
      type: "application/json",
    }),
    "_routes.json"
  );
  form.append("manifest", JSON.stringify(manifest));
  form.append("branch", "main");
  form.append("commit_message", "Termufix deploy from Termux");
  const dep = await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments`, {
    method: "POST",
    body: form,
  });
  console.log(`deployment: ${dep.id} (${dep.url})`);
  for (let i = 0; i < 60; i++) {
    const d = await cf(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments/${dep.id}`);
    const stage = d.latest_stage || {};
    if (stage.status === "success") return d;
    if (stage.status === "failure") throw new Error(`deployment failed: ${JSON.stringify(stage)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return dep;
}

async function main() {
  console.log(`account: ${ACCOUNT}`);
  const state = loadState();
  await ensureProject();
  const uuid = await ensureDatabase(state);
  await applySchema(uuid);

  const adminToken = fileEnv.TERMUFIX_ADMIN_TOKEN || crypto.randomBytes(24).toString("hex");
  if (!fileEnv.TERMUFIX_ADMIN_TOKEN) saveAdminToken(adminToken);
  await configureProject(uuid, adminToken);

  const manifest = await uploadAssets([
    { name: "index.html", path: path.join(HERE, "src", "index.html") },
  ]);
  const dep = await deploy(manifest);
  console.log(`live: https://${PROJECT}.pages.dev`);
  console.log(`deployment status: ${dep.latest_stage?.status || "unknown"}`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
