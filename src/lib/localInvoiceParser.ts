import { round2 } from './format';
import type { ExtractedDeliveryNote, ExtractedLineItem } from '../types';

export interface LocalParseOptions {
  fileName?: string;
  ownCompanyIco?: string;
}

const UNIT_SET = new Set([
  'ks',
  'kus',
  'kusu',
  'kusů',
  'kusy',
  'bal',
  'baleni',
  'balení',
  'm',
  'bm',
  'cm',
  'mm',
  'm2',
  'm²',
  'm3',
  'm³',
  'kg',
  'g',
  'dg',
  't',
  'l',
  'litr',
  'litru',
  'litrů',
  'hod',
  'h',
  'den',
  'dny',
  'mes',
  'měs',
  'sada',
  'sad',
  'set',
  'par',
  'pár',
  'pary',
  'páry',
  'kpl',
  'komplet',
  'kart',
  'karton',
  'krab',
  'krabice',
  'role',
  'rol',
  'pal',
  'paleta',
  'pcs',
  'pc',
  'ea',
  'box',
  'pack',
  'pkt',
  'st',
  'stk',
  'unit',
]);

const SKIP_LINE_PATTERNS = [
  /^\s*(celkem|součet|soucet|mezisoučet|mezisoucet|k\s+úhradě|k\s+uhrade|celková|celkova|total|subtotal|grand\s+total|amount\s+due|net\s+total)/i,
  /^\s*(základ|zaklad|dph\s+celkem|sazba\s+dph|rekapitulace|rozpis\s+dph|zaokrouhlení|zaokrouhleni|vat\s+summary|vat\s+total|tax\s+summary)/i,
  /^\s*(iban|swift|bic|číslo\s+účtu|cislo\s+uctu|bankovní\s+spojení|bankovni\s+spojeni|bank\s+account|variabilní|variabilni|konstantní|konstantni|specifický|specificky)/i,
  /^\s*(datum\s+vystavení|datum\s+vystaveni|datum\s+splatnosti|datum\s+zdan|duzp|splatnost|issue\s+date|due\s+date|tax\s+date)/i,
  /^\s*(dodavatel|odběratel|odberatel|příjemce|prijemce|konečný\s+příjemce|supplier|customer|buyer|seller|billing\s+address)/i,
  /^\s*(strana\s+\d|page\s+\d|vystavil|vyřizuje|vyrizuje|podpis|razítko|razitko|tel\.?:|telefon|e-?mail|www\.|http)/i,
  /^\s*(zapsán|zapsan|spisová\s+značka|spisova\s+znacka|obchodní\s+rejstřík|obchodni\s+rejstrik|vedená\s+u|vedena\s+u)/i,
  /^\s*(položka|polozka|název|nazev|označení|oznaceni|popis|description|item)\s+.*(množství|mnozstvi|cena|dph|celkem|qty|price|amount)/i,
  /^\s*(kód|kod|sku|art\.?|č\.)\s+.*(název|nazev|popis|množství|mnozstvi|cena)/i,
  /^\s*(sleva\s+celkem|uhrazeno|záloha|zaloha|zbývá\s+uhradit|zbyva\s+uhradit|paid|balance)/i,
  /^\s*(ičo?|dič|dic|vat\s*id|reg\.?\s*no)/i,
];

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function normalizeCurrencyCode(raw: unknown): string {
  const s = String(raw || 'CZK')
    .trim()
    .toUpperCase();
  if (s === '€' || s.includes('EUR')) return 'EUR';
  if (s === '$' || s.includes('USD')) return 'USD';
  if (s === '£' || s.includes('GBP')) return 'GBP';
  if (s === 'ZŁ' || s === 'ZL' || s.includes('PLN')) return 'PLN';
  if (s.includes('CHF')) return 'CHF';
  if (s.includes('HUF') || s === 'FT') return 'HUF';
  if (s.includes('KČ') || s.includes('KC') || s.includes('CZK')) return 'CZK';
  const clean = s.replace(/[^A-Z]/g, '');
  return clean.length === 3 ? clean : 'CZK';
}

/**
 * Parses Czech / EU / US formatted number string into a JS number.
 * Handles: "1 250,50", "1.250,50", "1,250.50", "250,-", "-12,5", "1250"
 */
