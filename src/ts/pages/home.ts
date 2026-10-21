import { getUser, loginUrl, mountAccountNav } from '../lib/auth';
import { supabase } from '../lib/supabase';
import type { Profile, Service, Slot } from '../lib/types';
import { $, $$, dayKey, errorMessage, esc, fmtDayNum, fmtDayShort, fmtPrice, fmtTime, setYear } from '../lib/ui';

const DRAFT_KEY = 'booking-draft';
const EMAIL = 'wiktoriaprzybylak9@wp.pl';

interface Draft {
  service: string;
  slotId: string | null;
  mode: string;
  fullName: string;
  phone: string;
  note: string;
}

const dialog = $<HTMLDialogElement>('#booking');
const form = $<HTMLFormElement>('#booking-form');
const serviceSelect = $<HTMLSelectElement>('#b-service');
const slotField = $('#b-slot-field');
const daysEl = $('#b-days');
const timesEl = $('#b-times');
const slotInfo = $('#b-slot-info');
const modeField = $('#b-mode-field');
const modeSelect = $<HTMLSelectElement>('#b-mode');
const nameInput = $<HTMLInputElement>('#b-name');
const phoneInput = $<HTMLInputElement>('#b-phone');
const noteInput = $<HTMLTextAreaElement>('#b-note');
const errorEl = $('#b-error');
const authHint = $('#b-auth-hint');
const submitBtn = $<HTMLButtonElement>('#b-submit');
const success = $('#b-success');

let services: Service[] = [];
let slots: Slot[] = [];
let selectedDay: string | null = null;
let selectedSlot: string | null = null;
let servicesLoaded: Promise<void> | null = null;

function showError(message: string | null): void {
  errorEl.textContent = message ?? '';
  errorEl.hidden = !message;
}

function currentService(): Service | undefined {
  return services.find((s) => s.id === serviceSelect.value);
}

async function loadServices(): Promise<void> {
  const { data, error } = await supabase
    .from('services')
    .select('id,name,description,price_pln,duration_min,requires_slot,sort')
    .order('sort');
  if (error) {
    serviceSelect.innerHTML = '<option value="">Nie udało się wczytać usług</option>';
    showError(errorMessage(error));
    return;
  }
  services = (data ?? []) as Service[];
  serviceSelect.innerHTML = services
    .map((s) => `<option value="${esc(s.id)}">${esc(s.name)} (${esc(fmtPrice(s.price_pln))})</option>`)
    .join('');
}

async function loadSlots(): Promise<void> {
  slotInfo.hidden = false;
  slotInfo.textContent = 'Wczytuję wolne terminy…';
  daysEl.replaceChildren();
  timesEl.replaceChildren();
  const { data, error } = await supabase.rpc('get_free_slots');
  if (error) {
    slotInfo.textContent = errorMessage(error);
    return;
  }
  slots = (data ?? []) as Slot[];
  if (selectedSlot && !slots.some((s) => s.id === selectedSlot)) selectedSlot = null;
  const firstWithSelection = selectedSlot ? slots.find((s) => s.id === selectedSlot) : undefined;
  selectedDay = firstWithSelection ? dayKey(firstWithSelection.starts_at) : slots[0] ? dayKey(slots[0].starts_at) : null;
  renderSlots();
}

function renderSlots(): void {
  if (!slots.length) {
    slotInfo.hidden = false;
    slotInfo.innerHTML = `Brak wolnych terminów online. Zadzwoń (<a href="tel:+48786893531">+48 786 893 531</a>) albo napisz na <a href="mailto:${EMAIL}">${EMAIL}</a>.`;
    daysEl.replaceChildren();
    timesEl.replaceChildren();
    return;
  }
  slotInfo.hidden = true;
  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = dayKey(slot.starts_at);
    byDay.set(key, [...(byDay.get(key) ?? []), slot]);
  }
  daysEl.innerHTML = [...byDay.entries()]
    .map(([key, list]) => {
      const first = list[0] as Slot;
      return `<button type="button" class="day" role="tab" data-day="${key}" aria-selected="${key === selectedDay}">
        ${esc(fmtDayShort(first.starts_at))}<strong>${esc(fmtDayNum(first.starts_at))}</strong></button>`;
    })
    .join('');
  timesEl.innerHTML = (byDay.get(selectedDay ?? '') ?? [])
    .map(
      (s) =>
        `<button type="button" class="time" data-slot="${s.id}" aria-pressed="${s.id === selectedSlot}">${esc(fmtTime(s.starts_at))}</button>`,
    )
    .join('');
}

function syncServiceFields(): void {
  const needsSlot = currentService()?.requires_slot ?? true;
  slotField.hidden = !needsSlot;
  modeField.hidden = !needsSlot;
  submitBtn.textContent = needsSlot ? 'Zarezerwuj termin' : 'Zamów';
  if (needsSlot && !slots.length) void loadSlots();
}

daysEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-day]');
  if (!btn) return;
  selectedDay = btn.dataset.day ?? null;
  renderSlots();
});

timesEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-slot]');
  if (!btn) return;
  selectedSlot = btn.dataset.slot ?? null;
  showError(null);
  renderSlots();
});

