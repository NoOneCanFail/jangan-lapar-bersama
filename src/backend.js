// Zwei austauschbare Datenquellen mit derselben Schnittstelle:
//  - supabaseBackend(): echte Daten, Login per E-Mail-Code, Live-Updates
//  - demoBackend(): alles lokal im Browser, beide Rollen umschaltbar (zum Ausprobieren)
import { createClient } from "@supabase/supabase-js";
import { PORTIONS } from "./logic.js";

export const config = {
  url: import.meta.env.VITE_SUPABASE_URL,
  key: import.meta.env.VITE_SUPABASE_ANON_KEY,
  vapid: import.meta.env.VITE_VAPID_PUBLIC_KEY,
};
export const isDemo = !!import.meta.env.VITE_EMBED || !config.url || !config.key || new URLSearchParams(location.search).has("demo");

/** Fehlermeldungen für Menschen. Eigene Meldungen der Datenbank (auf Deutsch) werden durchgereicht. */
export function friendly(err) {
  const m = err?.message || String(err || "");
  if (/fetch|network|Failed to/i.test(m)) return "Keine Verbindung. Bitte Internet prüfen und noch mal versuchen.";
  if (/rate limit|too many/i.test(m)) return "Zu viele Versuche. Bitte ein paar Minuten warten.";
  if (/invalid login credentials/i.test(m)) return "E-Mail oder Passwort stimmt nicht.";
  if (/already registered|already exists/i.test(m)) return "Für diese E-Mail gibt es schon ein Konto. Melde dich an.";
  if (/signups? not allowed|signup.*disabled/i.test(m)) return "Neue Konten sind geschlossen. Melde dich mit deinem bestehenden Konto an.";
  if (/password/i.test(m) && /(least|short|weak|characters)/i.test(m)) return "Das Passwort muss mindestens 8 Zeichen haben.";
  if (/[äöüÄÖÜß]|^(Du |Code|Nicht|Kein|Erst|Höchstens|Für |Zu viele|Ihr )/.test(m)) return m;
  return "Das hat nicht geklappt. Bitte noch mal versuchen.";
}

/* ------------------------------------------------------------------ Supabase */

export function supabaseBackend() {
  const sb = createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  let me = null; // { user_id, role, household_id }

  const must = ({ data, error }) => { if (error) throw error; return data; };

  return {
    demo: false,
    async session() { return must(await sb.auth.getSession()).session; },
    onAuth(cb) { return sb.auth.onAuthStateChange((_e, s) => cb(s)).data.subscription; },
    // Login mit E-Mail und Passwort. Es werden keine E-Mails verschickt (Bestätigung ist abgeschaltet),
    // weil der kostenlose Supabase-Mailversand nur an Team-Mitglieder zustellt.
    async signIn(email, password) {
      must(await sb.auth.signInWithPassword({ email: email.trim().toLowerCase(), password }));
    },
    async signUp(email, password) {
      const data = must(await sb.auth.signUp({ email: email.trim().toLowerCase(), password }));
      if (!data.session) throw new Error("Konto angelegt, aber noch nicht freigeschaltet. Bitte die Person fragen, die die App eingerichtet hat.");
    },
    async signOut() { me = null; await sb.auth.signOut(); },

    /** Mitgliedschaft und Kopplungsstand. */
    async membership() {
      const { user } = must(await sb.auth.getUser());
      const members = must(await sb.from("members").select("user_id, role, household_id"));
      me = members.find(m => m.user_id === user.id) || null;
      let pairCode = null, pairExpired = false;
      if (me && members.length < 2) {
        const h = must(await sb.from("households").select("pair_code, pair_code_expires_at").single());
        pairCode = h.pair_code;
        pairExpired = !h.pair_code_expires_at || new Date(h.pair_code_expires_at) < new Date();
      }
      return { email: user.email, me, partner: members.length >= 2, pairCode, pairExpired };
    },
    async createHousehold(role) { return must(await sb.rpc("create_household", { p_role: role })); },
    async renewCode() { return must(await sb.rpc("renew_pair_code")); },
    async join(code) {
      const r = must(await sb.rpc("join_household", { p_code: code }));
      if (r === "ungueltig") throw new Error("Code ungültig oder abgelaufen.");
      return r;
    },

    async load() {
      const [queue, week, freezer] = await Promise.all([
        sb.from("wishes").select("id, kind, dish_id, picks, chosen_dish_id, created_at").order("created_at").order("id"),
        sb.from("week_state").select("status, side_on, checked").single(),
        sb.from("freezer_items").select("id, dish_id, portions, frozen_on").order("created_at", { ascending: false }),
      ].map(p => p.then(must)));
      return { role: me.role, queue, week, freezer, inbox: [] };
    },

    addWish: async dishId => must(await sb.from("wishes").insert({ household_id: me.household_id, kind: "dish", dish_id: dishId })),
    addSurprise: async picks => must(await sb.from("wishes").insert({ household_id: me.household_id, kind: "surprise", picks })),
    removeWish: async id => must(await sb.from("wishes").delete().eq("id", id)),
    chooseSurprise: async (id, dishId) => must(await sb.from("wishes").update({ chosen_dish_id: dishId }).eq("id", id)),
    setWeek: async patch => must(await sb.from("week_state").update({ ...patch, updated_at: new Date().toISOString() }).eq("household_id", me.household_id)),
    handover: async () => must(await sb.rpc("handover", { p_portions: PORTIONS })),
    takePortion: async itemId => must(await sb.rpc("take_portion", { p_item: itemId })),
    adjustPortion: async (itemId, portions) => portions <= 0
      ? must(await sb.from("freezer_items").delete().eq("id", itemId))
      : must(await sb.from("freezer_items").update({ portions }).eq("id", itemId)),

    /** Push an die andere Person. Fehler hier sollen die App nie blockieren. */
    async notify(text) {
      try { await sb.functions.invoke("notify", { body: { text } }); } catch { /* egal */ }
    },
    async savePush({ endpoint, p256dh, auth }) {
      await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
      must(await sb.from("push_subscriptions").insert({ endpoint, p256dh, auth }));
    },
    async removePush(endpoint) {
      await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
    },
    async hasPush(endpoint) {
      const r = must(await sb.from("push_subscriptions").select("id").eq("endpoint", endpoint));
      return r.length > 0;
    },

    /** Live-Updates: bei jeder Änderung im Haushalt neu laden. */
    subscribe(onChange) {
      if (!me) return () => {};
      const f = `household_id=eq.${me.household_id}`;
      const ch = sb.channel("hh-" + me.household_id);
      for (const table of ["wishes", "week_state", "freezer_items", "members"])
        ch.on("postgres_changes", { event: "*", schema: "public", table, filter: f }, onChange);
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },
  };
}

