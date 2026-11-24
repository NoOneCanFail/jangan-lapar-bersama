// Reine Funktionen ohne Seiteneffekte. Getestet in tests/logic.test.js.
import { ING, SIDES, PICKS, SOUPS, DISHES, BY } from "./data.js";

export const PORTIONS = 5;
export const FREEZER_CAP = 5;
export const HEAT = ["mild", "leicht", "mittel", "scharf"];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Wie gut passt ein Gericht zu den gewählten Zutaten? 0 = gar nicht. Mild/Scharf sortiert nur. */
export function score(d, picked) {
  let s = 0, need = false, hit = false;
  for (const p of picked) {
    const def = PICKS.find(x => x[0] === p);
    if (!def) continue;
    if (p === "Mild") { if (d.heat <= 1) s++; continue; }
    if (p === "Scharf") { if (d.heat >= 2) s++; continue; }
    need = true;
    const h = p === "Suppe" ? SOUPS.includes(d.id) : def[1].some(k => k in d.ing);
    if (h) { s++; hit = true; }
  }
  return need && !hit ? 0 : s;
}

export function ranked(picks) {
  return DISHES.map(d => ({ d, s: score(d, picks) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || a.d.min - b.d.min);
}

/** Einkaufsmengen für eine Woche (ein Gericht, 5 Portionen), optional mit Beilage. */
export function needs(d, sideOn) {
  const t = { ...d.ing };
  const side = SIDES[d.side];
  if (side && sideOn) t[side[0]] = (t[side[0]] || 0) + side[1];
  return t;
}

/** Einkaufsliste nach Gängen gruppiert, Halal-Fleisch zuerst. */
export function shoppingGroups(d, sideOn, aisleOrder) {
  const t = needs(d, sideOn), by = {};
  for (const k of Object.keys(t)) (by[ING[k][1]] ||= []).push(k);
  return { totals: t, groups: aisleOrder.filter(a => by[a]).map(a => ({ aisle: a, items: by[a] })) };
}

const num = n => (Math.round(n * 10) / 10).toLocaleString("de-DE");

export function fmt(k, q) {
  const u = ING[k][2];
  if (u === "g" && q >= 1000) return num(q / 1000) + " kg";
  if (u === "ml" && q >= 1000) return num(q / 1000) + " l";
  if (["Stk", "Dosen", "Stangen", "Bund", "Topf"].includes(u)) {
    const c = Math.ceil(q), one = { Dosen: "Dose", Stangen: "Stange" };
    return `${c} ${c === 1 && one[u] ? one[u] : u}`;
  }
  return `${num(q)} ${u}`;
}

export function packHint(k, q) {
  if (k === "knoblauch") { const n = Math.ceil(q / 10); return `≈ ${n} Knolle${n > 1 ? "n" : ""}`; }
  if (k === "ingwer") return "1 Stück";
  const p = ING[k][5];
  return p ? `${Math.ceil(q / p[0])} ${p[1]}` : "";
}

/** Haltbarkeit im Gefrierfach: Fisch und Meeresfrüchte 1 Monat, sonst 3 Monate. */
export function expiryDate(dishId, frozenOn) {
  const d = BY[dishId];
  const x = new Date(frozenOn + "T12:00:00");
  x.setMonth(x.getMonth() + (d && (d.type === "fisch" || d.type === "meer") ? 1 : 3));
  return x;
}

export const shortDate = d => (d instanceof Date ? d : new Date(d + "T12:00:00"))
  .toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

export const weekLabel = i => i === 0 ? "Diese Woche" : i === 1 ? "Nächste Woche" : `In ${i} Wochen`;

/** Gericht eines Wunsches (bei Überraschung erst nach Auswahl). Unbekannte IDs → null. */
export const wishDish = w => BY[w.kind === "dish" ? w.dish_id : w.chosen_dish_id] || null;

export const freezerCount = items => items.reduce((a, f) => a + f.portions, 0);

/** Achtung-Hinweise für die Übergabe, wenn das Gefrierfach zu voll wird. */
export function freeSlots(items) {
  return FREEZER_CAP - freezerCount(items);
}

/** Login-Code aus der E-Mail: 6 bis 8 Ziffern. */
export const cleanOtp = s => String(s || "").replace(/\D/g, "").slice(0, 8);
export const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());
export const cleanPairCode = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
export const prettyPairCode = c => c ? `${c.slice(0, 4)}-${c.slice(4)}` : "";
