import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (name: string): string =>
  readFileSync(new URL(`../src/web/static/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Each rule's selectors, comma-split and trimmed.
const selectorsOf = (src: string): string[][] =>
  [...src.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1]!.split(',').map((s) => s.trim()));

const ruleFor = (src: string, selector: string): string => {
  const m = src.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1]!;
};

const token = (src: string, name: string): string => {
  const m = src.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`no --${name}`);
  return m[1]!;
};

// WCAG 2.1 contrast ratio between two #rrggbb colours.
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('stylesheets', () => {
  it('outlines form fields at 3:1 or better against white and the soft background (WCAG 1.4.11)', () => {
    const site = css('site.css');
    const portal = css('portal.css');
    const border = token(site, 'field-border');
    expect(contrast(border, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(border, token(site, 'bg-soft'))).toBeGreaterThanOrEqual(3);
    expect(ruleFor(site, 'textarea, select')).toContain('border: 1px solid var(--field-border)');
    expect(ruleFor(portal, '.upload-form input[type="file"]')).toContain('var(--field-border)');
  });

  it("keeps the home page's step cards off the claim page's progress tracker", () => {
    // The tracker's items are <li class="step">: no site-wide rule may style a bare .step.
    const bare = selectorsOf(css('site.css'))
      .flat()
      .filter((s) => /(^|[\s>+~])\.step(?![\w-])/.test(s) && !/\.steps\b/.test(s));
    expect(bare).toEqual([]);
    expect(selectorsOf(css('site.css')).flat()).toContain('.steps > .step');
  });
});
