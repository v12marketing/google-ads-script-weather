import type { MondayApi, MondayAsset, MondayColumnValue, MondayItem, MondayUpdate, MondayWriteOptions } from './types.js';

// In-memory Monday board for tests and local development. Mutations are applied
// to the stored items and recorded in `calls` so tests can assert on them.

interface FakeAsset extends MondayAsset {
  data: Buffer;
  mimeType: string;
}

export class FakeMonday implements MondayApi {
  items = new Map<string, MondayItem>();
  updates = new Map<string, MondayUpdate>();
  assets = new Map<string, FakeAsset>();
  notifications: Array<{ userId: string; itemId: string; text: string }> = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  // Set to make the next N calls throw, to exercise retries.
  failNext = 0;
  // Set to make the next N createUpdate/notifyUser calls apply and then throw
  // (a response lost after Monday applied the write).
  loseNextResponse = 0;
  // Like Monday: a write repeated with an Idempotency-Key it has seen returns the
  // first result without being applied again.
  private replays = new Map<string, unknown>();
  private nextId = 1000;

  constructor(private integrationUserId = '999') {}

  private id(): string {
    return String(this.nextId++);
  }

  private maybeFail(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error(`FakeMonday: simulated failure in ${method}`);
    }
  }

  // --- test helpers ---

  addItem(boardId: string, name: string, columns: Record<string, Partial<MondayColumnValue>> = {}): MondayItem {
    const id = this.id();
    const columnValues: Record<string, MondayColumnValue> = {};
    for (const [cid, v] of Object.entries(columns)) {
      columnValues[cid] = { id: cid, type: v.type ?? 'text', text: v.text ?? null, value: v.value ?? null, assetIds: v.assetIds };
    }
    const item: MondayItem = { id, boardId, name, createdAt: new Date().toISOString(), columnValues };
    this.items.set(id, item);
    return item;
  }

  setText(itemId: string, columnId: string, text: string | null, type = 'text'): void {
    const item = this.mustItem(itemId);
    const prev = item.columnValues[columnId];
    item.columnValues[columnId] = { id: columnId, type: prev?.type ?? type, text, value: text === null ? null : JSON.stringify(text), assetIds: prev?.assetIds };
  }

  // Adds an update as a team member (or the integration user, to test echo suppression).
  addTeamUpdate(itemId: string, textBody: string, creatorId = '111'): MondayUpdate {
    const u: MondayUpdate = { id: this.id(), itemId, textBody, creatorId, createdAt: new Date().toISOString() };
    this.updates.set(u.id, u);
    return u;
  }

  attachFile(itemId: string, columnId: string, file: { name: string; mimeType: string; data: Buffer }): string {
    const assetId = this.id();
    const ext = file.name.includes('.') ? file.name.split('.').pop()! : null;
    this.assets.set(assetId, { id: assetId, name: file.name, fileExtension: ext, fileSize: file.data.length, data: file.data, mimeType: file.mimeType });
    const item = this.mustItem(itemId);
    const col = item.columnValues[columnId] ?? { id: columnId, type: 'file', text: null, value: null, assetIds: [] };
    col.type = 'file';
    col.assetIds = [...(col.assetIds ?? []), assetId];
    col.text = col.assetIds.map((a) => this.assets.get(a)!.name).join(', ');
    item.columnValues[columnId] = col;
    return assetId;
  }

  removeFile(itemId: string, columnId: string, assetId: string): void {
    const col = this.mustItem(itemId).columnValues[columnId];
    if (col?.assetIds) col.assetIds = col.assetIds.filter((a) => a !== assetId);
  }

  mustItem(itemId: string): MondayItem {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`FakeMonday: no item ${itemId}`);
    return item;
  }

  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  // --- MondayApi ---

  async getItem(itemId: string, columnIds?: string[]): Promise<MondayItem | null> {
    this.maybeFail('getItem', [itemId, columnIds]);
    const item = this.items.get(itemId);
    if (!item) return null;
    const copy = structuredClone(item);
    if (columnIds) {
      for (const k of Object.keys(copy.columnValues)) if (!columnIds.includes(k)) delete copy.columnValues[k];
    }
    return copy;
  }

  async getUpdate(updateId: string): Promise<MondayUpdate | null> {
    this.maybeFail('getUpdate', [updateId]);
    return this.updates.get(updateId) ?? null;
  }

  async changeColumnValues(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void> {
    this.maybeFail('changeColumnValues', [boardId, itemId, values]);
    const item = this.mustItem(itemId);
    for (const [cid, v] of Object.entries(values)) {
      const prev = item.columnValues[cid];
      let text: string | null;
      if (v === null) text = null;
      else if (typeof v === 'string') text = v;
      else if (typeof v === 'object' && v && 'label' in v) text = String((v as { label: unknown }).label);
      else if (typeof v === 'object' && v && 'date' in v) text = String((v as { date: unknown }).date);
      else if (typeof v === 'object' && v && 'url' in v) text = String((v as { url: unknown }).url);
      else text = JSON.stringify(v);
      item.columnValues[cid] = { id: cid, type: prev?.type ?? 'text', text, value: v === null ? null : JSON.stringify(v), assetIds: prev?.assetIds };
    }
  }

  private idempotent<T>(opts: MondayWriteOptions | undefined, apply: () => T): T {
    const key = opts?.idempotencyKey;
    if (key && this.replays.has(key)) return this.replays.get(key) as T;
    const result = apply();
    if (key) this.replays.set(key, result);
    if (this.loseNextResponse > 0) {
      this.loseNextResponse--;
      throw new Error('FakeMonday: simulated timeout (it may still have been applied)');
    }
    return result;
  }

  async createUpdate(itemId: string, body: string, opts?: MondayWriteOptions): Promise<string> {
    this.maybeFail('createUpdate', [itemId, body]);
    this.mustItem(itemId);
    return this.idempotent(opts, () => {
      const textBody = body.replace(/<[^>]*>/g, '').trim();
      const u: MondayUpdate = { id: this.id(), itemId, textBody, creatorId: this.integrationUserId, createdAt: new Date().toISOString() };
      this.updates.set(u.id, u);
      return u.id;
    });
  }

  async notifyUser(userId: string, itemId: string, text: string, opts?: MondayWriteOptions): Promise<void> {
    this.maybeFail('notifyUser', [userId, itemId, text]);
    this.idempotent(opts, () => {
      this.notifications.push({ userId, itemId, text });
    });
  }

  async getAssets(assetIds: string[]): Promise<MondayAsset[]> {
    this.maybeFail('getAssets', [assetIds]);
    return assetIds
      .map((id) => this.assets.get(id))
      .filter((a): a is FakeAsset => !!a)
      .map(({ id, name, fileExtension, fileSize }) => ({ id, name, fileExtension, fileSize }));
  }

  async downloadAsset(assetId: string): Promise<{ data: Buffer; mimeType: string; name: string }> {
    this.maybeFail('downloadAsset', [assetId]);
    const a = this.assets.get(assetId);
    if (!a) throw new Error(`FakeMonday: no asset ${assetId}`);
    return { data: a.data, mimeType: a.mimeType, name: a.name };
  }

  async uploadFileToColumn(itemId: string, columnId: string, file: { name: string; mimeType: string; data: Buffer }): Promise<string> {
    this.maybeFail('uploadFileToColumn', [itemId, columnId, file.name]);
    return this.attachFile(itemId, columnId, file);
  }
}
