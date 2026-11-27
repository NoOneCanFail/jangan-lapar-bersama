#!/usr/bin/env node
// Richtet ein leeres Supabase-Projekt komplett ein. Einmalig ausführen.
//
//   SUPABASE_ACCESS_TOKEN=... node scripts/setup-supabase.mjs <project-ref> <app-adresse>
//
// Beispiel: node scripts/setup-supabase.mjs abcdefghijklmnop https://name.github.io/jangan-lapar-bersama/
//
// Was passiert:
//  1. Datenbank-Migration einspielen (Tabellen, Zugriffsregeln, Funktionen)
//  2. Login per E-Mail-Code einstellen (deutsche E-Mail mit Code statt Link)
//  3. Push-Schlüssel (VAPID) erzeugen und als Secrets speichern – der private Schlüssel wird nie ausgegeben
//  4. Edge Function "notify" hochladen
//  5. Öffentliche Werte für die App in .env.local schreiben (URL, anon key, VAPID public key)
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

await attempt("Datenbank-Migration", async () => {
  const already = await call("POST", "/database/query", { query: "select to_regclass('public.households') is not null as exists" });
  if (already?.[0]?.exists) return console.log("  Tabellen gibt es schon, Migration wird übersprungen.");
  for (const f of readdirSync(join(root, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort()) {
    await call("POST", "/database/query", { query: readFileSync(join(root, "supabase/migrations", f), "utf8") });
    console.log("  eingespielt:", f);
  }
});

await attempt("Login per E-Mail-Code", async () => {
  const mail = `<h2>Dein Code für Jangan Lapar Bersama</h2>
<p>Gib diesen Code in der App ein:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Der Code gilt eine Stunde. Wenn du das nicht warst, ignoriere diese E-Mail.</p>`;
  await call("PATCH", "/config/auth", {
    site_url: appUrl,
    uri_allow_list: appUrl,
    mailer_otp_exp: 3600,
    mailer_subjects_magic_link: "Dein Anmeldecode",
    mailer_templates_magic_link_content: mail,
    mailer_subjects_confirmation: "Dein Anmeldecode",
    mailer_templates_confirmation_content: mail,
    external_anonymous_users_enabled: false,
  });
  console.log("  E-Mail-Vorlage mit Code gesetzt, App-Adresse:", appUrl);
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
  const keys = JSON.parse(execFileSync("npx", ["-y", "web-push@3.6.7", "generate-vapid-keys", "--json"], { encoding: "utf8" }));
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
      { cwd: root, stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, SUPABASE_ACCESS_TOKEN: token } });
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

if (problems.length) {
  console.log("\nNicht alles hat geklappt:");
  for (const p of problems) console.log("  - " + p);
  console.log("\nDas Skript kann nach dem Beheben einfach noch mal laufen. Fertige Schritte werden übersprungen.");
  process.exit(1);
}
console.log("\nFertig.");
