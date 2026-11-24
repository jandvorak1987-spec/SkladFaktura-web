import type {
  BankTransaction,
  ExtractedDeliveryNote,
  ExtractedLineItem,
  InventoryItem,
  Invoice,
  ParsedBankTx,
} from '../types';
import { round2, toIsoDate } from './format';

export type StatementFormat = 'ABO_GPC' | 'CSV';

export interface StatementPreviewRow {
  transaction: ParsedBankTx;
  isDuplicate: boolean;
  matchedInvoice: Invoice | null;
}

export interface StatementImportPreview {
  fileName: string;
  format: StatementFormat;
  rows: StatementPreviewRow[];
  totalParsed: number;
  duplicateCount: number;
  autoMatchedCount: number;
  newTransactions: ParsedBankTx[];
}

export function extractVsFromMessage(message: string): string {
  if (!message) return '';
  const m = message.match(/(?:VS|VAR\.?\s*SYM\.?|FA(?:KTURA)?)\s*[:#-]?\s*(\d{4,10})/i);
  return m ? m[1] : '';
}

export function decodeBankFileBuffer(buffer: ArrayBuffer, fileName: string): string {
  const bytes = new Uint8Array(buffer);
  const lower = fileName.toLowerCase();
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const looksAbo =
    lower.endsWith('.gpc') ||
    lower.endsWith('.abo') ||
    utf8
      .split(/\r?\n/)
      .slice(0, 5)
      .some((l) => l.startsWith('074') || l.startsWith('075'));

  if (looksAbo || utf8.includes('\uFFFD')) {
    try {
      return new TextDecoder('windows-1250').decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

export function detectStatementFormat(raw: string, fileName: string): StatementFormat {
  const lower = fileName.toLowerCase();
  const hasAbo = raw
    .split(/\r?\n/)
    .some((l) => l.startsWith('075') && l.length >= 97);
  return hasAbo || lower.endsWith('.gpc') || lower.endsWith('.abo') ? 'ABO_GPC' : 'CSV';
}

function normalizeDate(raw: string): string | null {
  const t = raw.trim();
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dot = t.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (dot) return `${dot[3]}-${dot[2].padStart(2, '0')}-${dot[1].padStart(2, '0')}`;
  const slash = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  return null;
}

function parseCzechAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/\u00A0/g, '')
    .replace(/\s+/g, '')
    .replace(/CZK|Kč|EUR/gi, '')
    .replace(',', '.');
  const num = Number(cleaned);
  return Number.isFinite(num) ? round2(num) : null;
}

/**
 * Parses standard Czech ABO/GPC (.gpc, .abo) bank statements (records 075, 078, 079).
 */
export function parseGpcStatement(raw: string): ParsedBankTx[] {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const result: ParsedBankTx[] = [];
  let current: ParsedBankTx | null = null;
  let seq = 0;

  for (const line of lines) {
    if (line.startsWith('075') && line.length >= 97) {
      if (current) result.push(current);
      seq++;
      const counterAccRaw = line.slice(19, 35).replace(/^0+/, '');
      const docNum = line.slice(35, 48).trim() || `GPC-${seq}`;
      const amountHalere = Number(line.slice(48, 60)) || 0;
      const signCode = line.slice(60, 61); // 1 = debit, 2 = credit, 4 = debit storno, 5 = credit storno
      const isCredit = signCode === '2' || signCode === '5';
      const amount = round2((amountHalere / 100) * (isCredit ? 1 : -1));
      const vs = line.slice(61, 71).replace(/^0+/, '').replace(/\D/g, '');
      const bankCode = line.slice(73, 77).replace(/\D/g, '');
      const name = line.slice(97, 117).trim();
      const ddmmYY = line.slice(122, 128).trim();
      let dateIso = toIsoDate();
      if (/^\d{6}$/.test(ddmmYY)) {
        const dd = ddmmYY.slice(0, 2);
        const mm = ddmmYY.slice(2, 4);
        const yy = Number(ddmmYY.slice(4, 6));
        const yyyy = yy >= 70 ? 1900 + yy : 2000 + yy;
        dateIso = `${yyyy}-${mm}-${dd}`;
      }

      current = {
        externalId: `GPC-${docNum}-${dateIso}-${amountHalere}`.slice(0, 100),
        date: dateIso,
        amount,
        currency: 'CZK',
        variableSymbol: vs.slice(0, 30),
        counterpartyName: name.slice(0, 200),
        counterpartyAccount: (counterAccRaw && bankCode ? `${counterAccRaw}/${bankCode}` : counterAccRaw).slice(0, 60),
        message: '',
        source: 'GPC_IMPORT',
      };
    } else if ((line.startsWith('078') || line.startsWith('079')) && current) {
      const avText = line.slice(3).trim();
      if (avText) {
        current.message = [current.message, avText].filter(Boolean).join(' ').slice(0, 300);
        if (!current.variableSymbol) {
          current.variableSymbol = extractVsFromMessage(current.message).slice(0, 30);
        }
      }
    }
  }
  if (current) result.push(current);
  return result;
}

function splitCsvLine(line: string, sep: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/**
 * Universal Czech Bank CSV parser supporting Fio, ČS, KB, ČSOB, Air Bank, Raiffeisenbank, Moneta.
 */
export function parseCsvStatement(raw: string): ParsedBankTx[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  let headerIdx = -1;
  let sep = ';';
  let headers: string[] = [];

  for (let i = 0; i < Math.min(25, lines.length); i++) {
    const candidateSep = lines[i].includes(';') ? ';' : lines[i].includes('\t') ? '\t' : ',';
    const cols = splitCsvLine(lines[i], candidateSep).map((c) => c.toLowerCase());
    const hasDate = cols.some((c) => c.includes('datum') || c.includes('date'));
    const hasAmount = cols.some(
      (c) => c.includes('objem') || c.includes('částka') || c.includes('castka') || c.includes('amount')
    );
    if (hasDate && hasAmount) {
      headerIdx = i;
      sep = candidateSep;
      headers = cols;
      break;
    }
  }

  if (headerIdx === -1) return [];

  const findCol = (patterns: string[]) =>
    headers.findIndex((h) => patterns.some((p) => h.includes(p)));

  const idxDate = findCol(['datum', 'date']);
  const idxAmount = findCol(['objem', 'částka', 'castka', 'amount']);
  const idxCurrency = findCol(['měna', 'mena', 'currency']);
  const idxVs = findCol(['vs', 'variabilní', 'variabilni', 'variable']);
  const idxCounterName = findCol(['název protiúčtu', 'nazev protiuctu', 'protiúčet název', 'plátce', 'platce', 'příjemce', 'counterparty']);
  const idxCounterAcc = findCol(['protiúčet', 'protiucet', 'číslo účtu', 'account']);
  const idxMsg = findCol(['zpráva', 'zprava', 'poznámka', 'poznamka', 'popis', 'message', 'komentář']);
  const idxId = findCol(['id pohybu', 'id transakce', 'identifikace', 'reference', 'id']);

  const txs: ParsedBankTx[] = [];
  for (let r = headerIdx + 1; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r], sep);
    const dateIso = idxDate >= 0 ? normalizeDate(cols[idxDate] || '') : null;
    const amount = idxAmount >= 0 ? parseCzechAmount(cols[idxAmount] || '') : null;
    if (!dateIso || amount === null) continue;

    const msg = idxMsg >= 0 ? (cols[idxMsg] || '').slice(0, 300) : '';
    const vsRaw = idxVs >= 0 ? (cols[idxVs] || '').replace(/\D/g, '') : '';
    const vs = (vsRaw || extractVsFromMessage(msg)).slice(0, 30);
    const extId =
      (idxId >= 0 && cols[idxId] ? cols[idxId] : `CSV-${dateIso}-${amount}-${vs}-${r}`).slice(
        0,
        100
      );

    txs.push({
      externalId: extId,
      date: dateIso,
      amount,
      currency: (idxCurrency >= 0 && cols[idxCurrency] ? cols[idxCurrency] : 'CZK').slice(0, 10),
      variableSymbol: vs,
      counterpartyName: (idxCounterName >= 0 ? cols[idxCounterName] || '' : '').slice(0, 200),
      counterpartyAccount: (idxCounterAcc >= 0 ? cols[idxCounterAcc] || '' : '').slice(0, 60),
      message: msg,
      source: 'CSV_IMPORT',
    });
  }
  return txs;
}

export function findBestMatchingInvoice(
  tx: ParsedBankTx,
  unpaidInvoices: Invoice[]
): Invoice | null {
  if (tx.amount <= 0) return null;
  const txVs = tx.variableSymbol.replace(/^0+/, '').replace(/\D/g, '');
  if (!txVs) return null;

  const byVs = unpaidInvoices.filter((inv) => {
    const invVs = inv.variableSymbol.replace(/^0+/, '').replace(/\D/g, '');
    const invNumDigits = inv.invoiceNumber.replace(/^0+/, '').replace(/\D/g, '');
    return invVs === txVs || invNumDigits === txVs;
  });
  if (byVs.length === 0) return null;

  // Prefer exact balance match (within 1 CZK tolerance)
  const exact = byVs.find((inv) => {
    const remaining = round2(Math.max(0, inv.totalWithVat - inv.paidAmount));
    return Math.abs(remaining - tx.amount) <= 1.0;
  });
  return exact || byVs[0];
}

export function buildStatementImportPreview(params: {
  rawContent: string;
  fileName: string;
  companyId: string;
  existingTransactions: BankTransaction[];
  unpaidCompanyInvoices: Invoice[];
}): StatementImportPreview {
  const { rawContent, fileName, companyId, existingTransactions, unpaidCompanyInvoices } = params;
  const format = detectStatementFormat(rawContent, fileName);
  const parsed = format === 'ABO_GPC' ? parseGpcStatement(rawContent) : parseCsvStatement(rawContent);

  const existingIds = new Set(
    existingTransactions.filter((t) => t.companyId === companyId).map((t) => t.externalId)
  );
  const remainingUnpaid = [...unpaidCompanyInvoices];

  const rows: StatementPreviewRow[] = parsed.map((tx) => {
    const isDuplicate = existingIds.has(tx.externalId);
    let matchedInvoice: Invoice | null = null;
    if (!isDuplicate) {
      matchedInvoice = findBestMatchingInvoice(tx, remainingUnpaid);
      if (matchedInvoice) {
        const idx = remainingUnpaid.findIndex((i) => i.id === matchedInvoice!.id);
        if (idx >= 0) remainingUnpaid.splice(idx, 1);
      }
    }
    return { transaction: tx, isDuplicate, matchedInvoice };
  });

  return {
    fileName,
    format,
    rows,
    totalParsed: rows.length,
    duplicateCount: rows.filter((r) => r.isDuplicate).length,
    autoMatchedCount: rows.filter((r) => !r.isDuplicate && r.matchedInvoice !== null).length,
    newTransactions: rows.filter((r) => !r.isDuplicate).map((r) => r.transaction),
  };
}

/**
 * Local CSV/TSV parser for Smart Stock-In (mirrors AiStockImportService.parseCsvQuickly).
 */
export function parseQuickStockCsv(rawCsv: string): ExtractedDeliveryNote {
  const lines = rawCsv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const items: ExtractedLineItem[] = [];

  lines.forEach((line, idx) => {
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const cols = splitCsvLine(line, sep);
    const first = (cols[0] || '').toLowerCase();
    if (idx === 0 && (first.includes('sku') || first.includes('kód') || first.includes('název'))) {
      return;
    }
    if (cols.length >= 2) {
      const sku = (cols[0] || `IMP-${idx + 1}`).slice(0, 64);
      const name = (cols[1] || sku).slice(0, 200);
      const quantity = Math.max(0.01, Number((cols[2] || '1').replace(',', '.')) || 1);
      const unit = (cols[3] || 'ks').slice(0, 20);
      const purchasePrice = Math.max(0, round2(Number((cols[4] || '0').replace(',', '.')) || 0));
      const vatRaw = Number(cols[5] ?? 21);
      const vatRate = vatRaw === 0 || vatRaw === 12 || vatRaw === 21 ? vatRaw : 21;
      items.push({
        id: `csv_${Date.now()}_${idx}`,
        sku,
        name,
        ean: '',
        quantity,
        unit,
        purchasePrice,
        suggestedSalePrice: purchasePrice > 0 ? round2(purchasePrice * 1.25) : 0,
        vatRate,
        selected: true,
      });
    }
  });

  return {
    supplierName: 'Hromadný CSV import',
    supplierIco: '',
    documentNumber: `CSV-${Date.now() % 100000}`,
    documentType: 'CSV Import',
    items,
  };
}

export function normalizeMatchKey(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeSkuKey(value: string): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_./]+/g, '');
}

