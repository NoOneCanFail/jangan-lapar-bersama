import "./style.css";
import { AISLES, CUISINES, TYPES, SIDES, DISHES, BY, ING, PICKS, SOUPS, mainIng } from "./data.js";
import {
  esc, ranked, shoppingGroups, fmt, packHint, expiryDate, shortDate, weekLabel, wishDish,
  freezerCount, freeSlots, validEmail, cleanPairCode, prettyPairCode, PORTIONS, FREEZER_CAP, HEAT,
} from "./logic.js";
import { isDemo, supabaseBackend, demoBackend, friendly } from "./backend.js";
import { registerServiceWorker, pushStatus, enablePush, isIOS, isStandalone } from "./push.js";

const api = isDemo ? demoBackend() : supabaseBackend();
const $app = document.getElementById("app");
const $bar = document.getElementById("bar");
const $sheet = document.getElementById("sheet");

/* Bildschirmzustand (nicht gespeichert, außer ein paar Komfort-Einstellungen) */
const ui = {
  screen: "loading", email: "", authMode: "login", error: "", busy: false,
  tab: "start", cookTab: "einkauf", filter: "Alle", picked: [], sheet: null, editFreezer: false,
  member: null, data: null, push: null,
};
try { Object.assign(ui, JSON.parse(localStorage.getItem("jlb-ui") || "{}"), { screen: "loading", busy: false, sheet: null }); } catch { /* egal */ }
const remember = () => { try { localStorage.setItem("jlb-ui", JSON.stringify({ tab: ui.tab, cookTab: ui.cookTab, filter: ui.filter, email: ui.email })); } catch { /* egal */ } };

/* ------------------------------------------------------------------ Ablauf */

let unsubscribe = () => {};
async function boot() {
  registerServiceWorker();
  const session = await api.session().catch(() => null);
  if (!session) { ui.screen = "email"; return render(); }
  await afterLogin();
}

async function afterLogin() {
  try {
    ui.member = await api.membership();
  } catch (e) { ui.screen = "email"; ui.error = friendly(e); return render(); }
  if (!ui.member.me) { ui.screen = "pair"; return render(); }
  unsubscribe(); unsubscribe = api.subscribe(() => refresh());
  if (!ui.member.partner) { ui.screen = "waiting"; return render(); }
  ui.screen = "app";
  await refresh();
}

async function refresh() {
  if (ui.screen === "waiting") {
    ui.member = await api.membership().catch(() => ui.member);
    if (ui.member?.partner) { ui.screen = "app"; } else return render();
  }
  if (ui.screen !== "app" && ui.screen !== "settings") return;
  try { ui.data = await api.load(); } catch (e) { toast(friendly(e)); }
  render();
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && ui.member?.me) refresh(); });
api.onAuth(session => { if (!session && !["email", "loading"].includes(ui.screen)) { ui.screen = "email"; render(); } });

/** Führt eine Aktion aus, zeigt Fehler verständlich an und lädt danach neu. */
async function act(fn, { ok, notify } = {}) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const r = await fn();
    if (ok) toast(typeof ok === "function" ? ok(r) : ok);
    if (notify) api.notify(typeof notify === "function" ? notify(r) : notify);
  } catch (e) {
    toast(friendly(e));
  } finally {
    ui.busy = false;
    await refresh();
  }
}

/* ------------------------------------------------------------------ Hilfen */

let toastT;
function toast(t) {
  const el = document.getElementById("toast");
  el.textContent = t; el.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 2600);
}
const heat = h => `<span class="heat ${h ? "" : "zero"}">${HEAT[h]}${h ? " " + "●".repeat(h) : ""}</span>`;
const dishName = id => BY[id]?.name || "Unbekanntes Gericht";
const role = () => ui.data?.role || ui.member?.me?.role;
const queue = () => ui.data?.queue || [];
const week = () => ui.data?.week || { status: "gewuenscht", side_on: true, checked: {} };
const freezer = () => ui.data?.freezer || [];
const qIndex = id => queue().findIndex(w => w.kind === "dish" && w.dish_id === id);
const locked = () => week().status !== "gewuenscht";

/* ------------------------------------------------------------------ Render */

function render() {
  $bar.innerHTML = ""; $sheet.innerHTML = "";
  const s = ui.screen;
  $app.innerHTML = s === "loading" ? `<div class="screen"><p class="muted">Lädt …</p></div>`
    : s === "email" ? emailScreen() : s === "pair" ? pairScreen()
    : s === "join" ? joinScreen() : s === "waiting" ? waitingScreen() : s === "settings" ? settingsScreen() : appScreen();
  if (s === "app") {
    $bar.innerHTML = role() === "koch" ? cookBar() : "";
    if (ui.sheet && BY[ui.sheet]) $sheet.innerHTML = sheetHTML(BY[ui.sheet]);
  }
  bind();
}

