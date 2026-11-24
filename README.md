# Jangan Lapar Bersama

*„Nicht hungern, zusammen“* – eine kleine App fürs Vorkochen zu zweit.

- **Eine Person wünscht sich** jede Woche ein Gericht (aus 65 halal/vegetarischen/Fisch-Gerichten oder über Zutaten).
- **Die andere Person kocht**: Sie bekommt eine Push-Nachricht, eine Einkaufsliste nach EDEKA-Gängen und das Rezept für 5 Portionen.
- Nach der Übergabe landen die 5 Boxen automatisch im **Gefrierfach-Bestand**. Die essende Person tippt nur „1 genommen“.

Läuft als Web-App auf Android und iPhone (zum Home-Bildschirm hinzufügen), ohne App Store.

## Ausprobieren ohne Server

```bash
npm install
npm run dev
```

Dann `http://localhost:5173/?demo` öffnen. Im Demo-Modus liegen alle Daten nur im Browser, und man kann zwischen beiden Rollen umschalten.

## Einrichtung (einmalig)

### 1. Supabase-Projekt anlegen (Datenbank + Login)

1. Auf [supabase.com](https://supabase.com) kostenlos registrieren.
2. **New project** → Region **Frankfurt (eu-central-1)** → ein starkes Datenbank-Passwort vergeben (wird danach nicht mehr gebraucht).
3. Die **Project Reference** notieren (die 20 Zeichen in der Projekt-URL).
4. Unter **Account → Access Tokens** einen Token erstellen. Diesen Token **nie** in den Code oder in einen Chat kopieren.

### 2. Supabase einrichten

```bash
SUPABASE_ACCESS_TOKEN=<token> node scripts/setup-supabase.mjs <project-ref> https://<github-name>.github.io/jangan-lapar-bersama/
```

Das Skript spielt Tabellen und Zugriffsregeln ein, stellt Login per E-Mail-Code ein, erzeugt die Push-Schlüssel und lädt die Push-Funktion hoch. Es schreibt drei **öffentliche** Werte nach `.env.local`.

### 3. App veröffentlichen (GitHub Pages)

1. Im Repository: **Settings → Pages → Source: GitHub Actions**.
2. **Settings → Secrets and variables → Actions → Variables**: die drei Werte aus `.env.local` als *Variables* anlegen:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY`.
3. Bei jedem Push auf `main` testet und veröffentlicht GitHub die App automatisch.

> GitHub Pages ist bei kostenlosen Konten nur für **öffentliche** Repositories verfügbar. Das ist hier unbedenklich: Im Code stehen keine Geheimnisse, die Daten schützen die Zugriffsregeln der Datenbank.

### 4. Auf den Handys

1. App-Adresse öffnen und anmelden (Code kommt per E-Mail).
2. Person 1 wählt ihre Rolle und bekommt einen **Kopplungscode**. Person 2 tippt „Ich habe schon einen Code“.
3. **Zum Home-Bildschirm hinzufügen**
   - iPhone (Safari): Teilen → „Zum Home-Bildschirm“. Danach die App **vom Home-Bildschirm** öffnen.
   - Android (Chrome): Menü ⋮ → „App installieren“.
4. In der App: **Einstellungen → Push-Nachrichten einschalten**. iPhone braucht iOS 16.4 oder neuer.

### 5. Danach absichern

Wenn beide gekoppelt sind: in Supabase **Authentication → Sign In / Providers → „Allow new users to sign up“ ausschalten**. Dann kann sich niemand Fremdes mehr registrieren.

## Sicherheit

| Thema | Umsetzung |
| --- | --- |
| Wer sieht was? | Row Level Security auf allen Tabellen. Jede Person sieht nur den eigenen Haushalt. 50 automatische Tests prüfen das (`npm run test:db`). |
| Nicht angemeldet | Hat keinerlei Zugriff (außer einer leeren `ping`-Funktion fürs Wachhalten). |
| Koppeln | Höchstens zwei Personen pro Haushalt. Codes: 8 Zeichen, 24 h gültig, einmalig. Nach 10 Fehlversuchen pro Stunde gesperrt. |
| Login | E-Mail-Code, kein Passwort. Keine anonymen Konten. |
| Geheimnisse | Nur in Supabase-Secrets (VAPID private key, service role). Im Code und in GitHub nur öffentliche Werte. |
| Push | Empfänger wird auf dem Server bestimmt. Man kann nur der anderen Person im eigenen Haushalt schreiben. |
| Eingaben | Gerichte-IDs, Texte und Mengen werden in der Datenbank begrenzt. Alles wird beim Anzeigen escaped. |
| Gespeicherte Daten | E-Mail-Adresse, Wünsche, Wochenstatus, Gefrierfach, Push-Abo. Keine Namen, keine Adressen. |
| Abhängigkeiten | Nur `@supabase/supabase-js` in der App. Versionen fest gepinnt, `npm audit` ohne Befund. |

## Entwicklung

```bash
npm test          # Logik-Tests (Gerichte, Einkauf, Zutaten-Suche)
npm run test:db   # Zugriffsregeln in einer lokalen Wegwerf-Datenbank (braucht Postgres)
npm run build     # Build nach dist/
```

- `src/data.js` – Gerichte, Zutaten, EDEKA-Gänge. Neue Gerichte einfach in `RAW` und `INFO` ergänzen; die Tests prüfen, dass alles zusammenpasst.
- `src/main.js` – Bildschirme und Abläufe
- `src/backend.js` – Supabase und Demo-Modus
- `supabase/migrations/` – Datenbank
- `supabase/functions/notify/` – Push-Versand
