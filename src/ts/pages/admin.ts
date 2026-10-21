import { isAdmin, mountAccountNav, requireUser } from '../lib/auth';
import { LAB_BUCKET, supabase } from '../lib/supabase';
import { type Appointment, type AppointmentStatus, one, type Profile, type Slot } from '../lib/types';
import {
  $,
  $$,
  busy,
  dayKey,
  errorMessage,
  esc,
  fmtDateTime,
  fmtDay,
  fmtPrice,
  fmtShort,
  fmtTime,
  MODE_LABEL,
  PAYMENT_LABEL,
  statusPill,
  TIME_ZONE,
  toast,
} from '../lib/ui';
import type { Answers } from '../questionnaire/questions';
import { summarize } from '../questionnaire/summary';

// Explicit FK hints: questionnaires links appointments and profiles, so PostgREST could see two paths.
const APPT_SELECT =
  '*, services(name), profiles!appointments_user_id_fkey(id,email,full_name,phone), questionnaires!questionnaires_appointment_id_fkey(submitted_at,updated_at)';

type QMeta = { submitted_at: string | null; updated_at: string };
type Row = Appointment & {
  services: { name: string } | null;
  profiles: Profile | null;
  questionnaires: QMeta | QMeta[] | null;
};

interface ClientRow {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  appointments_total: number;
  appointments_upcoming: number;
  last_visit_at: string | null;
  next_visit_at: string | null;
  questionnaires_sent: number;
}

let appointments: Row[] = [];
let slots: Slot[] = [];
let clients: ClientRow[] = [];

const detail = $<HTMLDialogElement>('#detail');
const detailBody = $('#detail-body');

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadAppointments(): Promise<void> {
  const { data, error } = await supabase
    .from('appointments')
    .select(APPT_SELECT)
    .order('starts_at', { ascending: true, nullsFirst: false })
    .limit(2000);
  if (error) throw error;
  appointments = (data ?? []) as Row[];
}

async function loadSlots(): Promise<void> {
  const since = new Date(Date.now() - 62 * 86400_000).toISOString();
  const { data, error } = await supabase
    .from('slots')
    .select('id,starts_at,ends_at')
    .gte('starts_at', since)
    .order('starts_at')
    .limit(3000);
  if (error) throw error;
  slots = (data ?? []) as Slot[];
}

async function loadClients(): Promise<void> {
  const { data, error } = await supabase.rpc('admin_clients');
  if (error) throw error;
  clients = (data ?? []) as ClientRow[];
}

const isActive = (a: Row): boolean => a.status === 'pending' || a.status === 'confirmed';
const isFuture = (a: Row): boolean => !a.starts_at || new Date(a.starts_at) > new Date();
const clientName = (a: Row): string => a.profiles?.full_name || a.profiles?.email || 'Klient';
const takenSlotIds = (): Set<string> =>
  new Set(appointments.filter((a) => isActive(a) && a.slot_id).map((a) => a.slot_id as string));

async function reloadAll(): Promise<void> {
  try {
    await Promise.all([loadAppointments(), loadSlots(), loadClients()]);
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
  renderStats();
  renderAppointments();
  renderCalendar();
  renderSlots();
  renderClients();
  void renderQuestionnaires();
}

// ---------------------------------------------------------------------------
// Tabs + stats
// ---------------------------------------------------------------------------
const loaded = new Set<string>();
function showTab(name: string): void {
  $$<HTMLButtonElement>('.seg [data-tab]').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === name)),
  );
  $$<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === 'maile') void renderEmails();
  if (name === 'baza' && !loaded.has('baza')) {
    loaded.add('baza');
    void initDatabase();
  }
}
$$<HTMLButtonElement>('.seg [data-tab]').forEach((b) =>
  b.addEventListener('click', () => showTab(b.dataset.tab ?? '')),
);

