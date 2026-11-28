-- Die Push-Funktion läuft serverseitig mit der Service-Rolle. Neuere Supabase-Projekte vergeben
-- dafür keine Tabellenrechte mehr automatisch. Nur das Nötigste: Mitglieder und Push-Abos lesen,
-- abgelaufene Push-Abos löschen.
grant usage on schema public to service_role;
grant select on public.members to service_role;
grant select, delete on public.push_subscriptions to service_role;
