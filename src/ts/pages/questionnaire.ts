import { getUser, loginUrl } from '../lib/auth';
import { LAB_BUCKET, supabase } from '../lib/supabase';
import type { AppointmentStatus, QuestionnaireRow } from '../lib/types';
import { $, errorMessage, esc, fmtDateTime, fmtShort } from '../lib/ui';
import { confetti, createEngine, type Engine, type State } from '../questionnaire/engine';
import { summaryText } from '../questionnaire/summary';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{48}$/;
const MAX_FILE = 10 * 1024 * 1024;

const stage = $('#stage');
const top = $('#top');
const savedEl = $('#saved');
const params = new URLSearchParams(location.search);
const token = (params.get('t') ?? '').toLowerCase();
const appointmentId = params.get('wizyta') ?? '';
const linkMode = TOKEN.test(token);

/**
 * Two ways in: a secret link from the dietitian (?t=…, no account needed) or a signed-in client's
 * appointment (?wizyta=…). Both store answers in public.questionnaires.
 */
interface Backend {
  /** Storage folder for lab results. */
  folder: string;
  save: (state: State, submit: boolean) => Promise<{ submittedAt: string | null; error: unknown }>;
}
let backend: Backend;

interface Cache extends State {
  at: number;
}

const cacheKey = `kw-${linkMode ? token.slice(0, 16) : appointmentId}`;
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
    ${linkMode ? '' : '<div class="row"><a class="btn" href="/konto.html">Moje wizyty</a></div>'}</section>`;
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
  const { error } = await backend.save(state, false);
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

function renderFinish() {
  const folder = backend.folder;

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
        <label class="btn soft file-btn">📎 Dodaj zdjęcie lub PDF<input type="file" id="file" multiple accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"></label>
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
      const { submittedAt: at, error } = await backend.save(engine.state, true);
      submitBtn.disabled = false;
      if (error) {
        err.textContent = errorMessage(error);
        err.hidden = false;
        return;
      }
      submittedAt = at;
      clearCache();
      savedEl.textContent = '';
      root.innerHTML = `<section class="card center">
        <span class="big-emoji">💚</span>
        <h1>Gotowe!</h1>
        <p style="margin:0">Kwestionariusz dotarł do mnie. Przejrzę go przed naszym spotkaniem. Do zobaczenia!</p>
        <div class="row" style="justify-content:center">${linkMode ? '' : '<a class="btn" href="/konto.html">Moje wizyty</a>'}<button type="button" class="btn ghost" id="edit">Popraw odpowiedzi</button></div>
      </section>`;
      $('#edit', root).addEventListener('click', () => engine.render());
      confetti($<HTMLCanvasElement>('#conf'));
    });
  };
}

const SAVED_NOTE = 'Odpowiedzi zapisują się automatycznie, więc możesz przerwać i wrócić, także na innym urządzeniu.';

interface Loaded {
  saved: {
    answers: Record<string, unknown>;
    current_step: number;
    submitted_at: string | null;
    updated_at: string;
  } | null;
  title: string;
}

interface LinkRow {
  questionnaire_id: string | null;
  label: string | null;
  appointment_id: string | null;
  status: AppointmentStatus | null;
  service_name: string | null;
  starts_at: string | null;
  answers: Record<string, unknown> | null;
  current_step: number | null;
  submitted_at: string | null;
  updated_at: string | null;
}

async function initLink(): Promise<Loaded | null> {
  const { data, error } = await supabase.rpc('get_questionnaire_by_link', { p_token: token });
  const row = (data as LinkRow[] | null)?.[0];
  if (error || !row) {
    fatal(
      `<h1>Link nie działa</h1><p style="margin:0">${esc(error ? errorMessage(error) : 'Link jest nieprawidłowy.')}</p>
       <p style="margin:0">Napisz do mnie, a wyślę nowy: <a href="tel:+48786893531">+48 786 893 531</a>.</p>`,
    );
    return null;
  }
  backend = {
    folder: `link/${token}`,
    save: async (state, submit) => {
      const { data: res, error: err } = await supabase.rpc('save_questionnaire_by_link', {
        p_token: token,
        p_answers: state.a,
        p_step: state.i,
        p_submit: submit,
        p_health_consent: submit,
      });
      return { submittedAt: (res as { submitted_at: string | null }[] | null)?.[0]?.submitted_at ?? null, error: err };
    },
  };
  return {
    saved: row.updated_at
      ? {
          answers: row.answers ?? {},
          current_step: row.current_step ?? -1,
          submitted_at: row.submitted_at,
          updated_at: row.updated_at,
        }
      : null,
    title: row.starts_at ? `Kwestionariusz – ${fmtDateTime(row.starts_at)}` : 'Kwestionariusz',
  };
}

async function initAccount(): Promise<Loaded | null> {
  const user = await getUser();
  if (!user) {
    location.replace(loginUrl());
    return null;
  }
  if (!UUID.test(appointmentId)) {
    fatal(
      '<h1>Nie znaleziono wizyty</h1><p style="margin:0">Otwórz link jeszcze raz albo przejdź do swoich wizyt.</p>',
    );
    return null;
  }
  const [appt, row] = await Promise.all([
    supabase.from('appointments').select('id,status,starts_at').eq('id', appointmentId).maybeSingle(),
    supabase.from('questionnaires').select('*').eq('appointment_id', appointmentId).maybeSingle(),
  ]);
  if (appt.error || row.error) {
    fatal(`<h1>Coś poszło nie tak</h1><p style="margin:0">${esc(errorMessage(appt.error ?? row.error))}</p>`);
    return null;
  }
  const a = appt.data as { status: AppointmentStatus; starts_at: string | null } | null;
  if (!a) {
    fatal('<h1>Nie znaleziono wizyty</h1><p style="margin:0">Ta wizyta nie istnieje albo należy do innego konta.</p>');
    return null;
  }
  if (a.status !== 'confirmed') {
    fatal(
      a.status === 'pending'
        ? '<h1>Wizyta czeka na potwierdzenie</h1><p style="margin:0">Kwestionariusz otworzy się, gdy potwierdzę termin.</p>'
        : '<h1>Kwestionariusz jest niedostępny</h1><p style="margin:0">Ta wizyta nie jest już aktywna.</p>',
    );
    return null;
  }
  backend = {
    folder: `${user.id}/${appointmentId}`,
    save: async (state, submit) => {
      const { data, error } = await supabase.rpc('save_questionnaire', {
        p_appointment_id: appointmentId,
        p_answers: state.a,
        p_step: state.i,
        p_submit: submit,
        p_health_consent: submit,
      });
      return { submittedAt: (data as QuestionnaireRow | null)?.submitted_at ?? null, error };
    },
  };
  return { saved: row.data as QuestionnaireRow | null, title: `Kwestionariusz – ${fmtDateTime(a.starts_at)}` };
}

async function init(): Promise<void> {
  if (linkMode) document.querySelector('.kw-links')?.remove();
  const loaded = linkMode ? await initLink() : await initAccount();
  if (!loaded) return;
  const { saved } = loaded;
  submittedAt = saved?.submitted_at ?? null;
  const cache = readCache();
  const fromDb: State = { i: saved?.current_step ?? -1, a: saved?.answers ?? {} };
  // Prefer the local copy only if it is newer than the last server save (e.g. saving failed offline).
  const state: State =
    cache && (!saved || cache.at > Date.parse(saved.updated_at)) ? { i: cache.i, a: cache.a } : fromDb;

  document.title = `${loaded.title} · Zdrówko za zdrowie`;
  const engine = createEngine({
    stage,
    top,
    state,
    onChange: scheduleSave,
    renderFinish: renderFinish(),
    introNote: SAVED_NOTE,
  });
  engine.render();
}

void init();