const brand = sub => `<div class="brand"><h1>Jangan Lapar Bersama</h1>${sub ? `<small>${sub}</small>` : ""}</div>`;

/* ---------- Login ---------- */
function emailScreen() {
  const signup = ui.authMode === "signup";
  return `<form class="screen" id="f-login" novalidate>
    ${brand()}
    <h1>${signup ? "Konto anlegen" : "Anmelden"}</h1>
    <p class="lead">${signup ? "Einmalig: E-Mail-Adresse und ein Passwort mit mindestens 8 Zeichen. Es wird keine E-Mail verschickt." : "Mit deiner E-Mail-Adresse und deinem Passwort."}</p>
    <div class="field"><label for="email">E-Mail-Adresse</label>
      <input id="email" type="email" inputmode="email" autocomplete="${signup ? "email" : "username"}" required value="${esc(ui.email)}"></div>
    <div class="field"><label for="password">Passwort</label>
      <input id="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" minlength="8" required></div>
    ${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ""}
    <button class="cta" type="submit" ${ui.busy ? "disabled" : ""}><span>${signup ? "Konto anlegen" : "Anmelden"}</span></button>
    <p class="muted">${signup ? `Schon ein Konto? <button type="button" class="link" id="mode-login">Anmelden</button>`
      : `Neu hier? <button type="button" class="link" id="mode-signup">Konto anlegen</button>`}</p>
    ${signup ? "" : `<p class="muted">Passwort vergessen? Melde dich bei der Person, die die App eingerichtet hat.</p>`}
  </form>`;
}

/* ---------- Koppeln ---------- */
function pairScreen() {
  return `<div class="screen">
    ${brand()}
    <h1>Wer bist du?</h1>
    <p class="lead">Die App verbindet genau zwei Handys: eins wünscht sich das Essen, eins kocht.</p>
    <div class="choice">
      <button data-create="esser"><b>Ich wünsche mir das Essen</b><span>Du suchst Gerichte aus und bekommst die Boxen.</span></button>
      <button data-create="koch"><b>Ich koche</b><span>Du bekommst Einkaufsliste, Rezept und Push-Nachrichten.</span></button>
    </div>
    <button class="ghost full" id="to-join">Ich habe schon einen Code von der anderen Person</button>
    ${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ""}
    <p class="muted">Angemeldet als ${esc(ui.member?.email || "")}. <button class="link" id="logout">Abmelden</button></p>
  </div>`;
}
function joinScreen() {
  return `<form class="screen" id="f-join" novalidate>
    ${brand()}
    <h1>Code eingeben</h1>
    <p class="lead">Die andere Person sieht den Code in ihrer App. Er hat 8 Zeichen.</p>
    <div class="field"><label for="pair">Kopplungscode</label>
      <input id="pair" class="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" required></div>
    ${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ""}
    <button class="cta" type="submit" ${ui.busy ? "disabled" : ""}><span>Verbinden</span></button>
    <button type="button" class="link" id="back-pair">Zurück</button>
  </form>`;
}
function waitingScreen() {
  const m = ui.member;
  return `<div class="screen">
    ${brand()}
    <h1>Fast geschafft</h1>
    <p class="lead">Schick diesen Code an die andere Person. Sie meldet sich in ihrer App an und tippt „Ich habe schon einen Code“.</p>
    ${m.pairExpired ? `<p class="err">Der Code ist abgelaufen.</p><button class="cta" id="renew"><span>Neuen Code erzeugen</span></button>`
      : `<div class="bigcode" id="bigcode">${esc(prettyPairCode(m.pairCode))}</div>
         <button class="ghost full" id="copy-code">Code kopieren</button>
         <p class="muted">Gültig 24 Stunden. Du bist eingetragen als: <b>${m.me.role === "koch" ? "kocht" : "wünscht sich das Essen"}</b>.</p>`}
    <p class="muted">Diese Seite wechselt automatisch, sobald ihr verbunden seid. <button class="link" id="check-now">Jetzt prüfen</button></p>
  </div>`;
}