/* ------------------------------------------------------------------ Demo */

const DEMO_KEY = "jlb-demo-v1";
const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10);

function demoExample() {
  return {
    role: "esser",
    queue: [
      { id: uid(), kind: "dish", dish_id: "kari-ikan" },
      { id: uid(), kind: "dish", dish_id: "palak" },
      { id: uid(), kind: "surprise", picks: ["Hähnchen", "Kokos"], chosen_dish_id: null },
    ],
    week: { status: "gewuenscht", side_on: true, checked: {} },
    freezer: [
      { id: uid(), dish_id: "rendang", portions: 1, frozen_on: "2026-11-17" },
      { id: uid(), dish_id: "dhal", portions: 1, frozen_on: "2026-11-10" },
    ],
    inbox: { koch: [{ t: "Neuer Wunsch für diese Woche: Kari Ikan", at: "Mo, 18:04" }], esser: [] },
  };
}

export function demoBackend() {
  let s;
  try { s = JSON.parse(localStorage.getItem(DEMO_KEY)) || demoExample(); } catch { s = demoExample(); }
  const listeners = new Set();
  const commit = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); } catch { /* privat */ } listeners.forEach(f => f()); };
  const other = () => (s.role === "esser" ? "koch" : "esser");
  const head = () => s.queue[0];
  const fail = m => { throw new Error(m); };

  return {
    demo: true,
    async session() { return { user: { email: "demo" } }; },
    onAuth() { return { unsubscribe() {} }; },
    async membership() { return { email: "Demo", me: { role: s.role }, partner: true }; },
    async load() { return { role: s.role, queue: s.queue, week: s.week, freezer: s.freezer, inbox: s.inbox[s.role] }; },
    setRole(r) { s.role = r; commit(); },
    readInbox(i) { s.inbox[s.role].splice(i, 1); commit(); },
    reset(empty) { s = demoExample(); if (empty) { s.queue = []; s.freezer = []; s.inbox = { koch: [], esser: [] }; } commit(); },

    async addWish(dishId) { if (s.queue.length >= 12) fail("Höchstens 12 Wünsche gleichzeitig."); s.queue.push({ id: uid(), kind: "dish", dish_id: dishId }); commit(); },
    async addSurprise(picks) { s.queue.push({ id: uid(), kind: "surprise", picks, chosen_dish_id: null }); commit(); },
    async removeWish(id) {
      if (head()?.id === id && s.week.status !== "gewuenscht") fail("Für diese Woche ist schon eingekauft.");
      s.queue = s.queue.filter(w => w.id !== id); commit();
    },
    async chooseSurprise(id, dishId) { const w = s.queue.find(x => x.id === id); if (w) w.chosen_dish_id = dishId; commit(); },
    async setWeek(patch) { Object.assign(s.week, patch); commit(); },
    async handover() {
      const w = head() || fail("Kein Wunsch für diese Woche.");
      const dish = (w.kind === "dish" ? w.dish_id : w.chosen_dish_id) || fail("Erst ein Gericht für die Überraschung auswählen.");
      s.freezer.unshift({ id: uid(), dish_id: dish, portions: PORTIONS, frozen_on: today() });
      s.queue.shift(); s.week = { status: "gewuenscht", side_on: true, checked: {} }; commit(); return dish;
    },
    async takePortion(itemId) {
      const f = s.freezer.find(x => x.id === itemId) || fail("Nicht gefunden.");
      f.portions--; if (f.portions <= 0) s.freezer = s.freezer.filter(x => x !== f); commit(); return f.portions;
    },
    async adjustPortion(itemId, portions) {
      const f = s.freezer.find(x => x.id === itemId); if (!f) return;
      if (portions <= 0) s.freezer = s.freezer.filter(x => x !== f); else f.portions = Math.min(portions, 50); commit();
    },
    async notify(text) {
      const d = new Date();
      const at = d.toLocaleDateString("de-DE", { weekday: "short" }) + ", " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      s.inbox[other()].unshift({ t: text, at }); s.inbox[other()] = s.inbox[other()].slice(0, 4); commit();
    },
    async savePush() {}, async hasPush() { return false; },
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}
