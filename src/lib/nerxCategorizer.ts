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

type CachedNerxResult = Omit<NerxCategorizeMatch, 'id'>;

const clientNerxCache = new Map<string, CachedNerxResult>();

function makeCacheKey(item: NerxCategorizeInput): string {
  const normName = (item.name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const cleanEan = (item.ean || '').replace(/\D/g, '');
  return cleanEan.length >= 8 ? `${cleanEan}|${normName}` : normName;
}

/**
 * Categorizes inventory items against live Nerx.cz catalog:
 *  - Resolves already-known product names immediately from in-memory cache.
 *  - Dispatches unknown items in parallel batches via Promise.allSettled (concurrency limit 5).
 */
export async function categorizeItemsViaNerx(
  items: NerxCategorizeInput[],
  onProgress?: (done: number, total: number) => void
): Promise<NerxCategorizeMatch[]> {
  if (items.length === 0) return [];

  const total = items.length;
  const resultsById = new Map<string, NerxCategorizeMatch>();
  const unknownItems: NerxCategorizeInput[] = [];

  for (const item of items) {
    const key = makeCacheKey(item);
    const hit = clientNerxCache.get(key);
    if (hit) {
      resultsById.set(item.id, { id: item.id, ...hit });
    } else {
      unknownItems.push(item);
    }
  }

  let completed = resultsById.size;
  if (completed > 0) {
    onProgress?.(completed, total);
  }

  if (unknownItems.length > 0) {
    const batchSize = 20;
    const chunks: NerxCategorizeInput[][] = [];
    for (let i = 0; i < unknownItems.length; i += batchSize) {
      chunks.push(unknownItems.slice(i, i + batchSize));
    }

    const inputById = new Map(unknownItems.map((it) => [it.id, it]));
    const concurrency = 5;
    let firstError: Error | null = null;

    for (let start = 0; start < chunks.length; start += concurrency) {
      const wave = chunks.slice(start, start + concurrency);
      const settled = await Promise.allSettled(
        wave.map(async (chunk) => {
          const res = await fetch('/api/nerx-categorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: chunk }),
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || 'Nepodařilo se porovnat položky s Nerx.cz.');
          }
          return Array.isArray(data.results) ? (data.results as NerxCategorizeMatch[]) : [];
        })
      );

      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i];
        const chunk = wave[i];
        if (outcome.status === 'fulfilled') {
          for (const match of outcome.value) {
            resultsById.set(match.id, match);
            const orig = inputById.get(match.id);
            if (orig) {
              clientNerxCache.set(makeCacheKey(orig), {
                category: match.category,
                source: match.source,
                matchedTitle: match.matchedTitle,
                matchedUrl: match.matchedUrl,
              });
            }
          }
        } else if (!firstError) {
          firstError =
            outcome.reason instanceof Error
              ? outcome.reason
              : new Error('Nepodařilo se porovnat položky s Nerx.cz.');
        }
        completed = Math.min(total, completed + chunk.length);
        onProgress?.(completed, total);
      }
    }

    if (resultsById.size === 0 && firstError) {
      throw firstError;
    }
  }

  return items
    .map((item) => resultsById.get(item.id))
    .filter((m): m is NerxCategorizeMatch => Boolean(m));
}
