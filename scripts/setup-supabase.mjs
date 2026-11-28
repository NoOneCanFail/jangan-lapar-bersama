#!/usr/bin/env node
// Richtet ein leeres Supabase-Projekt komplett ein. Einmalig ausführen.
//
//   SUPABASE_ACCESS_TOKEN=... node scripts/setup-supabase.mjs <project-ref> <app-adresse>
//
// Beispiel: node scripts/setup-supabase.mjs abcdefghijklmnop https://name.github.io/jangan-lapar-bersama/
//
// Was passiert:
//  1. Datenbank-Migration einspielen (Tabellen, Zugriffsregeln, Funktionen)
//  2. Login per E-Mail + Passwort einstellen (ohne Bestätigungs-E-Mail)
//  3. Push-Schlüssel (VAPID) erzeugen und als Secrets speichern – der private Schlüssel wird nie ausgegeben
//  4. Edge Function "notify" hochladen
//  5. Öffentliche Werte für die App in .env.local schreiben (URL, anon key, VAPID public key)
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [ref, appUrlRaw] = process.argv.slice(2);
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!ref || !/^[a-z0-9]{20}$/.test(ref) || !appUrlRaw || !token) {
  console.error("Aufruf: SUPABASE_ACCESS_TOKEN=... node scripts/setup-supabase.mjs <project-ref> <app-adresse>");
  process.exit(1);
}
const appUrl = new URL(appUrlRaw).toString();
const appOrigin = new URL(appUrl).origin;
const API = `https://api.supabase.com/v1/projects/${ref}`;

async function call(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const step = m => console.log("\n• " + m);

/** VAPID-Schlüsselpaar (P-256) direkt mit Node erzeugen, ohne fremdes npm-Paket im Job mit dem Token. */
function vapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" }), priv = privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  return { publicKey: raw.toString("base64url"), privateKey: priv.d };
}

// Nur Registrierung schließen oder wieder öffnen, sonst nichts.
if (process.env.SIGNUPS === "schliessen" || process.env.SIGNUPS === "oeffnen") {
  const close = process.env.SIGNUPS === "schliessen";
  step(close ? "Registrierung schließen" : "Registrierung öffnen");
  await call("PATCH", "/config/auth", { disable_signup: close });
  console.log(close ? "  Neue Konten sind jetzt nicht mehr möglich." : "  Neue Konten sind wieder möglich.");
  process.exit(0);
}
const problems = [];
// Jeder Schritt läuft für sich. Fehlt eine Berechtigung, geht es trotzdem weiter,
// und am Ende steht eine vollständige Liste, was fehlt.
async function attempt(name, fn) {
  step(name);
  try { return await fn(); } catch (e) {
    const msg = String(e.message || e);
    const perm = msg.match(/missing_permissions":\[([^\]]*)\]/)?.[1]?.replace(/"/g, "");
    problems.push(`${name}: ${perm ? "fehlende Berechtigung " + perm : msg.slice(0, 300)}`);
    console.log("  FEHLER:", perm ? `fehlende Berechtigung ${perm}` : msg.slice(0, 300));
    return undefined;
  }
}