/* ---------- Einstellungen ---------- */
function settingsScreen() {
  const p = ui.push;
  const pushText = {
    demo: "Im Demo-Modus gibt es keine echten Push-Nachrichten.",
    "ios-homescreen": "Auf dem iPhone kommen Push-Nachrichten nur an, wenn die App auf dem Home-Bildschirm liegt: in Safari unten auf Teilen tippen, dann „Zum Home-Bildschirm“. Danach die App von dort öffnen und hier einschalten.",
    unsupported: "Dieses Gerät oder dieser Browser unterstützt keine Push-Nachrichten. Auf dem iPhone braucht es iOS 16.4 oder neuer.",
    denied: "Benachrichtigungen sind für diese App blockiert. Du kannst sie in den Handy-Einstellungen wieder erlauben.",
    on: "Push-Nachrichten sind an.",
    off: "Push-Nachrichten sind aus.",
  }[p] || "Wird geprüft …";
  return `<div class="screen">
    ${brand()}
    <h1>Einstellungen</h1>
    <div class="settings">
      <div class="card"><h3>Benachrichtigungen</h3><p class="muted">${esc(pushText)}</p>
        ${p === "off" ? `<button class="cta" id="push-on"><span>Push-Nachrichten einschalten</span></button>` : ""}</div>
      ${!isStandalone() ? `<div class="card"><h3>Als App installieren</h3><p class="muted">${isIOS()
        ? "Safari: unten auf Teilen tippen, dann „Zum Home-Bildschirm“."
        : "Chrome: Menü (⋮) oben rechts, dann „App installieren“ oder „Zum Startbildschirm hinzufügen“."}</p></div>` : ""}
      <div class="card"><h3>Konto</h3><p class="muted">${esc(ui.member?.email || "")} · ${role() === "koch" ? "kocht" : "wünscht sich das Essen"}</p>
        ${api.demo ? "" : `<button class="ghost full" id="logout">Abmelden</button>`}</div>
      <div class="card"><h3>Datenschutz</h3><p class="muted">Gespeichert werden nur eure E-Mail-Adressen, Wünsche, der Wochenstatus und das Gefrierfach, auf Servern in Frankfurt. Niemand außer euch beiden kann sie sehen.</p></div>
    </div>
    <button class="ghost full" id="back-app">Zurück</button>
  </div>`;
}

/* ---------- App ---------- */
function appScreen() {
  const r = role();
  const inbox = api.demo ? (ui.data?.inbox || []) : [];
  return `
  <header class="top">
    <div class="brand"><h1>Jangan Lapar Bersama</h1><button class="iconbtn" id="settings" aria-label="Einstellungen">Einstellungen</button></div>
    ${api.demo ? `<div class="roles" role="group" aria-label="Rolle">
        <button data-role="esser" aria-pressed="${r === "esser"}">Ich wünsche mir</button>
        <button data-role="koch" aria-pressed="${r === "koch"}">Ich koche</button></div>
        <div class="demo-note">Demo-Modus: beide Rollen auf einem Gerät, nichts wird gesendet.</div>`
      : `<div class="rolechip">${r === "koch" ? "Du kochst" : "Du wünschst dir das Essen"}</div>`}
  </header>
  ${inbox.map((m, i) => `<div class="push" role="status"><span class="ico">JLB</span><span class="t"><small>${esc(m.at)}</small>${esc(m.t)}</span><button data-read="${i}">OK</button></div>`).join("")}
  ${r === "koch" ? cook() : eater()}
  ${api.demo ? `<div class="footer"><span>Beispieldaten</span><span><button class="link" id="reset-ex">Beispiel laden</button> · <button class="link" id="reset-empty">Alles leeren</button></span></div>` : ""}`;
}

/* ---------- Essende Person ---------- */
function eater() {
  return `<div class="tabs" role="group" aria-label="Bereich">
    <button data-tab="start" aria-pressed="${ui.tab === "start"}">Übersicht</button>
    <button data-tab="gerichte" aria-pressed="${ui.tab === "gerichte"}">Gerichte</button>
    <button data-tab="zutaten" aria-pressed="${ui.tab === "zutaten"}">Zutaten</button></div>
  ${ui.tab === "start" ? overview() : ui.tab === "gerichte" ? dishGrid() : ingredientPick()}`;
}

