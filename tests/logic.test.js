import { describe, it, expect } from "vitest";
import { ING, DISHES, BY, SIDES, INFO, AISLES } from "../src/data.js";
import { score, ranked, needs, shoppingGroups, fmt, packHint, expiryDate, wishDish, cleanOtp, cleanPairCode, validEmail, esc } from "../src/logic.js";

describe("Gerichte-Daten", () => {
  it("hat mindestens 60 Gerichte mit eindeutigen IDs", () => {
    expect(DISHES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(DISHES.map(d => d.id)).size).toBe(DISHES.length);
  });
  it("IDs passen zur Datenbank-Regel ^[a-z0-9-]{1,40}$", () => {
    for (const d of DISHES) expect(d.id).toMatch(/^[a-z0-9-]{1,40}$/);
  });
  it("jede Zutat existiert im Sortiment", () => {
    for (const d of DISHES) for (const k of Object.keys(d.ing)) expect(ING[k], `${d.id}: ${k}`).toBeDefined();
    for (const s of Object.values(SIDES)) expect(ING[s[0]]).toBeDefined();
  });
  it("jedes Gericht dauert höchstens 60 Minuten und hat Erklärung, Schritte, Einfrier-Tipp", () => {
    for (const d of DISHES) {
      expect(d.min).toBeLessThanOrEqual(60);
      expect(INFO[d.id], d.id).toBeTruthy();
      expect(d.steps.length).toBeGreaterThanOrEqual(3);
      expect(d.freeze.length).toBeGreaterThan(5);
    }
  });
  it("Fleisch nur als Halal-Zutat und nur in Gerichten vom Typ halal", () => {
    for (const d of DISHES) {
      const hasHalalMeat = Object.keys(d.ing).some(k => ING[k][1] === "halal");
      expect(hasHalalMeat, d.id).toBe(d.type === "halal");
    }
  });
  it("keine verbotenen Zutaten (Schwein, Alkohol, Gelatine, Hühnerbrühe, Parmesan)", () => {
    const bad = /schwein|speck|schinken|wein|bier|rum\b|mirin|gelatine|hühnerbrühe|parmesan/i;
    for (const [k, v] of Object.entries(ING)) expect(bad.test(v[0]), `${k}: ${v[0]}`).toBe(false);
  });
  it("jeder Gang ist bekannt", () => {
    for (const v of Object.values(ING)) expect(AISLES[v[1]]).toBeDefined();
  });
});

describe("Zutaten-Auswahl", () => {
  it("findet Rendang bei Hähnchen + Kokos ganz oben", () => {
    const r = ranked(["Hähnchen", "Kokos"]);
    expect(r[0].s).toBe(2);
    expect(r.map(x => x.d.id)).toContain("rendang");
  });
  it("schlägt keine Garnelen vor, wenn Rind gewünscht ist", () => {
    expect(score(BY["sambal-udang"], ["Rind & Hack", "Scharf"])).toBe(0);
    expect(score(BY["chili-con"], ["Rind & Hack", "Scharf"])).toBe(2);
  });
  it("nur Schärfe gewählt: alles passende zählt", () => {
    expect(score(BY["kurma"], ["Mild"])).toBe(1);
    expect(score(BY["sambal-udang"], ["Mild"])).toBe(0);
  });
});

describe("Einkauf", () => {
  it("rechnet Reis nur mit ein, wenn er mitgekocht wird", () => {
    expect(needs(BY["kari-ikan"], true).reis).toBe(400);
    expect(needs(BY["kari-ikan"], false).reis).toBeUndefined();
  });
  it("Halal-Fleisch steht vorne in der Liste", () => {
    const { groups } = shoppingGroups(BY["rendang"], true, Object.keys(AISLES));
    expect(groups[0].aisle).toBe("halal");
  });
  it("formatiert Mengen verständlich", () => {
    expect(fmt("kartoffel", 1200)).toBe("1,2 kg");
    expect(fmt("kokosmilch", 1)).toBe("1 Dose");
    expect(fmt("kokosmilch", 2)).toBe("2 Dosen");
    expect(packHint("sahne", 300)).toBe("2 Becher");
    expect(packHint("knoblauch", 12)).toBe("≈ 2 Knollen");
  });
});

describe("Gefrierfach und Wünsche", () => {
  it("Fisch hält 1 Monat, Fleisch 3 Monate", () => {
    expect(expiryDate("kari-ikan", "2026-11-24").getMonth()).toBe(11);
    expect(expiryDate("rendang", "2026-11-24").getMonth()).toBe(1);
  });
  it("Überraschung hat erst nach Auswahl ein Gericht, unbekannte IDs werden ignoriert", () => {
    expect(wishDish({ kind: "surprise", picks: ["Kokos"], chosen_dish_id: null })).toBeNull();
    expect(wishDish({ kind: "surprise", chosen_dish_id: "dhal" }).id).toBe("dhal");
    expect(wishDish({ kind: "dish", dish_id: "gibt-es-nicht" })).toBeNull();
  });
});

describe("Eingaben", () => {
  it("bereinigt Codes", () => {
    expect(cleanOtp(" 123 456 ")).toBe("123456");
    expect(cleanPairCode("abcd-ef23")).toBe("ABCDEF23");
    expect(validEmail("a@b.de")).toBe(true);
    expect(validEmail("kein-at.de")).toBe(false);
  });
  it("escaped HTML", () => {
    expect(esc('<img src=x onerror="1">')).toBe("&lt;img src=x onerror=&quot;1&quot;&gt;");
  });
});
