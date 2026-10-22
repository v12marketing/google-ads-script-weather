import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Runs src/web/static/portal.js against a tiny fake DOM holding the claim
// page's upload form: just enough of the DOM for what the script touches.

const SCRIPT = readFileSync(new URL('../src/web/static/portal.js', import.meta.url), 'utf8');

type Listener = (e: FakeEvent) => void;
interface FakeEvent {
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
  persisted?: boolean;
}

class FakeEl {
  children: Array<FakeEl | string> = [];
  parentNode: FakeEl | null = null;
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  hidden = false;
  disabled = false;
  className = '';
  id = '';
  value = '';
  href = '';
  files: unknown[] = [];
  focused = false;
  private text = '';
  constructor(
    readonly tagName: string,
    readonly selectors: Record<string, FakeEl> = {},
  ) {}
  get textContent(): string {
    return this.text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  querySelector(sel: string): FakeEl | null {
    return this.selectors[sel] ?? null;
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  appendChild<T extends FakeEl | string>(c: T): T {
    this.children.push(c);
    if (typeof c !== 'string') c.parentNode = this;
    return c;
  }
  insertBefore(c: FakeEl, before: FakeEl): FakeEl {
    const i = this.children.indexOf(before);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c: FakeEl): void {
    this.children = this.children.filter((x) => x !== c);
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  closest(sel: string): FakeEl | null {
    let el: FakeEl | null = this.parentNode;
    while (el && el.tagName !== sel) el = el.parentNode;
    return el;
  }
  focus(): void {
    this.focused = true;
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => (typeof c === 'string' ? [] : [c, ...c.all()]));
  }
}

function setup(o: { fetch?: boolean; maxBytes?: number; maxTotal?: number } = {}) {
  const input = new FakeEl('input');
  const label = new FakeEl('label');
  label.appendChild(input);
  const summary = new FakeEl('p');
  summary.hidden = true;
  const csrf = new FakeEl('input');
  csrf.value = 'csrf-token';
  const button = new FakeEl('button');
  button.textContent = 'Upload';
  const form = new FakeEl('form', {
    'input[type="file"]': input,
    '[data-file-summary]': summary,
    'input[name="_csrf"]': csrf,
    'button[type="submit"]': button,
  });
  form.attrs.action = '/c/tok/files#files';
  Object.assign(form.dataset, {
    claimUrl: '/c/tok',
    maxBytes: String(o.maxBytes ?? 1000),
    maxFiles: '10',
    maxTotal: String(o.maxTotal ?? 1500),
  });
  for (const c of [csrf, label, summary, button]) form.appendChild(c);

  const fetchCalls: Array<{ url: string; entries: Array<[string, unknown]>; accept: string }> = [];
  let respond = (_n: number) => ({ added: 1, errors: [] as Array<{ name: string; message: string }> });
  const fetch = vi.fn(async (url: string, init: { body: FormData; headers: Record<string, string> }) => {
    fetchCalls.push({ url, entries: [...init.body.entries()], accept: init.headers.Accept! });
    const body = respond(fetchCalls.length);
    return { status: body.added ? 200 : 400, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body };
  });
  const location = { pathname: '/c/tok', search: '', hash: '', assign: vi.fn(), reload: vi.fn() };
  const docListeners: Record<string, Listener[]> = {};
  const document = {
    addEventListener: (t: string, fn: Listener) => (docListeners[t] ??= []).push(fn),
    querySelectorAll: (sel: string) => (sel === 'form.upload-form' ? [form] : []),
    createElement: (tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => text,
    getElementById: (id: string) => form.all().find((el) => el.id === id) ?? null,
  };
  const window = { addEventListener() {}, fetch: o.fetch === false ? undefined : fetch, FormData };
  vm.runInNewContext(SCRIPT, { window, document, location, fetch: window.fetch, FormData, HTMLFormElement: FakeEl, setTimeout });

  const choose = (files: unknown[]) => {
    input.files = files;
    for (const fn of input.listeners.change ?? []) fn({ target: input, defaultPrevented: false, preventDefault() {} });
  };
  // Dispatches submit on the form, then on the document (bubbling); true if the browser would send the form itself.
  const submit = (): boolean => {
    const e: FakeEvent = {
      target: form,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    for (const fn of [...(form.listeners.submit ?? []), ...(docListeners.submit ?? [])]) fn(e);
    return !e.defaultPrevented;
  };
  return { form, input, summary, button, fetch, fetchCalls, location, choose, submit, setResponse: (fn: typeof respond) => (respond = fn) };
}

const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'image/png' });

describe('portal.js uploads', () => {
  it('sends each chosen file in its own request, CSRF field first, then shows the claim page', async () => {
    const t = setup();
    const a = file('a.png', 900);
    const b = file('b.png', 900); // together over the 1500-byte total, fine one at a time
    t.choose([a, b]);
    expect(t.summary.textContent).not.toMatch(/Together/);

    expect(t.submit()).toBe(false);
    await vi.waitFor(() => expect(t.location.assign).toHaveBeenCalled());

    expect(t.fetchCalls.map((c) => [c.url, c.accept, c.entries.map(([k, v]) => [k, v instanceof File ? v.name : v])])).toEqual([
      ['/c/tok/files', 'application/json', [['_csrf', 'csrf-token'], ['files', 'a.png']]],
      ['/c/tok/files', 'application/json', [['_csrf', 'csrf-token'], ['files', 'b.png']]],
    ]);
    expect(t.location.assign).toHaveBeenCalledWith('/c/tok?uploaded=2#files');
  });

  it('reloads the claim page when the address to show differs only in its #fragment', async () => {
    // e.g. after an earlier upload of as many files, then the skip link (#main).
    const t = setup();
    Object.assign(t.location, { search: '?uploaded=2', hash: '#main' });
    t.choose([file('a.png', 10), file('b.png', 10)]);
    expect(t.submit()).toBe(false);
    await vi.waitFor(() => expect(t.location.reload).toHaveBeenCalled());
    expect(t.location.assign).not.toHaveBeenCalled();
    expect(t.location.hash).toBe('files');
  });

  it("'Show them' after a partly failed upload loads the claim page, even when only the #fragment differs", async () => {
    const t = setup();
    t.setResponse((n) => (n === 1 ? { added: 1, errors: [] } : { added: 0, errors: [{ name: 'b.png', message: 'Nope.' }] }));
    t.choose([file('a.png', 10), file('b.png', 10)]);
    t.submit();
    await vi.waitFor(() => expect(t.button.disabled).toBe(false));
    const link = t.form.all().find((el) => el.id === 'upload-added')!.all().find((el) => el.tagName === 'a')!;
    expect(link.href).toBe('/c/tok?uploaded=1#files');
    const click = () => {
      const e: FakeEvent = {
        target: link,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const fn of link.listeners.click ?? []) fn(e);
      return e;
    };

    expect(click().defaultPrevented).toBe(true);
    expect(t.location.assign).toHaveBeenCalledWith('/c/tok?uploaded=1#files');

    Object.assign(t.location, { search: '?uploaded=1', hash: '' });
    click();
    expect(t.location.reload).toHaveBeenCalledTimes(1);
    expect(t.location.hash).toBe('files');
  });

  it('warns and sends nothing when more files are chosen than one upload takes', () => {
    const t = setup();
    t.choose(Array.from({ length: 11 }, (_, i) => file(`p${i}.png`, 10)));
    expect(t.summary.hidden).toBe(false);
    expect(t.summary.textContent).toContain('You can add up to 10 files at a time');
    expect(t.submit()).toBe(false);
    expect(t.fetch).not.toHaveBeenCalled();
    expect(t.input.focused).toBe(true);
  });

  it('skips files over the size limit and lists everything that was not added', async () => {
    const t = setup();
    t.setResponse(() => ({ added: 1, errors: [] }));
    t.choose([file('huge.png', 2000), file('ok.png', 10)]);
    expect(t.summary.textContent).toContain('huge.png is larger than 1 KB and will not be added.');

    expect(t.submit()).toBe(false);
    await vi.waitFor(() => expect(t.button.disabled).toBe(false));

    expect(t.fetchCalls.map((c) => (c.entries[1]![1] as File).name)).toEqual(['ok.png']);
    expect(t.location.assign).not.toHaveBeenCalled();
    const error = t.form.all().find((el) => el.id === 'upload-error')!;
    expect(error.attrs.role).toBe('alert');
    expect(error.textContent).toContain("Some files weren't added:");
    expect(error.textContent).toContain('huge.png: This file is larger than');
    expect(t.form.all().find((el) => el.id === 'upload-added')!.textContent).toContain('1 file was added to your claim.');
    expect(t.button.textContent).toBe('Upload');
    expect(t.input.disabled).toBe(false);
  });

  it('shows what the server refused, and stops on an expired page', async () => {
    const t = setup();
    t.setResponse((n) => (n === 1 ? { added: 0, errors: [{ name: 'evil.html', message: "We can't accept that type of file." }] } : { added: 1, errors: [] }));
    t.choose([file('evil.html', 10), file('ok.png', 10)]);
    t.submit();
    await vi.waitFor(() => expect(t.button.disabled).toBe(false));
    expect(t.form.all().find((el) => el.id === 'upload-error')!.textContent).toContain("evil.html: We can't accept that type of file.");

    const expired = setup();
    expired.fetch.mockResolvedValue({ status: 403, headers: { get: () => 'text/html' }, json: async () => ({}) } as never);
    expired.choose([file('a.png', 10), file('b.png', 10)]);
    expired.submit();
    await vi.waitFor(() => expect(expired.button.disabled).toBe(false));
    expect(expired.fetch).toHaveBeenCalledTimes(1);
    expect(expired.form.all().find((el) => el.id === 'upload-error')!.textContent).toContain('This page has expired. Please reload it, then add the rest. Not added: a.png, b.png.');
  });

  it('without fetch, lets the form submit normally but warns first when the files are over the total', () => {
    const t = setup({ fetch: false });
    t.choose([file('a.png', 900), file('b.png', 900)]);
    expect(t.summary.textContent).toContain('Together these files are over');
    expect(t.submit()).toBe(false);

    t.choose([file('a.png', 900)]);
    expect(t.submit()).toBe(true);
  });
});