export function parseLocaleNumber(raw: string): number | null {
  if (!raw) return null;
  let s = raw
    .trim()
    .replace(/\u00A0/g, ' ')
    .replace(/,-$/g, '')
    .replace(/(Kč|Kc|CZK|EUR|USD|PLN|GBP|CHF|HUF|€|\$|£|zł|zl|%)$/i, '')
    .trim();

  if (!s || !/^-?\d[\d\s.,]*$/.test(s)) return null;

  // Reject pure phone/date/year-like patterns when obviously not a price/qty
  s = s.replace(/\s+/g, '');

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // Whichever appears last is the decimal separator
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length > 2) {
      // Multiple commas -> thousands separator
      s = s.replace(/,/g, '');
    } else if (parts[1].length === 3 && parts[0].length <= 3 && Number(parts[0]) > 0) {
      // Ambiguous e.g. "1,250" vs "1,250 kg" -> in Czech invoices, comma is almost always decimal unless >3 digits before
      s = s.replace(',', '.');
    } else {
      s = s.replace(',', '.');
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      s = s.replace(/\./g, '');
    } else if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3) {
      // Likely EU thousands separator like "1.250" if no decimals follow, wait: could be "1.500 kg" or "1.250 EUR"
      // Treat as decimal if leading 0 ("0.500"), otherwise if integer >= 10 keep as thousands only if preceded by 1-3 digits
      if (parts[0] === '0' || parts[0] === '-0') {
        // decimal
      } else {
        // Keep decimal by default unless clearly thousands (handled in price context)
      }
    }
  }

  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

function sanitizeStockUnit(raw: string): string {
  const trimmed = (raw || '').trim();
  const clean = trimmed.toLowerCase().replace(/[.,;:()]/g, '');
  if (
    !clean ||
    clean === 'ml' ||
    clean === 'mlt' ||
    clean === 'cl' ||
    clean === 'dl' ||
    clean === 'mililitr' ||
    clean === 'mililitru' ||
    clean === 'mililitrů' ||
    clean === 'mililitry' ||
    clean === 'h87' ||
    clean === 'pce'
  ) {
    return 'ks';
  }
  return (normalizeUnit(trimmed) || trimmed || 'ks').slice(0, 20);
}

function normalizeUnit(token: string): string | null {
  const clean = token
    .trim()
    .toLowerCase()
    .replace(/[.,;:()]/g, '');
  if (!clean) return null;
  if (!UNIT_SET.has(clean)) return null;
  if (clean === 'kus' || clean === 'kusy' || clean === 'kusů' || clean === 'kusu' || clean === 'pcs' || clean === 'pc' || clean === 'ea' || clean === 'st' || clean === 'stk') {
    return 'ks';
  }
  if (clean === 'balení' || clean === 'baleni' || clean === 'pack' || clean === 'pkt') return 'bal';
  if (clean === 'litr' || clean === 'litrů' || clean === 'litru') return 'l';
  if (clean === 'm2') return 'm²';
  if (clean === 'm3') return 'm³';
  if (clean === 'par' || clean === 'pary' || clean === 'páry') return 'pár';
  if (clean === 'karton') return 'kart';
  if (clean === 'krabice') return 'krab';
  if (clean === 'paleta') return 'pal';
  if (clean === 'komplet') return 'kpl';
  return clean;
}

function normalizeVatRate(raw: number): number {
  const r = Math.round(raw);
  if (r === 0 || r === 12 || r === 21) return r;
  if (r === 10 || r === 15) return 12; // Legacy CZ reduced rates mapped to current 12%
  if (r >= 18 && r <= 27) return 21;
  return 21;
}

function detectCurrencyAndRate(fullText: string): { currency: string; docRate: number } {
  let docRate = 0;
  const ratePatterns = [
    /(?:kurz(?:\s+čnb|\s+cnb)?|exchange\s+rate)\s*[:=]?\s*(?:1\s*[A-Z]{3}\s*=\s*)?(\d{1,4}[.,]\d{1,4})/i,
    /1\s*(?:EUR|USD|PLN|GBP|CHF)\s*=\s*(\d{1,4}[.,]\d{1,4})\s*(?:Kč|CZK)/i,
  ];
  for (const re of ratePatterns) {
    const m = fullText.match(re);
    if (m) {
      const parsed = parseLocaleNumber(m[1]);
      if (parsed && parsed > 0.01 && parsed < 1000) {
        docRate = round4(parsed);
        break;
      }
    }
  }

  // Count currency cues, weighting explicit total lines higher
  const scores: Record<string, number> = {
    CZK: 0,
    EUR: 0,
    USD: 0,
    PLN: 0,
    GBP: 0,
    CHF: 0,
    HUF: 0,
  };

  const countMatches = (re: RegExp) => (fullText.match(re) || []).length;
  scores.EUR += countMatches(/\bEUR\b/gi) * 3 + countMatches(/€/g) * 3;
  scores.USD += countMatches(/\bUSD\b/gi) * 3 + countMatches(/\$/g) * 2;
  scores.PLN += countMatches(/\bPLN\b/gi) * 3 + countMatches(/\bzł\b/gi) * 3;
  scores.GBP += countMatches(/\bGBP\b/gi) * 3 + countMatches(/£/g) * 3;
  scores.CHF += countMatches(/\bCHF\b/gi) * 3;
  scores.HUF += countMatches(/\bHUF\b/gi) * 3;
  scores.CZK += countMatches(/\bCZK\b/gi) * 2 + countMatches(/\bKč\b/gi) * 2;

  // Check explicit "Měna: EUR" or "Currency: EUR"
  const explicit = fullText.match(/(?:měna|mena|currency)\s*[:=]?\s*(CZK|EUR|USD|PLN|GBP|CHF|HUF|Kč|€)/i);
  if (explicit) {
    return { currency: normalizeCurrencyCode(explicit[1]), docRate };
  }

  // Check total line currency ("Celkem k úhradě ... EUR")
  const totalLineMatch = fullText.match(
    /(?:celkem\s+k\s+úhradě|celkem\s+k\s+uhrade|total\s+amount|grand\s+total|amount\s+due|celkem\s+s\s+dph)[^\n]{0,40}(EUR|USD|PLN|GBP|CHF|HUF|CZK|Kč|€|\$|£|zł)/i
  );
  if (totalLineMatch) {
    return { currency: normalizeCurrencyCode(totalLineMatch[1]), docRate };
  }

  // Pick highest scoring currency (default CZK)
  let best = 'CZK';
  let bestScore = scores.CZK;
  for (const [curr, score] of Object.entries(scores)) {
    if (curr !== 'CZK' && score > bestScore && score >= 3) {
      best = curr;
      bestScore = score;
    }
  }
  return { currency: best, docRate };
}

