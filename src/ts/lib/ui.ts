import type { AppointmentStatus, PaymentStatus } from './types';

export const TIME_ZONE = 'Europe/Warsaw';

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function esc(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const dateTimeFmt = new Intl.DateTimeFormat('pl-PL', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('pl-PL', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const dayShortFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TIME_ZONE, weekday: 'short' });
const dayNumFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TIME_ZONE, day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat('pl-PL', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
const keyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const shortFmt = new Intl.DateTimeFormat('pl-PL', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const fmtDateTime = (iso: string | null): string =>
  iso ? dateTimeFmt.format(new Date(iso)) : 'termin do ustalenia';
export const fmtDay = (iso: string): string => dayFmt.format(new Date(iso));
export const fmtDayShort = (iso: string): string => dayShortFmt.format(new Date(iso));
export const fmtDayNum = (iso: string): string => dayNumFmt.format(new Date(iso));
export const fmtTime = (iso: string): string => timeFmt.format(new Date(iso));
export const fmtShort = (iso: string | null): string => (iso ? shortFmt.format(new Date(iso)) : '—');
/** YYYY-MM-DD in the clinic's time zone. */
export const dayKey = (iso: string): string => keyFmt.format(new Date(iso));

export const fmtPrice = (pln: number): string =>
  Number(pln) === 0 ? 'bezpłatnie' : `${Number(pln).toLocaleString('pl-PL')} zł`;

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: 'Czeka na potwierdzenie',
  confirmed: 'Potwierdzona',
  rejected: 'Odrzucona',
  cancelled: 'Odwołana',
  completed: 'Zakończona',
};

export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  not_required: 'Bez opłaty',
  unpaid: 'Nieopłacona',
  paid: 'Opłacona',
  refunded: 'Zwrócona',
};

export const MODE_LABEL = { online: 'Online (wideorozmowa)', telefon: 'Telefonicznie' } as const;

export function statusPill(status: AppointmentStatus): string {
  return `<span class="pill ${status}">${esc(STATUS_LABEL[status])}</span>`;
}

const AUTH_ERRORS: [RegExp, string][] = [
  [/token has expired or is invalid|otp.*(expired|invalid)/i, 'Kod jest nieprawidłowy lub wygasł. Wyślij nowy.'],
  [/rate limit|too many requests|security purposes/i, 'Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.'],
  [/unable to validate email address|invalid format/i, 'Nieprawidłowy adres e-mail.'],
  [
    /error sending (magic link|confirmation|otp)|smtp/i,
    'Nie udało się wysłać e-maila. Zaloguj się przez Google albo spróbuj później.',
  ],
  [/signups not allowed|provider is not enabled/i, 'Ta metoda logowania jest teraz wyłączona.'],
  [/failed to fetch|networkerror|load failed/i, 'Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.'],
  [/jwt expired/i, 'Sesja wygasła. Zaloguj się ponownie.'],
];

/** Turns Supabase/PostgREST errors into a message for the user. SQL functions raise Polish messages already. */
export function errorMessage(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? '');
  for (const [pattern, text] of AUTH_ERRORS) if (pattern.test(message)) return text;
  if (/permission denied|row-level security/i.test(message)) return 'Brak uprawnień do tej operacji.';
  return message || 'Coś poszło nie tak. Spróbuj ponownie.';
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.className = kind === 'error' ? 'error' : '';
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (el) el.hidden = true;
  }, 4000);
}

/** Disables a button while an async action runs. */
export async function busy<T>(button: HTMLButtonElement, label: string, action: () => Promise<T>): Promise<T> {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

export function setYear(): void {
  const el = document.getElementById('year');
  if (el) el.textContent = String(new Date().getFullYear());
}
