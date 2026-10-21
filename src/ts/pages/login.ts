import { getSession, mountAccountNav, safeNext } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { $, busy, errorMessage } from '../lib/ui';

const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
const next = safeNext(params.get('next'));
const returnUrl = `${location.origin}/logowanie.html?next=${encodeURIComponent(next)}`;

const emailForm = $<HTMLFormElement>('#email-form');
const codeForm = $<HTMLFormElement>('#code-form');
const emailInput = $<HTMLInputElement>('#email');
const codeInput = $<HTMLInputElement>('#code');
const errorEl = $('#auth-error');
const infoEl = $('#auth-info');
let sentTo = '';

function message(kind: 'error' | 'info', text: string | null): void {
  const el = kind === 'error' ? errorEl : infoEl;
  el.textContent = text ?? '';
  el.hidden = !text;
  if (text) (kind === 'error' ? infoEl : errorEl).hidden = true;
}

function showCodeStep(email: string): void {
  sentTo = email;
  emailForm.hidden = true;
  codeForm.hidden = false;
  message('info', `Wysłałam link i kod na adres ${email}. Sprawdź skrzynkę (także spam).`);
  codeInput.focus();
}

$<HTMLButtonElement>('#google').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl, queryParams: { prompt: 'select_account' } },
  });
  if (error) message('error', errorMessage(error));
});

emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  message('error', null);
  const email = emailInput.value.trim();
  if (!email || !emailInput.checkValidity()) return message('error', 'Podaj poprawny adres e-mail.');
  await busy($<HTMLButtonElement>('#email-submit'), 'Wysyłam…', async () => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: returnUrl, shouldCreateUser: true },
    });
    if (error) return message('error', errorMessage(error));
    showCodeStep(email);
  });
});

codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  message('error', null);
  const token = codeInput.value.replace(/\s+/g, '');
  if (!/^\d{6,10}$/.test(token)) return message('error', 'Wpisz kod z e-maila (same cyfry).');
  await busy($<HTMLButtonElement>('#code-submit'), 'Sprawdzam…', async () => {
    const { error } = await supabase.auth.verifyOtp({ email: sentTo, token, type: 'email' });
    if (error) return message('error', errorMessage(error));
    location.replace(next);
  });
});

$<HTMLButtonElement>('#change-email').addEventListener('click', () => {
  codeForm.hidden = true;
  emailForm.hidden = false;
  codeForm.reset();
  message('info', null);
  emailInput.focus();
});

async function init(): Promise<void> {
  // supabase-js finishes the OAuth / e-mail link exchange (?code=…) before getSession() resolves.
  const session = await getSession();
  if (session) {
    location.replace(next);
    return;
  }
  const error = params.get('error_description') ?? hashParams.get('error_description');
  if (error) {
    message(
      'error',
      /expired|invalid|code verifier/i.test(error)
        ? 'Link wygasł, był już użyty albo otworzył się w innej przeglądarce. Wyślij nowy lub zaloguj się kodem.'
        : error,
    );
  }
  void mountAccountNav(document.getElementById('account-nav'));
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN') location.replace(next);
});

void init();
