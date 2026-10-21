// Questionnaire UI engine, ported 1:1 from docs/kwestionariusz-prototyp.html.
// Differences: state is persisted through a callback (database + local cache) and the final
// screen is rendered by the page (lab results upload, consent, submit).
import { esc } from '../lib/ui';
import {
  type Answers,
  type Ctx,
  ctxFor,
  type Option,
  parseOption,
  QUESTIONS,
  type Question,
  resolve,
} from './questions';
import { waistSVG } from './waist';

export interface State {
  /** -1 = intro, QUESTIONS.length = final screen */
  i: number;
  a: Answers;
}

export interface EngineOptions {
  stage: HTMLElement;
  top: HTMLElement;
  state: State;
  /** Called after every change (answers or position). */
  onChange: (state: State) => void;
  /** Renders the final screen into `stage`. */
  renderFinish: (stage: HTMLElement, engine: Engine) => void;
  /** Intro screen notes (HTML), e.g. about saving progress. */
  introNote: string;
}

export interface Engine {
  state: State;
  go: (delta: number) => void;
  render: () => void;
  restart: () => void;
  /** Wires up "start over" buttons (`.rsbox`) inside the given root. */
  bindRestart: (root: ParentNode) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T | null => root.querySelector<T>(sel);

export function createEngine(opts: EngineOptions): Engine {
  const { stage, top } = opts;
  const S = opts.state;
  let advance: number | undefined;

  const save = (): void => opts.onChange(S);
  const c = (): Ctx => ctxFor(S.a);
  const R = <T>(x: T | ((c: Ctx) => T)): T => resolve(x, c());

  function go(d: number): void {
    window.clearTimeout(advance);
    S.i = Math.max(-1, Math.min(QUESTIONS.length, S.i + d));
    save();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function restart(): void {
    S.a = {};
    S.i = 0;
    save();
    render();
    window.scrollTo({ top: 0 });
  }

  function nav(q: Question, extra = ''): string {
    return `${q.tip ?? ''}<div class="nav"><button type="button" class="btn ghost" id="back">← Wstecz</button><div class="row">${extra}<button type="button" class="btn ghost" id="skip">Pomiń</button><button type="button" class="btn" id="next">Dalej →</button></div></div>`;
  }

  function face(q: Extract<Question, { type: 'scale' }>, v: number): string {
    return q.faces[Math.min(4, Math.floor((v - 1) / 2))] ?? '';
  }

  function intro(): void {
    top.hidden = true;
    const started = Object.keys(S.a).length > 0;
    stage.innerHTML = `<section class="card">
      <span class="big-emoji">🥗</span>
      <h1>Poznajmy się przy talerzu</h1>
      <p style="margin:0">Ten kwestionariusz pomoże mi przygotować plan, który będzie pasował do Twojego dnia, smaków i samopoczucia. Nie ma tu dobrych ani złych odpowiedzi.</p>
      <div class="note">⏱️ Zajmie <b>ok. 8–10 minut</b>. Większość pytań to jedno kliknięcie. ${opts.introNote}</div>
      <div class="note">🧪 Jeśli masz <b>aktualne wyniki badań</b>, przygotuj je. Na końcu poproszę o przesłanie ich razem z odpowiedziami.</div>
      <div class="row"><button type="button" class="btn" id="start">${started ? 'Kontynuuj' : 'Zaczynamy'} →</button>${
        started ? '<button type="button" class="btn ghost" id="reset">Zacznij od nowa</button>' : ''
      }</div></section>`;
    $(stage, '#start')?.addEventListener('click', () => go(1));
    $(stage, '#reset')?.addEventListener('click', () => {
      S.a = {};
      S.i = -1;
      save();
      render();
    });
  }

  function render(): void {
    if (S.i < 0) return intro();
    if (S.i >= QUESTIONS.length) {
      top.hidden = true;
      opts.renderFinish(stage, engine);
      return;
    }
    const q = QUESTIONS[S.i] as Question;
    top.hidden = false;
    ($(top, '#sec') as HTMLElement).textContent = q.s;
    ($(top, '#count') as HTMLElement).textContent = `${S.i + 1} / ${QUESTIONS.length}`;
    ($(top, '#bar') as HTMLElement).style.width = `${(S.i / QUESTIONS.length) * 100}%`;
    let h = `<section class="card" aria-live="polite"><h2>${esc(R(q.q))}</h2>${q.hint ? `<p class="hint">${esc(R(q.hint))}</p>` : ''}`;
    const v = S.a[q.id];

    if (q.type === 'single' || q.type === 'multi') {
      const os: Option[] = R(q.opts).map(parseOption);
      const selected = (o: Option): boolean =>
        q.type === 'single' ? v === o.t : Array.isArray(v) && (v as string[]).includes(o.t);
      h +=
        `<div class="opts${os.some((o) => o.t.length > 30) ? ' wide' : ''}">` +
        os
          .map((o, k) => {
            const on = selected(o);
            return `<button type="button" class="opt${on ? ' on' : ''}" data-k="${k}" aria-pressed="${on}"><span class="e">${o.e}</span><span>${esc(o.t)}</span></button>`;
          })
          .join('') +
        '</div>';
      const other = os.find((o) => o.ot);
      if (other) {
        h += `<input type="text" class="other" id="other" placeholder="Wpisz…" value="${esc(S.a[`${q.id}_inne`] ?? '')}" ${selected(other) ? '' : 'hidden'}>`;
      }
      stage.innerHTML = `${h}${nav(q)}</section>`;
      stage.querySelectorAll<HTMLButtonElement>('.opt').forEach((b) =>
        b.addEventListener('click', () => {
          const o = os[Number(b.dataset.k)] as Option;
          if (q.type === 'single') {
            S.a[q.id] = o.t;
            save();
            render();
            if (!o.ot) advance = window.setTimeout(() => go(1), 420);
            else $(stage, '#other')?.focus();
          } else {
            let a = Array.isArray(S.a[q.id]) ? (S.a[q.id] as string[]).slice() : [];
            if (a.includes(o.t)) a = a.filter((x) => x !== o.t);
            else if (o.ex) a = [o.t];
            else a = a.filter((x) => !os.find((p) => p.t === x && p.ex)).concat(o.t);
            S.a[q.id] = a;
            save();
            render();
            if (o.ot && a.includes(o.t)) $(stage, '#other')?.focus();
          }
        }),
      );
      const ot = $<HTMLInputElement>(stage, '#other');
      ot?.addEventListener('input', () => {
        S.a[`${q.id}_inne`] = ot.value;
        save();
      });
    } else if (q.type === 'text') {
      h += `<textarea id="t" maxlength="4000" placeholder="${esc(q.ph ?? '')}">${esc(v && v !== q.none ? v : '')}</textarea>`;
      stage.innerHTML = `${h}${nav(q, q.none ? `<button type="button" class="btn soft" id="none">${esc(q.none)}</button>` : '')}</section>`;
      const t = $<HTMLTextAreaElement>(stage, '#t') as HTMLTextAreaElement;
      t.addEventListener('input', () => {
        S.a[q.id] = t.value;
        save();
      });
      $(stage, '#none')?.addEventListener('click', () => {
        S.a[q.id] = q.none;
        save();
        go(1);
      });
    } else if (q.type === 'fields') {
      const o = (v ?? {}) as Record<string, string>;
      h +=
        '<div class="fields">' +
        q.fields
          .map(
            ([k, l, t, u]) =>
              `<label class="f" for="f_${k}">${esc(l)}<span class="${u ? 'unit' : ''}"><input id="f_${k}" type="${t}" ${
                t === 'number' ? 'inputmode="decimal" min="0"' : ''
              } value="${esc(o[k] ?? '')}" data-k="${k}">${u ? `<b>${esc(u)}</b>` : ''}</span></label>`,
          )
          .join('') +
        '</div>';
      stage.innerHTML = `${h}${nav(q)}</section>`;
      stage.querySelectorAll<HTMLInputElement>('.fields input').forEach((i) =>
        i.addEventListener('input', () => {
          S.a[q.id] = { ...((S.a[q.id] as object | undefined) ?? {}), [i.dataset.k as string]: i.value };
          save();
        }),
      );
    } else if (q.type === 'waist') {
      const g = c().g;
      h += `<div class="waist">${waistSVG(c())}<div><ol>
        <li>${g('Stań prosto, rozluźniony', 'Stań prosto, rozluźniona', 'Stań prosto i rozluźnij się')}, z odsłoniętym brzuchem.</li>
        <li>Znajdź <b>dolne żebro</b> i <b>górny brzeg kości biodrowej</b>.</li>
        <li>Owiń centymetr <b>w połowie odległości między nimi</b>, zwykle na wysokości pępka lub tuż nad nim.</li>
        <li>Taśma poziomo, przylega, ale nie uciska. Zmierz po spokojnym wydechu, bez wciągania brzucha.</li></ol></div></div>
        <label class="f" for="w">Mój obwód talii<span class="unit"><input id="w" type="number" inputmode="decimal" min="40" max="200" value="${esc(v ?? '')}"><b>cm</b></span></label>`;
      stage.innerHTML = `${h}${nav(q)}</section>`;
      const w = $<HTMLInputElement>(stage, '#w') as HTMLInputElement;
      w.addEventListener('input', () => {
        S.a[q.id] = w.value;
        save();
      });
    } else if (q.type === 'matrix') {
      const o = (v ?? {}) as Record<string, string | string[] | undefined>;
      const cs = q.cols.map(parseOption);
      const sz: Record<string, number> = { s: 12, m: 18, l: 24 };
      h +=
        '<div class="matrix">' +
        q.rows
          .map(
            (r, ri) =>
              `<div class="mrow"><h3>${esc(r)}</h3><div class="chips">` +
              cs
                .map((col, ci) => {
                  const val = o[r];
                  const on = q.mode === 'single' ? val === col.t : Array.isArray(val) && val.includes(col.t);
                  const size = sz[col.e];
                  const icon = size ? `<span class="plate" style="width:${size}px;height:${size}px"></span>` : col.e;
                  return `<button type="button" class="chip${on ? ' on' : ''}" data-r="${ri}" data-c="${ci}" aria-pressed="${on}">${icon} ${esc(col.t)}</button>`;
                })
                .join('') +
              '</div></div>',
          )
          .join('') +
        '</div>';
      stage.innerHTML = `${h}${nav(q)}</section>`;
      stage.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) =>
        b.addEventListener('click', () => {
          const r = q.rows[Number(b.dataset.r)] as string;
          const col = (cs[Number(b.dataset.c)] as Option).t;
          const o2: Record<string, string | string[] | undefined> = { ...((S.a[q.id] as object | undefined) ?? {}) };
          if (q.mode === 'single') o2[r] = o2[r] === col ? undefined : col;
          else {
            const a = Array.isArray(o2[r]) ? (o2[r] as string[]).slice() : [];
            o2[r] = a.includes(col) ? a.filter((x) => x !== col) : a.concat(col);
          }
          S.a[q.id] = o2;
          save();
          render();
        }),
      );
    } else if (q.type === 'scale') {
      const val = typeof v === 'number' ? v : 5;
      h += `<div class="scale"><div class="face" id="face">${face(q, val)}</div><div class="val" id="val">${val} / 10</div><input type="range" id="r" min="1" max="10" value="${val}" aria-label="${esc(R(q.q))}"><div class="ends"><span>1 · ${esc(q.lo)}</span><span>${esc(q.hi)} · 10</span></div></div>`;
      stage.innerHTML = `${h}${nav(q)}</section>`;
      const r = $<HTMLInputElement>(stage, '#r') as HTMLInputElement;
      if (v == null) {
        S.a[q.id] = 5;
        save();
      }
      r.addEventListener('input', () => {
        S.a[q.id] = Number(r.value);
        ($(stage, '#val') as HTMLElement).textContent = `${r.value} / 10`;
        const f = $(stage, '#face') as HTMLElement;
        f.textContent = face(q, Number(r.value));
        f.style.transform = 'scale(1.15)';
        window.setTimeout(() => (f.style.transform = ''), 150);
        save();
      });
    }

    bindRestart(top);
    $(stage, '#back')?.addEventListener('click', () => go(-1));
    $(stage, '#next')?.addEventListener('click', () => go(1));
    $(stage, '#skip')?.addEventListener('click', () => {
      S.a[q.id] = S.a[q.id] ?? '—';
      go(1);
    });
    const first = stage.querySelector<HTMLElement>('textarea,input:not([hidden])');
    if (first && q.type !== 'scale') first.focus({ preventScroll: true });
  }

