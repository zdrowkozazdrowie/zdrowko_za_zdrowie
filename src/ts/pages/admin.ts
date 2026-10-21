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
    await Promise.all([loadAppointments(), loadSlots(), loadClients(), loadSchedule()]);
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
  renderStats();
  renderAppointments();
  renderCalendar();
  renderSlots();
  renderClients();
  renderSchedule();
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

// ---------------------------------------------------------------------------
// Questionnaire link box (copy / SMS / WhatsApp / e-mail / new link)
// ---------------------------------------------------------------------------
interface LinkInfo {
  questionnaire_id: string | null;
  url: string;
  folders: string[];
}
interface Contact {
  name: string | null;
  phone: string | null;
  email: string | null;
}

function linkMessage(c: Contact, url: string): string {
  const hello = c.name ? `Cześć ${c.name.split(' ')[0]},` : 'Cześć,';
  return `${hello}\nprzed naszym spotkaniem proszę o wypełnienie krótkiego kwestionariusza (ok. 10 minut): ${url}\nOdpowiedzi zapisują się automatycznie, a na końcu można dołączyć wyniki badań.`;
}

function linkBoxHtml(info: LinkInfo, c: Contact): string {
  const msg = linkMessage(c, info.url);
  const digits = (c.phone ?? '').replace(/[^\d+]/g, '');
  const wa = digits.replace(/^\+/, '').replace(/^(\d{9})$/, '48$1');
  return `<div class="link-box">
    <div class="link-row"><input type="text" readonly value="${esc(info.url)}" aria-label="Link do kwestionariusza" data-link-url>
      <button class="btn btn-primary btn-sm" type="button" data-link-copy>Kopiuj link</button></div>
    <div class="appt-actions">
      <button class="btn btn-outline btn-sm" type="button" data-link-copy-msg>Kopiuj z wiadomością</button>
      ${digits ? `<a class="btn btn-outline btn-sm" href="sms:${esc(digits)}?body=${encodeURIComponent(msg)}">SMS</a>` : ''}
      ${wa ? `<a class="btn btn-outline btn-sm" href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
      ${c.email ? `<a class="btn btn-outline btn-sm" href="mailto:${esc(c.email)}?subject=${encodeURIComponent('Kwestionariusz przed wizytą')}&body=${encodeURIComponent(msg)}">E-mail</a>` : ''}
      <button class="btn btn-ghost btn-sm" type="button" data-link-reset>Nowy link</button>
    </div>
    <p class="muted small">Link działa bez logowania. Wyślij go wybranym kanałem. „Nowy link” wyłącza stary (np. gdy trafił do złej osoby).</p>
  </div>`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Skopiowano.');
  } catch {
    toast('Nie udało się skopiować. Zaznacz link i skopiuj ręcznie.', 'error');
  }
}

function bindLinkBox(root: HTMLElement, info: LinkInfo, c: Contact, reset: () => Promise<void>): void {
  root.querySelector('[data-link-copy]')?.addEventListener('click', () => void copyText(info.url));
  root.querySelector('[data-link-copy-msg]')?.addEventListener('click', () => void copyText(linkMessage(c, info.url)));
  root
    .querySelector<HTMLInputElement>('[data-link-url]')
    ?.addEventListener('focus', (e) => (e.target as HTMLInputElement).select());
  const btn = root.querySelector<HTMLButtonElement>('[data-link-reset]');
  btn?.addEventListener('click', async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Stary link przestanie działać. Na pewno?';
      return;
    }
    await busy(btn, 'Tworzę…', reset);
  });
}

// ---------------------------------------------------------------------------
// Lab result files (account folder and link folders)
// ---------------------------------------------------------------------------
async function renderFiles(el: HTMLElement | null, folders: string[]): Promise<void> {
  if (!el) return;
  const all: { path: string; name: string }[] = [];
  for (const folder of folders) {
    const { data, error } = await supabase.storage.from(LAB_BUCKET).list(folder);
    if (error) {
      el.innerHTML = `<li>${esc(errorMessage(error))}</li>`;
      return;
    }
    for (const f of data ?? []) if (f.id) all.push({ path: `${folder}/${f.name}`, name: f.name });
  }
  el.innerHTML = all.length
    ? all
        .map(
          (f) =>
            `<li><span>📄 ${esc(f.name.replace(/^\d+-/, ''))}</span><button class="btn btn-outline btn-sm" type="button" data-file="${esc(f.path)}">Otwórz</button></li>`,
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

type QFull = {
  id: string;
  label: string | null;
  appointment_id: string | null;
  answers: Answers;
  submitted_at: string | null;
  updated_at: string;
};

function questionnaireStatus(q: QFull | null): string {
  if (q?.submitted_at) return `<span class="pill confirmed">wysłany ${esc(fmtShort(q.submitted_at))}</span>`;
  if (q && Object.keys(q.answers ?? {}).length) return '<span class="pill pending">w trakcie wypełniania</span>';
  return '<span class="pill cancelled">nie rozpoczęty</span>';
}

// ---------------------------------------------------------------------------
// Appointment detail (actions, questionnaire link + answers, lab results)
// ---------------------------------------------------------------------------
function bindDeleteQuestionnaire(id: string, after: () => Promise<void>): void {
  const btn = detailBody.querySelector<HTMLButtonElement>('[data-q-delete]');
  btn?.addEventListener('click', async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Na pewno usunąć odpowiedzi?';
      return;
    }
    await busy(btn, 'Usuwam…', async () => {
      const { error } = await supabase.rpc('admin_delete_questionnaire', { p_id: id });
      if (error) return toast(errorMessage(error), 'error');
      toast('Kwestionariusz usunięty.');
      await reloadAll();
      await after();
    });
  });
}
const DELETE_BTN =
  '<div><button class="btn btn-danger btn-sm" type="button" data-q-delete>Usuń kwestionariusz</button></div>';

async function openDetail(id: string): Promise<void> {
  history.replaceState(null, '', `#wizyta-${id}`);
  $('#detail-title').textContent = 'Wizyta';
  $('#detail-sub').textContent = '';
  detailBody.innerHTML = '<p class="loading">Wczytuję…</p>';
  if (!detail.open) detail.showModal();

  const [{ data, error }, q, link] = await Promise.all([
    supabase.from('appointments').select(APPT_SELECT).eq('id', id).maybeSingle(),
    supabase
      .from('questionnaires')
      .select('id,label,appointment_id,answers,submitted_at,updated_at')
      .eq('appointment_id', id)
      .maybeSingle(),
    supabase.rpc('admin_questionnaire_link', { p_appointment_id: id }),
  ]);
  if (error || !data) {
    detailBody.innerHTML = `<p class="form-error">${esc(error ? errorMessage(error) : 'Nie znaleziono wizyty.')}</p>`;
    return;
  }
  const a = data as Row;
  const qa = q.data as QFull | null;
  const info = link.data as LinkInfo | null;
  const contact: Contact = {
    name: a.profiles?.full_name ?? null,
    phone: a.profiles?.phone ?? null,
    email: a.profiles?.email ?? null,
  };
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
    <h3 class="section-title">Link do kwestionariusza ${questionnaireStatus(qa)}</h3>
    ${
      info && isActive(a)
        ? linkBoxHtml(info, contact)
        : `<p class="muted">${link.error ? esc(errorMessage(link.error)) : 'Wizyta nie jest aktywna, więc link jest wyłączony.'}</p>`
    }
    <h3 class="section-title">Wyniki badań</h3>
    <ul class="files" id="d-files"><li>Wczytuję…</li></ul>
    <h3 class="section-title">Odpowiedzi</h3>
    ${qa && Object.keys(qa.answers ?? {}).length ? answersHtml(qa.answers) : '<p class="muted">Klient jeszcze nie zaczął wypełniać kwestionariusza.</p>'}
    ${qa ? DELETE_BTN : ''}
  </div>`;

  if (info && isActive(a)) {
    bindLinkBox(detailBody, info, contact, async () => {
      const { error: err } = await supabase.rpc('admin_questionnaire_link', { p_appointment_id: id, p_reset: true });
      if (err) return toast(errorMessage(err), 'error');
      toast('Utworzono nowy link. Stary już nie działa.');
      await openDetail(id);
    });
  }

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
        toast('Zapisano.');
        await reloadAll();
        await openDetail(a.id);
      });
    }),
  );

  if (qa) bindDeleteQuestionnaire(qa.id, () => openDetail(id));
  void renderFiles(detailBody.querySelector('#d-files'), [`${a.user_id}/${a.id}`, ...(info?.folders ?? [])]);
}

// ---------------------------------------------------------------------------
// Questionnaire without an appointment
// ---------------------------------------------------------------------------
async function openQuestionnaire(id: string): Promise<void> {
  history.replaceState(null, '', `#kwestionariusz-${id}`);
  $('#detail-title').textContent = 'Kwestionariusz';
  $('#detail-sub').textContent = 'bez wizyty';
  detailBody.innerHTML = '<p class="loading">Wczytuję…</p>';
  if (!detail.open) detail.showModal();

  const [q, link] = await Promise.all([
    supabase
      .from('questionnaires')
      .select('id,label,appointment_id,answers,submitted_at,updated_at')
      .eq('id', id)
      .maybeSingle(),
    supabase.rpc('admin_questionnaire_link', { p_questionnaire_id: id }),
  ]);
  const qa = q.data as QFull | null;
  if (q.error || !qa) {
    detailBody.innerHTML = `<p class="form-error">${esc(q.error ? errorMessage(q.error) : 'Nie znaleziono kwestionariusza.')}</p>`;
    return;
  }
  if (qa.appointment_id) return openDetail(qa.appointment_id);
  const info = link.data as LinkInfo | null;
  const contact: Contact = { name: qa.label, phone: null, email: null };
  const free = appointments.filter((a) => !one(a.questionnaires));
  $('#detail-title').textContent = qa.label ?? 'Kwestionariusz';

  detailBody.innerHTML = `<div class="stack">
    <div>${questionnaireStatus(qa)}</div>
    <h3 class="section-title">Link do kwestionariusza</h3>
    ${info ? linkBoxHtml(info, contact) : `<p class="form-error">${esc(errorMessage(link.error))}</p>`}
    <h3 class="section-title">Przypisz do wizyty</h3>
    <p class="muted small">Gdy ta osoba umówi wizytę, przypisz do niej kwestionariusz. Odpowiedzi pojawią się wtedy przy wizycie i w historii klienta.</p>
    <div class="filters">
      <select id="q-attach" aria-label="Wizyta">${
        free.length
          ? free
              .slice()
              .reverse()
              .map((a) => `<option value="${a.id}">${esc(clientName(a))} · ${esc(fmtDateTime(a.starts_at))}</option>`)
              .join('')
          : '<option value="">Brak wizyt bez kwestionariusza</option>'
      }</select>
      <button class="btn btn-outline btn-sm" type="button" id="q-attach-btn" ${free.length ? '' : 'disabled'}>Przypisz</button>
    </div>
    <h3 class="section-title">Wyniki badań</h3>
    <ul class="files" id="d-files"><li>Wczytuję…</li></ul>
    <h3 class="section-title">Odpowiedzi</h3>
    ${Object.keys(qa.answers ?? {}).length ? answersHtml(qa.answers) : '<p class="muted">Jeszcze nikt nie zaczął wypełniać.</p>'}
    ${DELETE_BTN}
  </div>`;

  if (info) {
    bindLinkBox(detailBody, info, contact, async () => {
      const { error: err } = await supabase.rpc('admin_questionnaire_link', { p_questionnaire_id: id, p_reset: true });
      if (err) return toast(errorMessage(err), 'error');
      toast('Utworzono nowy link. Stary już nie działa.');
      await openQuestionnaire(id);
    });
  }
  $<HTMLButtonElement>('#q-attach-btn', detailBody).addEventListener('click', async (e) => {
    const appt = $<HTMLSelectElement>('#q-attach', detailBody).value;
    if (!appt) return;
    await busy(e.currentTarget as HTMLButtonElement, 'Przypisuję…', async () => {
      const { error: err } = await supabase.rpc('admin_attach_questionnaire', {
        p_questionnaire_id: id,
        p_appointment_id: appt,
      });
      if (err) return toast(errorMessage(err), 'error');
      toast('Kwestionariusz przypisany do wizyty.');
      await reloadAll();
      await openDetail(appt);
    });
  });
  bindDeleteQuestionnaire(id, async () => detail.close());
  void renderFiles(detailBody.querySelector('#d-files'), info?.folders ?? []);
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
    const offs = timeOff.filter((t) => t.day === key);
    const wholeDay = offs.some((t) => !t.starts_at);
    const offTag = wholeDay
      ? '<span class="tag-off">wolne</span>'
      : offs.length
        ? `<span class="tag-off">blokada ${offs.map((t) => `${hhmm(t.starts_at)}–${hhmm(t.ends_at)}`).join(', ')}</span>`
        : '';
    cells.push(`<div class="day${out ? ' out' : ''}${key === today ? ' today' : ''}${wholeDay ? ' dayoff' : ''}" data-key="${key}" title="Kliknij, aby zablokować ten dzień">
      <span class="num">${d.getUTCDate()}</span>${offTag}${(byDay.get(key) ?? []).join('')}</div>`);
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
// Working hours (weekly schedule) and time off
// ---------------------------------------------------------------------------
interface WorkHour {
  weekday: number;
  starts_at: string;
  ends_at: string;
  slot_min: number;
  break_min: number;
}
interface TimeOff {
  id: string;
  day: string;
  starts_at: string | null;
  ends_at: string | null;
  note: string | null;
}

const WEEKDAYS = ['Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota', 'Niedziela'];
const WEEKDAYS_SHORT = ['pon', 'wt', 'śr', 'czw', 'pt', 'sob', 'nd'];
let workHours: WorkHour[] = [];
let timeOff: TimeOff[] = [];
let horizonDays = 56;

const hhmm = (t: string | null): string => (t ?? '').slice(0, 5);
const todayKey = (): string => dayKey(new Date().toISOString());

async function loadSchedule(): Promise<void> {
  const [wh, off, cfg] = await Promise.all([
    supabase
      .from('work_hours')
      .select('weekday,starts_at,ends_at,slot_min,break_min')
      .order('weekday')
      .order('starts_at'),
    supabase
      .from('time_off')
      .select('id,day,starts_at,ends_at,note')
      .gte('day', todayKey())
      .order('day')
      .order('starts_at'),
    supabase.rpc('admin_booking_settings'),
  ]);
  if (wh.error) throw wh.error;
  if (off.error) throw off.error;
  workHours = (wh.data ?? []) as WorkHour[];
  timeOff = (off.data ?? []) as TimeOff[];
  horizonDays = Number((cfg.data as { horizon_days?: number } | null)?.horizon_days ?? 56);
}

function rangeHtml(from = '09:00', to = '15:00'): string {
  return `<span class="wh-range"><input type="time" value="${esc(from)}" aria-label="Od" data-from> – <input type="time" value="${esc(to)}" aria-label="Do" data-to>
    <button class="btn btn-ghost btn-sm" type="button" data-remove aria-label="Usuń przedział">×</button></span>`;
}

function renderSchedule(): void {
  $('#wh-days').innerHTML = WEEKDAYS.map((name, i) => {
    const rules = workHours.filter((r) => r.weekday === i + 1);
    return `<div class="wh-day${rules.length ? '' : ' off'}" data-weekday="${i + 1}">
      <label class="check"><input type="checkbox" data-on ${rules.length ? 'checked' : ''}> ${name}</label>
      <div class="wh-ranges">${(rules.length ? rules : [null]).map((r) => (r ? rangeHtml(hhmm(r.starts_at), hhmm(r.ends_at)) : rangeHtml())).join('')}
        <button class="btn btn-ghost btn-sm" type="button" data-add>+ przedział</button></div>
    </div>`;
  }).join('');
  if (workHours[0]) {
    $<HTMLInputElement>('#wh-slot').value = String(workHours[0].slot_min);
    $<HTMLInputElement>('#wh-break').value = String(workHours[0].break_min);
  }
  const horizon = $<HTMLSelectElement>('#wh-horizon');
  if (![...horizon.options].some((o) => o.value === String(horizonDays))) {
    horizon.insertAdjacentHTML('beforeend', `<option value="${horizonDays}">${horizonDays} dni</option>`);
  }
  horizon.value = String(horizonDays);

  const byDay = WEEKDAYS_SHORT.map((d, i) => {
    const rules = workHours.filter((r) => r.weekday === i + 1);
    return rules.length ? `${d} ${rules.map((r) => `${hhmm(r.starts_at)}–${hhmm(r.ends_at)}`).join(', ')}` : '';
  }).filter(Boolean);
  $('#wh-summary').textContent = byDay.length
    ? byDay.join(' · ')
    : 'nie ustawiono – klienci widzą tylko terminy dodane ręcznie';
  // First visit: open the editor so the admin sees where to start.
  if (!workHours.length) $<HTMLDetailsElement>('#wh-box').open = true;

  $('#off-summary').textContent = timeOff.length ? `zaplanowane: ${timeOff.length}` : '';
  $('#off-list').innerHTML = timeOff.length
    ? timeOff
        .map(
          (t) => `<div class="off-row"><span><strong>${esc(fmtDay(`${t.day}T12:00:00Z`))}</strong> · ${
            t.starts_at ? `${hhmm(t.starts_at)}–${hhmm(t.ends_at)}` : 'cały dzień'
          }${t.note ? ` · ${esc(t.note)}` : ''}</span>
          <button class="btn btn-ghost btn-sm" type="button" data-off-del="${t.id}">Usuń</button></div>`,
        )
        .join('')
    : '<p class="muted small">Brak zaplanowanych dni wolnych.</p>';
}

$('#wh-days').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const day = target.closest<HTMLElement>('.wh-day');
  if (!day) return;
  if (target.closest('[data-add]')) {
    const last = [...day.querySelectorAll<HTMLInputElement>('[data-to]')].at(-1)?.value || '12:00';
    target
      .closest('[data-add]')
      ?.insertAdjacentHTML('beforebegin', rangeHtml(last, last < '20:00' ? '20:00' : '23:00'));
    const on = day.querySelector<HTMLInputElement>('[data-on]');
    if (on) on.checked = true;
    day.classList.remove('off');
  }
  if (target.closest('[data-remove]')) {
    if (day.querySelectorAll('.wh-range').length > 1) target.closest('.wh-range')?.remove();
    else {
      const on = day.querySelector<HTMLInputElement>('[data-on]');
      if (on) on.checked = false;
      day.classList.add('off');
    }
  }
});
$('#wh-days').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.matches('[data-on]')) input.closest('.wh-day')?.classList.toggle('off', !input.checked);
});