function renderStats(): void {
  const pending = appointments.filter((a) => a.status === 'pending').length;
  const upcoming = appointments.filter((a) => a.status === 'confirmed' && isFuture(a)).length;
  const taken = takenSlotIds();
  const free = slots.filter((s) => !taken.has(s.id) && new Date(s.starts_at) > new Date()).length;
  const toReview = appointments.filter(
    (a) => a.status === 'confirmed' && isFuture(a) && one(a.questionnaires)?.submitted_at,
  ).length;
  const stat = (n: number, label: string, tab: string, filter = '', attention = false): string =>
    `<button type="button" class="stat${attention && n ? ' attention' : ''}" data-go="${tab}" data-filter="${filter}"><b>${n}</b><span>${esc(label)}</span></button>`;
  $('#stats').innerHTML = [
    stat(pending, 'do potwierdzenia', 'wizyty', 'todo', true),
    stat(upcoming, 'nadchodzące wizyty', 'wizyty', 'upcoming'),
    stat(toReview, 'kwestionariusze przed wizytą', 'kwestionariusze'),
    stat(free, 'wolne terminy', 'terminy'),
    stat(clients.length, 'klientów', 'klienci'),
  ].join('');
}
$('#stats').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-go]');
  if (!b) return;
  if (b.dataset.filter) {
    $<HTMLSelectElement>('#f-status').value = b.dataset.filter;
    renderAppointments();
  }
  showTab(b.dataset.go ?? 'wizyty');
});

// ---------------------------------------------------------------------------
// Appointments list
// ---------------------------------------------------------------------------
function appointmentCard(a: Row): string {
  const q = one(a.questionnaires);
  return `<article class="appt" data-open="${a.id}" role="button" tabindex="0" style="cursor:pointer">
    <div class="appt-head">
      <div><div class="appt-title">${esc(clientName(a))} · ${esc(a.services?.name ?? a.service_id)}</div>
      <div class="appt-when">${esc(fmtDateTime(a.starts_at))}${a.starts_at ? ` · ${esc(MODE_LABEL[a.mode])}` : ''}</div></div>
      ${statusPill(a.status)}
    </div>
    <div class="muted small">${esc(fmtPrice(a.price_pln))}${a.payment_status === 'unpaid' ? ` · ${PAYMENT_LABEL.unpaid}` : ''}${
      a.status === 'confirmed' ? ` · kwestionariusz: ${q?.submitted_at ? 'wysłany ✓' : q ? 'w trakcie' : 'brak'}` : ''
    }${a.client_note ? ` · „${esc(a.client_note.slice(0, 80))}${a.client_note.length > 80 ? '…' : ''}”` : ''}</div>
  </article>`;
}

function renderAppointments(): void {
  const filter = $<HTMLSelectElement>('#f-status').value;
  const term = $<HTMLInputElement>('#f-search').value.trim().toLowerCase();
  let rows = appointments.filter((a) => {
    if (filter === 'todo') return a.status === 'pending';
    if (filter === 'upcoming') return isActive(a) && isFuture(a);
    if (filter === 'past') return !isFuture(a) || !isActive(a);
    return true;
  });
  if (term) {
    rows = rows.filter((a) =>
      [a.profiles?.full_name, a.profiles?.email, a.profiles?.phone, a.services?.name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term)),
    );
  }
  if (filter === 'past' || filter === 'all') rows = [...rows].reverse();
  $('#a-list').innerHTML = rows.length ? rows.map(appointmentCard).join('') : '<p class="empty">Brak wizyt.</p>';
}
$('#f-status').addEventListener('change', renderAppointments);
$('#f-search').addEventListener('input', renderAppointments);
for (const id of ['#a-list', '#cal']) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
    if (t?.dataset.open) void openDetail(t.dataset.open);
  });
  el.addEventListener('keydown', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
    if (t?.dataset.open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      void openDetail(t.dataset.open);
    }
  });
}

