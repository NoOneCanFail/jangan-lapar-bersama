-- Minimaler Nachbau der Supabase-Umgebung für lokale Tests (nicht in Supabase ausführen).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase vergibt standardmäßig alle Rechte an anon/authenticated. Das simulieren wir,
-- damit der Test zeigt, dass die Migration diese Rechte wieder entzieht.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create publication supabase_realtime;
