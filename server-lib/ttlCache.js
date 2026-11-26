// Lightweight bounded in-memory TTL cache for Express & Vercel serverless routes.
// Zero external dependencies, O(1) Map operations with automatic expiry and FIFO/LRU cap.

export const TTL_CNB_RATES_MS = 24 * 60 * 60 * 1000; // 24 hours
export const TTL_ARES_COMPANY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const TTL_NERX_CATEGORY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class TtlCache {
  constructor({ defaultTtlMs, maxEntries = 2000 }) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh recency for LRU behavior
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key) {
    return this.get(key) !== undefined;
  }
}

/**
 * Extracts a likely supplier 8-digit Czech ICO from raw invoice/delivery-note text
 * so ARES validation can start concurrently with Gemini parsing.
 */
export function extractCandidateSupplierIco(rawText, explicitIco = '') {
  const direct = String(explicitIco || '').replace(/\D/g, '');
  if (direct.length === 8) return direct;

  const text = String(rawText || '');
  if (!text) return '';

  // Prefer ICO appearing near "Dodavatel" / "Supplier" or the first labeled "IČO:"
  const supplierSection = text.match(
    /(?:dodavatel|prodávající|prodavajici|vystavitel|supplier|seller)[\s\S]{0,260}?(?:ičo?|ic|reg\.?\s*no\.?)\s*[:.]?\s*(\d{8})\b/i
  );
  if (supplierSection?.[1]) return supplierSection[1];

  const firstLabeled = text.match(/(?:ičo?|ič)\s*[:.]?\s*(\d{8})\b/i);
  if (firstLabeled?.[1]) return firstLabeled[1];

  return '';
}

/**
 * Returns true if an invoice/delivery-note line represents a statutory recycling fee / PHE
 * contribution (elektrozařízení, baterie, zpětný odběr, WEEE) that must NEVER be added to stock.
 */
export function isNonStockRecyclingFee(name, sku = '') {
  const normName = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  if (normName) {
    if (
      /recyklacni\s*(poplatek|prispevek|priplatek|popl\.?|prisp\.?)/.test(normName) ||
      /\brec\.?\s*(poplatek|prispevek|popl\.?|prisp\.?)\b/.test(normName) ||
      /\b(poplatek|prispevek|priplatek)\s+(za|na|k)\s+recyklac/.test(normName) ||
      /^\s*recyklac(e|ni)\b/.test(normName) ||
      /\brecyklac(e|ni)\s+(elektro|bater|zariz|odpad)/.test(normName) ||
      /\b(recycling|weee)\s*(fee|charge|contribution|levy)\b/.test(normName) ||
      /\b(eko|eco)\s*[- ]?(poplatek|prispevek)\b/.test(normName) ||
      /\b(elektroodpad|zpetny\s+odber|historick\w*\s+elektrozariz)/.test(normName) ||
      /^\s*phe(\s*[-–:/(].*)?$/.test(normName) ||
      /\bphe\b.*\b(poplatek|prispevek|recykl|elektro|bater)/.test(normName) ||
      /\b(poplatek|prispevek)\b.*\bphe\b/.test(normName) ||
      /\b(asekol|elektrowin|retela|ecobat|rema\s+system)\b/.test(normName)
    ) {
      return true;
    }
  }

  const normSku = String(sku || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

  if (
    normSku === 'phe' ||
    normSku === 'weee' ||
    normSku === 'recyklace' ||
    normSku.startsWith('recyklacnipopl') ||
    normSku.startsWith('recpopl') ||
    normSku.startsWith('ekopopl')
  ) {
    return true;
  }

  return false;
}

