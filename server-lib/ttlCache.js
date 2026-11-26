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