function freezerBlock() {
  const items = freezer(), c = freezerCount(items);
  const boxes = Array.from({ length: Math.max(FREEZER_CAP, c) }, (_, i) => `<i class="${i < c ? (i < FREEZER_CAP ? "full" : "over") : ""}"></i>`).join("");
  return `<div class="h2"><h2>Mein Gefrierfach</h2><small>${c} von ${FREEZER_CAP} Boxen</small></div>
  <div class="freezer"><div class="boxes" aria-hidden="true">${boxes}</div>
  ${items.length ? items.map(f => {
    const d = BY[f.dish_id];
    return `<div class="frow" style="--sauce:${d?.sauce || "var(--surface-2)"}"><span class="bowl"></span>
      <span class="txt"><b>${esc(dishName(f.dish_id))}</b><small>eingefroren ${shortDate(f.frozen_on)} · essen bis ${shortDate(expiryDate(f.dish_id, f.frozen_on))}</small></span>
      ${ui.editFreezer
        ? `<span class="edit-row"><button class="mini" data-adj="${f.id}" data-n="${f.portions - 1}" aria-label="Eine weniger">−</button><span class="n">${f.portions}</span><button class="mini" data-adj="${f.id}" data-n="${f.portions + 1}" aria-label="Eine mehr">+</button></span>`
        : `<span class="n">${f.portions}×</span><button class="take" data-take="${f.id}">1 genommen</button>`}</div>`;
  }).join("") : `<div class="frow"><span class="txt"><small>Leer. Die nächsten Boxen kommen mit der Übergabe.</small></span></div>`}
  </div>
  ${items.length ? `<button class="link" id="edit-freezer">${ui.editFreezer ? "Fertig" : "Stimmt nicht? Bestand korrigieren"}</button>` : ""}`;
}

function overview() {
  const st = { gewuenscht: "Wartet auf Einkauf", eingekauft: "Wird gekocht", gekocht: "Fertig, wird übergeben" }[week().status];
  const q = queue();
  return `${freezerBlock()}
  <div class="h2"><h2>Meine Wünsche</h2><small>1 Gericht pro Woche</small></div>
  ${q.length ? `<div class="list">${q.map((w, i) => {
    const d = wishDish(w), lk = i === 0 && locked();
    return `<div class="row" style="--sauce:${d ? d.sauce : "var(--kunyit)"}">
      <span class="wk ${i === 0 ? "now" : ""}">${weekLabel(i)}</span>
      <span class="bowl ${w.kind === "surprise" && !d ? "stripe" : ""}"></span>
      <span class="txt"><b>${d ? esc(d.name) : "Überraschung"}</b><span class="s">${w.kind === "surprise" ? `Etwas mit ${esc((w.picks || []).join(" + "))}${d ? "" : " · Koch wählt"}` : esc(d?.de || "")}${i === 0 ? ` · ${st}` : ""}</span></span>
      ${lk ? `<span class="lock">fest</span>` : `<button class="x" data-del="${w.id}" aria-label="Wunsch entfernen">×</button>`}</div>`;
  }).join("")}</div>`
  : `<div class="empty"><b>Noch kein Wunsch</b>Such dir ein Gericht für diese Woche aus.</div>`}
  <div style="margin-top:10px"><button class="add" data-tab="gerichte">+ Gericht wünschen</button></div>`;
}

function dishCard(d) {
  const i = qIndex(d.id);
  return `<button class="dish" data-info="${d.id}" aria-pressed="${i >= 0}" style="--sauce:${d.sauce}">
    <span class="tick" aria-hidden="true">${i >= 0 ? (i === 0 ? "Diese W." : `W+${i}`) : ""}</span>
    <span class="bowl"></span><h3>${esc(d.name)}</h3><span class="de">${esc(d.de)}</span>
    <span class="meta"><span>${d.min} Min</span>${heat(d.heat)}</span>
    <span class="meta"><span class="type ${d.type}">${TYPES[d.type]}</span></span></button>`;
}
function dishGrid() {
  const f = ["Alle", "Vegetarisch", "Fisch & Meer", "Halal-Fleisch", "Mild", "Suppen"];
  const ok = d => ui.filter === "Alle" || (ui.filter === "Vegetarisch" && d.type === "veg")
    || (ui.filter === "Fisch & Meer" && (d.type === "fisch" || d.type === "meer"))
    || (ui.filter === "Halal-Fleisch" && d.type === "halal") || (ui.filter === "Mild" && d.heat <= 1)
    || (ui.filter === "Suppen" && SOUPS.includes(d.id));
  const n = DISHES.filter(ok).length;
  return `<p class="hint">Tippe ein Gericht an, um zu sehen, was es ist, und es dir zu wünschen. ${n} Gerichte.</p>
  <div class="filters">${f.map(t => `<button data-filter="${t}" aria-pressed="${ui.filter === t}">${t}</button>`).join("")}</div>
  ${Object.entries(CUISINES).map(([k, label]) => {
    const l = DISHES.filter(d => d.cu === k && ok(d));
    return l.length ? `<div class="cuisine"><span>${label}</span><span>${l.length}</span></div><div class="grid">${l.map(dishCard).join("")}</div>` : "";
  }).join("")}`;
}

