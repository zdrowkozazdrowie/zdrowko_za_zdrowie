import { getSession, loginUrl } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { $, errorMessage, toast } from '../lib/ui';

const form = $<HTMLFormElement>('#password-form');
const errorEl = $('#pw-error');

function showError(text: string | null): void {
  errorEl.textContent = text ?? '';
  errorEl.hidden = !text;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = $<HTMLInputElement>('#new-password').value;
  const b = $<HTMLInputElement>('#new-password-2').value;
  if (a.length < 8) return showError('Hasło musi mieć co najmniej 8 znaków.');
  if (a !== b) return showError('Hasła się różnią.');
  const { error } = await supabase.auth.updateUser({ password: a });
  if (error) return showError(errorMessage(error));
  toast('Hasło zmienione.');
  setTimeout(() => location.replace('/konto.html'), 800);
});

void (async () => {
  // The recovery link (?code=…) is exchanged for a session by supabase-js on load.
  if (!(await getSession())) {
    showError('Link wygasł lub był już użyty. Poproś o nowy na stronie logowania.');
    form.querySelectorAll('input, button').forEach((el) => ((el as HTMLInputElement).disabled = true));
    const a = document.createElement('a');
    a.href = loginUrl('/konto.html');
    a.textContent = 'Przejdź do logowania';
    form.append(a);
  }
})();