function extractHeaderMetadata(
  lines: string[],
  options?: LocalParseOptions
): {
  supplierName: string;
  supplierIco: string;
  documentNumber: string;
  documentType: string;
} {
  const fullText = lines.join('\n');
  const ownIcoClean = (options?.ownCompanyIco || '').replace(/\D/g, '');

  // Document type
  let documentType = 'Nákupní faktura';
  if (/dodací\s+list|dodaci\s+list|delivery\s+note|výdejka|vydejka/i.test(fullText)) {
    documentType = 'Dodací list';
  } else if (/zálohov|zalohov|proforma/i.test(fullText)) {
    documentType = 'Zálohová faktura';
  } else if (/dobropis|opravný\s+daňový|credit\s+note/i.test(fullText)) {
    documentType = 'Dobropis';
  }

  // Document number
  let documentNumber = '';
  const docNumPatterns = [
    /(?:faktura|daňový\s+doklad|danovy\s+doklad|dodací\s+list|dodaci\s+list|doklad|invoice|receipt)\s*(?:č\.?|c\.?|no\.?|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9/\-_]{3,24})/i,
    /(?:číslo\s+dokladu|cislo\s+dokladu|číslo\s+faktury|cislo\s+faktury|document\s+no\.?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/\-_]{3,24})/i,
    /(?:variabilní\s+symbol|variabilni\s+symbol|VS)\s*[:#-]?\s*(\d{4,14})/i,
  ];
  for (const re of docNumPatterns) {
    const m = fullText.match(re);
    if (m && /\d/.test(m[1])) {
      documentNumber = m[1].trim();
      break;
    }
  }

  // Supplier IČO (prefer first 8-digit IČO that is NOT our own company's IČO)
  let supplierIco = '';
  const icoRegex = /(?:IČO?|IC)\s*[:#.]?\s*(\d{8})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = icoRegex.exec(fullText)) !== null) {
    const candidate = match[1];
    if (ownIcoClean && candidate === ownIcoClean) continue;
    supplierIco = candidate;
    break;
  }

  // Supplier Name: look near "Dodavatel" or legal entity suffix in top 30 lines
  let supplierName = '';
  const topLines = lines.slice(0, 30);
  const dodavatelIdx = topLines.findIndex((l) => /\bdodavatel\b|\bsupplier\b|\bseller\b/i.test(l));
  if (dodavatelIdx >= 0) {
    const sameLineLeft = topLines[dodavatelIdx].split(/\s{3,}|\t/)[0].trim();
    const inlineMatch = sameLineLeft.match(/(?:dodavatel|supplier|seller)\s*[:\-–]?\s*(.+)$/i);
    const inlineCandidate = inlineMatch?.[1]?.trim() || '';
    if (
      inlineCandidate.length >= 3 &&
      !/^(odběratel|odberatel|buyer|customer|ičo?|dič|dic|datum|faktura|číslo|cislo|strana|měna|mena|currency|kód|kod|název|nazev)/i.test(
        inlineCandidate
      )
    ) {
      supplierName = inlineCandidate.slice(0, 120);
    } else {
      for (let i = dodavatelIdx + 1; i <= Math.min(dodavatelIdx + 4, topLines.length - 1); i++) {
        const candidate = topLines[i].split(/\s{3,}|\t/)[0].trim();
        if (
          candidate.length >= 3 &&
          !/^(odběratel|odberatel|buyer|customer|ičo?|dič|dic|datum|faktura|číslo|cislo|strana|měna|mena|currency|kód|kod|název|nazev|part\s*no|description)/i.test(
            candidate
          )
        ) {
          supplierName = candidate.slice(0, 120);
          break;
        }
      }
    }
  }
  if (!supplierName) {
    const legalLine = topLines.find((l) =>
      /\b(s\.?\s*r\.?\s*o\.?|a\.?\s*s\.?|spol\.\s*s\s*r\.o\.|v\.o\.s\.|k\.s\.|gmbh|ltd\.?|sp\.\s*z\s*o\.o\.|s\.p\.)\b/i.test(
        l
      )
    );
    if (legalLine) {
      supplierName = legalLine
        .split(/\s{3,}|\t/)[0]
        .replace(/^(?:dodavatel|supplier|seller)\s*[:\-–]?\s*/i, '')
        .trim()
        .slice(0, 120);
    }
  }

  return { supplierName, supplierIco, documentNumber, documentType };
}

