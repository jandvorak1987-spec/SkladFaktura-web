import { round2 } from './format';
import type { InventoryItem } from '../types';

export interface PriceBreakdown {
  goodsPrice: number | null;
  exciseTaxPrice: number | null;
  cleanNotes: string;
}

const BREAKDOWN_TAG_RE = /\[Cena:\s*([^\]]+)\]/i;

function parseCzNum(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00A0]+/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function formatTagNum(n: number): string {
  const r = round2(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace('.', ',');
}

/**
 * Extracts optional goods price + excise stamp (kolek) breakdown stored inside InventoryItem.notes
 * so it remains 100% compatible with shared Android Firestore schema and security rules.
 */
export function parsePriceBreakdown(notes?: string): PriceBreakdown {
  const src = notes || '';
  const match = src.match(BREAKDOWN_TAG_RE);
  if (!match) {
    return { goodsPrice: null, exciseTaxPrice: null, cleanNotes: src.trim() };
  }

  const body = match[1];
  const goodsMatch = body.match(/zbo[žz][íi]\s+([0-9]+(?:[.,][0-9]+)?)/i);
  const exciseMatch = body.match(/kolek\s+([0-9]+(?:[.,][0-9]+)?)/i);

  const goodsPrice = goodsMatch ? parseCzNum(goodsMatch[1]) : null;
  const exciseTaxPrice = exciseMatch ? parseCzNum(exciseMatch[1]) : null;
  const cleanNotes = src
    .replace(BREAKDOWN_TAG_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { goodsPrice, exciseTaxPrice, cleanNotes };
}

/**
 * Rebuilds InventoryItem.notes preserving user notes and embedding the structured
 * [Cena: zboží X Kč + kolek Y Kč] breakdown (within Firestore's 500-char limit).
 */
export function composeNotesWithPriceBreakdown(
  cleanNotes: string,
  goodsPrice: number | null,
  exciseTaxPrice: number | null
): string {
  const stripped = (cleanNotes || '').replace(BREAKDOWN_TAG_RE, '').trim();
  const hasGoods = goodsPrice !== null && Number.isFinite(goodsPrice) && goodsPrice >= 0;
  const hasExcise = exciseTaxPrice !== null && Number.isFinite(exciseTaxPrice) && exciseTaxPrice >= 0;

  if (!hasGoods && !hasExcise) {
    return stripped.slice(0, 500);
  }

  const parts: string[] = [];
  if (hasGoods) parts.push(`zboží ${formatTagNum(goodsPrice!)} Kč`);
  if (hasExcise) parts.push(`kolek ${formatTagNum(exciseTaxPrice!)} Kč`);
  const tag = `[Cena: ${parts.join(' + ')}]`;

  if (!stripped) return tag.slice(0, 500);
  const maxNoteLen = Math.max(0, 500 - tag.length - 1);
  return `${stripped.slice(0, maxNoteLen).trim()} ${tag}`.trim();
}

export function normalizeSearchText(str: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches an inventory item against one or more comma/semicolon/newline-separated phrases.
 * Example: "elfliq, venix nex" matches any item containing "elfliq" OR containing both "venix" AND "nex".
 */
export function matchesNameQuery(
  item: Pick<InventoryItem, 'name' | 'sku' | 'ean' | 'category' | 'supplierName'>,
  rawQuery: string
): boolean {
  const trimmed = (rawQuery || '').trim();
  if (!trimmed) return true;

  const phrases = trimmed
    .split(/[,;\n]+/)
    .map((p) => normalizeSearchText(p))
    .filter(Boolean);

  if (phrases.length === 0) return true;

  const haystack = normalizeSearchText(
    `${item.name} ${item.sku} ${item.ean} ${item.category} ${item.supplierName}`
  );

  return phrases.some((phrase) => {
    const tokens = phrase.split(' ').filter(Boolean);
    return tokens.every((tok) => haystack.includes(tok));
  });
}

/**
 * Detects top common brand / product prefix words from the inventory for 1-click filter chips.
 */
export function extractQuickBrandChips(items: InventoryItem[], limit = 10): Array<{ label: string; count: number }> {
  const counts = new Map<string, { label: string; count: number }>();
  const skip = new Set(['pod', 'kit', 'pro', 'new', 'set', 'mix', 'max', 'mini', 'plus', 'sada', 'ks']);

  for (const item of items) {
    const words = (item.name || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const first = words[0].replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ-]/g, '');
    if (first.length < 3) continue;
    const key = normalizeSearchText(first);
    if (!key || skip.has(key) || /^\d+$/.test(key)) continue;

    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { label: first, count: 1 });
    }
  }

  return Array.from(counts.values())
    .filter((entry) => entry.count >= 2)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'cs'))
    .slice(0, limit);
}

