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

step("Datenbank-Migration");
const already = await call("POST", "/database/query", {
  query: "select to_regclass('public.households') is not null as exists",
});
if (already?.[0]?.exists) {
  console.log("  Tabellen gibt es schon, Migration wird übersprungen.");
} else {
  for (const f of readdirSync(join(root, "supabase/migrations")).filter(f => f.endsWith(".sql")).sort()) {
    await call("POST", "/database/query", { query: readFileSync(join(root, "supabase/migrations", f), "utf8") });
    console.log("  eingespielt:", f);
  }
}

step("Login per E-Mail-Code");
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

step("Push-Schlüssel (VAPID)");
const secrets = await call("GET", "/secrets");
let vapidPublic;
if (secrets.some(s => s.name === "VAPID_PRIVATE_KEY")) {
  console.log("  Schlüssel gibt es schon. Öffentlichen Schlüssel aus .env.local verwenden.");
  for (const f of [".env.production", ".env.local"]) {
    try { vapidPublic ||= readFileSync(join(root, f), "utf8").match(/VITE_VAPID_PUBLIC_KEY=(.*)/)?.[1]; } catch { /* fehlt */ }
  }
} else {
  const keys = JSON.parse(execFileSync("npx", ["-y", "web-push@3.6.7", "generate-vapid-keys", "--json"], { encoding: "utf8" }));
  vapidPublic = keys.publicKey;
  await call("POST", "/secrets", [
    { name: "VAPID_PUBLIC_KEY", value: keys.publicKey },
    { name: "VAPID_PRIVATE_KEY", value: keys.privateKey },
    { name: "VAPID_SUBJECT", value: appOrigin },
    { name: "ALLOWED_ORIGIN", value: appOrigin },
  ]);
  console.log("  neu erzeugt und gespeichert (privater Schlüssel nur in Supabase).");
}

step("Edge Function notify hochladen");
execFileSync("npx", ["-y", "supabase@3.1.0", "functions", "deploy", "notify", "--project-ref", ref, "--use-api"],
  { cwd: root, stdio: "inherit", env: { ...process.env, SUPABASE_ACCESS_TOKEN: token } });

step("Öffentliche Werte für die App");
const keys = await call("GET", "/api-keys");
// Ältere Projekte: "anon" key. Neuere Projekte: "publishable" key. Beide sind öffentlich.
const pub = keys.find(k => k.type === "publishable" && k.api_key) || keys.find(k => k.name === "anon");
const anon = pub?.api_key;
if (!anon) throw new Error("Kein öffentlicher Schlüssel (anon/publishable) gefunden.");
const env = `VITE_SUPABASE_URL=https://${ref}.supabase.co\nVITE_SUPABASE_ANON_KEY=${anon}\nVITE_VAPID_PUBLIC_KEY=${vapidPublic ?? ""}\n`;
const envFile = process.env.ENV_FILE || ".env.local";
writeFileSync(join(root, envFile), env);
console.log(`  ${envFile} geschrieben. Diese drei Werte sind öffentlich (keine Geheimnisse):`);
console.log(env.replace(/^/gm, "    "));
console.log("Fertig.");