// ---------------------------------------------------------------------------
// Appointment detail (actions, questionnaire answers, lab results)
// ---------------------------------------------------------------------------
function answersHtml(answers: Answers): string {
  return `<div class="answers">${summarize(answers)
    .map(
      (s) =>
        `<section><h3>${esc(s.title)}</h3><dl>${s.items
          .map((i) => `<dt>${esc(i.question)}</dt><dd>${esc(i.answer)}</dd>`)
          .join('')}</dl></section>`,
    )
    .join('')}</div>`;
}

function actionsHtml(a: Row): string {
  const buttons: string[] = [];
  if (a.status === 'pending') {
    buttons.push('<button class="btn btn-primary btn-sm" type="button" data-status="confirmed">Potwierdź</button>');
    buttons.push('<button class="btn btn-danger btn-sm" type="button" data-status="rejected">Odrzuć</button>');
  }
  if (a.status === 'confirmed') {
    buttons.push(
      '<button class="btn btn-outline btn-sm" type="button" data-status="completed">Oznacz jako odbytą</button>',
    );
  }
  if (isActive(a))
    buttons.push('<button class="btn btn-danger btn-sm" type="button" data-status="cancelled">Odwołaj</button>');
  if (!buttons.length) return '';
  return `<div class="stack">
    <label>Wiadomość do klienta (opcjonalnie, trafi do e-maila)<textarea id="d-msg" maxlength="2000" placeholder="Np. link do spotkania, propozycja innego terminu"></textarea></label>
    <div class="appt-actions">${buttons.join('')}</div>
  </div>`;
}

async function openDetail(id: string): Promise<void> {
  history.replaceState(null, '', `#wizyta-${id}`);
  $('#detail-title').textContent = 'Wizyta';
  $('#detail-sub').textContent = '';
  detailBody.innerHTML = '<p class="loading">Wczytuję…</p>';
  if (!detail.open) detail.showModal();

  const [{ data, error }, q] = await Promise.all([
    supabase.from('appointments').select(APPT_SELECT).eq('id', id).maybeSingle(),
    supabase.from('questionnaires').select('answers,submitted_at,updated_at').eq('appointment_id', id).maybeSingle(),
  ]);
  if (error || !data) {
    detailBody.innerHTML = `<p class="form-error">${esc(error ? errorMessage(error) : 'Nie znaleziono wizyty.')}</p>`;
    return;
  }
  const a = data as Row;
  const qa = q.data as { answers: Answers; submitted_at: string | null; updated_at: string } | null;
  $('#detail-title').textContent = clientName(a);
  $('#detail-sub').textContent = `${a.services?.name ?? ''} · ${fmtDateTime(a.starts_at)}`;

  detailBody.innerHTML = `<div class="stack">
    <div>${statusPill(a.status)}</div>
    <dl class="meta-grid">
      <dt>Usługa</dt><dd>${esc(a.services?.name ?? a.service_id)} (${esc(fmtPrice(a.price_pln))})</dd>
      <dt>Termin</dt><dd>${esc(fmtDateTime(a.starts_at))}</dd>
      ${a.starts_at ? `<dt>Forma</dt><dd>${esc(MODE_LABEL[a.mode])}</dd>` : ''}
      <dt>Płatność</dt><dd>${esc(PAYMENT_LABEL[a.payment_status])}</dd>
      <dt>E-mail</dt><dd><a href="mailto:${esc(a.profiles?.email ?? '')}">${esc(a.profiles?.email ?? '—')}</a></dd>
      <dt>Telefon</dt><dd>${a.profiles?.phone ? `<a href="tel:${esc(a.profiles.phone.replace(/\s+/g, ''))}">${esc(a.profiles.phone)}</a>` : '—'}</dd>
      ${a.client_note ? `<dt>Uwagi klienta</dt><dd>${esc(a.client_note)}</dd>` : ''}
      ${a.admin_message ? `<dt>Twoja wiadomość</dt><dd>${esc(a.admin_message)}</dd>` : ''}
      <dt>Zarezerwowano</dt><dd>${esc(fmtShort(a.created_at))}</dd>
    </dl>
    ${actionsHtml(a)}
    <h3 class="section-title">Wyniki badań</h3>
    <ul class="files" id="d-files"><li>Wczytuję…</li></ul>
    <h3 class="section-title">Kwestionariusz ${
      qa?.submitted_at
        ? `<span class="pill confirmed">wysłany ${esc(fmtShort(qa.submitted_at))}</span>`
        : qa
          ? '<span class="pill pending">w trakcie wypełniania</span>'
          : ''
    }</h3>
    ${qa ? answersHtml(qa.answers) : '<p class="muted">Klient jeszcze nie zaczął wypełniać kwestionariusza.</p>'}
  </div>`;

  detailBody.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.dataset.armed !== '1' && btn.dataset.status !== 'confirmed') {
        btn.dataset.armed = '1';
        btn.textContent = 'Na pewno?';
        return;
      }
      const message = detailBody.querySelector<HTMLTextAreaElement>('#d-msg')?.value.trim() || null;
      await busy(btn, 'Zapisuję…', async () => {
        const { error: err } = await supabase.rpc('admin_set_status', {
          p_id: a.id,
          p_status: btn.dataset.status as AppointmentStatus,
          p_message: message,
        });
        if (err) return toast(errorMessage(err), 'error');
        toast('Zapisano. Klient dostanie e-mail.');
        await reloadAll();
        await openDetail(a.id);
      });
    }),
  );

  void listFiles(a);
}