export type SaleRoundingMode = 'NONE' | 'WHOLE' | 'ENDING_90';

export function applySaleRounding(price: number, mode: SaleRoundingMode): number {
  const safe = Math.max(0, round2(price));
  if (mode === 'WHOLE') return Math.round(safe);
  if (mode === 'ENDING_90') {
    if (safe <= 0) return 0;
    return Math.max(0.9, round2(Math.floor(safe) + 0.9));
  }
  return safe;
}

export type PurchaseRuleMode = 'NONE' | 'BREAKDOWN' | 'SET' | 'PERCENT' | 'DELTA';
export type SaleRuleMode =
  | 'NONE'
  | 'SET'
  | 'SET_WITH_VAT'
  | 'MARGIN_FROM_PURCHASE'
  | 'MARKUP_FROM_PURCHASE'
  | 'PERCENT'
  | 'DELTA';

export interface BulkPriceRule {
  purchaseMode: PurchaseRuleMode;
  /** Used for SET / PERCENT / DELTA */
  purchaseValue?: number | null;
  /** Used for BREAKDOWN (null = keep existing goods price) */
  goodsPrice?: number | null;
  /** Used for BREAKDOWN (null = keep existing excise stamp price) */
  exciseTaxPrice?: number | null;

  saleMode: SaleRuleMode;
  saleValue?: number | null;
  saleRounding?: SaleRoundingMode;
}

export interface ComputedItemPriceChange {
  item: InventoryItem;
  oldPurchasePrice: number;
  newPurchasePrice: number;
  oldGoodsPrice: number | null;
  oldExciseTaxPrice: number | null;
  newGoodsPrice: number | null;
  newExciseTaxPrice: number | null;
  oldSalePrice: number;
  newSalePrice: number;
  newNotes: string;
  changed: boolean;
  ruleLabel?: string;
}

