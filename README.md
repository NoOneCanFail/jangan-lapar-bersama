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
3. Die **Project Reference** notieren (die 20 Zeichen in der Projekt-Adresse, z. B. `supabase.com/dashboard/project/<ref>`).

### 2. App-Veröffentlichung einschalten

Im Repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 3. Supabase einrichten (läuft auf GitHub, der Token bleibt dort)

1. Auf supabase.com: **Account → Access Tokens → Generate new token**.
2. Im Repository: **Settings → Secrets and variables → Actions → New repository secret**
   Name `SUPABASE_ACCESS_TOKEN`, Wert = der Token.
3. **Actions → „Supabase einrichten“ → Run workflow** und die Project Reference eingeben.

Der Workflow spielt Tabellen und Zugriffsregeln ein, stellt Login per E-Mail und Passwort ein, erzeugt die Push-Schlüssel, lädt die Push-Funktion hoch, speichert die drei **öffentlichen** Werte in `.env.production` und veröffentlicht die App neu.

Danach den Token in Supabase wieder löschen (oder das Secret in GitHub), er wird nicht mehr gebraucht.

> Alternativ lokal: `SUPABASE_ACCESS_TOKEN=<token> ENV_FILE=.env.production node scripts/setup-supabase.mjs <project-ref> <app-adresse>`

> GitHub Pages ist bei kostenlosen Konten nur für **öffentliche** Repositories verfügbar. Das ist hier unbedenklich: Im Code stehen keine Geheimnisse, die Daten schützen die Zugriffsregeln der Datenbank. Die Werte in `.env.production` (Projekt-URL, öffentlicher Schlüssel, öffentlicher Push-Schlüssel) sind dafür gemacht, öffentlich zu sein.

### 4. Auf den Handys

1. App-Adresse öffnen, **Konto anlegen** (E-Mail + Passwort mit mindestens 8 Zeichen). Es wird keine E-Mail verschickt.
2. Person 1 wählt ihre Rolle und bekommt einen **Kopplungscode**. Person 2 tippt „Ich habe schon einen Code“.
3. **Zum Home-Bildschirm hinzufügen**
   - iPhone (Safari): Teilen → „Zum Home-Bildschirm“. Danach die App **vom Home-Bildschirm** öffnen.
   - Android (Chrome): Menü ⋮ → „App installieren“.
4. In der App: **Einstellungen → Push-Nachrichten einschalten**. iPhone braucht iOS 16.4 oder neuer.

### 5. Danach absichern

Wenn beide gekoppelt sind: **Actions → „Supabase einrichten“ → Run workflow → Aktion „registrierung-schliessen“**. Dann kann niemand mehr ein Konto anlegen. (Alternativ in Supabase: Authentication → Sign In / Providers → „Allow new users to sign up“ ausschalten.)

**Passwort vergessen?** Die eingerichtete Person kann in Supabase unter Authentication → Users das Konto löschen. Dann Registrierung kurz öffnen, neu registrieren, mit neuem Kopplungscode verbinden und wieder schließen.

## Sicherheit

| Thema | Umsetzung |
| --- | --- |
| Wer sieht was? | Row Level Security auf allen Tabellen. Jede Person sieht nur den eigenen Haushalt. 50 automatische Tests prüfen das (`npm run test:db`). |
| Nicht angemeldet | Hat keinerlei Zugriff (außer einer leeren `ping`-Funktion fürs Wachhalten). |
| Koppeln | Höchstens zwei Personen pro Haushalt. Codes: 8 Zeichen, 24 h gültig, einmalig. Nach 10 Fehlversuchen pro Stunde gesperrt. |
| Login | E-Mail und Passwort (mind. 8 Zeichen). Ohne Bestätigungs-E-Mail, weil der kostenlose Supabase-Mailversand nur an Team-Mitglieder zustellt. Nach dem Koppeln wird die Registrierung geschlossen. Keine anonymen Konten. |
| Geheimnisse | Nur in Supabase-Secrets (VAPID private key, service role). Im Code und in GitHub nur öffentliche Werte. |
| Push | Empfänger wird auf dem Server bestimmt. Man kann nur der anderen Person im eigenen Haushalt schreiben. Push-Ziele nur bei bekannten Push-Diensten (Google, Apple, Mozilla, Microsoft), damit der Server keine beliebigen Adressen aufruft (SSRF). Beim Abmelden wird das Push-Abo des Geräts gelöscht. |
| Browser | Content Security Policy: nur eigene Skripte, Verbindungen nur zu Supabase. Kein Laden in fremden Rahmen (Clickjacking), per Skript, weil GitHub Pages keine eigenen Header erlaubt. |
| Login-Sitzung | Liegt wie bei Supabase-Web-Apps üblich im Browser-Speicher. Schutz davor sind die strenge CSP, durchgehendes Escaping und nur eine Fremdbibliothek. |
| GitHub-Workflows | Actions auf feste Commit-Hashes gepinnt, Dependabot mit 14 Tagen Wartezeit, Setup-Job ohne fremde npm-Pakete außer der Supabase-CLI. Der Supabase-Token wird nur für die Einrichtung gebraucht und danach gelöscht. |
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
