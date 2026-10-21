import type { Ctx } from './questions';

/** Body outline with the waist measurement line (female / male / in-between silhouette). Ported from the prototype. */
export function waistSVG(c: Ctx): string {
  const C = 100;
  const [S, W, H] = c.male ? [47, 33, 36] : c.neutral ? [43, 29, 40] : [39, 25, 43];
  const L = (x: number): number => C - x;
  const Rt = (x: number): number => C + x;
  const body = `M ${L(9)} 2 L ${L(9)} 16 Q ${L(10)} 24 ${L(S)} 30 Q ${L(S + 2)} 40 ${L(S - 6)} 56 Q ${L(W + 6)} 80 ${L(W)} 110 Q ${L(W + 2)} 130 ${L(H)} 152 Q ${L(H + 1)} 185 ${L(H - 6)} 218 L ${L(3)} 218 Q ${C} 205 ${C} 192 Q ${C} 205 ${Rt(3)} 218 L ${Rt(H - 6)} 218 Q ${Rt(H + 1)} 185 ${Rt(H)} 152 Q ${Rt(W + 2)} 130 ${Rt(W)} 110 Q ${Rt(W + 6)} 80 ${Rt(S - 6)} 56 Q ${Rt(S + 2)} 40 ${Rt(S)} 30 Q ${Rt(10)} 24 ${Rt(9)} 16 L ${Rt(9)} 2 Z`;
  const arm = (f: number): string => {
    const X = (x: number): number => C + f * x;
    return `M ${X(S)} 30 Q ${X(S + 10)} 90 ${X(S + 9)} 150 Q ${X(S + 3)} 160 ${X(S - 2)} 150 Q ${X(S - 2)} 100 ${X(S - 6)} 56 Z`;
  };
  const bust = !c.male
    ? `<path d="M ${L(W + 8)} 64 Q ${L(14)} ${c.neutral ? 72 : 78} ${C - 2} 66 M ${Rt(W + 8)} 64 Q ${Rt(14)} ${c.neutral ? 72 : 78} ${C + 2} 66" fill="none" stroke="var(--muted)" stroke-width="1.2" opacity=".7"/>`
    : `<path d="M ${L(W + 6)} 66 Q ${L(14)} 72 ${C - 3} 68 M ${Rt(W + 6)} 66 Q ${Rt(14)} 72 ${C + 3} 68" fill="none" stroke="var(--muted)" stroke-width="1.2" opacity=".5"/>`;
  return `<svg viewBox="0 0 200 222" role="img" aria-label="Miejsce pomiaru obwodu talii" class="waist-svg">
  <g fill="var(--leaf-soft)" stroke="var(--muted)" stroke-width="1.5"><path d="${arm(-1)}"/><path d="${arm(1)}"/><path d="${body}"/></g>
  ${bust}
  <path d="M ${L(W + 4)} 80 Q ${C} 96 ${Rt(W + 4)} 80" fill="none" stroke="var(--muted)" stroke-width="1.3"/>
  <line x1="18" y1="82" x2="182" y2="82" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3"/>
  <text x="198" y="78" font-size="10" fill="var(--muted)" text-anchor="end">żebro</text>
  <path d="M ${L(H - 4)} 148 Q ${L(H - 10)} 138 ${L(H - 18)} 144 M ${Rt(H - 4)} 148 Q ${Rt(H - 10)} 138 ${Rt(H - 18)} 144" fill="none" stroke="var(--muted)" stroke-width="1.3"/>
  <line x1="18" y1="140" x2="182" y2="140" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3"/>
  <text x="198" y="155" font-size="10" fill="var(--muted)" text-anchor="end">biodro</text>
  <circle cx="${C}" cy="116" r="2" fill="var(--muted)"/>
  <line class="tape" x1="${L(W + 3)}" y1="111" x2="${Rt(W + 3)}" y2="111" stroke="var(--accent)" stroke-width="5" stroke-linecap="round"/>
  <text x="${C}" y="130" font-size="10" fill="var(--accent)" text-anchor="middle" font-weight="700">tu mierz</text>
  <path d="M 10 86 L 10 136 M 6 90 L 10 84 L 14 90 M 6 132 L 10 138 L 14 132" fill="none" stroke="var(--leaf)" stroke-width="1.5"/>
  <text x="6" y="111" font-size="9" fill="var(--leaf)" transform="rotate(-90 6 111)" text-anchor="middle">połowa</text></svg>`;
}
