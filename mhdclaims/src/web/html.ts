// Minimal safe HTML templating: every interpolated value is escaped unless it is
// already an Html fragment produced by `html` or `raw`.

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

type Value = Html | string | number | boolean | null | undefined | Value[];

const render = (v: Value): string => {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return escapeHtml(String(v));
};

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

// Trusted markup only (our own constants). Never pass user input.
export const raw = (s: string): Html => new Html(s);

// Plain text -> paragraphs with line breaks, escaped.
export function textToHtml(text: string): Html {
  const paras = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return new Html(paras.join('\n'));
}
