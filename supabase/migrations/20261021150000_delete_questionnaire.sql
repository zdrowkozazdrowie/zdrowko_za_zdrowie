-- Admin deletes a single questionnaire (answers and its standalone links). Lab result files stay in Storage.
create or replace function public.admin_delete_questionnaire(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  delete from public.questionnaires where id = p_id;
  if not found then
    raise exception 'Nie znaleziono kwestionariusza.' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.admin_delete_questionnaire(uuid) from public, anon;
grant execute on function public.admin_delete_questionnaire(uuid) to authenticated;
