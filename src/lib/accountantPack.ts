import type { Company, InventoryItem, Invoice, StockMovement, Warehouse } from '../types';
import {
  calculateInvoiceTotals,
  formatCzk,
  generatePohodaDataPackXml,
  getDocumentTypeShortLabel,
  round2,
  timestampToMs,
  toIsoDate,
} from './format';
import type { CashbookEntry } from './pdfExport';
import { listArchivedStockInDocuments } from './stockInArchive';
import type { ZipEntryInput } from './zipBuilder';

export interface MonthlyAccountantPackSummary {
  monthKey: string;
  issuedInvoicesCount: number;
  receivedArchiveFilesCount: number;
  stockReceiptsCount: number;
  cashEntriesCount: number;
  totalRevenueWithVatCzk: number;
  totalOutputVatCzk: number;
  zipFileName: string;
  zipSizeKb: number;
}

function sanitizeFilePart(text: string): string {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function escCsv(v: string | number | boolean): string {
  const s = String(v ?? '');
  return s.includes(';') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function getMonthKeyFromDate(isoDate?: string): string {
  if (!isoDate || isoDate.length < 7) return '';
  return isoDate.slice(0, 7);
}

export function getMonthKeyFromMs(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function getMonthlyPackPreviewCounts(params: {
  company: Company | null;
  monthKey: string;
  invoices: Invoice[];
  movements: StockMovement[];
}) {
  const { company, monthKey, invoices, movements } = params;
  const companyInvoices = invoices.filter(
    (inv) =>
      (!company || inv.companyId === company.id) &&
      inv.status !== 'CANCELLED' &&
      getMonthKeyFromDate(inv.taxDate || inv.issueDate) === monthKey
  );
  const cashInvoices = companyInvoices.filter((inv) => inv.paymentMethod === 'CASH');
  const monthReceipts = movements.filter(
    (m) =>
      m.quantityDelta > 0 &&
      (!company || !m.companyId || m.companyId === company.id) &&
      getMonthKeyFromMs(timestampToMs(m.createdAt)) === monthKey
  );
  return {
    issuedCount: companyInvoices.length,
    cashCount: cashInvoices.length,
    receiptsCount: monthReceipts.length,
  };
}

/**
 * Builds and downloads the complete Monthly Accountant ZIP Pack:
 *  - 01_Vydane_faktury_PDF/   (A4 PDFs of all issued invoices, credit notes & prodejky)
 *  - 02_Prijate_doklady/      (original archived stock-in PDFs/images + CSV summary of stock receipts)
 *  - 03_Pokladna/             (Pokladní kniha PDF + CSV of cash documents)
 *  - 04_POHODA/               (Stormware POHODA XML DataPack v2.0 for the month)
 *  - 05_DPH_Prehled/          (VAT summary CSV per § 37 ZDPH)
 *  - README_Ucetni.txt
 */
export async function generateAndDownloadMonthlyAccountantPack(params: {
  workspaceId: string;
  company: Company;
  monthKey: string; // YYYY-MM
  invoices: Invoice[];
  movements: StockMovement[];
  inventory: InventoryItem[];
  warehouses: Warehouse[];
}): Promise<MonthlyAccountantPackSummary> {
  const { workspaceId, company, monthKey, invoices, movements, inventory, warehouses } = params;
  const [{ generateCashbookPdfBytes, generateInvoicePdfBytes }, { buildZipBlob, downloadBlob }] =
    await Promise.all([import('./pdfExport'), import('./zipBuilder')]);
  const entries: ZipEntryInput[] = [];

  const monthInvoices = invoices
    .filter(
      (inv) =>
        inv.companyId === company.id &&
        inv.status !== 'CANCELLED' &&
        getMonthKeyFromDate(inv.taxDate || inv.issueDate) === monthKey
    )
    .sort((a, b) => (a.issueDate || '').localeCompare(b.issueDate || ''));

  const usedPdfNames = new Set<string>();
  let totalRevenueWithVatCzk = 0;
  let totalOutputVatCzk = 0;

  // 1. Issued Invoices / Prodejky / Credit Notes as real A4 PDFs
  for (const inv of monthInvoices) {
    const fx = inv.currency && inv.currency !== 'CZK' ? inv.exchangeRate || 1 : 1;
    const isTaxDoc = !inv.documentType || inv.documentType === 'INVOICE' || inv.documentType === 'CREDIT_NOTE' || inv.documentType === 'SIMPLIFIED';
    if (isTaxDoc) {
      const effectiveVat = Boolean(company.vatPayer) && !inv.reverseCharge;
      const calc = calculateInvoiceTotals(inv.items || [], effectiveVat);
      totalRevenueWithVatCzk = round2(totalRevenueWithVatCzk + calc.totalWithVat * fx);
      totalOutputVatCzk = round2(totalOutputVatCzk + calc.totalVat * fx);
    }

    const typeTag = sanitizeFilePart(getDocumentTypeShortLabel(inv.documentType));
    const numTag = sanitizeFilePart(inv.invoiceNumber || inv.id);
    const clientTag = sanitizeFilePart(inv.clientName || 'Zakaznik').slice(0, 28);
    let fileName = `${typeTag}_${numTag}_${clientTag}.pdf`;
    let dup = 2;
    while (usedPdfNames.has(fileName)) {
      fileName = `${typeTag}_${numTag}_${clientTag}_${dup++}.pdf`;
    }
    usedPdfNames.add(fileName);

    const pdfBytes = await generateInvoicePdfBytes(inv, company);
    entries.push({
      name: `01_Vydane_faktury_PDF/${fileName}`,
      data: pdfBytes,
    });
  }

  // 2. Received Documents (Archived original files from IndexedDB + Stock-in Receipts CSV)
  const archivedDocs = await listArchivedStockInDocuments(workspaceId);
  const monthArchived = archivedDocs.filter(
    (d) =>
      (!d.companyId || d.companyId === company.id) &&
      getMonthKeyFromMs(d.createdAtMs) === monthKey
  );

  let receivedArchiveFilesCount = 0;
  const usedArchNames = new Set<string>();
  for (const docItem of monthArchived) {
    if (!docItem.fileBlob) continue;
    const buf = new Uint8Array(await docItem.fileBlob.arrayBuffer());
    const base = sanitizeFilePart(
      docItem.fileName || `${docItem.documentNumber || 'doklad'}_${docItem.supplierName || 'dodavatel'}.pdf`
    );
    let finalName = base || `doklad_${receivedArchiveFilesCount + 1}.pdf`;
    let dup = 2;
    while (usedArchNames.has(finalName)) {
      finalName = `${dup++}_${base}`;
    }
    usedArchNames.add(finalName);
    entries.push({
      name: `02_Prijate_doklady/${finalName}`,
      data: buf,
    });
    receivedArchiveFilesCount += 1;
  }

  const whMap = new Map(warehouses.map((w) => [w.id, w.name]));
  const monthReceipts = movements.filter(
    (m) =>
      m.quantityDelta > 0 &&
      (!m.companyId || m.companyId === company.id) &&
      getMonthKeyFromMs(timestampToMs(m.createdAt)) === monthKey
  );
  const receiptHeaders = [
    'Datum',
    'Doklad',
    'SKU',
    'Položka',
    'Sklad',
    'Množství',
    'MJ',
    'Nákupní cena/MJ (Kč)',
    'Celkem bez DPH (Kč)',
    'Poznámka',
  ];
  const receiptRows = monthReceipts.map((m) =>
    [
      toIsoDate(new Date(timestampToMs(m.createdAt))),
      m.documentRef || '',
      m.itemSku || '',
      m.itemName || '',
      whMap.get(m.warehouseId) || m.warehouseId,
      m.quantityDelta,
      m.unit || 'ks',
      m.unitPrice || 0,
      round2(m.quantityDelta * (m.unitPrice || 0)),
      m.note || '',
    ]
      .map(escCsv)
      .join(';')
  );
  entries.push({
    name: `02_Prijate_doklady/prehled_prijemek_${monthKey}.csv`,
    data: '\uFEFF' + [receiptHeaders.join(';'), ...receiptRows].join('\r\n'),
  });

  // 3. Pokladna (Cashbook PDF + CSV)
  const cashInvoices = monthInvoices.filter((inv) => inv.paymentMethod === 'CASH');
  const cashEntries: CashbookEntry[] = cashInvoices.map((inv) => {
    const fx = inv.currency && inv.currency !== 'CZK' ? inv.exchangeRate || 1 : 1;
    const grossCzk = round2((inv.totalWithVat || 0) * fx);
    const isOut = grossCzk < 0 || inv.documentType === 'CREDIT_NOTE';
    return {
      date: inv.paidDate || inv.issueDate,
      docNumber: inv.invoiceNumber,
      partner: inv.clientName || 'Konečný zákazník',
      description: `${getDocumentTypeShortLabel(inv.documentType)} (${inv.status === 'PAID' ? 'uhrazeno' : 'vystaveno'})`,
      incomeCzk: isOut ? 0 : Math.abs(grossCzk),
      expenseCzk: isOut ? Math.abs(grossCzk) : 0,
    };
  });
  const totalCashIncome = round2(cashEntries.reduce((s, e) => s + e.incomeCzk, 0));
  const totalCashExpense = round2(cashEntries.reduce((s, e) => s + e.expenseCzk, 0));

  const cashPdf = generateCashbookPdfBytes({
    company,
    monthKey,
    entries: cashEntries,
    totalIncome: totalCashIncome,
    totalExpense: totalCashExpense,
  });
  entries.push({
    name: `03_Pokladna/pokladni_kniha_${monthKey}.pdf`,
    data: cashPdf,
  });

  const cashCsvHeaders = ['Datum', 'Číslo dokladu', 'Partner', 'Popis', 'Příjem Kč', 'Výdej Kč'];
  const cashCsvRows = cashEntries.map((e) =>
    [e.date, e.docNumber, e.partner, e.description, e.incomeCzk.toFixed(2), e.expenseCzk.toFixed(2)]
      .map(escCsv)
      .join(';')
  );
  entries.push({
    name: `03_Pokladna/pokladna_${monthKey}.csv`,
    data: '\uFEFF' + [cashCsvHeaders.join(';'), ...cashCsvRows].join('\r\n'),
  });

  // 4. POHODA XML DataPack v2.0 for the month
  const pohodaXml = generatePohodaDataPackXml({
    company,
    invoices: monthInvoices,
    inventory,
    warehouses,
    scope: 'INVOICES',
  });
  entries.push({
    name: `04_POHODA/pohoda_faktury_${monthKey}.xml`,
    data: pohodaXml,
  });

  // 5. VAT Summary CSV (Podklad pro DPH a Kontrolní hlášení)
  const vatHeaders = [
    'Typ dokladu',
    'Číslo dokladu',
    'VS',
    'Datum vystavení',
    'DUZP',
    'Splatnost',
    'Odběratel',
    'IČO',
    'DIČ',
    'Úhrada',
    'Stav',
    'Měna',
    'Kurz',
    'Základ 21% (CZK)',
    'DPH 21% (CZK)',
    'Základ 12% (CZK)',
    'DPH 12% (CZK)',
    'Osvobozeno/0% (CZK)',
    'Celkem s DPH (CZK)',
    'Přenesená DPH',
  ];
  const vatRows = monthInvoices.map((inv) => {
    const fx = inv.currency && inv.currency !== 'CZK' ? inv.exchangeRate || 1 : 1;
    const effVat = Boolean(company.vatPayer) && !inv.reverseCharge;
    const calc = calculateInvoiceTotals(inv.items || [], effVat);
    const b21 = calc.breakdown.find((r) => r.rate === 21);
    const b12 = calc.breakdown.find((r) => r.rate === 12);
    const b0 = calc.breakdown.find((r) => r.rate === 0);
    return [
      getDocumentTypeShortLabel(inv.documentType),
      inv.invoiceNumber,
      inv.variableSymbol,
      inv.issueDate,
      inv.taxDate || inv.issueDate,
      inv.dueDate,
      inv.clientName,
      inv.clientIco,
      inv.clientDic,
      inv.paymentMethod,
      inv.status,
      inv.currency || 'CZK',
      fx,
      round2((b21?.base || 0) * fx).toFixed(2),
      round2((b21?.vat || 0) * fx).toFixed(2),
      round2((b12?.base || 0) * fx).toFixed(2),
      round2((b12?.vat || 0) * fx).toFixed(2),
      round2((b0?.base || 0) * fx).toFixed(2),
      round2(calc.totalWithVat * fx).toFixed(2),
      inv.reverseCharge ? 'ANO' : 'NE',
    ]
      .map(escCsv)
      .join(';');
  });
  entries.push({
    name: `05_DPH_Prehled/podklad_dph_${monthKey}.csv`,
    data: '\uFEFF' + [vatHeaders.join(';'), ...vatRows].join('\r\n'),
  });

  // 6. README_Ucetni.txt
  const readme = [
    `MĚSÍČNÍ BALÍČEK PRO ÚČETNÍ — ${monthKey}`,
    `==============================================`,
    `Firma: ${company.name}`,
    `IČO: ${company.ico || '—'} | DIČ: ${company.dic || 'Neplátce DPH'}`,
    `Vygenerováno: ${new Date().toLocaleString('cs-CZ')}`,
    ``,
    `OBSAH ARCHIVU:`,
    `1. 01_Vydane_faktury_PDF/ — ${monthInvoices.length} vydaných dokladů v PDF (faktury, prodejky, dobropisy)`,
    `2. 02_Prijate_doklady/    — ${receivedArchiveFilesCount} originálních přijatých dokladů + přehled ${monthReceipts.length} příjemek (CSV)`,
    `3. 03_Pokladna/           — Pokladní kniha v PDF + CSV (${cashEntries.length} hotovostních dokladů, příjmy ${formatCzk(totalCashIncome)})`,
    `4. 04_POHODA/             — Stormware POHODA XML DataPack v2.0 (připraveno pro přímý import)`,
    `5. 05_DPH_Prehled/        — Podklad pro přiznání k DPH a Kontrolní hlášení dle § 37 ZDPH (CSV pro Excel)`,
    ``,
    `SOUHRN MĚSÍCE (DAŇOVÉ DOKLADY):`,
    `- Celkem fakturováno s DPH: ${formatCzk(totalRevenueWithVatCzk)}`,
    `- DPH na výstupu celkem:    ${formatCzk(totalOutputVatCzk)}`,
  ].join('\r\n');
  entries.push({ name: 'README_Ucetni.txt', data: readme });

  const zipBlob = buildZipBlob(entries);
  const safeCompany = sanitizeFilePart(company.name).toLowerCase() || 'firma';
  const zipFileName = `ucetni_balicek_${safeCompany}_${monthKey}.zip`;
  downloadBlob(zipBlob, zipFileName);

  return {
    monthKey,
    issuedInvoicesCount: monthInvoices.length,
    receivedArchiveFilesCount,
    stockReceiptsCount: monthReceipts.length,
    cashEntriesCount: cashEntries.length,
    totalRevenueWithVatCzk,
    totalOutputVatCzk,
    zipFileName,
    zipSizeKb: Math.max(1, Math.round(zipBlob.size / 1024)),
  };
}