async function listFiles(a: Row): Promise<void> {
  const el = detailBody.querySelector<HTMLElement>('#d-files');
  if (!el) return;
  const folder = `${a.user_id}/${a.id}`;
  const { data, error } = await supabase.storage.from(LAB_BUCKET).list(folder);
  if (error) {
    el.innerHTML = `<li>${esc(errorMessage(error))}</li>`;
    return;
  }
  const files = (data ?? []).filter((f) => f.id);
  el.innerHTML = files.length
    ? files
        .map(
          (f) =>
            `<li><span>📄 ${esc(f.name.replace(/^\d+-/, ''))}</span><button class="btn btn-outline btn-sm" type="button" data-file="${esc(`${folder}/${f.name}`)}">Otwórz</button></li>`,
        )
        .join('')
    : '<li>Brak plików.</li>';
  el.querySelectorAll<HTMLButtonElement>('[data-file]').forEach((b) =>
    b.addEventListener('click', async () => {
      // Open the tab synchronously (popup blockers), then point it at a short-lived signed URL.
      const tab = window.open('about:blank', '_blank');
      const { data: signed, error: err } = await supabase.storage
        .from(LAB_BUCKET)
        .createSignedUrl(b.dataset.file ?? '', 300);
      if (err || !signed) {
        tab?.close();
        return toast(errorMessage(err), 'error');
      }
      if (tab) {
        tab.opener = null;
        tab.location.href = signed.signedUrl;
      } else location.href = signed.signedUrl;
    }),
  );
}

$$('[data-close]', detail).forEach((el) => el.addEventListener('click', () => detail.close()));
detail.addEventListener('click', (e) => {
  if (e.target === detail) detail.close();
});
detail.addEventListener('close', () => history.replaceState(null, '', location.pathname));

// ---------------------------------------------------------------------------
// Calendar (month view, Mondays first, clinic time zone)
// ---------------------------------------------------------------------------
const monthFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TIME_ZONE, month: 'long', year: 'numeric' });
let calMonth = (() => {
  const [y, m] = dayKey(new Date().toISOString()).split('-').map(Number);
  return { y: y as number, m: (m as number) - 1 };
})();

