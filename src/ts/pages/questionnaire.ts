import type { User } from '@supabase/supabase-js';
import { requireUser } from '../lib/auth';
import { LAB_BUCKET, supabase } from '../lib/supabase';
import type { AppointmentStatus, QuestionnaireRow } from '../lib/types';
import { $, errorMessage, esc, fmtDateTime, fmtShort } from '../lib/ui';
import { confetti, createEngine, type Engine, type State } from '../questionnaire/engine';
import { summaryText } from '../questionnaire/summary';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 10 * 1024 * 1024;

const stage = $('#stage');
const top = $('#top');
const savedEl = $('#saved');
const appointmentId = new URLSearchParams(location.search).get('wizyta') ?? '';

interface Cache extends State {
  at: number;
}

const cacheKey = `kw-${appointmentId}`;
const readCache = (): Cache | null => {
  try {
    return JSON.parse(localStorage.getItem(cacheKey) ?? 'null') as Cache | null;
  } catch {
    return null;
  }
};
const writeCache = (s: State): void => {
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ ...s, at: Date.now() }));
  } catch {
    /* storage unavailable: the database copy is still saved */
  }
};
const clearCache = (): void => {
  try {
    localStorage.removeItem(cacheKey);
  } catch {
    /* ignore */
  }
};

function fatal(html: string): void {
  top.hidden = true;
  stage.innerHTML = `<section class="card"><span class="big-emoji">🗓️</span>${html}
    <div class="row"><a class="btn" href="/konto.html">Moje wizyty</a></div></section>`;
}

let submittedAt: string | null = null;
let saveTimer: number | undefined;
let saving: Promise<void> = Promise.resolve();

function scheduleSave(state: State): void {
  writeCache(state);
  window.clearTimeout(saveTimer);
  savedEl.textContent = 'Zapisuję…';
  saveTimer = window.setTimeout(() => {
    saving = saving.then(() => saveDraft(state));
  }, 800);
}

async function saveDraft(state: State): Promise<void> {
  const { error } = await supabase.rpc('save_questionnaire', {
    p_appointment_id: appointmentId,
    p_answers: state.a,
    p_step: state.i,
    p_submit: false,
    p_health_consent: false,
  });
  savedEl.textContent = error
    ? 'Nie udało się zapisać na serwerze. Odpowiedzi są zapamiętane na tym urządzeniu.'
    : 'Zapisano ✓';
}

function safeFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext =
    dot > 0
      ? name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      : '';
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${Date.now()}-${base || 'plik'}${ext ? `.${ext}` : ''}`;
}

const displayName = (stored: string): string => stored.replace(/^\d+-/, '');

function renderFinish(user: User) {
  const folder = `${user.id}/${appointmentId}`;

  return (root: HTMLElement, engine: Engine): void => {
    const a = engine.state.a;
    const name = (a.dane as Record<string, string> | undefined)?.imie;
    root.innerHTML = `<section class="card">
      <span class="big-emoji">🎉</span>
      <h1>Dziękuję${name ? `, ${esc(name)}` : ''}!</h1>
      <p style="margin:0">Ostatni krok: ${submittedAt ? 'możesz poprawić odpowiedzi i wysłać je jeszcze raz.' : `dołącz wyniki badań (jeśli je masz) i wyślij kwestionariusz.`}</p>
      ${submittedAt ? `<div class="note">✅ Kwestionariusz wysłany ${esc(fmtShort(submittedAt))}.</div>` : ''}
      <div class="upload">
        <h2>🧪 Wyniki badań</h2>
        <p class="hint" style="margin:0">Zdjęcie lub PDF, do 10 MB na plik. Widzę je tylko ja.</p>
        <ul class="files" id="files"><li>Wczytuję…</li></ul>
        <input type="file" id="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" aria-label="Dodaj wyniki badań">
        <p class="err" id="file-err" hidden></p>
      </div>
      <label class="consent"><input type="checkbox" id="consent" ${submittedAt ? 'checked' : ''}>
        <span>Wyrażam zgodę na przetwarzanie moich danych o zdrowiu podanych w kwestionariuszu i w przesłanych wynikach badań w celu przygotowania konsultacji i planu żywienia.</span></label>
      <p class="err" id="submit-err" hidden></p>
      <div class="row"><button type="button" class="btn" id="submit">${submittedAt ? 'Wyślij poprawione odpowiedzi' : 'Wyślij kwestionariusz'}</button></div>
      <details class="sumbox"><summary>Podgląd odpowiedzi</summary><div class="sum">${esc(summaryText(a))}</div></details>
      <div class="nav"><button type="button" class="btn ghost" id="back">← Popraw odpowiedzi</button><span id="rs" class="rsbox"><button type="button" class="btn soft" data-open>↺ Wypełnij od nowa</button><span class="confirm" hidden>Usunąć odpowiedzi i zacząć od nowa? <button type="button" class="btn small" data-yes>Tak</button> <button type="button" class="btn ghost small" data-no>Nie</button></span></span></div>
    </section>`;
    engine.bindRestart(root);
    $('#back', root).addEventListener('click', () => engine.go(-1));

    const filesEl = $('#files', root);
    const fileErr = $('#file-err', root);
    const showFileErr = (text: string | null): void => {
      fileErr.textContent = text ?? '';
      fileErr.hidden = !text;
    };

    async function listFiles(): Promise<void> {
      const { data, error } = await supabase.storage
        .from(LAB_BUCKET)
        .list(folder, { sortBy: { column: 'name', order: 'asc' } });
      if (error) {
        filesEl.innerHTML = `<li>${esc(errorMessage(error))}</li>`;
        return;
      }
      const files = (data ?? []).filter((f) => f.id);
      filesEl.innerHTML = files.length
        ? files
            .map(
              (f) =>
                `<li><span>📄 ${esc(displayName(f.name))}</span><button type="button" class="btn ghost small" data-del="${esc(f.name)}">Usuń</button></li>`,
            )
            .join('')
        : '<li>Brak dołączonych plików.</li>';
    }

    filesEl.addEventListener('click', async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del]');
      if (!btn) return;
      btn.disabled = true;
      const { error } = await supabase.storage.from(LAB_BUCKET).remove([`${folder}/${btn.dataset.del}`]);
      if (error) showFileErr(errorMessage(error));
      await listFiles();
    });

    const input = $<HTMLInputElement>('#file', root);
    input.addEventListener('change', async () => {
      showFileErr(null);
      for (const file of Array.from(input.files ?? [])) {
        if (file.size > MAX_FILE) {
          showFileErr(`Plik ${file.name} jest większy niż 10 MB.`);
          continue;
        }
        filesEl.insertAdjacentHTML('beforeend', `<li><span>⏳ ${esc(file.name)}</span></li>`);
        const { error } = await supabase.storage
          .from(LAB_BUCKET)
          .upload(`${folder}/${safeFileName(file.name)}`, file, { contentType: file.type || undefined, upsert: false });
        if (error) showFileErr(`${file.name}: ${errorMessage(error)}`);
      }
      input.value = '';
      await listFiles();
    });
    void listFiles();

    const submitBtn = $<HTMLButtonElement>('#submit', root);
    submitBtn.addEventListener('click', async () => {
      const err = $('#submit-err', root);
      err.hidden = true;
      if (!$<HTMLInputElement>('#consent', root).checked) {
        err.textContent = 'Zaznacz zgodę na przetwarzanie danych o zdrowiu.';
        err.hidden = false;
        return;
      }
      submitBtn.disabled = true;
      window.clearTimeout(saveTimer);
      await saving;
      const { data, error } = await supabase.rpc('save_questionnaire', {
        p_appointment_id: appointmentId,
        p_answers: engine.state.a,
        p_step: engine.state.i,
        p_submit: true,
        p_health_consent: true,
      });
      submitBtn.disabled = false;
      if (error) {
        err.textContent = errorMessage(error);
        err.hidden = false;
        return;
      }
      submittedAt = (data as QuestionnaireRow).submitted_at;
      clearCache();
      savedEl.textContent = '';
      root.innerHTML = `<section class="card center">
        <span class="big-emoji">💚</span>
        <h1>Gotowe!</h1>
        <p style="margin:0">Kwestionariusz dotarł do mnie. Przejrzę go przed naszą wizytą. Do zobaczenia!</p>
        <div class="row" style="justify-content:center"><a class="btn" href="/konto.html">Moje wizyty</a><button type="button" class="btn ghost" id="edit">Popraw odpowiedzi</button></div>
      </section>`;
      $('#edit', root).addEventListener('click', () => engine.render());
      confetti($<HTMLCanvasElement>('#conf'));
    });
  };
}

async function init(): Promise<void> {
  const user = await requireUser();
  if (!UUID.test(appointmentId)) {
    fatal(
      '<h1>Nie znaleziono wizyty</h1><p style="margin:0">Otwórz link z e-maila jeszcze raz albo przejdź do swoich wizyt.</p>',
    );
    return;
  }
  const [appt, row] = await Promise.all([
    supabase.from('appointments').select('id,status,starts_at').eq('id', appointmentId).maybeSingle(),
    supabase.from('questionnaires').select('*').eq('appointment_id', appointmentId).maybeSingle(),
  ]);
  if (appt.error || row.error) {
    fatal(`<h1>Coś poszło nie tak</h1><p style="margin:0">${esc(errorMessage(appt.error ?? row.error))}</p>`);
    return;
  }
  const a = appt.data as { status: AppointmentStatus; starts_at: string | null } | null;
  if (!a) {
    fatal('<h1>Nie znaleziono wizyty</h1><p style="margin:0">Ta wizyta nie istnieje albo należy do innego konta.</p>');
    return;
  }
  if (a.status !== 'confirmed') {
    fatal(
      a.status === 'pending'
        ? '<h1>Wizyta czeka na potwierdzenie</h1><p style="margin:0">Kwestionariusz otworzy się, gdy potwierdzę termin. Dostaniesz wtedy e-mail.</p>'
        : '<h1>Kwestionariusz jest niedostępny</h1><p style="margin:0">Ta wizyta nie jest już aktywna.</p>',
    );
    return;
  }

  const saved = row.data as QuestionnaireRow | null;
  submittedAt = saved?.submitted_at ?? null;
  const cache = readCache();
  const fromDb: State = { i: saved?.current_step ?? -1, a: saved?.answers ?? {} };
  // Prefer the local copy only if it is newer than the last server save (e.g. saving failed offline).
  const state: State =
    cache && (!saved || cache.at > Date.parse(saved.updated_at)) ? { i: cache.i, a: cache.a } : fromDb;

  document.title = `Kwestionariusz – ${fmtDateTime(a.starts_at)} · Zdrówko za zdrowie`;
  const engine = createEngine({
    stage,
    top,
    state,
    onChange: scheduleSave,
    renderFinish: renderFinish(user),
    introNote: 'Odpowiedzi zapisują się automatycznie, więc możesz przerwać i wrócić, także na innym urządzeniu.',
  });
  engine.render();
}

void init();
