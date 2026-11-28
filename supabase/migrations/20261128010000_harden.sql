-- Härtung nach Sicherheitsprüfung.

-- 1) Push-Endpunkte nur von bekannten Push-Diensten (Google/FCM, Mozilla, Apple, Microsoft).
--    Sonst könnte ein angemeldetes Konto eine beliebige Adresse hinterlegen, an die unser Server
--    dann Anfragen schickt (Server-Side Request Forgery).
delete from public.push_subscriptions
  where endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/';
alter table public.push_subscriptions
  add constraint push_endpoint_known_service
  check (endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)/');

-- 2) Feste search_path auch für die Keepalive-Funktion (Empfehlung des Supabase Security Advisors).
alter function public.ping() set search_path = '';