$<HTMLFormElement>('#wh-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rules = $$<HTMLElement>('.wh-day', $('#wh-days')).flatMap((day) => {
    if (!day.querySelector<HTMLInputElement>('[data-on]')?.checked) return [];
    return $$<HTMLElement>('.wh-range', day).map((r) => ({
      weekday: Number(day.dataset.weekday),
      from: r.querySelector<HTMLInputElement>('[data-from]')?.value ?? '',
      to: r.querySelector<HTMLInputElement>('[data-to]')?.value ?? '',
    }));
  });
  await busy($<HTMLButtonElement>('#wh-form button[type=submit]'), 'Zapisuję…', async () => {
    const { data, error } = await supabase.rpc('admin_set_work_hours', {
      p_rules: rules,
      p_slot_min: Number($<HTMLInputElement>('#wh-slot').value),
      p_break_min: Number($<HTMLInputElement>('#wh-break').value) || 0,
      p_horizon_days: Number($<HTMLSelectElement>('#wh-horizon').value),
    });
    if (error) return toast(errorMessage(error), 'error');
    toast(rules.length ? `Zapisano. Wolne terminy dla klientów: ${data}.` : 'Zapisano. Brak stałych godzin pracy.');
    await reloadAll();
  });
});

$<HTMLInputElement>('#off-all').addEventListener('change', (e) => {
  const all = (e.target as HTMLInputElement).checked;
  $<HTMLInputElement>('#off-from').disabled = all;
  $<HTMLInputElement>('#off-to').disabled = all;
});