await attempt("Datenbank-Migrationen", async () => {
  // Buchführung, welche Migrationen schon eingespielt sind (eigenes Schema, nicht über die API erreichbar).
  await call("POST", "/database/query", {
    query: "create schema if not exists private; create table if not exists private.applied_migrations (name text primary key, applied_at timestamptz not null default now()); revoke all on schema private from public;",
  });
  const files = readdirSync(join(root, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort();
  let done = new Set((await call("POST", "/database/query", { query: "select name from private.applied_migrations" })).map(r => r.name));
  // Projekte, die vor dieser Buchführung eingerichtet wurden: erste Migration gilt als eingespielt.
  if (!done.size) {
    const exists = await call("POST", "/database/query", { query: "select to_regclass('public.households') is not null as exists" });
    if (exists?.[0]?.exists) {
      await call("POST", "/database/query", { query: `insert into private.applied_migrations (name) values ('${files[0]}') on conflict do nothing` });
      done = new Set([files[0]]);
    }
  }
  for (const f of files) {
    if (done.has(f)) { console.log("  schon da:", f); continue; }
    if (!/^[0-9]{14}_[a-z0-9_]+\.sql$/.test(f)) throw new Error("Ungültiger Dateiname: " + f);
    await call("POST", "/database/query", { query: readFileSync(join(root, "supabase/migrations", f), "utf8") });
    await call("POST", "/database/query", { query: `insert into private.applied_migrations (name) values ('${f}')` });
    console.log("  eingespielt:", f);
  }
});

await attempt("Login einstellen", async () => {
  // E-Mail + Passwort ohne Bestätigungs-E-Mail: Der kostenlose Supabase-Mailversand stellt nur an
  // Team-Mitglieder zu. Schutz kommt stattdessen über Kopplungscode + später geschlossene Registrierung.
  await call("PATCH", "/config/auth", {
    site_url: appUrl,
    uri_allow_list: appUrl,
    mailer_autoconfirm: true,
    password_min_length: 8,
    external_anonymous_users_enabled: false,
  });
  console.log("  E-Mail + Passwort aktiv (ohne Bestätigungs-E-Mail), App-Adresse:", appUrl);
});

// Öffentlicher Push-Schlüssel aus einem früheren Lauf (falls vorhanden)
let vapidPublic;
for (const f of [".env.production", ".env.local"]) {
  try { vapidPublic ||= readFileSync(join(root, f), "utf8").match(/VITE_VAPID_PUBLIC_KEY=(.+)/)?.[1]; } catch { /* fehlt */ }
}

await attempt("Push-Schlüssel (VAPID)", async () => {
  const secrets = await call("GET", "/secrets");
  if (vapidPublic && secrets.some(s => s.name === "VAPID_PRIVATE_KEY")) return console.log("  Schlüssel gibt es schon.");
  // Neu erzeugen (auch wenn nur der öffentliche Teil verloren ging). POST überschreibt vorhandene Secrets.
  const keys = vapidKeys();
  await call("POST", "/secrets", [
    { name: "VAPID_PUBLIC_KEY", value: keys.publicKey },
    { name: "VAPID_PRIVATE_KEY", value: keys.privateKey },
    { name: "VAPID_SUBJECT", value: appOrigin },
    { name: "ALLOWED_ORIGIN", value: appOrigin },
  ]);
  vapidPublic = keys.publicKey;
  console.log("  neu erzeugt und gespeichert (privater Schlüssel nur in Supabase).");
});

await attempt("Edge Function notify hochladen", async () => {
  try {
    execFileSync("npx", ["-y", "supabase@3.1.0", "functions", "deploy", "notify", "--project-ref", ref, "--use-api", "--yes"],
      // Nur die nötigsten Umgebungsvariablen weitergeben.
      { cwd: root, stdio: ["ignore", "inherit", "pipe"], env: { PATH: process.env.PATH, HOME: process.env.HOME, SUPABASE_ACCESS_TOKEN: token } });
  } catch (e) {
    throw new Error(String(e.stderr || e.message).replace(token, "***").slice(-400));
  }
  console.log("  hochgeladen.");
});

await attempt("Öffentliche Werte für die App", async () => {
  const keys = await call("GET", "/api-keys");
  // Ältere Projekte: "anon" key. Neuere Projekte: "publishable" key. Beide sind öffentlich.
  const pub = keys.find(k => k.type === "publishable" && k.api_key) || keys.find(k => k.name === "anon");
  if (!pub?.api_key) throw new Error("Kein öffentlicher Schlüssel (anon/publishable) gefunden.");
  if (!vapidPublic) throw new Error("Öffentlicher Push-Schlüssel fehlt (Schritt Push-Schlüssel ist gescheitert).");
  const env = `VITE_SUPABASE_URL=https://${ref}.supabase.co\nVITE_SUPABASE_ANON_KEY=${pub.api_key}\nVITE_VAPID_PUBLIC_KEY=${vapidPublic}\n`;
  const envFile = process.env.ENV_FILE || ".env.local";
  writeFileSync(join(root, envFile), env);
  console.log(`  ${envFile} geschrieben. Diese drei Werte sind öffentlich (keine Geheimnisse):`);
  console.log(env.replace(/^/gm, "    "));
});

// Supabase Security Advisor: nur zur Info, braucht die Berechtigung "Advisors: Read".
await (async () => {
  step("Security Advisor (Info)");
  try {
    const r = await call("GET", "/advisors/security");
    const lints = (r?.lints ?? []).filter(l => l.level !== "INFO");
    if (!lints.length) return console.log("  Keine Warnungen.");
    for (const l of lints) console.log(`  ${l.level}: ${l.title} – ${String(l.detail ?? "").slice(0, 160)}`);
  } catch (e) {
    console.log("  Übersprungen (Token ohne Berechtigung \"Advisors: Read\"). Im Dashboard unter Advisors → Security Advisor ansehen.");
  }
})();

if (problems.length) {
  console.log("\nNicht alles hat geklappt:");
  for (const p of problems) console.log("  - " + p);
  console.log("\nDas Skript kann nach dem Beheben einfach noch mal laufen. Fertige Schritte werden übersprungen.");
  process.exit(1);
}
console.log("\nFertig.");
