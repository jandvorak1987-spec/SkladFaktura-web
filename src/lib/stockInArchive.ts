import type { ExtractedLineItem } from '../types';

export interface ArchivedStockInItem {
  sku: string;
  name: string;
  ean: string;
  category: string;
  quantity: number;
  unit: string;
  purchasePrice: number;
  salePrice: number;
  vatRate: number;
}

export interface ArchivedStockInDocument {
  id: string;
  workspaceId: string;
  documentNumber: string;
  supplierName: string;
  supplierIco: string;
  warehouseId: string;
  companyId: string;
  currency: string;
  exchangeRate: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  /** Full original PDF / Image / XML / CSV binary file stored locally in IndexedDB */
  fileBlob?: Blob | null;
  rawText?: string;
  items: ArchivedStockInItem[];
  createdAtMs: number;
}

const DB_NAME = 'skladfaktura_stockin_archive';
const DB_VERSION = 1;
const STORE_NAME = 'documents';

function openArchiveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Prohlížeč nepodporuje lokální archivaci (IndexedDB).'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('workspaceId', 'workspaceId', { unique: false });
        store.createIndex('documentNumber', 'documentNumber', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Nepodařilo se otevřít archiv dokladů.'));
  });
}

export async function saveArchivedStockInDocument(
  docRecord: Omit<ArchivedStockInDocument, 'id' | 'createdAtMs'> & {
    id?: string;
    createdAtMs?: number;
  }
): Promise<ArchivedStockInDocument> {
  const full: ArchivedStockInDocument = {
    ...docRecord,
    id: docRecord.id || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAtMs: docRecord.createdAtMs || Date.now(),
  };

  const db = await openArchiveDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(full);
    tx.oncomplete = () => {
      db.close();
      resolve(full);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Uložení dokladu do archivu selhalo.'));
    };
  });
}

export async function listArchivedStockInDocuments(
  workspaceId: string
): Promise<ArchivedStockInDocument[]> {
  if (!workspaceId || typeof indexedDB === 'undefined') return [];
  try {
    const db = await openArchiveDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const idx = tx.objectStore(STORE_NAME).index('workspaceId');
      const req = idx.getAll(workspaceId);
      req.onsuccess = () => {
        db.close();
        const rows = (req.result || []) as ArchivedStockInDocument[];
        rows.sort((a, b) => b.createdAtMs - a.createdAtMs);
        resolve(rows);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return [];
  }
}

export async function deleteArchivedStockInDocument(id: string): Promise<void> {
  const db = await openArchiveDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Smazání dokladu z archivu selhalo.'));
    };
  });
}

export function mapLinesToArchivedItems(
  items: ExtractedLineItem[],
  defaultCategory = ''
): ArchivedStockInItem[] {
  return items
    .filter((i) => i.selected && i.name.trim() && i.quantity > 0)
    .map((i) => ({
      sku: i.sku.trim(),
      name: i.name.trim(),
      ean: i.ean.trim(),
      category: (i.category || defaultCategory || '').trim(),
      quantity: i.quantity,
      unit: i.unit || 'ks',
      purchasePrice: i.purchasePrice || 0,
      salePrice: i.suggestedSalePrice || 0,
      vatRate: i.vatRate ?? 21,
    }));
}