function renderCalendar(): void {
  const { y, m } = calMonth;
  $('#cal-title').textContent = monthFmt.format(new Date(Date.UTC(y, m, 15, 12)));
  const first = new Date(Date.UTC(y, m, 1, 12));
  const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(first.getTime() - offset * 86400_000);
  const today = dayKey(new Date().toISOString());
  const taken = takenSlotIds();

  const byDay = new Map<string, string[]>();
  const push = (key: string, html: string): void => {
    byDay.set(key, [...(byDay.get(key) ?? []), html]);
  };
  const events = appointments
    .filter((a) => a.starts_at && a.status !== 'rejected' && a.status !== 'cancelled')
    .map((a) => ({
      at: a.starts_at as string,
      html: `<button type="button" class="ev ${a.status}" data-open="${a.id}" title="${esc(`${clientName(a)} · ${a.services?.name ?? ''}`)}">${esc(fmtTime(a.starts_at as string))} ${esc(clientName(a))}</button>`,
    }));
  const free = slots
    .filter((s) => !taken.has(s.id))
    .map((s) => ({ at: s.starts_at, html: `<span class="ev free">${esc(fmtTime(s.starts_at))} wolny</span>` }));
  for (const ev of [...events, ...free].sort((a, b) => a.at.localeCompare(b.at))) push(dayKey(ev.at), ev.html);

  const dows = ['pon', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'].map((d) => `<div class="dow">${d}</div>`).join('');
  const cells: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86400_000);
    const key = d.toISOString().slice(0, 10);
    const out = d.getUTCMonth() !== m;
    if (i >= 35 && out) break;
    cells.push(`<div class="day${out ? ' out' : ''}${key === today ? ' today' : ''}">
      <span class="num">${d.getUTCDate()}</span>${(byDay.get(key) ?? []).join('')}</div>`);
  }
  $('#cal').innerHTML = dows + cells.join('');
}
const shiftMonth = (delta: number): void => {
  const d = new Date(Date.UTC(calMonth.y, calMonth.m + delta, 1));
  calMonth = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  renderCalendar();
};
$('#cal-prev').addEventListener('click', () => shiftMonth(-1));
$('#cal-next').addEventListener('click', () => shiftMonth(1));
$('#cal-today').addEventListener('click', () => {
  const [y, m] = dayKey(new Date().toISOString()).split('-').map(Number);
  calMonth = { y: y as number, m: (m as number) - 1 };
  renderCalendar();
});

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------
function renderSlots(): void {
  const taken = takenSlotIds();
  const byAppt = new Map(appointments.filter((a) => isActive(a) && a.slot_id).map((a) => [a.slot_id as string, a]));
  const future = slots.filter((s) => new Date(s.ends_at) > new Date());
  if (!future.length) {
    $('#s-list').innerHTML = '<p class="empty">Brak przyszłych terminów. Dodaj je formularzem powyżej.</p>';
    return;
  }
  const days = new Map<string, Slot[]>();
  for (const s of future) days.set(dayKey(s.starts_at), [...(days.get(dayKey(s.starts_at)) ?? []), s]);
  $('#s-list').innerHTML = [...days.values()]
    .map(
      (list) =>
        `<div class="slot-day"><h3>${esc(fmtDay((list[0] as Slot).starts_at))}</h3>${list
          .map((s) => {
            const a = byAppt.get(s.id);
            return `<div class="slot-row${taken.has(s.id) ? ' taken' : ''}">
            <span>${esc(fmtTime(s.starts_at))}–${esc(fmtTime(s.ends_at))}${a ? ` · <a href="#wizyta-${a.id}" data-open="${a.id}">${esc(clientName(a))}</a> ${statusPill(a.status)}` : ' · wolny'}</span>
            ${a ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-del="${s.id}">Usuń</button>`}
          </div>`;
          })
          .join('')}</div>`,
    )
    .join('');
}

$('#s-list').addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const open = target.closest<HTMLElement>('[data-open]');
  if (open?.dataset.open) {
    e.preventDefault();
    return void openDetail(open.dataset.open);
  }
  const del = target.closest<HTMLButtonElement>('[data-del]');
  if (!del) return;
  del.disabled = true;
  const { error } = await supabase.rpc('admin_delete_slot', { p_id: del.dataset.del });
  if (error) {
    del.disabled = false;
    return toast(errorMessage(error), 'error');
  }
  slots = slots.filter((s) => s.id !== del.dataset.del);
  renderSlots();
  renderCalendar();
  renderStats();
});

$<HTMLFormElement>('#slot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const day = $<HTMLInputElement>('#s-day').value;
  if (!day) return toast('Wybierz dzień.', 'error');
  const weeks = Math.min(12, Math.max(1, Number($<HTMLInputElement>('#s-weeks').value) || 1));
  const btn = $<HTMLButtonElement>('#slot-form button[type=submit]');
  await busy(btn, 'Dodaję…', async () => {
    let added = 0;
    for (let w = 0; w < weeks; w++) {
      const d = new Date(`${day}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 7 * w);
      const { data, error } = await supabase.rpc('admin_add_slots', {
        p_day: d.toISOString().slice(0, 10),
        p_from: $<HTMLInputElement>('#s-from').value,
        p_to: $<HTMLInputElement>('#s-to').value,
        p_duration_min: Number($<HTMLInputElement>('#s-dur').value),
        p_break_min: Number($<HTMLInputElement>('#s-break').value) || 0,
      });
      if (error) return toast(errorMessage(error), 'error');
      added += Number(data ?? 0);
    }
    toast(added ? `Dodano terminy: ${added}.` : 'Nie dodano nowych terminów (nakładają się z istniejącymi).');
    await loadSlots();
    renderSlots();
    renderCalendar();
    renderStats();
  });
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
function renderClients(): void {
  const term = $<HTMLInputElement>('#c-search').value.trim().toLowerCase();
  const rows = clients.filter(
    (c) => !term || [c.full_name, c.email, c.phone].filter(Boolean).some((v) => String(v).toLowerCase().includes(term)),
  );
  $('#c-list').innerHTML = rows.length
    ? `<table class="data"><thead><tr><th>Klient</th><th>Kontakt</th><th>Wizyty</th><th>Najbliższa</th><th>Ostatnia</th><th>Kwest.</th><th>Konto od</th></tr></thead><tbody>${rows
        .map(
          (c) => `<tr class="click" data-client="${c.id}">
          <td><strong>${esc(c.full_name ?? '—')}</strong></td>
          <td>${esc(c.email)}${c.phone ? `<br><span class="muted">${esc(c.phone)}</span>` : ''}</td>
          <td>${c.appointments_total}${c.appointments_upcoming ? ` <span class="muted">(${c.appointments_upcoming} aktywne)</span>` : ''}</td>
          <td>${esc(c.next_visit_at ? fmtShort(c.next_visit_at) : '—')}</td>
          <td>${esc(c.last_visit_at ? fmtShort(c.last_visit_at) : '—')}</td>
          <td>${c.questionnaires_sent}</td>
          <td>${esc(fmtShort(c.created_at).slice(0, 10))}</td>
        </tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="empty">Brak klientów.</p>';
}
$('#c-search').addEventListener('input', renderClients);
$('#c-list').addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLElement>('[data-client]');
  if (tr?.dataset.client) openClient(tr.dataset.client);
});

