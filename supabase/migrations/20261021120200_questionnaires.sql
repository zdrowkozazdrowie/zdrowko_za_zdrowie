-- Pre-visit questionnaire and lab results uploads.

create table public.questionnaires (
  appointment_id    uuid primary key references public.appointments (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  answers           jsonb not null default '{}'::jsonb check (jsonb_typeof(answers) = 'object'),
  current_step      integer not null default -1,
  health_consent_at timestamptz,
  submitted_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint questionnaires_submitted_needs_consent
    check (submitted_at is null or health_consent_at is not null)
);
create index questionnaires_user_idx on public.questionnaires (user_id);

create trigger questionnaires_touch before update on public.questionnaires
  for each row execute function private.touch_updated_at();

alter table public.questionnaires enable row level security;
revoke all on public.questionnaires from anon, authenticated;
grant select on public.questionnaires to authenticated;
create policy questionnaires_select on public.questionnaires
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Saves a draft (autosave) or submits the questionnaire.
create or replace function public.save_questionnaire(
  p_appointment_id uuid,
  p_answers        jsonb,
  p_step           integer default null,
  p_submit         boolean default false,
  p_health_consent boolean default false
) returns public.questionnaires
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a   public.appointments;
  v_q   public.questionnaires;
begin
  if v_uid is null then
    raise exception 'Zaloguj się, aby wypełnić kwestionariusz.' using errcode = '42501';
  end if;
  select * into v_a from public.appointments where id = p_appointment_id and user_id = v_uid;
  if not found then
    raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
  end if;
  if v_a.status <> 'confirmed' then
    raise exception 'Kwestionariusz jest dostępny dla potwierdzonych wizyt.' using errcode = 'P0001';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'Nieprawidłowe odpowiedzi.' using errcode = '22023';
  end if;
  if octet_length(p_answers::text) > 200000 then
    raise exception 'Odpowiedzi są zbyt długie.' using errcode = '22023';
  end if;
  if p_submit and not coalesce(p_health_consent, false) then
    raise exception 'Zaznacz zgodę na przetwarzanie danych o zdrowiu.' using errcode = '22023';
  end if;

  insert into public.questionnaires as q
    (appointment_id, user_id, answers, current_step, health_consent_at, submitted_at)
  values
    (v_a.id, v_uid, p_answers, coalesce(p_step, -1),
     case when p_submit then now() end, case when p_submit then now() end)
  on conflict (appointment_id) do update
    set answers           = excluded.answers,
        current_step      = coalesce(p_step, q.current_step),
        health_consent_at = case when p_submit then now() else q.health_consent_at end,
        submitted_at      = case when p_submit then now() else q.submitted_at end
  returning * into v_q;

  return v_q;
end;
$$;

revoke execute on function public.save_questionnaire(uuid, jsonb, integer, boolean, boolean) from public, anon;
grant execute on function public.save_questionnaire(uuid, jsonb, integer, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Lab results (Supabase Storage). Path: <user_id>/<appointment_id>/<file>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wyniki-badan', 'wyniki-badan', false, 10485760,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.owns_appointment_folder(p_name text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.appointments a
     where a.user_id = (select auth.uid())
       and a.id::text = (storage.foldername(p_name))[2]
       and (storage.foldername(p_name))[1] = (select auth.uid())::text
  )
$$;
revoke execute on function public.owns_appointment_folder(text) from public, anon;
grant execute on function public.owns_appointment_folder(text) to authenticated;

create policy "wyniki_badan_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'wyniki-badan' and public.owns_appointment_folder(name));

create policy "wyniki_badan_select_own_or_admin" on storage.objects
  for select to authenticated
  using (bucket_id = 'wyniki-badan' and (public.owns_appointment_folder(name) or public.is_admin()));

create policy "wyniki_badan_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'wyniki-badan' and public.owns_appointment_folder(name));
