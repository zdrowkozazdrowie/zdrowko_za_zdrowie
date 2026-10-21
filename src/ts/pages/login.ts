import { getSession, mountAccountNav, safeNext } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { $, $$, errorMessage } from '../lib/ui';

type Mode = 'login' | 'register';

const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.slice(1));
const next = safeNext(params.get('next'));
const returnUrl = `${location.origin}/logowanie.html?next=${encodeURIComponent(next)}`;

const form = $<HTMLFormElement>('#auth-form');
const nameField = $('#name-field');
const nameInput = $<HTMLInputElement>('#full_name');
const emailInput = $<HTMLInputElement>('#email');
const passwordInput = $<HTMLInputElement>('#password');
const passwordField = $('#password-field');
const errorEl = $('#auth-error');
const infoEl = $('#auth-info');
const submit = $<HTMLButtonElement>('#auth-submit');
const forgot = $<HTMLButtonElement>('#forgot');
let mode: Mode = 'login';
let resetMode = false;

function message(kind: 'error' | 'info', text: string | null): void {
  const el = kind === 'error' ? errorEl : infoEl;
  el.textContent = text ?? '';
  el.hidden = !text;
  if (text) (kind === 'error' ? infoEl : errorEl).hidden = true;
}

function setMode(m: Mode): void {
  mode = m;
  resetMode = false;
  $$<HTMLButtonElement>('.seg [data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  nameField.hidden = m !== 'register';
  passwordField.hidden = false;
  passwordInput.autocomplete = m === 'register' ? 'new-password' : 'current-password';
  submit.textContent = m === 'register' ? 'Załóż konto' : 'Zaloguj się';
  forgot.hidden = m !== 'login';
  $('#auth-title').textContent = m === 'register' ? 'Załóż konto' : 'Zaloguj się';
  message('error', null);
  message('info', null);
}

$$<HTMLButtonElement>('.seg [data-mode]').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
);

forgot.addEventListener('click', () => {
  resetMode = true;
  passwordField.hidden = true;
  forgot.hidden = true;
  submit.textContent = 'Wyślij link do zmiany hasła';
  $('#auth-title').textContent = 'Nie pamiętasz hasła?';
  message('info', 'Podaj e-mail, a wyślę link do ustawienia nowego hasła.');
  emailInput.focus();
});

$<HTMLButtonElement>('#google').addEventListener('click', async () => {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: returnUrl, queryParams: { prompt: 'select_account' } },
  });
  if (error) message('error', errorMessage(error));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  message('error', null);
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!emailInput.checkValidity() || !email) return message('error', 'Podaj poprawny adres e-mail.');

  submit.disabled = true;
  try {
    if (resetMode) {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${location.origin}/nowe-haslo.html`,
      });
      if (error) return message('error', errorMessage(error));
      return message('info', 'Jeśli konto istnieje, wysłałam link do zmiany hasła. Sprawdź skrzynkę (także spam).');
    }
    if (password.length < 8) return message('error', 'Hasło musi mieć co najmniej 8 znaków.');

    if (mode === 'register') {
      const fullName = nameInput.value.trim();
      if (!fullName) return message('error', 'Podaj imię i nazwisko.');
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: returnUrl, data: { full_name: fullName } },
      });
      if (error) return message('error', errorMessage(error));
      if (data.session) return location.replace(next);
      form.reset();
      return message(
        'info',
        'Wysłałam e-mail z linkiem aktywacyjnym. Kliknij go, aby dokończyć rejestrację (sprawdź też spam).',
      );
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return message('error', errorMessage(error));
    location.replace(next);
  } finally {
    submit.disabled = false;
  }
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
    message('error', /expired|invalid/i.test(error) ? 'Link wygasł lub był już użyty. Zaloguj się albo wyślij nowy.' : error);
  } else if (params.has('code')) {
    message('info', 'Adres e-mail potwierdzony. Zaloguj się, aby kontynuować.');
  }
  if (params.get('tryb') === 'rejestracja') setMode('register');
  void mountAccountNav(document.getElementById('account-nav'));
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN') location.replace(next);
});

void init();
