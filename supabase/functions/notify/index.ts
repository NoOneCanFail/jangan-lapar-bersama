// Edge Function "notify": schickt eine Push-Nachricht an die ANDERE Person im eigenen Haushalt.
// - Nur angemeldete Personen: die Funktion prüft das Login-Token selbst über Supabase Auth.
// - Empfänger wird serverseitig ermittelt; man kann niemandem außerhalb des Haushalts schreiben.
// - Text wird gekürzt und als reiner Text behandelt.
// Benötigte Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (z. B. https://deine-app-adresse)
// Optional: ALLOWED_ORIGIN (Adresse der App, für CORS). SUPABASE_URL und den Server-Schlüssel
// stellt Supabase automatisch bereit.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const origin = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const cors = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  Vary: "Origin",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "https://example.invalid",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

// Server-Schlüssel: klassischer service_role key oder neuer secret key (beides stellt Supabase bereit).
function serviceKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { return Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0] as string; } catch { return ""; }
}

// Einfache Bremse pro Instanz gegen versehentliche Push-Fluten.
const recent = new Map<string, number[]>();
function tooMany(userId: string) {
  const now = Date.now();
  const list = (recent.get(userId) ?? []).filter(t => now - t < 60_000);
  list.push(now);
  recent.set(userId, list);
  return list.length > 10;
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method" });

  // Anmeldung selbst prüfen (funktioniert mit alten und neuen Supabase-Schlüsseln).
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { error: "auth" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json(401, { error: "auth" });
  if (tooMany(user.id)) return json(429, { error: "rate" });

  let text = "";
  try { text = String((await req.json())?.text ?? ""); } catch { /* leer */ }
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
  if (!text) return json(400, { error: "text" });

  // Ab hier mit Service-Rolle, aber nur für den Haushalt der anfragenden Person.
  const { data: me } = await admin.from("members").select("household_id").eq("user_id", user.id).maybeSingle();
  if (!me) return json(403, { error: "member" });
  const { data: others } = await admin.from("members").select("user_id").eq("household_id", me.household_id).neq("user_id", user.id);
  const ids = (others ?? []).map(o => o.user_id);
  if (!ids.length) return json(200, { sent: 0 });

  const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", ids);
  const payload = JSON.stringify({ title: "Jangan Lapar Bersama", body: text });
  let sent = 0;
  await Promise.all((subs ?? []).map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id); // Abo abgelaufen
    }
  }));
  return json(200, { sent });
});