serviceSelect.addEventListener('change', syncServiceFields);

function readDraft(): Draft {
  return {
    service: serviceSelect.value,
    slotId: selectedSlot,
    mode: modeSelect.value,
    fullName: nameInput.value.trim(),
    phone: phoneInput.value.trim(),
    note: noteInput.value.trim(),
  };
}

async function prefillProfile(): Promise<void> {
  const user = await getUser();
  authHint.hidden = Boolean(user);
  if (!user) return;
  const { data } = await supabase.from('profiles').select('id,email,full_name,phone').eq('id', user.id).maybeSingle();
  const profile = data as Profile | null;
  if (profile?.full_name && !nameInput.value) nameInput.value = profile.full_name;
  if (profile?.phone && !phoneInput.value) phoneInput.value = profile.phone;
}

async function openBooking(opts: { service?: string; mode?: string; draft?: Draft }): Promise<void> {
  form.hidden = false;
  success.hidden = true;
  showError(null);
  if (!dialog.open) dialog.showModal();
  servicesLoaded ??= loadServices();
  await servicesLoaded;
  const draft = opts.draft;
  if (draft) {
    serviceSelect.value = draft.service;
    modeSelect.value = draft.mode;
    nameInput.value = draft.fullName;
    phoneInput.value = draft.phone;
    noteInput.value = draft.note;
    selectedSlot = draft.slotId;
  } else {
    if (opts.service) serviceSelect.value = opts.service;
    if (opts.mode) modeSelect.value = opts.mode;
  }
  syncServiceFields();
  await Promise.all([currentService()?.requires_slot ? loadSlots() : Promise.resolve(), prefillProfile()]);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  showError(null);
  const draft = readDraft();
  const service = currentService();
  if (!service) return showError('Wybierz usługę.');
  if (service.requires_slot && !draft.slotId) return showError('Wybierz dzień i godzinę wizyty.');
  if (!draft.fullName) {
    nameInput.focus();
    return showError('Podaj imię i nazwisko.');
  }

  const user = await getUser();
  if (!user) {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    location.href = loginUrl('/?rezerwacja=1');
    return;
  }

  submitBtn.disabled = true;
  const { error } = await supabase.rpc('book_appointment', {
    p_service_id: service.id,
    p_slot_id: service.requires_slot ? draft.slotId : null,
    p_mode: draft.mode,
    p_note: draft.note || null,
    p_full_name: draft.fullName,
    p_phone: draft.phone || null,
  });
  submitBtn.disabled = false;
  if (error) {
    showError(errorMessage(error));
    if (service.requires_slot) void loadSlots();
    return;
  }
  sessionStorage.removeItem(DRAFT_KEY);
  selectedSlot = null;
  slots = [];
  form.hidden = true;
  success.hidden = false;
});

// Open the booking dialog from every "Umów wizytę" button.
$$<HTMLElement>('[data-book]').forEach((el) =>
  el.addEventListener('click', (e) => {
    e.preventDefault();
    closeMenu();
    void openBooking({ service: el.dataset.service, mode: el.dataset.mode });
  }),
);

// E-books are still ordered by e-mail (online payments are a TODO).
const ebookDialog = $<HTMLDialogElement>('#ebook');
const ebookForm = $<HTMLFormElement>('#ebook-form');
$$<HTMLElement>('[data-ebook]').forEach((el) =>
  el.addEventListener('click', () => {
    ebookForm.reset();
    $<HTMLInputElement>('#e-product').value = el.dataset.ebook ?? '';
    ebookDialog.showModal();
  }),
);
ebookForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(ebookForm);
  const lines = [
    `Zamówienie e-booka: ${f.get('product')}`,
    `Imię i nazwisko: ${f.get('name')}`,
    `E-mail: ${f.get('email')}`,
    f.get('message') ? `\nWiadomość:\n${f.get('message')}` : '',
  ].filter(Boolean);
  location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(`Zamówienie e-booka: ${f.get('product')}`)}&body=${encodeURIComponent(lines.join('\n'))}`;
  ebookDialog.close();
});

for (const d of [dialog, ebookDialog]) {
  $$('[data-close]', d).forEach((el) => el.addEventListener('click', () => d.close()));
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
}

// Offer tabs
$$<HTMLButtonElement>('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$<HTMLElement>('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== tab.dataset.tab));
  }),
);

// Mobile menu
const toggle = $<HTMLButtonElement>('.menu-toggle');
const links = $('.nav-links');
function closeMenu(): void {
  links.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
}
toggle.addEventListener('click', () => {
  const open = links.classList.toggle('open');
  toggle.setAttribute('aria-expanded', String(open));
});
links.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (a && !a.hasAttribute('data-book')) closeMenu();
});

setYear();
void mountAccountNav(document.getElementById('account-nav'));

// Back from the login page with a booking in progress.
const params = new URLSearchParams(location.search);
if (params.has('rezerwacja')) {
  history.replaceState(null, '', '/#umow');
  let draft: Draft | undefined;
  try {
    draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null') ?? undefined;
  } catch {
    draft = undefined;
  }
  void openBooking({ draft });
} else if (location.hash === '#umow') {
  void openBooking({});
}