export function computeItemPriceChange(
  item: InventoryItem,
  rule: BulkPriceRule,
  ruleLabel?: string
): ComputedItemPriceChange {
  const parsed = parsePriceBreakdown(item.notes);
  const oldPurchasePrice = round2(item.purchasePrice || 0);
  const oldSalePrice = round2(item.salePrice || 0);

  let newPurchasePrice = oldPurchasePrice;
  let newGoodsPrice = parsed.goodsPrice;
  let newExciseTaxPrice = parsed.exciseTaxPrice;

  if (rule.purchaseMode === 'BREAKDOWN') {
    const hasIncomingGoods = rule.goodsPrice !== undefined && rule.goodsPrice !== null;
    const hasIncomingExcise = rule.exciseTaxPrice !== undefined && rule.exciseTaxPrice !== null;

    if (hasIncomingGoods || hasIncomingExcise) {
      const resolvedGoods = hasIncomingGoods
        ? Math.max(0, round2(rule.goodsPrice!))
        : parsed.goodsPrice !== null
          ? parsed.goodsPrice
          : Math.max(0, round2(oldPurchasePrice - (parsed.exciseTaxPrice || 0)));

      const resolvedExcise = hasIncomingExcise
        ? Math.max(0, round2(rule.exciseTaxPrice!))
        : parsed.exciseTaxPrice !== null
          ? parsed.exciseTaxPrice
          : 0;

      newGoodsPrice = resolvedGoods;
      newExciseTaxPrice = resolvedExcise;
      newPurchasePrice = round2(resolvedGoods + resolvedExcise);
    }
  } else if (rule.purchaseMode === 'SET' && rule.purchaseValue !== undefined && rule.purchaseValue !== null) {
    newPurchasePrice = Math.max(0, round2(rule.purchaseValue));
    // Clear stale breakdown if user sets a flat purchase price directly
    newGoodsPrice = null;
    newExciseTaxPrice = null;
  } else if (rule.purchaseMode === 'PERCENT' && rule.purchaseValue !== undefined && rule.purchaseValue !== null) {
    newPurchasePrice = Math.max(0, round2(oldPurchasePrice * (1 + rule.purchaseValue / 100)));
    if (parsed.goodsPrice !== null) {
      newGoodsPrice = Math.max(0, round2(newPurchasePrice - (parsed.exciseTaxPrice || 0)));
    }
  } else if (rule.purchaseMode === 'DELTA' && rule.purchaseValue !== undefined && rule.purchaseValue !== null) {
    newPurchasePrice = Math.max(0, round2(oldPurchasePrice + rule.purchaseValue));
    if (parsed.goodsPrice !== null) {
      newGoodsPrice = Math.max(0, round2(newPurchasePrice - (parsed.exciseTaxPrice || 0)));
    }
  }

  let newSalePrice = oldSalePrice;
  const saleVal = rule.saleValue;
  const rounding: SaleRoundingMode = rule.saleRounding || 'NONE';

  if (rule.saleMode === 'SET' && saleVal !== undefined && saleVal !== null) {
    newSalePrice = applySaleRounding(saleVal, rounding);
  } else if (rule.saleMode === 'SET_WITH_VAT' && saleVal !== undefined && saleVal !== null) {
    const vatRate = item.vatRate || 0;
    const net = vatRate > 0 ? saleVal / (1 + vatRate / 100) : saleVal;
    newSalePrice = applySaleRounding(net, rounding);
  } else if (rule.saleMode === 'MARGIN_FROM_PURCHASE' && saleVal !== undefined && saleVal !== null) {
    newSalePrice = applySaleRounding(newPurchasePrice * (1 + saleVal / 100), rounding);
  } else if (rule.saleMode === 'MARKUP_FROM_PURCHASE' && saleVal !== undefined && saleVal !== null) {
    newSalePrice = applySaleRounding(newPurchasePrice + saleVal, rounding);
  } else if (rule.saleMode === 'PERCENT' && saleVal !== undefined && saleVal !== null) {
    newSalePrice = applySaleRounding(oldSalePrice * (1 + saleVal / 100), rounding);
  } else if (rule.saleMode === 'DELTA' && saleVal !== undefined && saleVal !== null) {
    newSalePrice = applySaleRounding(oldSalePrice + saleVal, rounding);
  }

  const newNotes = composeNotesWithPriceBreakdown(parsed.cleanNotes, newGoodsPrice, newExciseTaxPrice);
  const changed =
    newPurchasePrice !== oldPurchasePrice ||
    newSalePrice !== oldSalePrice ||
    newNotes !== (item.notes || '').trim();

  return {
    item,
    oldPurchasePrice,
    newPurchasePrice,
    oldGoodsPrice: parsed.goodsPrice,
    oldExciseTaxPrice: parsed.exciseTaxPrice,
    newGoodsPrice,
    newExciseTaxPrice,
    oldSalePrice,
    newSalePrice,
    newNotes,
    changed,
    ruleLabel,
  };
}

export interface ParsedExternalCommandResult {
  changes: ComputedItemPriceChange[];
  warnings: string[];
  rulesCount: number;
}

