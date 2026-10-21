import { mountAccountNav, requireUser } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { type Appointment, one, type Profile } from '../lib/types';
import { $, errorMessage, esc, fmtDateTime, fmtPrice, MODE_LABEL, PAYMENT_LABEL, statusPill, toast } from '../lib/ui';

type Row = Appointment & {
  services: { name: string } | null;
  questionnaires: { submitted_at: string | null } | { submitted_at: string | null }[] | null;
};

const list = $('#appointments');

function card(a: Row): string {
  const q = one(a.questionnaires);
  const future = !a.starts_at || new Date(a.starts_at) > new Date();
  const actions: string[] = [];
  if (a.status === 'confirmed' && future) {
    actions.push(
      `<a class="btn btn-primary btn-sm" href="/kwestionariusz.html?wizyta=${a.id}">${
        q?.submitted_at ? 'Popraw kwestionariusz' : 'Wypełnij kwestionariusz'
      }</a>`,
    );
  }
  if ((a.status === 'pending' || a.status === 'confirmed') && future) {
    actions.push(`<button class="btn btn-danger btn-sm" type="button" data-cancel="${a.id}">Odwołaj</button>`);
  }
  const questionnaire =
    a.status === 'confirmed'
      ? `<dt>Kwestionariusz</dt><dd>${q?.submitted_at ? 'wysłany ✓' : 'czeka na wypełnienie'}</dd>`
      : '';
  return `<article class="appt">
    <div class="appt-head">
      <div><div class="appt-title">${esc(a.services?.name ?? a.service_id)}</div>
      <div class="appt-when">${esc(fmtDateTime(a.starts_at))}</div></div>
      ${statusPill(a.status)}
    </div>
    <dl class="meta-grid">
      ${a.starts_at ? `<dt>Forma</dt><dd>${esc(MODE_LABEL[a.mode])}</dd>` : ''}
      <dt>Cena</dt><dd>${esc(fmtPrice(a.price_pln))}${a.payment_status === 'unpaid' ? ` · ${PAYMENT_LABEL.unpaid}` : ''}</dd>
      ${questionnaire}
      ${a.admin_message ? `<dt>Wiadomość</dt><dd>${esc(a.admin_message)}</dd>` : ''}
    </dl>
    ${actions.length ? `<div class="appt-actions">${actions.join('')}</div>` : ''}
  </article>`;
}

async function load(): Promise<void> {
  const { data, error } = await supabase
    .from('appointments')
    .select('*, services(name), questionnaires!questionnaires_appointment_id_fkey(submitted_at)')
    .order('starts_at', { ascending: false, nullsFirst: true })
    .order('created_at', { ascending: false });
  if (error) {
    list.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const rows = (data ?? []) as Row[];
  list.innerHTML = rows.length
    ? rows.map(card).join('')
    : '<p class="empty">Nie masz jeszcze żadnych wizyt.<br><a href="/#umow">Umów pierwszą konsultację</a></p>';
}

list.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cancel]');
  if (!btn) return;
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Na pewno odwołać?';
    return;
  }
  btn.disabled = true;
  const { error } = await supabase.rpc('cancel_my_appointment', { p_id: btn.dataset.cancel });
  if (error) {
    toast(errorMessage(error), 'error');
    btn.disabled = false;
    return;
  }
  toast('Wizyta odwołana.');
  await load();
});

async function init(): Promise<void> {
  const user = await requireUser();
  void mountAccountNav(document.getElementById('account-nav'));
  const { data } = await supabase.from('profiles').select('id,email,full_name,phone').eq('id', user.id).maybeSingle();
  const profile = data as Profile | null;
  $('#hello').textContent = profile?.full_name ? `Cześć, ${profile.full_name.split(' ')[0]}!` : '';
  $<HTMLInputElement>('#p-name').value = profile?.full_name ?? '';
  $<HTMLInputElement>('#p-phone').value = profile?.phone ?? '';
  $('#p-email').textContent = `E-mail konta: ${user.email ?? ''}`;
  await load();
}

$<HTMLFormElement>('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = await requireUser();
  const { error } = await supabase
    .from('profiles')
    .update({
      full_name: $<HTMLInputElement>('#p-name').value.trim() || null,
      phone: $<HTMLInputElement>('#p-phone').value.trim() || null,
    })
    .eq('id', user.id);
  toast(error ? errorMessage(error) : 'Zapisano.', error ? 'error' : 'ok');
});

void init();