interface ParsedRowCandidate {
  sku: string;
  ean: string;
  name: string;
  quantity: number;
  unit: string;
  unitPurchasePrice: number;
  vatRate: number;
}

function isSkippableLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return true;
  if (!/[a-zA-ZáčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(trimmed)) return true;
  if (!/\d/.test(trimmed)) return true;
  for (const re of SKIP_LINE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Pure date lines like "12.05.2026" or "2026-05-12"
  if (/^\d{1,2}\.\s*\d{1,2}\.\s*\d{4}$/.test(trimmed)) return true;
  return false;
}

function extractLeadingSkuAndEan(rawName: string): { sku: string; ean: string; name: string } {
  let working = rawName.trim();
  let ean = '';
  let sku = '';

  // Remove leading row index like "1." or "01)"
  working = working.replace(/^\d{1,3}[.)]\s+/, '').trim();

  // Extract 13-digit or 8-digit EAN anywhere if isolated
  const eanMatch = working.match(/\b(\d{13}|\d{8})\b/);
  if (eanMatch) {
    ean = eanMatch[1];
    // Only strip EAN from name if there is plenty of name left
    const withoutEan = working.replace(eanMatch[0], ' ').replace(/\s{2,}/g, ' ').trim();
    if (withoutEan.length >= 4) {
      working = withoutEan;
    }
  }

  // Extract leading SKU code (alphanumeric with digits, 3-20 chars, followed by whitespace + name)
  const skuMatch = working.match(/^([A-Z0-9][A-Z0-9._/-]{2,20})\s+(.{3,})$/i);
  if (skuMatch && /\d/.test(skuMatch[1]) && !/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(skuMatch[1])) {
    const candidateSku = skuMatch[1];
    // Don't strip dimensions like "200x300" or "3x1,5" as SKU if the rest looks like a unit/modifier
    if (!/^\d+[x×]\d+/i.test(candidateSku)) {
      sku = candidateSku;
      working = skuMatch[2].trim();
    }
  }

  return { sku, ean, name: working };
}

/**
 * Given trailing numeric tokens after quantity, determines unitPurchasePrice (excl. VAT) and vatRate.
 */
function resolvePriceAndVat(
  qty: number,
  numericTokens: Array<{ raw: string; value: number; isPercent: boolean }>,
  defaultVat = 21
): { unitPurchasePrice: number; vatRate: number } {
  let vatRate = defaultVat;
  const priceValues: number[] = [];

  for (const tok of numericTokens) {
    if (tok.isPercent) {
      if (tok.value === 0 || tok.value === 10 || tok.value === 12 || tok.value === 15 || tok.value === 21) {
        vatRate = normalizeVatRate(tok.value);
      }
      continue;
    }
    priceValues.push(tok.value);
  }

  // Check if one of the middle values is an un-suffixed VAT rate (0, 12, 21) surrounded by prices
  if (priceValues.length >= 3) {
    for (let i = 1; i < priceValues.length - 1; i++) {
      const v = priceValues[i];
      if ((v === 21 || v === 12 || v === 0) && Number.isInteger(v)) {
        const before = priceValues[i - 1];
        const after = priceValues[i + 1];
        if (before > 0 && after > 0) {
          vatRate = v;
          priceValues.splice(i, 1);
          break;
        }
      }
    }
  }

  const positive = priceValues.filter((v) => v >= 0);
  if (positive.length === 0) {
    return { unitPurchasePrice: 0, vatRate };
  }
  if (positive.length === 1) {
    // Only one number — if qty > 1 it's commonly line total or unit price; assume unit price if small or qty=1
    return { unitPurchasePrice: round2(positive[0]), vatRate };
  }

  // Arithmetic verification: find pair (u, total) where qty * u ≈ total
  const safeQty = Math.max(0.0001, qty);
  for (let i = 0; i < positive.length; i++) {
    const u = positive[i];
    if (u <= 0) continue;
    const expectedBase = u * safeQty;
    const expectedWithVat = expectedBase * (1 + vatRate / 100);

    for (let j = i + 1; j < positive.length; j++) {
      const t = positive[j];
      if (t <= 0) continue;
      // Match excl. VAT: qty * u ≈ t
      if (Math.abs(expectedBase - t) <= Math.max(0.5, t * 0.02)) {
        return { unitPurchasePrice: round2(u), vatRate };
      }
      // Match incl. VAT: qty * u * (1 + vat) ≈ t
      if (Math.abs(expectedWithVat - t) <= Math.max(0.5, t * 0.02)) {
        return { unitPurchasePrice: round2(u), vatRate };
      }
    }
  }

  // Check if positive[0] is base total and positive[1] is total with VAT (when unit price wasn't printed)
  if (positive.length === 2 && positive[0] > 0 && positive[1] > positive[0]) {
    const ratio = positive[1] / positive[0];
    if (Math.abs(ratio - (1 + vatRate / 100)) < 0.03) {
      return { unitPurchasePrice: round2(positive[0] / safeQty), vatRate };
    }
  }

  // Default: first price column after quantity is unit price
  return { unitPurchasePrice: round2(positive[0]), vatRate };
}