$<HTMLFormElement>('#off-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const day = $<HTMLInputElement>('#off-day').value;
  if (!day) return toast('Wybierz dzień.', 'error');
  const all = $<HTMLInputElement>('#off-all').checked;
  await busy($<HTMLButtonElement>('#off-form button[type=submit]'), 'Zapisuję…', async () => {
    const { error } = await supabase.rpc('admin_add_time_off', {
      p_day: day,
      p_from: all ? null : $<HTMLInputElement>('#off-from').value,
      p_to: all ? null : $<HTMLInputElement>('#off-to').value,
      p_note: $<HTMLInputElement>('#off-note').value.trim() || null,
    });
    if (error) return toast(errorMessage(error), 'error');
    $<HTMLInputElement>('#off-note').value = '';
    const booked = appointments.filter((a) => isActive(a) && a.starts_at && dayKey(a.starts_at) === day).length;
    toast(
      booked
        ? `Zablokowano. Uwaga: ${booked} zarezerwowana wizyta w tym dniu zostaje – odwołaj ją ręcznie.`
        : 'Zablokowano.',
    );
    await reloadAll();
  });
});

$('#off-list').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-off-del]');
  if (!btn) return;
  btn.disabled = true;
  const { error } = await supabase.rpc('admin_delete_time_off', { p_id: btn.dataset.offDel });
  if (error) {
    btn.disabled = false;
    return toast(errorMessage(error), 'error');
  }
  toast('Usunięto blokadę. Terminy z godzin pracy wróciły.');
  await reloadAll();
});