function ingredientPick() {
  const r = ranked(ui.picked);
  return `<p class="hint">Worauf hast du Lust? Tippe 1–3 Sachen an.</p>
  <div class="chips">${PICKS.map(([p]) => `<button class="chip" data-pick="${esc(p)}" aria-pressed="${ui.picked.includes(p)}">${esc(p)}</button>`).join("")}</div>
  ${ui.picked.length ? `<div class="sectionlabel">Passende Gerichte (${r.length})</div>
    ${r.length ? `<div class="list">${r.slice(0, 8).map(({ d, s }) => {
      const i = qIndex(d.id);
      return `<button class="row" data-info="${d.id}" aria-pressed="${i >= 0}" style="--sauce:${d.sauce}">
        <span class="bowl"></span><span class="txt"><b>${esc(d.name)}</b><span class="s">${esc(d.de)} · ${s === ui.picked.length ? "passt genau" : `passt zu ${s} von ${ui.picked.length}`}</span></span>
        <span class="type ${d.type}">${i >= 0 ? "gewünscht" : "+"}</span></button>`;
    }).join("")}</div>` : `<div class="empty"><b>Keine Treffer</b>Nimm eine Zutat weg.</div>`}
    <button class="surprise" id="surprise">Koch soll entscheiden: „Etwas mit ${esc(ui.picked.join(" + "))}“</button>`
  : `<div class="empty"><b>Noch nichts gewählt</b>Wähle oben, dann siehst du passende Gerichte.</div>`}`;
}

function sheetHTML(d) {
  const i = qIndex(d.id), lk = i === 0 && locked(), pos = i >= 0 ? i : queue().length;
  const sideTxt = d.side ? `mit ${SIDES[d.side][2]}` : (d.id === "laksa" ? "mit Reisnudeln" : "ohne Beilage");
  return `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t" style="--sauce:${d.sauce}">
    <div class="head"><span class="bowl"></span><div><h2 id="sh-t">${esc(d.name)}</h2><p class="sub">${esc(d.de)} · ${CUISINES[d.cu]}</p></div></div>
    <p class="what">${esc(d.info)}</p>
    <div class="facts"><div><b>${HEAT[d.heat]}</b>Schärfe</div><div><b>${TYPES[d.type]}</b>Art</div><div><b>${PORTIONS} Boxen</b>${sideTxt}</div></div>
    <div><div class="lbl">Hauptzutaten</div><div class="ing">${mainIng(d).map(n => `<span>${esc(n)}</span>`).join("")}</div></div>
    <div class="freeze"><b>Aus dem Gefrierfach:</b> ${esc(d.freeze)}</div>
    ${role() === "esser" ? `<div class="actions">
      ${lk ? `<button class="cta" disabled><span>Schon eingekauft für diese Woche</span></button>`
        : i >= 0 ? `<button class="ghost full" id="sh-wish">Wunsch entfernen (${weekLabel(i)})</button>`
        : `<button class="cta" id="sh-wish"><span>Wünschen</span><span class="pill">${weekLabel(pos)}</span></button>`}
      <button class="link" id="sh-close">Schließen</button></div>` : `<button class="link" id="sh-close">Schließen</button>`}
  </div></div>`;
}

/* ---------- Kochende Person ---------- */
function cook() {
  const q = queue(), w = q[0];
  if (!w) return `<div class="empty" style="margin-top:6px"><b>Noch kein Wunsch für diese Woche</b>Im Gefrierfach sind ${freezerCount(freezer())} Boxen.<button class="ghost" id="nudge">Erinnerung senden</button></div>`;
  const d = wishDish(w);
  const steps = ["gewuenscht", "eingekauft", "gekocht"], L = { gewuenscht: "Gewünscht", eingekauft: "Eingekauft", gekocht: "Gekocht" };
  const si = steps.indexOf(week().status);
  const next = q.slice(1).map((x, i) => `${weekLabel(i + 1)}: ${esc(wishDish(x)?.name || "Überraschung")}`).join(" · ");
  if (!d) {
    const opts = ranked(w.picks || []).slice(0, 3);
    return `<div class="note"><b>Überraschungs-Wunsch für diese Woche</b><span>Etwas mit ${esc((w.picks || []).join(" + "))}. Such eins aus:</span>
      <div class="opts">${opts.map(({ d }) => `<button data-choose="${w.id}" data-dish="${d.id}">${esc(d.name)}</button>`).join("")}</div>
</div>
      ${next ? `<p class="hint">Danach: ${next}</p>` : ""}`;
  }
  const side = SIDES[d.side];
  const halalItems = Object.keys(d.ing).filter(k => ING[k][1] === "halal");
  return `<section class="week" style="--sauce:${d.sauce}">
    <div class="head"><span class="bowl"></span><div><div class="eyebrow">Diese Woche</div><h2>${esc(d.name)}</h2>
      <p style="color:var(--fg);margin-block:2px 4px">${esc(d.info)}</p>
      <p>${PORTIONS} Portionen · ${d.min} Min · ${HEAT[d.heat]} · ${TYPES[d.type]}</p></div></div>
    <div class="status">${steps.map((s, i) => `<span class="step ${i <= si ? "on" : ""}">${L[s]}</span>`).join("")}<span class="step">Übergeben</span></div>
    ${side ? `<label class="switch"><span>${side[2]} mitkochen<small>${week().side_on ? `${side[1]} g, kommt mit in die Boxen` : "Macht die andere Person selbst dazu"}</small></span><input type="checkbox" id="side" ${week().side_on ? "checked" : ""}></label>` : ""}
  </section>
  ${halalItems.length ? `<div class="note"><b>Halal-Fleisch extra besorgen</b><span>${halalItems.map(k => `${fmt(k, d.ing[k])} ${esc(ING[k][0].replace(" (halal)", ""))}`).join(", ")}. Gibt es nicht bei EDEKA.</span></div>` : ""}
  ${next ? `<p class="hint">Danach gewünscht: ${next}</p>` : ""}
  <div class="tabs" role="group" aria-label="Ansicht">
    <button data-ctab="einkauf" aria-pressed="${ui.cookTab === "einkauf"}">Einkaufsliste</button>
    <button data-ctab="kochen" aria-pressed="${ui.cookTab === "kochen"}">Rezept</button></div>
  ${ui.cookTab === "einkauf" ? shopping(d) : recipe(d)}`;
}

