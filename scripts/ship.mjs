#!/usr/bin/env node
/**
 * GHOSTFUN — one-command ship.
 *
 *   npm run ship
 *
 * Reads credentials from .deploy.env (gitignored) or the environment, then does
 * everything automatically and idempotently:
 *
 *   1. Create a Neon Postgres project        (or reuse DATABASE_URL)
 *   2. Push the Drizzle schema to it
 *   3. Create the GitHub repo and push       (optional)
 *   4. Store DATABASE_URL as a Worker secret
 *   5. Build the Worker bundle and deploy to Cloudflare
 *
 * Safe to re-run: every step detects work that is already done and skips it.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const ENV_FILE = ".deploy.env";
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ok = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const info = (m) => console.log(`${C.cyan}→${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const fail = (m) => console.log(`${C.red}✗${C.reset} ${m}`);
const step = (n, m) => console.log(`\n${C.bold}${C.cyan}[${n}/5]${C.reset} ${C.bold}${m}${C.reset}`);

function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (value && !process.env[match[1]]) process.env[match[1]] = value;
  }
}

function persist(key, value) {
  const line = `${key}=${value}\n`;
  if (existsSync(ENV_FILE) && readFileSync(ENV_FILE, "utf8").includes(`${key}=`)) return;
  appendFileSync(ENV_FILE, line);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: options.quiet ? "pipe" : "inherit", env: { ...process.env, ...options.env } });
}

function capture(command) {
  try { return execSync(command, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch { return ""; }
}

async function api(url, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  return { ok: response.ok, status: response.status, data, text };
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

/* ------------------------------------------------------------------ 1. DB */

async function ensureDatabase() {
  step(1, "Database Postgres");

  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("127.0.0.1") && !process.env.DATABASE_URL.includes("localhost")) {
    ok("DATABASE_URL sudah ada, memakai yang itu");
    return process.env.DATABASE_URL;
  }

  const neonKey = process.env.NEON_API_KEY;
  if (!neonKey) {
    warn("NEON_API_KEY tidak ada — lewati pembuatan database otomatis");
    console.log(`${C.dim}  Buat gratis di https://neon.tech lalu salin connection string-nya,`);
    console.log(`  atau taruh NEON_API_KEY di ${ENV_FILE} supaya dibuatkan otomatis.${C.reset}`);
    const manual = await ask("  Tempel DATABASE_URL (atau Enter untuk batal): ");
    if (!manual) throw new Error("DATABASE_URL dibutuhkan untuk lanjut.");
    persist("DATABASE_URL", manual);
    process.env.DATABASE_URL = manual;
    return manual;
  }

  info("Mencari project Neon yang sudah ada...");
  const list = await api("https://console.neon.tech/api/v2/projects", { token: neonKey });
  if (!list.ok) throw new Error(`Neon API gagal (${list.status}): ${list.text.slice(0, 200)}`);

  let project = (list.data?.projects || []).find((p) => p.name === "ghostfun");
  if (project) {
    ok(`Project Neon "ghostfun" sudah ada (${project.id})`);
  } else {
    info("Membuat project Neon baru...");
    const created = await api("https://console.neon.tech/api/v2/projects", {
      token: neonKey, method: "POST",
      body: { project: { name: "ghostfun", pg_version: 17 } },
    });
    if (!created.ok) throw new Error(`Gagal membuat project Neon (${created.status}): ${created.text.slice(0, 300)}`);
    project = created.data.project;
    const uri = created.data.connection_uris?.[0]?.connection_uri;
    if (uri) {
      ok(`Project Neon dibuat (${project.id})`);
      persist("DATABASE_URL", uri);
      process.env.DATABASE_URL = uri;
      return uri;
    }
  }

  const uris = await api(`https://console.neon.tech/api/v2/projects/${project.id}/connection_uri?database_name=neondb&role_name=neondb_owner`, { token: neonKey });
  const uri = uris.data?.uri;
  if (!uri) throw new Error("Tidak bisa mengambil connection string dari Neon.");
  ok("Connection string Neon didapat");
  persist("DATABASE_URL", uri);
  process.env.DATABASE_URL = uri;
  return uri;
}

/* -------------------------------------------------------------- 2. SCHEMA */

function pushSchema(databaseUrl) {
  step(2, "Push skema database (watchlist_items, launch_drafts)");
  try {
    run("npx", ["drizzle-kit", "push", "--config=drizzle.config.prod.ts", "--force"], { env: { DATABASE_URL: databaseUrl } });
    ok("Skema diterapkan");
  } catch {
    throw new Error("drizzle-kit push gagal. Cek DATABASE_URL-nya benar dan database bisa diakses.");
  }
}

/* -------------------------------------------------------------- 3. GITHUB */