function readNum(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const val = obj[k];
    if (val === undefined || val === null || val === '') continue;
    const n = typeof val === 'number' ? val : Number(String(val).replace(/[\s\u00A0]+/g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (Array.isArray(val) && val.length > 0) {
      return val.map((v) => String(v || '').trim()).filter(Boolean).join(', ');
    }
  }
  return '';
}

function ruleFromJsonObject(obj: Record<string, unknown>): { match: string; category: string; rule: BulkPriceRule } {
  const match = readStr(obj, ['match', 'filter', 'name', 'names', 'query', 'produkt', 'produkty', 'znacka', 'brand']);
  const category = readStr(obj, ['category', 'kategorie']);

  const goodsPrice = readNum(obj, ['goodsPrice', 'goods', 'zbozi', 'cenaZbozi', 'cena_zbozi']);
  const exciseTaxPrice = readNum(obj, ['exciseTaxPrice', 'excise', 'kolek', 'cenaKolku', 'cena_kolku', 'spotrebniDan']);
  const purchasePrice = readNum(obj, ['purchasePrice', 'purchase', 'nakup', 'nakupniCena', 'nakupni_cena']);
  const purchasePercent = readNum(obj, ['purchasePercent', 'nakupProcent', 'nakup_procent']);
  const purchaseDelta = readNum(obj, ['purchaseDelta', 'nakupDelta', 'nakupRozdil']);

  let purchaseMode: PurchaseRuleMode = 'NONE';
  let purchaseValue: number | null = null;
  if (goodsPrice !== null || exciseTaxPrice !== null) {
    purchaseMode = 'BREAKDOWN';
  } else if (purchasePrice !== null) {
    purchaseMode = 'SET';
    purchaseValue = purchasePrice;
  } else if (purchasePercent !== null) {
    purchaseMode = 'PERCENT';
    purchaseValue = purchasePercent;
  } else if (purchaseDelta !== null) {
    purchaseMode = 'DELTA';
    purchaseValue = purchaseDelta;
  }

  const salePrice = readNum(obj, ['salePrice', 'sale', 'prodej', 'prodejniCena', 'prodejni_cena']);
  const saleWithVat = readNum(obj, ['saleWithVat', 'prodejSDph', 'prodej_s_dph']);
  const marginPercent = readNum(obj, ['marginPercent', 'margin', 'marze', 'prirazkaProcent']);
  const markupDelta = readNum(obj, ['markupDelta', 'markup', 'prirazka', 'prirazkaKc']);
  const salePercent = readNum(obj, ['salePercent', 'prodejProcent', 'prodej_procent']);
  const saleDelta = readNum(obj, ['saleDelta', 'prodejDelta', 'prodejRozdil']);

  let saleMode: SaleRuleMode = 'NONE';
  let saleValue: number | null = null;
  if (salePrice !== null) {
    saleMode = 'SET';
    saleValue = salePrice;
  } else if (saleWithVat !== null) {
    saleMode = 'SET_WITH_VAT';
    saleValue = saleWithVat;
  } else if (marginPercent !== null) {
    saleMode = 'MARGIN_FROM_PURCHASE';
    saleValue = marginPercent;
  } else if (markupDelta !== null) {
    saleMode = 'MARKUP_FROM_PURCHASE';
    saleValue = markupDelta;
  } else if (salePercent !== null) {
    saleMode = 'PERCENT';
    saleValue = salePercent;
  } else if (saleDelta !== null) {
    saleMode = 'DELTA';
    saleValue = saleDelta;
  }

  const roundStr = readStr(obj, ['roundTo', 'rounding', 'zaokrouhleni']).toUpperCase();
  const saleRounding: SaleRoundingMode =
    roundStr === 'WHOLE' || roundStr === 'CELE'
      ? 'WHOLE'
      : roundStr === 'ENDING_90' || roundStr === '90'
        ? 'ENDING_90'
        : 'NONE';

  return {
    match,
    category,
    rule: {
      purchaseMode,
      purchaseValue,
      goodsPrice,
      exciseTaxPrice,
      saleMode,
      saleValue,
      saleRounding,
    },
  };
}

function parsePlainTextLine(line: string): { match: string; category: string; rule: BulkPriceRule } | null {
  const cleaned = line.replace(/^[-*•\d.)\s]+/, '').trim();
  if (!cleaned || !cleaned.includes(':')) return null;
  const colonIdx = cleaned.indexOf(':');
  const match = cleaned.slice(0, colonIdx).trim();
  const rhs = cleaned.slice(colonIdx + 1).trim();
  if (!match || !rhs) return null;

  const normRhs = normalizeSearchText(rhs);

  const extractVal = (re: RegExp): { value: number; isPercent: boolean; isSigned: boolean } | null => {
    const m = normRhs.match(re);
    if (!m) return null;
    const rawNum = m[1].replace(',', '.');
    const isSigned = rawNum.startsWith('+') || rawNum.startsWith('-');
    const value = Number(rawNum);
    if (!Number.isFinite(value)) return null;
    const isPercent = Boolean(m[2] && m[2].includes('%'));
    return { value, isPercent, isSigned };
  };

  const goodsM = extractVal(/(?:zbozi|cena zbozi)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/i);
  const exciseM = extractVal(/(?:kolek|kolku|spotrebni dan)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/i);
  const purchaseM = extractVal(/(?:nakup|nakupni|nakupni cena)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)\s*(%|kc)?/i);
  const saleVatM = extractVal(/(?:prodej\s*s\s*dph|s\s*dph)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)/i);
  const saleM = !saleVatM
    ? extractVal(/(?:prodej|prodejni|prodejni cena)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)\s*(%|kc)?/i)
    : null;
  const marginM = extractVal(/(?:marze)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)\s*(%)?/i);
  const markupM = extractVal(/(?:prirazka)\s*[:=]?\s*([+-]?\d+(?:[.,]\d+)?)\s*(%|kc)?/i);

  let purchaseMode: PurchaseRuleMode = 'NONE';
  let purchaseValue: number | null = null;
  let goodsPrice: number | null = null;
  let exciseTaxPrice: number | null = null;

  if (goodsM || exciseM) {
    purchaseMode = 'BREAKDOWN';
    goodsPrice = goodsM ? Math.max(0, goodsM.value) : null;
    exciseTaxPrice = exciseM ? Math.max(0, exciseM.value) : null;
  } else if (purchaseM) {
    if (purchaseM.isPercent) {
      purchaseMode = 'PERCENT';
      purchaseValue = purchaseM.value;
    } else if (purchaseM.isSigned) {
      purchaseMode = 'DELTA';
      purchaseValue = purchaseM.value;
    } else {
      purchaseMode = 'SET';
      purchaseValue = purchaseM.value;
    }
  }

  let saleMode: SaleRuleMode = 'NONE';
  let saleValue: number | null = null;
  if (saleVatM) {
    saleMode = 'SET_WITH_VAT';
    saleValue = saleVatM.value;
  } else if (saleM) {
    if (saleM.isPercent) {
      saleMode = 'PERCENT';
      saleValue = saleM.value;
    } else if (saleM.isSigned) {
      saleMode = 'DELTA';
      saleValue = saleM.value;
    } else {
      saleMode = 'SET';
      saleValue = saleM.value;
    }
  } else if (marginM) {
    saleMode = 'MARGIN_FROM_PURCHASE';
    saleValue = marginM.value;
  } else if (markupM) {
    saleMode = markupM.isPercent ? 'MARGIN_FROM_PURCHASE' : 'MARKUP_FROM_PURCHASE';
    saleValue = markupM.value;
  }

  if (purchaseMode === 'NONE' && saleMode === 'NONE') return null;

  return {
    match,
    category: '',
    rule: {
      purchaseMode,
      purchaseValue,
      goodsPrice,
      exciseTaxPrice,
      saleMode,
      saleValue,
      saleRounding: 'NONE',
    },
  };
}