export function isSyntheticSku(sku: string): boolean {
  const s = (sku || '').trim();
  if (!s) return true;
  return /^(sku|ai|imp|isdoc|poh|loc|item|pol)[-_ ]?\d{1,6}$/i.test(s);
}

export function areNamesCompatible(nameA: string, nameB: string): boolean {
  const a = normalizeMatchKey(nameA);
  const b = normalizeMatchKey(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  return tokensEqualSet(a, b);
}

export function generateUniqueSku(name: string, takenSkus: Set<string>): string {
  const norm = normalizeMatchKey(name);
  const words = norm.split(' ').filter(Boolean);
  const prefix =
    words
      .slice(0, 3)
      .map((w) => w.slice(0, 3).toUpperCase())
      .join('-') || 'POL';
  const baseStamp = (Date.now() % 100000).toString(36).toUpperCase();
  for (let attempt = 0; attempt < 200; attempt++) {
    const suffix = attempt === 0 ? baseStamp : `${baseStamp}${attempt}`;
    const candidate = `${prefix}-${suffix}`.slice(0, 48);
    if (!takenSkus.has(normalizeSkuKey(candidate))) {
      takenSkus.add(normalizeSkuKey(candidate));
      return candidate;
    }
  }
  const fallback = `POL-${Date.now()}-${Math.floor(Math.random() * 1000)}`.slice(0, 48);
  takenSkus.add(normalizeSkuKey(fallback));
  return fallback;
}

function tokensEqualSet(a: string, b: string): boolean {
  const ta = a.split(' ').filter((w) => w.length >= 1);
  const tb = b.split(' ').filter((w) => w.length >= 1);
  if (ta.length < 2 || ta.length !== tb.length) return false;
  // Require identical token multiset (every word & variant digit must match 1:1)
  const sortedA = [...ta].sort();
  const sortedB = [...tb].sort();
  return sortedA.every((w, idx) => w === sortedB[idx]);
}

export function findMatchingInventoryItem(
  line: Pick<ExtractedLineItem, 'ean' | 'sku' | 'name'>,
  candidates: InventoryItem[]
): InventoryItem | null {
  const eanClean = (line.ean || '').replace(/\D/g, '');
  const skuKey = normalizeSkuKey(line.sku);
  const nameKey = normalizeMatchKey(line.name);

  if (eanClean.length >= 8) {
    const byEan = candidates.find((i) => (i.ean || '').replace(/\D/g, '') === eanClean);
    if (byEan) return byEan;
  }

  // Never match by auto-generated placeholder SKUs like SKU-001..SKU-008, AI-1234, IMP-1
  if (skuKey.length >= 2 && !isSyntheticSku(line.sku)) {
    const bySku = candidates.find((i) => {
      if (isSyntheticSku(i.sku) || normalizeSkuKey(i.sku) !== skuKey) return false;
      // Extra guard: if both have names, ensure we didn't match two totally different products
      if (nameKey.length >= 2 && normalizeMatchKey(i.name).length >= 2) {
        return areNamesCompatible(i.name, line.name);
      }
      return true;
    });
    if (bySku) return bySku;
  }

  if (nameKey.length >= 2) {
    const byExactName = candidates.find((i) => normalizeMatchKey(i.name) === nameKey);
    if (byExactName) return byExactName;

    const byTokens = candidates.find((i) => tokensEqualSet(normalizeMatchKey(i.name), nameKey));
    if (byTokens) return byTokens;
  }

  return null;
}

export function matchExtractedToInventory(
  note: ExtractedDeliveryNote,
  inventory: InventoryItem[],
  warehouseId: string
): ExtractedDeliveryNote {
  const whItems = inventory.filter((i) => i.warehouseId === warehouseId);
  const otherWhItems = inventory.filter((i) => i.warehouseId !== warehouseId);

  return {
    ...note,
    items: note.items.map((line) => {
      if (line.manualMatchLock) {
        const pinned = line.matchedInventoryId
          ? inventory.find((i) => i.id === line.matchedInventoryId) || null
          : null;
        return {
          ...line,
          matchedInventoryId: pinned?.id || null,
          matchedItemName: pinned?.name || null,
          matchedOtherWarehouseId: null,
        };
      }

      const matched = findMatchingInventoryItem(line, whItems);
      if (matched) {
        return {
          ...line,
          matchedInventoryId: matched.id,
          matchedItemName: matched.name,
          matchedOtherWarehouseId: null,
        };
      }

      const otherMatch = findMatchingInventoryItem(line, otherWhItems);
      return {
        ...line,
        matchedInventoryId: null,
        matchedItemName: null,
        matchedOtherWarehouseId: otherMatch?.warehouseId || null,
      };
    }),
  };
}

