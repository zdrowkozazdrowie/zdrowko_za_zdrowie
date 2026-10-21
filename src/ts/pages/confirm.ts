import { mountAccountNav } from '../lib/auth';
import { supabase } from '../lib/supabase';
import type { AppointmentStatus } from '../lib/types';
import { $, errorMessage, esc, fmtDateTime, fmtPrice, MODE_LABEL, statusPill } from '../lib/ui';

interface TokenRow {
  id: string;
  status: AppointmentStatus;
  service_name: string;
  price_pln: number;
  starts_at: string | null;
  mode: 'online' | 'telefon';
  client_note: string | null;
  client_name: string | null;
  client_email: string;
  client_phone: string | null;
}

const params = new URLSearchParams(location.search);
const token = params.get('t') ?? '';
const suggested = params.get('decyzja') === 'odrzuc' ? 'reject' : 'confirm';
const body = $('#decision-body');

function details(r: TokenRow): string {
  return `<dl class="meta-grid">
    <dt>Usługa</dt><dd>${esc(r.service_name)}</dd>
    <dt>Termin</dt><dd>${esc(fmtDateTime(r.starts_at))}</dd>
    ${r.starts_at ? `<dt>Forma</dt><dd>${esc(MODE_LABEL[r.mode])}</dd>` : ''}
    <dt>Cena</dt><dd>${esc(fmtPrice(r.price_pln))}</dd>
    <dt>Klient</dt><dd>${esc(r.client_name ?? '—')}</dd>
    <dt>E-mail</dt><dd>${esc(r.client_email)}</dd>
    <dt>Telefon</dt><dd>${esc(r.client_phone ?? '—')}</dd>
    ${r.client_note ? `<dt>Uwagi</dt><dd>${esc(r.client_note)}</dd>` : ''}
  </dl>`;
}

async function load(): Promise<void> {
  if (!token) {
    body.innerHTML = '<p class="form-error">Brak kodu w linku. Otwórz link z e-maila jeszcze raz.</p>';
    return;
  }
  const { data, error } = await supabase.rpc('get_appointment_by_token', { p_token: token });
  const row = (data as TokenRow[] | null)?.[0];
  if (error || !row) {
    body.innerHTML = `<p class="form-error">${esc(error ? errorMessage(error) : 'Link jest nieprawidłowy lub wygasł.')}</p>`;
    return;
  }
  if (row.status !== 'pending') {
    body.innerHTML = `<p>Ta rezerwacja została już obsłużona: ${statusPill(row.status)}</p>${details(row)}
      <p><a class="btn btn-outline" href="/admin.html#wizyta-${row.id}">Otwórz w panelu</a></p>`;
    return;
  }
  // Nothing happens on page load: e-mail scanners open links, so the decision needs a click.
  body.innerHTML = `${statusPill(row.status)}${details(row)}
    <form class="plain stack" id="decide">
      <label>Wiadomość do klienta (opcjonalnie)
        <textarea id="msg" maxlength="2000" placeholder="${
          suggested === 'reject' ? 'Np. propozycja innego terminu' : 'Np. link do spotkania lub krótka informacja'
        }"></textarea>
      </label>
      <p class="form-error" id="d-error" role="alert" hidden></p>
      <div class="appt-actions">
        <button class="btn ${suggested === 'confirm' ? 'btn-primary' : 'btn-outline'}" type="submit" value="confirm">Potwierdź wizytę</button>
        <button class="btn ${suggested === 'reject' ? 'btn-primary' : 'btn-danger'}" type="submit" value="reject">Odrzuć</button>
      </div>
    </form>`;
  const form = $<HTMLFormElement>('#decide');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const decision = ((e as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? suggested;
    form.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const { data: status, error: err } = await supabase.rpc('decide_appointment', {
      p_token: token,
      p_decision: decision,
      p_message: $<HTMLTextAreaElement>('#msg').value.trim() || null,
    });
    if (err) {
      const el = $('#d-error');
      el.textContent = errorMessage(err);
      el.hidden = false;
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }
    body.innerHTML = `<p class="notice">${
      status === 'confirmed'
        ? 'Wizyta potwierdzona. Klient dostał e-mail z linkiem do kwestionariusza.'
        : 'Rezerwacja odrzucona. Klient dostał informację e-mailem.'
    }</p>${details({ ...row, status: status as AppointmentStatus })}
      <p><a class="btn btn-outline" href="/admin.html">Przejdź do panelu</a></p>`;
  });
}

void mountAccountNav(document.getElementById('account-nav'));
void load();