/**
 * Parses either a ChatGPT JSON block OR simple Czech line-by-line price rules into
 * an exact preview of per-item changes. Never mutates Firestore directly.
 */
export function parseBulkPriceCommands(
  rawInput: string,
  inventory: InventoryItem[]
): ParsedExternalCommandResult {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return { changes: [], warnings: [], rulesCount: 0 };

  const warnings: string[] = [];
  const parsedRules: Array<{ match: string; category: string; rule: BulkPriceRule; label: string }> = [];

  // 1. Try JSON (also strips ```json ... ``` markdown fences from ChatGPT)
  const jsonCandidate = (() => {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    const firstBracket = trimmed.search(/[\[{]/);
    if (firstBracket >= 0) return trimmed.slice(firstBracket).trim();
    return '';
  })();

  let parsedAsJson = false;
  if (jsonCandidate && (jsonCandidate.startsWith('[') || jsonCandidate.startsWith('{'))) {
    try {
      const parsed = JSON.parse(jsonCandidate);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.changes)
          ? parsed.changes
          : Array.isArray(parsed.rules)
            ? parsed.rules
            : [parsed];
      parsedAsJson = true;
      arr.forEach((entry: unknown, idx: number) => {
        if (!entry || typeof entry !== 'object') return;
        const r = ruleFromJsonObject(entry as Record<string, unknown>);
        if (!r.match && !r.category) {
          warnings.push(`Pravidlo #${idx + 1} nemá zadaný název produktu ani kategorii (pole "match").`);
          return;
        }
        if (r.rule.purchaseMode === 'NONE' && r.rule.saleMode === 'NONE') {
          warnings.push(`Pravidlo „${r.match || r.category}“ neobsahuje žádnou změnu ceny.`);
          return;
        }
        parsedRules.push({ ...r, label: r.match || `Kategorie: ${r.category}` });
      });
    } catch {
      // Fall through to plain Czech text parser
    }
  }

  // 2. Plain Czech lines fallback: "elfliq: zboží 55, kolek 35, prodej 125"
  if (!parsedAsJson) {
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parsed = parsePlainTextLine(line);
      if (parsed) {
        parsedRules.push({ ...parsed, label: parsed.match });
      } else {
        warnings.push(`Řádek nebylo možné rozpoznat: „${line.slice(0, 70)}“`);
      }
    }
  }

  // Apply rules sequentially across matching items (later rules override earlier ones on same item)
  const workingItems = new Map<string, InventoryItem>(inventory.map((i) => [i.id, i]));
  const finalChanges = new Map<string, ComputedItemPriceChange>();

  for (const r of parsedRules) {
    const matched = inventory.filter((item) => {
      if (r.category) {
        const normCat = normalizeSearchText(item.category);
        if (!normCat.includes(normalizeSearchText(r.category))) return false;
      }
      if (r.match) {
        return matchesNameQuery(item, r.match);
      }
      return true;
    });

    if (matched.length === 0) {
      warnings.push(`Žádná položka na skladě neodpovídá filtru „${r.label}“.`);
      continue;
    }

    for (const origItem of matched) {
      const current = workingItems.get(origItem.id) || origItem;
      const step = computeItemPriceChange(current, r.rule, r.label);
      // Chain mutations if multiple rules touch the same card, while preserving original baseline for UI diff
      workingItems.set(origItem.id, {
        ...current,
        purchasePrice: step.newPurchasePrice,
        salePrice: step.newSalePrice,
        notes: step.newNotes,
      });

      const origBreakdown = parsePriceBreakdown(origItem.notes);
      const changed =
        step.newPurchasePrice !== round2(origItem.purchasePrice || 0) ||
        step.newSalePrice !== round2(origItem.salePrice || 0) ||
        step.newNotes !== (origItem.notes || '').trim();

      finalChanges.set(origItem.id, {
        item: origItem,
        oldPurchasePrice: round2(origItem.purchasePrice || 0),
        newPurchasePrice: step.newPurchasePrice,
        oldGoodsPrice: origBreakdown.goodsPrice,
        oldExciseTaxPrice: origBreakdown.exciseTaxPrice,
        newGoodsPrice: step.newGoodsPrice,
        newExciseTaxPrice: step.newExciseTaxPrice,
        oldSalePrice: round2(origItem.salePrice || 0),
        newSalePrice: step.newSalePrice,
        newNotes: step.newNotes,
        changed,
        ruleLabel: r.label,
      });
    }
  }

  return {
    changes: Array.from(finalChanges.values()),
    warnings,
    rulesCount: parsedRules.length,
  };
}