function shopping(d) {
  const { totals: t, groups } = shoppingGroups(d, week().side_on, Object.keys(AISLES));
  const checked = week().checked || {};
  const row = k => {
    const [name, , , av, note] = ING[k], c = !!checked[k], h = packHint(k, t[k]);
    const showNote = av === "check" || (note && ["mozzarella", "bruehe", "h_schenkel", "basilikum"].includes(k));
    return `<label class="item ${c ? "done" : ""}"><input type="checkbox" id="c-${k}" data-check="${k}" ${c ? "checked" : ""}>
      <span class="n"><div>${esc(name)}${av === "check" ? '<span class="badge">vor Ort prüfen</span>' : ""}</div>${showNote ? `<small>${esc(note)}</small>` : ""}</span>
      <span class="q">${fmt(k, t[k])}${h ? `<small>${h}</small>` : ""}</span></label>`;
  };
  const left = Object.keys(t).filter(k => ING[k][1] !== "vorrat" && !checked[k]).length;
  return `<p class="hint">${left ? `Noch ${left} Sachen offen.` : "Alles im Korb."} Sortiert nach Gängen. Das EDEKA-Sortiment ist eine Annahme.</p>
  ${groups.filter(g => g.aisle !== "vorrat").map(g => g.aisle === "halal"
    ? `<section class="aisle halal"><h3>${AISLES.halal}</h3><p class="sub">Nicht bei EDEKA. Vorher besorgen.</p>${g.items.map(row).join("")}</section>`
    : `<section class="aisle"><h3>${AISLES[g.aisle]}</h3>${g.items.map(row).join("")}</section>`).join("")}
  ${groups.find(g => g.aisle === "vorrat") ? `<details class="pantry"><summary>Gewürze & Vorrat <small>· meist zu Hause</small></summary>${groups.find(g => g.aisle === "vorrat").items.map(row).join("")}</details>` : ""}`;
}

function recipe(d) {
  const side = SIDES[d.side], on = side && week().side_on;
  return `<div class="card"><h3>Zutaten für ${PORTIONS} Portionen</h3>
    <div class="ing">${Object.keys(d.ing).map(k => `<span>${fmt(k, d.ing[k])} ${esc(ING[k][0].replace(" (halal)", ""))}</span>`).join("")}</div>
    <ol>${d.steps.map(s => `<li>${esc(s)}</li>`).join("")}${on ? `<li>${side[2]} (${side[1]} g) nach Packung kochen, ausbreiten und schnell abkühlen lassen.</li>` : ""}
    <li>In ${PORTIONS} Boxen verteilen${on ? ` (${side[2]} dazu)` : ""}, Name und Datum drauf.</li></ol>
    <div class="freeze"><b>Einfrieren:</b> ${esc(d.freeze)}</div></div>
  <div class="card"><h3>Vorkoch-Regeln</h3><ul>
    <li>Innerhalb von 2 Stunden abkühlen lassen, dann sofort einfrieren.</li>
    <li>Fleisch und Gemüse halten 3 Monate, Fisch und Garnelen 1 Monat.</li>
    <li>Für die Übergabe gefroren transportieren, am besten in einer Kühltasche.</li>
    <li>Auftauen im Kühlschrank oder in der Mikrowelle, dann dampfend heiß erhitzen. Nicht erneut einfrieren.</li></ul></div>`;
}