function tokenizeTailNumbers(tail: string): Array<{ raw: string; value: number; isPercent: boolean }> {
  const results: Array<{ raw: string; value: number; isPercent: boolean }> = [];
  // Match numbers with optional spaces inside thousands ("1 250,50") and optional %
  const re = /(-?\d{1,3}(?:[ \u00A0]\d{3})+(?:[.,]\d{1,4})?|-?\d+(?:[.,]\d{1,4})?)\s*(%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    const val = parseLocaleNumber(m[1]);
    if (val !== null) {
      results.push({ raw: m[0], value: val, isPercent: Boolean(m[2]) });
    }
  }
  return results;
}

function parseSingleItemLine(line: string, previousTitleLine?: string): ParsedRowCandidate | null {
  if (isSkippableLine(line)) return null;

  // Strategy 1: Explicit quantity + known unit token ("10 ks", "2,5 m", "1 bal.")
  // Deliberately excludes "ml" so bottle volumes inside product names ("10 ml", "2 ml") are never misparsed as quantity+unit.
  const qtyUnitRegex =
    /(?:^|[\s\t])(\d+(?:[.,]\d{1,3})?)\s*(ks|kus|kusů|kusu|kusy|bal\.?|balení|baleni|bm|m2|m²|m3|m³|cm|mm|kg|dg|litr(?:ů|u)?|hod|sada|sad|set|pár(?:y)?|par(?:y)?|kpl|komplet|kart(?:on)?|krab(?:ice)?|role|rol|pal(?:eta)?|pcs|pc|ea|box|pack|pkt|stk|st|m|g|t|l|h)(?=$|[\s\t.,;:/])/gi;

  let bestMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = qtyUnitRegex.exec(line)) !== null) {
    // Prefer a qty+unit match that appears after some product name (or at start if wrapped) AND has numbers or end after it
    const idx = m.index;
    const before = line.slice(0, idx).trim();
    const after = line.slice(idx + m[0].length).trim();
    const afterNums = tokenizeTailNumbers(after);
    // Avoid matching dimensions inside product names like "500 ml" when another qty+unit follows later
    if (afterNums.length > 0 || (before.length >= 3 && after.length === 0)) {
      bestMatch = m;
    }
  }

  if (bestMatch) {
    const qty = parseLocaleNumber(bestMatch[1]);
    const unit = normalizeUnit(bestMatch[2]);
    if (qty !== null && qty > 0 && qty < 1000000 && unit) {
      let leftPart = line.slice(0, bestMatch.index).trim();
      const rightPart = line.slice(bestMatch.index + bestMatch[0].length).trim();
      const tailNums = tokenizeTailNumbers(rightPart);

      // If leftPart is empty/too short, check previous title line (2-line wrapped item!)
      if (leftPart.length < 3 && previousTitleLine && !isSkippableLine(previousTitleLine + ' 1')) {
        leftPart = previousTitleLine.trim();
      }

      if (leftPart.length >= 2) {
        const { sku, ean, name } = extractLeadingSkuAndEan(leftPart);
        if (name.length >= 2 && !/^(dph|celkem|základ|zaklad|sazba|kurz)/i.test(name)) {
          const { unitPurchasePrice, vatRate } = resolvePriceAndVat(qty, tailNums);
          // Require either at least one price OR an explicit delivery note line
          if (tailNums.length > 0 || unit === 'ks' || unit === 'bal' || unit === 'kg' || unit === 'm') {
            return {
              sku,
              ean,
              name,
              quantity: round2(qty),
              unit,
              unitPurchasePrice,
              vatRate,
            };
          }
        }
      }
    }
  }

  // Strategy 2: Columnar row split by tab or 2+ spaces, ending with >= 2 numeric columns (qty, price, [vat], total)
  const cols = line
    .trim()
    .split(/\t|\s{2,}/)
    .map((c) => c.trim())
    .filter(Boolean);

  if (cols.length >= 3) {
    // Walk backwards from end to collect numeric/unit columns
    const tailParts: string[] = [];
    let splitIdx = cols.length;
    for (let i = cols.length - 1; i >= 1; i--) {
      const col = cols[i];
      const isNumCol =
        /^-?\d[\d\s.,]*\s*(%|Kč|Kc|CZK|EUR|USD|PLN|GBP|CHF|€|\$|£|zł)?$/i.test(col) ||
        normalizeUnit(col) !== null;
      if (isNumCol) {
        tailParts.unshift(col);
        splitIdx = i;
      } else {
        break;
      }
    }

    if (tailParts.length >= 2 && splitIdx >= 1) {
      const namePart = cols.slice(0, splitIdx).join(' ').trim();
      if (namePart.length >= 3 && !isSkippableLine(namePart + ' 1')) {
        // Parse qty from first numeric token in tailParts
        let qty: number | null = null;
        let unit = 'ks';
        const priceTokens: Array<{ raw: string; value: number; isPercent: boolean }> = [];

        for (const tp of tailParts) {
          const u = normalizeUnit(tp);
          if (u) {
            unit = u;
            continue;
          }
          const isPct = tp.includes('%');
          const num = parseLocaleNumber(tp);
          if (num === null) continue;
          if (qty === null && !isPct && num > 0 && num < 100000) {
            qty = num;
          } else {
            priceTokens.push({ raw: tp, value: num, isPercent: isPct });
          }
        }

        if (qty !== null && priceTokens.length >= 1) {
          const { unitPurchasePrice, vatRate } = resolvePriceAndVat(qty, priceTokens);
          if (unitPurchasePrice > 0) {
            const { sku, ean, name } = extractLeadingSkuAndEan(namePart);
            if (name.length >= 2) {
              return {
                sku,
                ean,
                name,
                quantity: round2(qty),
                unit,
                unitPurchasePrice,
                vatRate,
              };
            }
          }
        }
      }
    }
  }

  return null;
}