// Clicking a calendar day (outside an appointment) prepares a day off for it.
$('#cal').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('[data-open]')) return;
  const key = target.closest<HTMLElement>('[data-key]')?.dataset.key;
  if (!key || key < todayKey()) return;
  $<HTMLInputElement>('#off-day').value = key;
  const box = $<HTMLDetailsElement>('#off-box');
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $<HTMLInputElement>('#off-note').focus({ preventScroll: true });
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
      'id,label,appointment_id,answers,submitted_at,updated_at,profiles!questionnaires_user_id_fkey(full_name,email),appointments!questionnaires_appointment_id_fkey(starts_at,status,services(name))',
    )
    .order('updated_at', { ascending: false })
    .limit(500);
  if (filter === 'submitted') query = query.not('submitted_at', 'is', null);
  if (filter === 'draft') query = query.is('submitted_at', null);
  if (filter === 'standalone') query = query.is('appointment_id', null);
  const { data, error } = await query;
  if (error) {
    $('#q-list').innerHTML = `<p class="form-error">${esc(errorMessage(error))}</p>`;
    return;
  }
  type QRow = QFull & {
    profiles: { full_name: string | null; email: string } | null;
    appointments: { starts_at: string | null; status: AppointmentStatus; services: { name: string } | null } | null;
  };
  const rows = (data ?? []) as unknown as QRow[];
  $('#q-list').innerHTML = rows.length
    ? `<table class="data"><thead><tr><th>Osoba</th><th>Wizyta</th><th>Status</th><th>Ostatnia zmiana</th></tr></thead><tbody>${rows
        .map(
          (r) => `<tr class="click" data-q="${r.id}" data-appt="${r.appointment_id ?? ''}">
          <td><strong>${esc(r.profiles?.full_name ?? r.label ?? r.profiles?.email ?? '—')}</strong></td>
          <td>${
            r.appointment_id
              ? `${esc(r.appointments?.services?.name ?? '')}<br><span class="muted">${esc(fmtDateTime(r.appointments?.starts_at ?? null))}</span>`
              : '<span class="muted">bez wizyty</span>'
          }</td>
          <td>${questionnaireStatus(r)}</td>
          <td>${esc(fmtShort(r.updated_at))}</td>
        </tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="empty">Brak kwestionariuszy.</p>';
}
$('#q-filter').addEventListener('change', () => void renderQuestionnaires());
$('#q-list').addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLElement>('[data-q]');
  if (!tr) return;
  if (tr.dataset.appt) void openDetail(tr.dataset.appt);
  else void openQuestionnaire(tr.dataset.q ?? '');
});
$<HTMLFormElement>('#q-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('#q-label');
  const label = input.value.trim();
  if (!label) {
    input.focus();
    return toast('Wpisz, dla kogo jest kwestionariusz.', 'error');
  }
  await busy($<HTMLButtonElement>('#q-new button[type=submit]'), 'Tworzę…', async () => {
    const { data, error } = await supabase.rpc('admin_create_questionnaire', { p_label: label });
    if (error) return toast(errorMessage(error), 'error');
    input.value = '';
    await renderQuestionnaires();
    await openQuestionnaire((data as LinkInfo).questionnaire_id ?? '');
  });
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
$('#new-link').addEventListener('click', () => {
  showTab('kwestionariusze');
  const input = $<HTMLInputElement>('#q-label');
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  input.focus({ preventScroll: true });
});

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
  $<HTMLInputElement>('#off-day').value = tomorrow;
  $<HTMLInputElement>('#off-day').min = new Date().toISOString().slice(0, 10);
  $<HTMLInputElement>('#s-day').min = new Date().toISOString().slice(0, 10);
  await reloadAll();
  const match = /^#(wizyta|kwestionariusz)-([0-9a-f-]{36})$/i.exec(location.hash);
  if (match?.[2]) void (match[1] === 'wizyta' ? openDetail(match[2]) : openQuestionnaire(match[2]));
}

void init();