function cookBar() {
  const w = queue()[0];
  if (!w || !wishDish(w)) return "";
  const st = week().status;
  if (st === "gewuenscht") return `<button class="cta" id="bought" ${ui.busy ? "disabled" : ""}><span>Einkauf erledigt</span><span class="pill">sperrt den Wunsch</span></button>`;
  if (st === "eingekauft") return `<button class="cta" id="cooked" ${ui.busy ? "disabled" : ""}><span>Gekocht & eingefroren</span><span class="pill">${PORTIONS} Boxen</span></button>`;
  const free = freeSlots(freezer());
  return `<button class="cta" id="handover" ${ui.busy ? "disabled" : ""}><span>Übergeben</span><span class="pill">${free >= PORTIONS ? `Platz für ${free}` : `nur ${Math.max(free, 0)} Plätze frei`}</span></button>`;
}

/* ------------------------------------------------------------------ Events */

function on(sel, fn, ev = "click") { document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn)); }

function toggleWish(id) {
  const i = qIndex(id), d = BY[id];
  if (i === 0 && locked()) return toast("Für diese Woche ist schon eingekauft.");
  if (i >= 0) return act(() => api.removeWish(queue()[i].id), { ok: `${d.name} entfernt`, notify: `Wunsch entfernt: ${d.name}` });
  const pos = queue().length;
  act(() => api.addWish(id), { ok: `Gewünscht: ${weekLabel(pos)}`, notify: `Neuer Wunsch (${weekLabel(pos)}): ${d.name}` });
}

