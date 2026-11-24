export interface NerxCategorizeInput {
  id: string;
  name: string;
  sku?: string;
  ean?: string;
}

export interface NerxCategorizeMatch {
  id: string;
  category: string;
  source: 'NERX' | 'RULE' | 'NONE';
  matchedTitle: string;
  matchedUrl: string;
}

/**
 * Categorizes inventory items in batches against live Nerx.cz catalog
 * (with automatic rule-based fallback when a product isn't listed on Nerx.cz).
 */
export async function categorizeItemsViaNerx(
  items: NerxCategorizeInput[],
  onProgress?: (done: number, total: number) => void
): Promise<NerxCategorizeMatch[]> {
  if (items.length === 0) return [];

  const allResults: NerxCategorizeMatch[] = [];
  const batchSize = 20;

  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const res = await fetch('/api/nerx-categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: chunk }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Nepodařilo se porovnat položky s Nerx.cz.');
    }
    const batchMatches = Array.isArray(data.results) ? (data.results as NerxCategorizeMatch[]) : [];
    allResults.push(...batchMatches);
    onProgress?.(Math.min(i + chunk.length, items.length), items.length);
  }

  return allResults;
}