export function parseInvoiceFromTextLines(
  rawLines: string[],
  options?: LocalParseOptions
): { note: ExtractedDeliveryNote; docRate: number } {
  const lines = rawLines
    .map((l) => l.replace(/\u00A0/g, ' ').replace(/\s+$/g, ''))
    .filter((l) => l.trim().length > 0);

  const fullText = lines.join('\n');
  const header = extractHeaderMetadata(lines, options);
  const { currency, docRate } = detectCurrencyAndRate(fullText);

  const candidates: ParsedRowCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prevLine = i > 0 ? lines[i - 1] : undefined;
    const parsed = parseSingleItemLine(lines[i], prevLine);
    if (parsed) {
      candidates.push(parsed);
    }
  }

  const now = Date.now();
  const items: ExtractedLineItem[] = candidates.map((c, idx) => ({
    id: `loc_${now}_${idx}`,
    sku: (c.sku || `SKU-${String(idx + 1).padStart(3, '0')}`).slice(0, 64),
    name: c.name.slice(0, 200),
    ean: c.ean.slice(0, 40),
    quantity: Math.max(0.01, round2(c.quantity)),
    unit: sanitizeStockUnit(c.unit),
    originalPurchasePrice: Math.max(0, round2(c.unitPurchasePrice)),
    purchasePrice: Math.max(0, round2(c.unitPurchasePrice)),
    suggestedSalePrice: c.unitPurchasePrice > 0 ? round2(c.unitPurchasePrice * 1.25) : 0,
    vatRate: c.vatRate,
    selected: true,
  }));

  return {
    docRate,
    note: {
      supplierName: header.supplierName,
      supplierIco: header.supplierIco,
      documentNumber: header.documentNumber,
      documentType: header.documentType,
      currency,
      exchangeRate: docRate > 0 ? docRate : 1,
      exchangeRateSource: currency === 'CZK' ? 'CZK' : docRate > 0 ? 'DOKLAD' : 'MANUAL',
      items,
    },
  };
}

// =============================================================================
// DETERMINISTIC XML PARSERS (ISDOC 6.x & STORMWARE POHODA XML)
// =============================================================================

function getFirstTagText(parent: Element | Document, localName: string): string {
  const all = parent.getElementsByTagName('*');
  const target = localName.toLowerCase();
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const ln = (el.localName || el.nodeName.split(':').pop() || '').toLowerCase();
    if (ln === target) {
      const txt = (el.textContent || '').trim();
      if (txt) return txt;
    }
  }
  return '';
}

function getElementsByLocalName(parent: Element | Document, localName: string): Element[] {
  const all = parent.getElementsByTagName('*');
  const target = localName.toLowerCase();
  const res: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const ln = (el.localName || el.nodeName.split(':').pop() || '').toLowerCase();
    if (ln === target) res.push(el);
  }
  return res;
}

