#!/usr/bin/env python3
"""Lokale Tests für Schema und Zugriffsregeln (Row Level Security).

Startet eine wegwerfbare Postgres-Instanz, baut die Supabase-Grundstruktur nach,
spielt die Migration ein und prüft, dass jede Person nur ihren eigenen Haushalt sieht.

Aufruf: python3 supabase/tests/run_rls_tests.py
Benötigt: Postgres 15+ (initdb, pg_ctl, psql) im PATH oder unter /usr/lib/postgresql/*/bin.
"""
import glob, json, os, shutil, subprocess, sys, tempfile, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BIN = next(iter(sorted(glob.glob("/usr/lib/postgresql/*/bin"), reverse=True)), "")
def tool(name): return os.path.join(BIN, name) if BIN and os.path.exists(os.path.join(BIN, name)) else name

tmp = tempfile.mkdtemp(prefix="jlb-pg-")
data, sock = os.path.join(tmp, "data"), tmp
port = "54329"
as_pg = ["runuser", "-u", "postgres", "--"] if os.geteuid() == 0 else []
if as_pg: shutil.chown(tmp, "postgres")

def run(cmd, **kw): return subprocess.run(as_pg + cmd, capture_output=True, text=True, **kw)

def psql(sql, user=None):
    """Führt SQL als 'anon' (user='anon'), als angemeldete Person (uuid) oder als Admin (None) aus."""
    pre = ""
    if user == "anon":
        pre = "set role anon;"
    elif user == "service":
        pre = "set role service_role;"
    elif user:
        pre = f"set role authenticated; set request.jwt.claims = '{json.dumps({'sub': user, 'role': 'authenticated'})}';"
    r = run([tool("psql"), "-h", sock, "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1",
             "-qAt", "-c", pre + sql])
    return r.returncode == 0, (r.stdout.strip() if r.returncode == 0 else r.stderr.strip())

passed = failed = 0
def check(name, cond, detail=""):
    global passed, failed
    if cond: passed += 1; print(f"  ok   {name}")
    else: failed += 1; print(f"  FAIL {name}  {detail}")

def ok(name, sql, user=None, expect=None):
    good, out = psql(sql, user)
    check(name, good and (expect is None or out == expect), out)
    return out

def denied(name, sql, user=None, contains=None):
    good, out = psql(sql, user)
    check(name, (not good) and (contains is None or contains in out), out or "lief ohne Fehler durch")