async function pushToGithub() {
  step(3, "GitHub");
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    warn("GITHUB_TOKEN tidak ada — lewati (deploy tetap bisa jalan tanpa GitHub)");
    console.log(`${C.dim}  Buat di https://github.com/settings/tokens/new (scope: repo)${C.reset}`);
    return null;
  }

  const me = await api("https://api.github.com/user", { token, headers: { accept: "application/vnd.github+json" } });
  if (!me.ok) throw new Error(`GITHUB_TOKEN tidak valid (${me.status}).`);
  const user = me.data.login;
  const repo = process.env.GITHUB_REPO || "ghostfun";
  ok(`Login sebagai ${user}`);

  const existing = await api(`https://api.github.com/repos/${user}/${repo}`, { token, headers: { accept: "application/vnd.github+json" } });
  if (existing.ok) {
    ok(`Repo ${user}/${repo} sudah ada`);
  } else {
    info(`Membuat repo ${user}/${repo}...`);
    const created = await api("https://api.github.com/user/repos", {
      token, method: "POST", headers: { accept: "application/vnd.github+json" },
      body: { name: repo, description: "GHOSTFUN — NEAR trading terminal & token launchpad", private: false },
    });
    if (!created.ok) throw new Error(`Gagal membuat repo (${created.status}): ${created.text.slice(0, 200)}`);
    ok("Repo dibuat");
  }

  const remoteUrl = `https://${token}@github.com/${user}/${repo}.git`;
  if (capture("git remote get-url origin")) run("git", ["remote", "set-url", "origin", remoteUrl], { quiet: true });
  else run("git", ["remote", "add", "origin", remoteUrl], { quiet: true });

  info("Push ke GitHub...");
  run("git", ["push", "-u", "origin", "main", "--force"], { quiet: true });
  // Store the clean URL so the token never sits in .git/config
  run("git", ["remote", "set-url", "origin", `https://github.com/${user}/${repo}.git`], { quiet: true });
  ok(`Terkirim → https://github.com/${user}/${repo}`);
  return `${user}/${repo}`;
}

/* ---------------------------------------------------------- 4+5. CLOUDFLARE */

async function deployCloudflare(databaseUrl) {
  step(4, "Secret Cloudflare");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) {
    warn("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID tidak ada — lewati deploy");
    console.log(`${C.dim}  Token : https://dash.cloudflare.com/profile/api-tokens → template "Edit Cloudflare Workers"`);
    console.log(`  Account ID: Workers & Pages → sidebar kanan${C.reset}`);
    return null;
  }

  const verify = await api("https://api.cloudflare.com/client/v4/user/tokens/verify", { token });
  if (!verify.ok) throw new Error(`CLOUDFLARE_API_TOKEN tidak valid (${verify.status}).`);
  ok("Token Cloudflare valid");

  const env = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account };

  step(5, "Build & deploy Worker");
  info("Build bundle (butuh 1-3 menit)...");
  run("npx", ["opennextjs-cloudflare", "build"], { env });
  ok("Bundle siap");

  info("Deploy ke Cloudflare...");
  run("npx", ["wrangler", "deploy"], { env });

  // Secret must exist on the Worker, which only exists after the first deploy.
  info("Memasang secret DATABASE_URL...");
  execSync("npx wrangler secret put DATABASE_URL", { input: `${databaseUrl}\n`, stdio: ["pipe", "inherit", "inherit"], env: { ...process.env, ...env } });
  ok("Secret terpasang");

  info("Re-deploy agar secret aktif...");
  run("npx", ["wrangler", "deploy"], { env });
  return true;
}

/* ----------------------------------------------------------------- MAIN */

async function main() {
  console.log(`${C.bold}\n👻 GHOSTFUN — ship ke Cloudflare${C.reset}`);
  loadEnvFile();

  const databaseUrl = await ensureDatabase();
  pushSchema(databaseUrl);
  const repo = await pushToGithub();
  const deployed = await deployCloudflare(databaseUrl);

  console.log(`\n${C.bold}${C.green}━━━ SELESAI ━━━${C.reset}`);
  if (repo) console.log(`${C.green}✓${C.reset} GitHub    https://github.com/${repo}`);
  if (deployed) {
    console.log(`${C.green}✓${C.reset} Cloudflare — URL ada di output "Deployed ghostfun" di atas`);
    console.log(`\n${C.dim}Cek: buka URL-nya + /api/health → harus {"ok":true}`);
    console.log(`Log langsung: npx wrangler tail${C.reset}`);
  } else {
    console.log(`${C.yellow}!${C.reset} Deploy dilewati — lengkapi token di ${ENV_FILE} lalu jalankan ulang: npm run ship`);
  }
}

main().catch((error) => {
  console.log(`\n${C.red}${C.bold}GAGAL${C.reset}`);
  fail(error.message);
  console.log(`${C.dim}\nPerbaiki lalu jalankan ulang: npm run ship (aman diulang)${C.reset}`);
  process.exit(1);
});