  function bindRestart(root: ParentNode): void {
    root.querySelectorAll<HTMLElement>('.rsbox').forEach((box) => {
      const confirm = box.querySelector<HTMLElement>('.confirm') as HTMLElement;
      (box.querySelector('[data-open]') as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        confirm.hidden = !confirm.hidden;
      };
      (confirm.querySelector('[data-yes]') as HTMLElement).onclick = () => {
        confirm.hidden = true;
        restart();
      };
      (confirm.querySelector('[data-no]') as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        confirm.hidden = true;
      };
      confirm.onclick = (e) => e.stopPropagation();
    });
  }

  const closeConfirms = (): void =>
    document.querySelectorAll<HTMLElement>('.rsbox .confirm').forEach((el) => (el.hidden = true));
  document.addEventListener('click', closeConfirms);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeConfirms();
    const target = e.target as HTMLElement;
    if (e.key === 'Enter' && !e.shiftKey && target.tagName === 'INPUT' && $(stage, '#next')) {
      e.preventDefault();
      go(1);
    }
  });

  const engine: Engine = { state: S, go, render, restart, bindRestart };
  return engine;
}

export function confetti(canvas: HTMLCanvasElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const x = canvas.getContext('2d');
  if (!x) return;
  canvas.hidden = false;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const cs = getComputedStyle(document.documentElement);
  const cols = [cs.getPropertyValue('--accent'), cs.getPropertyValue('--leaf'), '#E9B44C', '#7FB3D5'];
  const p = Array.from({ length: 110 }, () => ({
    x: canvas.width / 2,
    y: canvas.height / 3,
    vx: (Math.random() - 0.5) * 12,
    vy: Math.random() * -11 - 3,
    r: Math.random() * 6 + 4,
    c: cols[(Math.random() * 4) | 0] as string,
    a: Math.random() * 6,
  }));
  let t = 0;
  const frame = (): void => {
    x.clearRect(0, 0, canvas.width, canvas.height);
    for (const o of p) {
      o.x += o.vx;
      o.y += o.vy;
      o.vy += 0.35;
      o.a += 0.2;
      x.save();
      x.translate(o.x, o.y);
      x.rotate(o.a);
      x.fillStyle = o.c;
      x.fillRect(-o.r / 2, -o.r / 4, o.r, o.r / 2);
      x.restore();
    }
    if (++t < 140) requestAnimationFrame(frame);
    else canvas.hidden = true;
  };
  frame();
}