export function parseXmlInvoice(
  xmlText: string
): { note: ExtractedDeliveryNote; docRate: number; format: 'ISDOC_XML' | 'POHODA_XML' } | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }

  // 1. Check for ISDOC (<Invoice> with <InvoiceLine>)
  const isdocLines = getElementsByLocalName(doc, 'InvoiceLine');
  if (isdocLines.length > 0) {
    const supplierParty = getElementsByLocalName(doc, 'AccountingSupplierParty')[0];
    const supplierName = supplierParty ? getFirstTagText(supplierParty, 'Name') : '';
    const supplierIco = supplierParty
      ? getFirstTagText(supplierParty, 'ID').replace(/\D/g, '').slice(0, 8)
      : '';
    const documentNumber = getFirstTagText(doc, 'ID');
    const currency = normalizeCurrencyCode(
      getFirstTagText(doc, 'ForeignCurrencyCode') ||
        getFirstTagText(doc, 'LocalCurrencyCode') ||
        'CZK'
    );
    const currRateRaw = parseLocaleNumber(getFirstTagText(doc, 'CurrRate')) || 0;
    const refCurrRateRaw = parseLocaleNumber(getFirstTagText(doc, 'RefCurrRate')) || 1;
    const docRate = currRateRaw > 0 ? round4(currRateRaw / Math.max(1, refCurrRateRaw)) : 0;

    const now = Date.now();
    const items: ExtractedLineItem[] = isdocLines
      .map((line, idx) => {
        const name =
          getFirstTagText(line, 'Description') ||
          getFirstTagText(line, 'Name') ||
          `Položka ${idx + 1}`;
        const qtyEl = getElementsByLocalName(line, 'InvoicedQuantity')[0];
        const qty = Math.max(0.01, parseLocaleNumber(qtyEl?.textContent || '1') || 1);
        const unit = (qtyEl?.getAttribute('unitCode') || 'ks').trim();
        const rawUnitPrice = parseLocaleNumber(getFirstTagText(line, 'UnitPrice'));
        const rawLineExt = parseLocaleNumber(getFirstTagText(line, 'LineExtensionAmount'));
        const unitPrice = Math.max(
          0,
          round2(
            rawUnitPrice !== null && rawUnitPrice > 0
              ? rawUnitPrice
              : rawLineExt !== null
                ? rawLineExt / qty
                : 0
          )
        );
        const vatRate = normalizeVatRate(
          parseLocaleNumber(getFirstTagText(line, 'Percent')) ?? 21
        );
        const sellerIdEl = getElementsByLocalName(line, 'SellersItemIdentification')[0];
        const stdIdEl = getElementsByLocalName(line, 'StandardItemIdentification')[0];
        const sku =
          (sellerIdEl ? getFirstTagText(sellerIdEl, 'ID') : '') ||
          `ISDOC-${String(idx + 1).padStart(3, '0')}`;
        const ean = stdIdEl ? getFirstTagText(stdIdEl, 'ID') : '';

        return {
          id: `isdoc_${now}_${idx}`,
          sku: sku.slice(0, 64),
          name: name.slice(0, 200),
          ean: ean.slice(0, 40),
          quantity: round2(qty),
          unit: sanitizeStockUnit(unit),
          originalPurchasePrice: unitPrice,
          purchasePrice: unitPrice,
          suggestedSalePrice: unitPrice > 0 ? round2(unitPrice * 1.25) : 0,
          vatRate,
          selected: true,
        };
      })
      .filter((i) => i.name.trim().length > 0);

    return {
      format: 'ISDOC_XML',
      docRate,
      note: {
        supplierName,
        supplierIco,
        documentNumber,
        documentType: 'ISDOC Faktura',
        currency,
        exchangeRate: docRate > 0 ? docRate : 1,
        exchangeRateSource: currency === 'CZK' ? 'CZK' : docRate > 0 ? 'DOKLAD' : 'MANUAL',
        items,
      },
    };
  }

  // 2. Check for Stormware POHODA XML (<inv:invoiceItem>)
  const pohodaItems = getElementsByLocalName(doc, 'invoiceItem');
  if (pohodaItems.length > 0) {
    const myIdentity = getElementsByLocalName(doc, 'myIdentity')[0];
    const partnerIdentity = getElementsByLocalName(doc, 'partnerIdentity')[0];
    const supBlock = myIdentity || partnerIdentity;
    const supplierName = supBlock ? getFirstTagText(supBlock, 'company') || getFirstTagText(supBlock, 'name') : '';
    const supplierIco = supBlock ? getFirstTagText(supBlock, 'ico').replace(/\D/g, '').slice(0, 8) : '';
    const documentNumber =
      getFirstTagText(doc, 'numberRequested') || getFirstTagText(doc, 'symVar');
    const foreignCurBlock = getElementsByLocalName(doc, 'foreignCurrency')[0];
    const currency = normalizeCurrencyCode(
      foreignCurBlock ? getFirstTagText(foreignCurBlock, 'ids') : 'CZK'
    );
    const docRate = foreignCurBlock
      ? round4(parseLocaleNumber(getFirstTagText(foreignCurBlock, 'rate')) || 0)
      : 0;

    const now = Date.now();
    const items: ExtractedLineItem[] = pohodaItems
      .map((item, idx) => {
        const name = getFirstTagText(item, 'text') || `Položka ${idx + 1}`;
        const qty = Math.max(0.01, parseLocaleNumber(getFirstTagText(item, 'quantity')) || 1);
        const unit = getFirstTagText(item, 'unit') || 'ks';
        const sku = getFirstTagText(item, 'code') || `POH-${String(idx + 1).padStart(3, '0')}`;
        const ean = getFirstTagText(item, 'EAN');

        const itemForeign = getElementsByLocalName(item, 'foreignCurrency')[0];
        const itemHome = getElementsByLocalName(item, 'homeCurrency')[0];
        const priceBlock = currency !== 'CZK' && itemForeign ? itemForeign : itemHome;
        const unitPrice = Math.max(
          0,
          round2(
            priceBlock
              ? parseLocaleNumber(getFirstTagText(priceBlock, 'unitPrice')) ||
                  (parseLocaleNumber(getFirstTagText(priceBlock, 'price')) || 0) / qty
              : 0
          )
        );
        const rateVatStr = getFirstTagText(item, 'rateVAT').toLowerCase();
        const vatRate =
          rateVatStr === 'none'
            ? 0
            : rateVatStr === 'low' || rateVatStr === 'third'
              ? 12
              : 21;

        return {
          id: `pohoda_${now}_${idx}`,
          sku: sku.slice(0, 64),
          name: name.slice(0, 200),
          ean: ean.slice(0, 40),
          quantity: round2(qty),
          unit: sanitizeStockUnit(unit),
          originalPurchasePrice: unitPrice,
          purchasePrice: unitPrice,
          suggestedSalePrice: unitPrice > 0 ? round2(unitPrice * 1.25) : 0,
          vatRate,
          selected: true,
        };
      })
      .filter((i) => i.name.trim().length > 0);

    return {
      format: 'POHODA_XML',
      docRate,
      note: {
        supplierName,
        supplierIco,
        documentNumber,
        documentType: 'POHODA XML Faktura',
        currency,
        exchangeRate: docRate > 0 ? docRate : 1,
        exchangeRateSource: currency === 'CZK' ? 'CZK' : docRate > 0 ? 'DOKLAD' : 'MANUAL',
        items,
      },
    };
  }

  return null;
}

