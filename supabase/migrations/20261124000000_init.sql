-- Jangan Lapar Bersama: Datenbank für genau zwei Personen pro Haushalt.
-- Grundsatz: Jede Tabelle hat Row Level Security. Niemand sieht Daten außerhalb des eigenen Haushalts.
-- Schreibzugriffe, die mehrere Tabellen betreffen (Koppeln, Übergabe), laufen nur über Funktionen.

-- ---------------------------------------------------------------- Tabellen

create table public.households (
  id uuid primary key default gen_random_uuid(),
  pair_code text unique,
  pair_code_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  role text not null check (role in ('esser', 'koch')),
  created_at timestamptz not null default now(),
  -- je Rolle genau eine Person: damit hat ein Haushalt höchstens zwei Mitglieder
  unique (household_id, role)
);

create table public.wishes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind text not null check (kind in ('dish', 'surprise')),
  dish_id text check (dish_id ~ '^[a-z0-9-]{1,40}$'),
  picks text[] check (picks is null or (cardinality(picks) between 1 and 5 and length(array_to_string(picks, ',')) <= 200)),
  chosen_dish_id text check (chosen_dish_id ~ '^[a-z0-9-]{1,40}$'),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default clock_timestamp(),
  check ((kind = 'dish' and dish_id is not null and picks is null)
      or (kind = 'surprise' and picks is not null and dish_id is null))
);
create index wishes_household_order on public.wishes (household_id, created_at);

create table public.week_state (
  household_id uuid primary key references public.households (id) on delete cascade,
  status text not null default 'gewuenscht' check (status in ('gewuenscht', 'eingekauft', 'gekocht')),
  side_on boolean not null default true,
  checked jsonb not null default '{}'::jsonb check (jsonb_typeof(checked) = 'object' and pg_column_size(checked) < 4000),
  updated_at timestamptz not null default now()
);

create table public.freezer_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  dish_id text not null check (dish_id ~ '^[a-z0-9-]{1,40}$'),
  portions int not null check (portions between 0 and 50),
  frozen_on date not null default current_date,
  created_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and length(endpoint) < 1000),
  p256dh text not null check (length(p256dh) < 200),
  auth text not null check (length(auth) < 100),
  created_at timestamptz not null default now()
);

-- Fehlversuche beim Koppeln, um Raten des Codes zu bremsen
create table public.join_attempts (
  user_id uuid not null references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index join_attempts_user_at on public.join_attempts (user_id, at);

-- ---------------------------------------------------------------- Hilfsfunktion

create function public.my_household() returns uuid
language sql stable security definer set search_path = '' as $$
  select household_id from public.members where user_id = auth.uid()
$$;

-- ---------------------------------------------------------------- Row Level Security

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.wishes enable row level security;
alter table public.week_state enable row level security;
alter table public.freezer_items enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.join_attempts enable row level security;

-- Nicht angemeldete Besucher bekommen gar nichts.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select on public.households, public.members to authenticated;
grant select, insert, delete on public.wishes to authenticated;
grant update (chosen_dish_id) on public.wishes to authenticated;
grant select on public.week_state to authenticated;
grant update (status, side_on, checked, updated_at) on public.week_state to authenticated;
grant select, delete on public.freezer_items to authenticated;
grant update (portions) on public.freezer_items to authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;
-- join_attempts: kein direkter Zugriff, nur über join_household()

create policy "eigener Haushalt lesen" on public.households
  for select to authenticated using (id = public.my_household());

create policy "Mitglieder im eigenen Haushalt lesen" on public.members
  for select to authenticated using (household_id = public.my_household());

create policy "Wünsche lesen" on public.wishes
  for select to authenticated using (household_id = public.my_household());
create policy "Wünsche anlegen" on public.wishes
  for insert to authenticated with check (household_id = public.my_household() and created_by = auth.uid());
create policy "Überraschung auswählen" on public.wishes
  for update to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "Wünsche entfernen" on public.wishes
  for delete to authenticated using (household_id = public.my_household());

create policy "Wochenstatus lesen" on public.week_state
  for select to authenticated using (household_id = public.my_household());
create policy "Wochenstatus ändern" on public.week_state
  for update to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());

create policy "Gefrierfach lesen" on public.freezer_items
  for select to authenticated using (household_id = public.my_household());
create policy "Gefrierfach korrigieren" on public.freezer_items
  for update to authenticated using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "Gefrierfach leeren" on public.freezer_items
  for delete to authenticated using (household_id = public.my_household());

create policy "eigene Push-Abos" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- Regeln als Trigger

-- Höchstens 12 offene Wünsche pro Haushalt.
create function public.limit_wishes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.wishes where household_id = new.household_id) >= 12 then
    raise exception 'Höchstens 12 Wünsche gleichzeitig.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger wishes_limit before insert on public.wishes
  for each row execute function public.limit_wishes();

-- Der Wunsch dieser Woche ist fest, sobald eingekauft wurde.
create function public.protect_current_wish() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  head uuid;
  st text;
