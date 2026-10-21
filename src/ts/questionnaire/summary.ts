import { type Answers, ctxFor, QUESTIONS, type Question, resolve } from './questions';

export interface SummarySection {
  title: string;
  items: { question: string; answer: string }[];
}

const empty = (v: unknown): boolean => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Human-readable answer for one question (same rules as the approved prototype). */
export function formatAnswer(q: Question, answers: Answers): string {
  const v = answers[q.id];
  if (empty(v)) return '—';
  switch (q.type) {
    case 'fields': {
      const o = (v ?? {}) as Record<string, string>;
      return q.fields
        .map(([k, label, , unit]) => `${label}: ${o[k] || '—'}${o[k] && unit ? ` ${unit}` : ''}`)
        .join(' | ');
    }
    case 'matrix': {
      const o = (v ?? {}) as Record<string, string | string[] | undefined>;
      return q.rows
        .map((r) => {
          const x = o[r];
          return `${r}: ${x == null || (Array.isArray(x) && !x.length) ? '—' : ([] as string[]).concat(x).join(', ')}`;
        })
        .join('\n');
    }
    case 'scale':
      return `${String(v)}/10 (${q.lo} → ${q.hi})`;
    case 'waist':
      return v === '—' ? '—' : `${String(v)} cm`;
    default: {
      let s = ([] as unknown[]).concat(v).join(', ');
      const other = answers[`${q.id}_inne`];
      if (typeof other === 'string' && other && s.includes('Inne')) s += ` (${other})`;
      return s;
    }
  }
}

export function summarize(answers: Answers): SummarySection[] {
  const c = ctxFor(answers);
  const sections: SummarySection[] = [];
  for (const q of QUESTIONS) {
    let section = sections.at(-1);
    if (!section || section.title !== q.s) {
      section = { title: q.s, items: [] };
      sections.push(section);
    }
    section.items.push({ question: resolve(q.q, c), answer: formatAnswer(q, answers) });
  }
  return sections;
}

export function summaryText(answers: Answers): string {
  const name = (answers.dane as Record<string, string> | undefined)?.imie ?? '';
  let out = `KWESTIONARIUSZ – ${name}\n`;
  for (const s of summarize(answers)) {
    out += `\n== ${s.title.toUpperCase()} ==\n`;
    for (const i of s.items)
      out += `• ${i.question} ${i.answer.includes('\n') ? `\n   ${i.answer.replaceAll('\n', '\n   ')}` : i.answer}\n`;
  }
  return out;
}