function openClient(id: string): void {
  const c = clients.find((x) => x.id === id);
  if (!c) return;
  const list = appointments.filter((a) => a.user_id === id).reverse();
  $('#detail-title').textContent = c.full_name ?? c.email;
  $('#detail-sub').textContent = 'Klient';
  detailBody.innerHTML = `<div class="stack">
    <dl class="meta-grid">
      <dt>E-mail</dt><dd><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd>
      <dt>Telefon</dt><dd>${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : '—'}</dd>
      <dt>Konto od</dt><dd>${esc(fmtShort(c.created_at))}</dd>
    </dl>
    <h3 class="section-title">Wizyty (${list.length})</h3>
    <div class="list">${list.length ? list.map(appointmentCard).join('') : '<p class="empty">Brak wizyt.</p>'}</div>
  </div>`;
  detailBody
    .querySelectorAll<HTMLElement>('[data-open]')
    .forEach((el) => el.addEventListener('click', () => void openDetail(el.dataset.open ?? '')));
  if (!detail.open) detail.showModal();
}

// ---------------------------------------------------------------------------
// Questionnaires
// ---------------------------------------------------------------------------
async function renderQuestionnaires(): Promise<void> {
  const filter = $<HTMLSelectElement>('#q-filter').value;
  let query = supabase
    .from('questionnaires')
    .select(
      'appointment_id,submitted_at,updated_at,current_step,profiles!questionnaires_user_id_fkey(full_name,email),appointments!questionnaires_appointment_id_fkey(starts_at,status,services(name))',
    )
    .order('updated_at', { ascending: false })
    .limit(500);
  if (filter === 'submitted') query = query.not('submitted_at', 'is', null);
  if (filter === 'draft') query = query.is('submitted_at', null);
  const { data, error } = await query;
  if (error) {
    $('#q-list').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  type QRow = {
    appointment_id: string;
    submitted_at: string | null;
    updated_at: string;
    profiles: { full_name: string | null; email: string } | null;
    appointments: { starts_at: string | null; status: AppointmentStatus; services: { name: string } | null } | null;
  };
  const rows = (data ?? []) as unknown as QRow[];
  $('#q-list').innerHTML = rows.length
    ? `<table class="data"><thead><tr><th>Klient</th><th>Wizyta</th><th>Status</th><th>Ostatnia zmiana</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr class="click" data-open="${r.appointment_id}">
          <td><strong>${esc(r.profiles?.full_name ?? r.profiles?.email ?? '—')}</strong></td>
          <td>${esc(r.appointments?.services?.name ?? '')}<br><span class="muted">${esc(fmtDateTime(r.appointments?.starts_at ?? null))}</span></td>
          <td>${r.submitted_at ? `<span class="pill confirmed">wysłany ${esc(fmtShort(r.submitted_at))}</span>` : '<span class="pill pending">w trakcie</span>'}</td>
          <td>${esc(fmtShort(r.updated_at))}</td>
        </tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="empty">Brak kwestionariuszy.</p>';
}
$('#q-filter').addEventListener('change', () => void renderQuestionnaires());
$('#q-list').addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
  if (tr?.dataset.open) void openDetail(tr.dataset.open);
});

// ---------------------------------------------------------------------------
// E-mail log
// ---------------------------------------------------------------------------
const MAIL_STATUS: Record<string, string> = {
  queued: 'w kolejce',
  sending: 'wysyłanie',
  sent: 'wysłana',
  failed: 'błąd',
  skipped: 'pominięta',
};

async function renderEmails(): Promise<void> {
  const { data, error } = await supabase.rpc('admin_email_log', { p_limit: 200 });
  if (error) {
    $('#m-list').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  type Mail = {
    id: number;
    to_email: string;
    subject: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: string;
  };
  const rows = (data ?? []) as Mail[];
  $('#m-list').innerHTML = rows.length
    ? `<table class="data"><thead><tr><th>Kiedy</th><th>Do</th><th>Temat</th><th>Status</th></tr></thead><tbody>${rows
        .map(
          (m) => `<tr><td>${esc(fmtShort(m.created_at))}</td><td>${esc(m.to_email)}</td><td>${esc(m.subject)}</td>
          <td>${esc(MAIL_STATUS[m.status] ?? m.status)}${m.last_error && m.status !== 'skipped' ? `<br><span class="muted small">${esc(m.last_error)}</span>` : ''}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="empty">Brak wiadomości.</p>';
}

// ---------------------------------------------------------------------------
// Database browser (read-only)
// ---------------------------------------------------------------------------
const PAGE = 50;
let dbOffset = 0;
let dbSearchTimer: number | undefined;

type DbPage = { total: number; rows: Record<string, unknown>[]; limit: number; offset: number };

async function fetchDb(offset: number, limit = PAGE): Promise<DbPage> {
  const { data, error } = await supabase.rpc('admin_db_rows', {
    p_table: $<HTMLSelectElement>('#db-table').value,
    p_limit: limit,
    p_offset: offset,
    p_search: $<HTMLInputElement>('#db-search').value.trim() || null,
  });
  if (error) throw error;
  return data as DbPage;
}

const cell = (v: unknown): string => {
  if (v == null) return '<td class="muted">—</td>';
  if (typeof v === 'object') return `<td class="json">${esc(JSON.stringify(v, null, 1))}</td>`;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? `<td>${esc(fmtShort(s))}</td>` : `<td>${esc(s)}</td>`;
};

async function renderDb(): Promise<void> {
  const wrap = $('#db-rows');
  wrap.innerHTML = '<p class="loading">Wczytuję…</p>';
  try {
    const page = await fetchDb(dbOffset);
    const cols = [...new Set(page.rows.flatMap((r) => Object.keys(r)))];
    wrap.innerHTML = page.rows.length
      ? `<table class="data"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${page.rows
          .map((r) => `<tr>${cols.map((c) => cell(r[c])).join('')}</tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">Brak wierszy.</p>';
    const to = Math.min(page.offset + page.limit, page.total);
    $('#db-pager').innerHTML = `<span>${page.total ? `${page.offset + 1}–${to} z ${page.total}` : '0 wierszy'}</span>
      <button class="btn btn-outline btn-sm" type="button" id="db-prev" ${page.offset === 0 ? 'disabled' : ''}>←</button>
      <button class="btn btn-outline btn-sm" type="button" id="db-next" ${to >= page.total ? 'disabled' : ''}>→</button>`;
    $('#db-prev').addEventListener('click', () => {
      dbOffset = Math.max(0, dbOffset - PAGE);
      void renderDb();
    });
    $('#db-next').addEventListener('click', () => {
      dbOffset += PAGE;
      void renderDb();
    });
  } catch (error) {
    wrap.innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
  }
}

async function initDatabase(): Promise<void> {
  const { data, error } = await supabase.rpc('admin_db_tables');
  if (error) {
    $('#db-rows').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  const tables = (data ?? []) as { name: string; label: string; row_count: number }[];
  $('#db-table').innerHTML = tables
    .map((t) => `<option value="${esc(t.name)}">${esc(t.label)} (${t.row_count})</option>`)
    .join('');
  void renderDb();
}
$('#db-table').addEventListener('change', () => {
  dbOffset = 0;
  void renderDb();
});
$('#db-search').addEventListener('input', () => {
  window.clearTimeout(dbSearchTimer);
  dbSearchTimer = window.setTimeout(() => {
    dbOffset = 0;
    void renderDb();
  }, 300);
});

const csvValue = (v: unknown): string => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

$<HTMLButtonElement>('#db-csv').addEventListener('click', async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  await busy(btn, 'Przygotowuję…', async () => {
    try {
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await fetchDb(offset, 200);
        rows.push(...page.rows);
        if (offset + 200 >= page.total || offset >= 20000) break;
      }
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvValue(r[c])).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${$<HTMLSelectElement>('#db-table').value}-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
$('#refresh').addEventListener('click', () => void reloadAll());

async function init(): Promise<void> {
  await requireUser();
  void mountAccountNav(document.getElementById('account-nav'));
  if (!(await isAdmin())) {
    $('#no-access').hidden = false;
    return;
  }
  $('#admin').hidden = false;
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  $<HTMLInputElement>('#s-day').value = tomorrow;
  $<HTMLInputElement>('#s-day').min = new Date().toISOString().slice(0, 10);
  await reloadAll();
  const match = /^#wizyta-([0-9a-f-]{36})$/i.exec(location.hash);
  if (match?.[1]) void openDetail(match[1]);
}

void init();