try:
    r = run([tool("initdb"), "-D", data, "-U", "postgres", "--auth=trust"])
    assert r.returncode == 0, r.stderr
    r = run([tool("pg_ctl"), "-D", data, "-l", os.path.join(tmp, "server.log"), "-o", f"-k {sock} -p {port} -c listen_addresses=''", "-w", "start"])
    assert r.returncode == 0, r.stderr

    for f in [os.path.join(HERE, "supabase_stub.sql"), *sorted(glob.glob(os.path.join(ROOT, "migrations", "*.sql")))]:
        good, out = psql(open(f, encoding="utf-8").read())
        assert good, f"{os.path.basename(f)}: {out}"
    print("Migration eingespielt.\n")

    A, B, C, D = (str(uuid.uuid4()) for _ in range(4))   # A isst, B kocht, C fremd, D ungekoppelt
    psql("insert into auth.users (id) values " + ",".join(f"('{u}')" for u in (A, B, C, D)))

    print("Nicht angemeldet")
    denied("anon kann Haushalte nicht lesen", "select * from public.households", "anon", "permission denied")
    denied("anon kann Wünsche nicht lesen", "select * from public.wishes", "anon", "permission denied")
    denied("anon kann keinen Haushalt anlegen", "select public.create_household('esser')", "anon", "permission denied")
    ok("anon darf ping (Keepalive)", "select public.ping()", "anon", "1")
    ok("ping hat feste search_path", "select array_to_string(proconfig, ',') from pg_proc where proname = 'ping'", None, 'search_path=""')

    print("Koppeln")
    code = ok("A legt Haushalt an (isst)", "select public.create_household('esser')", A)
    check("Code hat 8 Zeichen ohne verwechselbare Zeichen", len(code) == 8 and not set(code) & set("01OIL"), code)
    denied("A kann nicht zweimal anlegen", "select public.create_household('koch')", A, "schon gekoppelt")
    ok("D sieht A's Haushalt nicht", "select count(*) from public.households", D, "0")
    ok("B mit falschem Code", "select public.join_household('AAAAAAAA')", B, "ungueltig")
    ok("B mit richtigem Code (Kleinschreibung, Bindestrich)", f"select public.join_household('{code[:4].lower()}-{code[4:]}')", B, "koch")
    ok("Code ist danach gelöscht", "select coalesce(pair_code,'leer') from public.households", A, "leer")
    ok("Dritte Person kann nicht mehr beitreten", f"select public.join_household('{code}')", C, "ungueltig")
    ok("A sieht beide Mitglieder", "select string_agg(role, ',' order by role) from public.members", A, "esser,koch")
    denied("renew nicht möglich, wenn schon zu zweit", "select public.renew_pair_code()", A, "schon zu zweit")
    ok("C legt eigenen Haushalt an", "select length(public.create_household('koch'))", C, "8")

    print("Direktzugriffe gesperrt")
    denied("Haushalt direkt anlegen", "insert into public.households default values", A, "permission denied")
    denied("Rolle direkt ändern", "update public.members set role='koch'", A, "permission denied")
    denied("Mitglied direkt einfügen", f"insert into public.members (user_id, household_id, role) values ('{D}', public.my_household(), 'esser')", D, "permission denied")
    denied("join_attempts nicht lesbar", "select * from public.join_attempts", A, "permission denied")
    denied("Gefrierfach nicht direkt befüllen", "insert into public.freezer_items (household_id, dish_id, portions) values (public.my_household(), 'dhal', 50)", A, "permission denied")

    print("Wünsche")
    ok("A wünscht Kari Ikan", "insert into public.wishes (household_id, kind, dish_id) values (public.my_household(), 'dish', 'kari-ikan')", A)
    ok("A wünscht Palak", "insert into public.wishes (household_id, kind, dish_id) values (public.my_household(), 'dish', 'palak')", A)
    ok("A wünscht Überraschung", "insert into public.wishes (household_id, kind, picks) values (public.my_household(), 'surprise', array['Hähnchen','Kokos'])", A)
    ok("B sieht 3 Wünsche", "select count(*) from public.wishes", B, "3")
    ok("C sieht keine fremden Wünsche", "select count(*) from public.wishes", C, "0")
    hid_a = psql("select public.my_household()", A)[1]
    denied("C kann nicht in A's Haushalt wünschen", f"insert into public.wishes (household_id, kind, dish_id) values ('{hid_a}', 'dish', 'dhal')", C, "row-level security")
    denied("Wunsch im Namen einer anderen Person", f"insert into public.wishes (household_id, kind, dish_id, created_by) values (public.my_household(), 'dish', 'dhal', '{B}')", A, "row-level security")
    denied("Ungültige Gericht-ID", "insert into public.wishes (household_id, kind, dish_id) values (public.my_household(), 'dish', '<script>')", A, "check constraint")
    ok("C kann A's Wünsche nicht löschen (0 Zeilen)", f"with d as (delete from public.wishes where household_id = '{hid_a}' returning 1) select count(*) from d", C, "0")

    print("Woche")
    ok("C kann A's Wochenstatus nicht ändern (0 Zeilen)", f"with u as (update public.week_state set status='gekocht' where household_id='{hid_a}' returning 1) select count(*) from u", C, "0")
    ok("B setzt 'eingekauft'", "update public.week_state set status='eingekauft'", B)
    head = psql("select id from public.wishes order by created_at limit 1", A)[1]
    denied("A kann Wunsch dieser Woche nicht mehr entfernen", f"delete from public.wishes where id='{head}'", A, "schon eingekauft")
    ok("A kann späteren Wunsch entfernen", "with d as (delete from public.wishes where dish_id='palak' returning 1) select count(*) from d", A, "1")
    denied("Ungültiger Status", "update public.week_state set status='gegessen'", B, "check constraint")

    print("Übergabe und Gefrierfach")
    ok("B übergibt", "select public.handover()", B, "kari-ikan")
    ok("Gefrierfach hat 5 Portionen", "select sum(portions) from public.freezer_items", A, "5")
    ok("Status zurückgesetzt", "select status from public.week_state", A, "gewuenscht")
    denied("Überraschung ohne Auswahl nicht übergebbar", "select public.handover()", B, "Erst ein Gericht")
    ok("B wählt Gericht für Überraschung", "update public.wishes set chosen_dish_id='rendang' where kind='surprise'", B)
    item = psql("select id from public.freezer_items limit 1", A)[1]
    ok("A nimmt eine Portion", f"select public.take_portion('{item}')", A, "4")
    denied("C kann A's Portion nicht nehmen", f"select public.take_portion('{item}')", C, "Nicht gefunden")
    ok("C sieht A's Gefrierfach nicht", "select count(*) from public.freezer_items", C, "0")

    print("Push-Abos")
    ok("A speichert Push-Abo", "insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://fcm.googleapis.com/fcm/send/abc', 'k', 'a')", A)
    ok("B sieht A's Push-Abo nicht", "select count(*) from public.push_subscriptions", B, "0")
    denied("Abo für andere Person anlegen", f"insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('{B}', 'https://web.push.apple.com/x', 'k', 'a')", A, "row-level security")
    denied("Nur https-Endpunkte", "insert into public.push_subscriptions (endpoint, p256dh, auth) values ('http://evil', 'k', 'a')", B, "check constraint")
    denied("Keine beliebigen Server als Push-Ziel (SSRF)", "insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://evil.example/hook', 'k', 'a')", B, "check constraint")
    denied("Kein Trick mit ähnlichem Namen", "insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://fcm.googleapis.com.evil.example/x', 'k', 'a')", B, "check constraint")
    ok("Apple-Push erlaubt", "insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://web.push.apple.com/QOabc', 'k', 'a')", B)
    ok("Windows-Push erlaubt", "with i as (insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://wns2-par02p.notify.windows.com/w/?token=x', 'k', 'a') returning 1) select count(*) from i", B, "1")

    print("Server (Push-Funktion)")
    ok("Service-Rolle liest Mitglieder", "select count(*) > 0 from public.members", "service", "t")
    ok("Service-Rolle liest Push-Abos", "select count(*) from public.push_subscriptions", "service", "3")
    denied("Service-Rolle kann Wünsche nicht lesen (nicht nötig)", "select * from public.wishes", "service", "permission denied")

    print("Grenzen")
    for i in range(11):
        psql(f"insert into public.wishes (household_id, kind, dish_id) values (public.my_household(), 'dish', 'dhal')", A)
    denied("Höchstens 12 Wünsche", "insert into public.wishes (household_id, kind, dish_id) values (public.my_household(), 'dish', 'dhal')", A, "Höchstens 12")
    for i in range(9):
        psql("select public.join_household('ZZZZZZZZ')", D)
    ok("10. Fehlversuch noch normal", "select public.join_household('ZZZZZZZZ')", D, "ungueltig")
    denied("Danach Sperre", "select public.join_household('ZZZZZZZZ')", D, "Zu viele Versuche")

    print("Konto löschen")
    ok("Haushalt mit eingekaufter Woche lässt sich löschen", f"update public.week_state set status='eingekauft'; delete from public.households where id='{hid_a}'")

finally:
    run([tool("pg_ctl"), "-D", data, "-m", "immediate", "stop"])
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{passed} bestanden, {failed} fehlgeschlagen")
sys.exit(1 if failed else 0)