begin
  -- Löschen über Kaskade (Haushalt wird gelöscht) nicht blockieren
  if pg_trigger_depth() > 1 then return old; end if;
  select status into st from public.week_state where household_id = old.household_id;
  select id into head from public.wishes where household_id = old.household_id order by created_at, id limit 1;
  if st is distinct from 'gewuenscht' and head = old.id then
    raise exception 'Für diese Woche ist schon eingekauft.' using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger wishes_protect before delete on public.wishes
  for each row execute function public.protect_current_wish();

-- ---------------------------------------------------------------- Funktionen (RPC)

-- 8 Zeichen ohne verwechselbare Zeichen (kein 0/O, 1/I/L)
create function public.new_pair_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  code text := '';
  i int;
begin
  for i in 0..7 loop
    code := code || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
  end loop;
  return code;
end $$;

create function public.create_household(p_role text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  hid uuid;
  code text := public.new_pair_code();
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet.'; end if;
  if p_role not in ('esser', 'koch') then raise exception 'Unbekannte Rolle.'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'Du bist schon gekoppelt.';
  end if;
  insert into public.households (pair_code, pair_code_expires_at)
    values (code, now() + interval '24 hours') returning id into hid;
  insert into public.members (user_id, household_id, role) values (auth.uid(), hid, p_role);
  insert into public.week_state (household_id) values (hid);
  return code;
end $$;

-- Neuen Code erzeugen, falls der alte abgelaufen ist und die zweite Person noch fehlt
create function public.renew_pair_code() returns text
language plpgsql security definer set search_path = '' as $$
declare
  hid uuid := public.my_household();
  code text := public.new_pair_code();
begin
  if hid is null then raise exception 'Nicht gekoppelt.'; end if;
  if (select count(*) from public.members where household_id = hid) >= 2 then
    raise exception 'Ihr seid schon zu zweit.';
  end if;
  update public.households set pair_code = code, pair_code_expires_at = now() + interval '24 hours' where id = hid;
  return code;
end $$;

-- Rückgabe: 'esser' oder 'koch' bei Erfolg, 'ungueltig' bei falschem oder abgelaufenem Code.
create function public.join_household(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  norm text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  hid uuid;
  taken text;
  my_role text;
begin
  if auth.uid() is null then raise exception 'Nicht angemeldet.'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'Du bist schon gekoppelt.';
  end if;
  if (select count(*) from public.join_attempts where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'Zu viele Versuche. Bitte in einer Stunde noch mal.';
  end if;

  select id into hid from public.households
    where pair_code = norm and pair_code_expires_at > now()
    for update;
  if hid is null then
    -- Kein raise: sonst würde der Fehlversuch mit zurückgerollt und nie gezählt.
    insert into public.join_attempts (user_id) values (auth.uid());
    return 'ungueltig';
  end if;

  select role into taken from public.members where household_id = hid;
  my_role := case taken when 'esser' then 'koch' else 'esser' end;
  insert into public.members (user_id, household_id, role) values (auth.uid(), hid, my_role);
  update public.households set pair_code = null, pair_code_expires_at = null where id = hid;
  return my_role;
end $$;

-- Übergabe: 5 Boxen ins Gefrierfach, Wunsch dieser Woche erledigt, neue Woche beginnt.
create function public.handover(p_portions int default 5) returns text
language plpgsql security definer set search_path = '' as $$
declare
  hid uuid := public.my_household();
  w record;
  dish text;
begin
  if hid is null then raise exception 'Nicht gekoppelt.'; end if;
  if p_portions not between 1 and 20 then raise exception 'Ungültige Portionen.'; end if;
  perform 1 from public.week_state where household_id = hid for update;
  select * into w from public.wishes where household_id = hid order by created_at, id limit 1;
  if w.id is null then raise exception 'Kein Wunsch für diese Woche.'; end if;
  dish := coalesce(w.chosen_dish_id, w.dish_id);
  if dish is null then raise exception 'Erst ein Gericht für die Überraschung auswählen.'; end if;

  insert into public.freezer_items (household_id, dish_id, portions) values (hid, dish, p_portions);
  update public.week_state set status = 'gewuenscht', side_on = true, checked = '{}'::jsonb, updated_at = now()
    where household_id = hid;
  delete from public.wishes where id = w.id;
  return dish;
end $$;

-- Eine Portion aus dem Gefrierfach nehmen. Leere Einträge verschwinden.
create function public.take_portion(p_item uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  left_over int;
begin
  update public.freezer_items set portions = portions - 1
    where id = p_item and household_id = public.my_household() and portions > 0
    returning portions into left_over;
  if left_over is null then raise exception 'Nicht gefunden.'; end if;
  if left_over = 0 then delete from public.freezer_items where id = p_item; end if;
  return left_over;
end $$;

-- Für den wöchentlichen Keepalive (kostenlose Projekte pausieren sonst nach 7 Tagen).
create function public.ping() returns int language sql stable as $$ select 1 $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_household(text), public.renew_pair_code(), public.join_household(text),
  public.handover(int), public.take_portion(uuid), public.my_household() to authenticated;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------- Live-Aktualisierung

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.wishes, public.week_state, public.freezer_items, public.members;
  end if;
end $$;