export async function applyLiveCnbRateToNote(
  note: ExtractedDeliveryNote,
  docRate: number
): Promise<ExtractedDeliveryNote> {
  const currency = normalizeCurrencyCode(note.currency);
  if (currency === 'CZK') {
    return {
      ...note,
      currency: 'CZK',
      exchangeRate: 1,
      exchangeRateSource: 'CZK',
      exchangeRateDate: '',
      cnbRate: 1,
    };
  }

  let exchangeRate = docRate > 0 && docRate < 10000 ? round4(docRate) : 1;
  let exchangeRateSource: 'CZK' | 'CNB' | 'DOKLAD' | 'MANUAL' =
    docRate > 0 && docRate < 10000 ? 'DOKLAD' : 'MANUAL';
  let exchangeRateDate = '';
  let cnbRate = 1;

  try {
    const resp = await fetch('/api/cnb-rates');
    if (resp.ok) {
      const data = (await resp.json()) as {
        date?: string;
        rates?: Record<string, number>;
        source?: 'CNB' | 'FALLBACK';
      };
      const rateFromCnb = Number(data.rates?.[currency] || 0);
      if (rateFromCnb > 0) {
        cnbRate = round4(rateFromCnb);
        exchangeRateDate = data.date || '';
        if (exchangeRateSource !== 'DOKLAD') {
          exchangeRate = cnbRate;
          exchangeRateSource = data.source === 'CNB' ? 'CNB' : 'MANUAL';
        }
      }
    }
  } catch {
    // Keep docRate or manual 1
  }

  return {
    ...note,
    currency,
    exchangeRate,
    exchangeRateSource,
    exchangeRateDate,
    cnbRate,
    items: note.items.map((item) => {
      const orig =
        item.originalPurchasePrice !== undefined ? item.originalPurchasePrice : item.purchasePrice;
      const czkPrice = Math.max(0, round2(orig * exchangeRate));
      return {
        ...item,
        originalPurchasePrice: orig,
        purchasePrice: czkPrice,
        suggestedSalePrice: czkPrice > 0 ? round2(czkPrice * 1.25) : 0,
      };
    }),
  };
}