function bind() {
  // Login
  on("#f-login", async e => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    ui.email = email; remember();
    if (!validEmail(email)) { ui.error = "Bitte eine gültige E-Mail-Adresse eingeben."; return render(); }
    if (password.length < 8) { ui.error = "Das Passwort muss mindestens 8 Zeichen haben."; return render(); }
    ui.busy = true; ui.error = ""; render();
    try {
      if (ui.authMode === "signup") await api.signUp(email, password); else await api.signIn(email, password);
      ui.busy = false; await afterLogin();
    } catch (err) { ui.busy = false; ui.error = friendly(err); render(); }
  }, "submit");
  on("#mode-signup", () => { ui.authMode = "signup"; ui.error = ""; render(); });
  on("#mode-login", () => { ui.authMode = "login"; ui.error = ""; render(); });
  on("#logout", async () => { unsubscribe(); await api.signOut(); ui.member = null; ui.data = null; ui.screen = "email"; render(); });

  // Koppeln
  on("[data-create]", async e => {
    ui.busy = true; ui.error = "";
    try { await api.createHousehold(e.currentTarget.dataset.create); await afterLogin(); }
    catch (err) { ui.error = friendly(err); render(); }
    ui.busy = false;
  });
  on("#to-join", () => { ui.screen = "join"; ui.error = ""; render(); document.getElementById("pair")?.focus(); });
  on("#back-pair", () => { ui.screen = "pair"; ui.error = ""; render(); });
  on("#f-join", async e => {
    e.preventDefault();
    const code = cleanPairCode(document.getElementById("pair").value);
    if (code.length !== 8) { ui.error = "Der Code hat 8 Zeichen."; return render(); }
    ui.busy = true; ui.error = ""; render();
    try {
      const r = await api.join(code);
      ui.busy = false; await afterLogin();
      api.notify(r === "koch" ? "Ihr seid verbunden. Die andere Person kocht." : "Ihr seid verbunden. Die andere Person wünscht sich das Essen.");
    } catch (err) { ui.busy = false; ui.error = friendly(err); render(); }
  }, "submit");
  on("#renew", () => act(async () => { await api.renewCode(); ui.member = await api.membership(); }));
  on("#check-now", () => refresh());
  on("#copy-code", async () => {
    const code = prettyPairCode(ui.member.pairCode);
    try { await navigator.clipboard.writeText(code); toast("Code kopiert"); }
    catch { const r = document.createRange(); r.selectNodeContents(document.getElementById("bigcode")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Code markiert. Jetzt kopieren."); }
  });

  // Einstellungen
  on("#settings", async () => { ui.screen = "settings"; ui.push = null; render(); ui.push = await pushStatus(api).catch(() => "unsupported"); render(); });
  on("#back-app", () => { ui.screen = "app"; render(); });
  on("#push-on", async () => {
    try { await enablePush(api); ui.push = "on"; toast("Push-Nachrichten sind an."); }
    catch (e) { toast(e.message?.length < 140 ? e.message : friendly(e)); ui.push = await pushStatus(api).catch(() => "unsupported"); }
    render();
  });

  // App allgemein
  on("[data-role]", e => { api.setRole(e.currentTarget.dataset.role); refresh(); });
  on("[data-read]", e => { api.readInbox(+e.currentTarget.dataset.read); refresh(); });
  on("#reset-ex", () => { api.reset(false); refresh(); });
  on("#reset-empty", () => { api.reset(true); refresh(); });
  on("[data-tab]", e => { ui.tab = e.currentTarget.dataset.tab; remember(); render(); scrollTo(0, 0); });
  on("[data-ctab]", e => { ui.cookTab = e.currentTarget.dataset.ctab; remember(); render(); });
  on("[data-filter]", e => { ui.filter = e.currentTarget.dataset.filter; remember(); render(); });

  // Detailansicht
  on("[data-info]", e => { ui.sheet = e.currentTarget.dataset.info; render(); document.getElementById("sh-wish")?.focus(); });
  on("#sh-wish", () => { const id = ui.sheet; ui.sheet = null; toggleWish(id); });
  on("#sh-close", () => { ui.sheet = null; render(); });
  on("#scrim", e => { if (e.target.id === "scrim") { ui.sheet = null; render(); } });

  // Essende Person
  on("[data-pick]", e => {
    const p = e.currentTarget.dataset.pick;
    let a = ui.picked.filter(x => x !== p);
    if (a.length === ui.picked.length) {
      a.push(p);
      if (p === "Mild") a = a.filter(x => x !== "Scharf");
      if (p === "Scharf") a = a.filter(x => x !== "Mild");
    }
    ui.picked = a; render();
  });
  on("#surprise", () => {
    const picks = [...ui.picked], pos = queue().length;
    ui.picked = []; ui.tab = "start";
    act(() => api.addSurprise(picks), { ok: `Gewünscht: ${weekLabel(pos)}`, notify: `Überraschungs-Wunsch (${weekLabel(pos)}): etwas mit ${picks.join(" + ")}` });
  });
  on("[data-del]", e => {
    const w = queue().find(x => x.id === e.currentTarget.dataset.del), name = wishDish(w)?.name || "Überraschung";
    act(() => api.removeWish(w.id), { ok: `${name} entfernt`, notify: `Wunsch entfernt: ${name}` });
  });
  on("[data-take]", e => act(() => api.takePortion(e.currentTarget.dataset.take), {
    ok: () => `Guten Appetit! Noch ${freezerCount(freezer()) - 1} Boxen.`,
    notify: () => freezerCount(freezer()) - 1 <= 1 && queue().length === 0 ? "Gefrierfach fast leer und noch kein Wunsch offen." : null,
  }));
  on("#edit-freezer", () => { ui.editFreezer = !ui.editFreezer; render(); });
  on("[data-adj]", e => act(() => api.adjustPortion(e.currentTarget.dataset.adj, +e.currentTarget.dataset.n)));

  // Kochende Person
  on("[data-choose]", e => {
    const id = e.currentTarget.dataset.choose, dish = e.currentTarget.dataset.dish;
    act(() => api.chooseSurprise(id, dish), { notify: `Überraschung gewählt: ${dishName(dish)}` });
  });
  on("#side", e => act(() => api.setWeek({ side_on: e.target.checked })), "change");
  on("[data-check]", e => act(() => api.setWeek({ checked: { ...(week().checked || {}), [e.target.dataset.check]: e.target.checked } })), "change");
  on("#bought", () => act(() => api.setWeek({ status: "eingekauft" }), { notify: `Eingekauft für ${wishDish(queue()[0]).name}.` }).then(() => { ui.cookTab = "kochen"; render(); }));
  on("#cooked", () => act(() => api.setWeek({ status: "gekocht" }), { notify: `${wishDish(queue()[0]).name} ist gekocht und eingefroren.` }));
  on("#handover", () => {
    const d = wishDish(queue()[0]), last = queue().length <= 1;
    act(() => api.handover(), {
      ok: "Übergeben. Gefrierfach aktualisiert.",
      notify: `${PORTIONS} Boxen ${d.name} sind da. Ab ins Gefrierfach!${last ? " Was möchtest du nächste Woche?" : ""}`,
    });
  });
  on("#nudge", () => act(async () => {}, { ok: "Erinnerung gesendet", notify: "Was möchtest du diese Woche essen?" }));
}

document.addEventListener("keydown", e => { if (e.key === "Escape" && ui.sheet) { ui.sheet = null; render(); } });

// notify(null) überspringen
const rawNotify = api.notify.bind(api);
api.notify = t => (t ? rawNotify(t) : undefined);

boot();
