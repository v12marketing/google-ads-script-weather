// The slice of the Monday.com API the integration uses. The real client is in
// client.ts; fake.ts is an in-memory board for tests and local development.

export interface MondayAsset {
  id: string;
  name: string;
  fileExtension: string | null;
  fileSize: number | null;
}

export interface MondayColumnValue {
  id: string;
  type: string;
  // Human-readable text Monday renders for the column (status label, email, etc.).
  text: string | null;
  // Raw JSON string Monday stores, or null.
  value: string | null;
  // For file columns: assets currently attached to this column, in board order.
  assetIds?: string[];
}

export interface MondayItem {
  id: string;
  boardId: string;
  name: string;
  createdAt: string;
  columnValues: Record<string, MondayColumnValue>;
}

export interface MondayUpdate {
  id: string;
  itemId: string;
  // Plain text of the update body (HTML stripped).
  textBody: string;
  creatorId: string | null;
  createdAt: string;
}

export interface MondayApi {
  getItem(itemId: string, columnIds?: string[]): Promise<MondayItem | null>;
  getUpdate(updateId: string): Promise<MondayUpdate | null>;

  // Values keyed by column id, in Monday's change_multiple_column_values JSON
  // shapes, e.g. { text_x: "HDC-000001", status: { label: "Settlement signed" } }.
  changeColumnValues(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void>;

  // Posts an update (comment) on the item. `body` is HTML. Returns the update id.
  createUpdate(itemId: string, body: string): Promise<string>;

  // In-app notification to a Monday user, linked to the item.
  notifyUser(userId: string, itemId: string, text: string): Promise<void>;

  getAssets(assetIds: string[]): Promise<MondayAsset[]>;
  // Streams/downloads an asset's bytes (resolves the short-lived public URL internally).
  downloadAsset(assetId: string): Promise<{ data: Buffer; mimeType: string; name: string }>;
  // Attaches a file to a file column. Returns the new asset id.
  uploadFileToColumn(itemId: string, columnId: string, file: { name: string; mimeType: string; data: Buffer }): Promise<string>;
}

// Normalised webhook event, produced from Monday's raw payload by the webhook route.
export type MondayEvent =
  | { kind: 'item_created'; boardId: string; itemId: string; triggerUuid: string | null }
  | {
      kind: 'status_changed';
      boardId: string;
      itemId: string;
      columnId: string;
      label: string | null;
      previousLabel: string | null;
      triggerUuid: string | null;
    }
  | { kind: 'column_changed'; boardId: string; itemId: string; columnId: string; triggerUuid: string | null }
  | {
      kind: 'update_created';
      boardId: string;
      itemId: string;
      updateId: string;
      textBody: string;
      creatorId: string | null;
      triggerUuid: string | null;
    };