/**
 * Generates a ready-to-copy prompt for ChatGPT / Claude so any colleague can type
 * natural Czech instructions (or paste a supplier pricelist) and receive valid JSON
 * ready to paste back into SkladFaktura with live preview.
 */
export function buildChatGptPromptForInventory(items: InventoryItem[]): string {
  const brands = extractQuickBrandChips(items, 20).map((b) => b.label);
  const categories = Array.from(
    new Set(items.map((i) => (i.category || '').trim()).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, 'cs'));

  return [
    'Pomoz mi připravit hromadnou změnu cen do skladové aplikace SkladFaktura.',
    'Na základě mého zadání (nebo ceníku, který ti pošlu) vrať POUZE platný JSON pole objektů v tomto formátu:',
    '```json',
    '[',
    '  {',
    '    "match": "elfliq",',
    '    "goodsPrice": 55,',
    '    "exciseTaxPrice": 35,',
    '    "salePrice": 129',
    '  },',
    '  {',
    '    "match": "venix nex",',
    '    "purchasePrice": 90,',
    '    "marginPercent": 30',
    '  }',
    ']',
    '```',
    'Povolená pole v každém objektu:',
    '- "match": název nebo značka produktu (lze více oddělených čárkou, např. "elfliq, bar juice")',
    '- "category": volitelný filtr kategorie',
    '- Nákupní cena (vyber jednu možnost): "goodsPrice" + "exciseTaxPrice" (cena zboží + cena kolku = výsledný nákup), NEBO "purchasePrice" (pevný nákup bez DPH), NEBO "purchasePercent" (změna v %), NEBO "purchaseDelta" (změna v Kč)',
    '- Prodejní cena (vyber jednu možnost): "salePrice" (pevný prodej bez DPH), NEBO "saleWithVat" (pevný prodej s DPH), NEBO "marginPercent" (marže % z nového nákupu), NEBO "markupDelta" (přirážka Kč z nového nákupu), NEBO "salePercent" (změna v %), NEBO "saleDelta" (změna v Kč)',
    '- "roundTo": volitelně "WHOLE" (celé Kč) nebo "ENDING_90" (na ,90 Kč)',
    brands.length > 0 ? `Značky aktuálně na skladě: ${brands.join(', ')}.` : '',
    categories.length > 0 ? `Kategorie na skladě: ${categories.join(', ')}.` : '',
    '',
    'Moje zadání změn cen:',
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
