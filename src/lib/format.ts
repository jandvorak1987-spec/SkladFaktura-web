import type { Timestamp } from 'firebase/firestore';
import {
  COMPANY_BRAND_PALETTES,
  type Company,
  type CompanyBrandPalette,
  type InventoryItem,
  type Invoice,
  type InvoiceLineItem,
  type PohodaExportScope,
  type Warehouse,
  type Workspace,
} from '../types';

const czkFormatter = new Intl.NumberFormat('cs-CZ', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const qtyFormatter = new Intl.NumberFormat('cs-CZ', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

export function formatCzk(amount: number, currency = 'CZK'): string {
  const suffix = currency === 'CZK' ? 'Kč' : currency;
  return `${czkFormatter.format(Number.isFinite(amount) ? amount : 0)} ${suffix}`;
}

export function formatQty(value: number): string {
  return qtyFormatter.format(Number.isFinite(value) ? value : 0);
}

export function toIsoDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDaysIso(isoDate: string, days: number): string {
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    return toIsoDate(new Date(Date.now() + days * 86400000));
  }
  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  dt.setDate(dt.getDate() + days);
  return toIsoDate(dt);
}

export function formatDateCz(isoDate: string): string {
  if (!isoDate) return '—';
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${Number(parts[2])}. ${Number(parts[1])}. ${parts[0]}`;
}

export function formatTimestampCz(ts?: Timestamp | null): string {
  if (!ts || typeof ts.toDate !== 'function') return 'Právě teď';
  return ts.toDate().toLocaleString('cs-CZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function timestampToMs(ts?: Timestamp | null): number {
  if (!ts || typeof ts.toMillis !== 'function') return Date.now();
  return ts.toMillis();
}

export function nowSyncLabel(): string {
  return new Date().toLocaleString('cs-CZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getCompanyPalette(accentIndex?: number): CompanyBrandPalette {
  const len = COMPANY_BRAND_PALETTES.length;
  const idx = (((accentIndex ?? 0) % len) + len) % len;
  return COMPANY_BRAND_PALETTES[idx];
}

export function hasAdminRights(workspace: Workspace | null, email?: string | null): boolean {
  if (!workspace || !email) return false;
  const norm = email.trim().toLowerCase();
  return (
    workspace.ownerEmail.toLowerCase() === norm ||
    (workspace.adminEmails || []).some((e) => e.toLowerCase() === norm)
  );
}

export function formatCompanyAddress(c: Pick<Company, 'street' | 'zip' | 'city'>): string {
  return [c.street, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export function previewNextInvoiceNumber(c: Pick<Company, 'invoicePrefix' | 'nextInvoiceNumber'>): string {
  return `${c.invoicePrefix}${String(c.nextInvoiceNumber || 1).padStart(4, '0')}`;
}

export function lineTotalWithoutVat(item: InvoiceLineItem): number {
  const gross = (item.quantity || 0) * (item.unitPrice || 0);
  const disc = Math.min(100, Math.max(0, item.discountPercent || 0));
  return round2(gross * ((100 - disc) / 100));
}

export function lineVatAmount(item: InvoiceLineItem, vatPayer: boolean): number {
  if (!vatPayer) return 0;
  return round2(lineTotalWithoutVat(item) * ((item.vatRate || 0) / 100));
}

export function lineTotalWithVat(item: InvoiceLineItem, vatPayer: boolean): number {
  return round2(lineTotalWithoutVat(item) + lineVatAmount(item, vatPayer));
}

export interface VatBreakdownRow {
  rate: number;
  base: number;
  vat: number;
  total: number;
}

export function calculateInvoiceTotals(
  items: InvoiceLineItem[],
  vatPayer: boolean
): {
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  breakdown: VatBreakdownRow[];
} {
  const byRate = new Map<number, { base: number; vat: number }>();
  for (const item of items) {
    const rate = vatPayer ? item.vatRate || 0 : 0;
    const base = lineTotalWithoutVat(item);
    const vat = lineVatAmount(item, vatPayer);
    const curr = byRate.get(rate) || { base: 0, vat: 0 };
    curr.base = round2(curr.base + base);
    curr.vat = round2(curr.vat + vat);
    byRate.set(rate, curr);
  }
  const breakdown: VatBreakdownRow[] = Array.from(byRate.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([rate, v]) => ({
      rate,
      base: v.base,
      vat: v.vat,
      total: round2(v.base + v.vat),
    }));

  const totalWithoutVat = round2(breakdown.reduce((s, r) => s + r.base, 0));
  const totalVat = round2(breakdown.reduce((s, r) => s + r.vat, 0));
  const totalWithVat = round2(totalWithoutVat + totalVat);

  return { totalWithoutVat, totalVat, totalWithVat, breakdown };
}

export function daysUntilDue(dueDate: string): number | null {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  const [y, m, d] = dueDate.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

export function isInvoiceOverdue(invoice: Invoice): boolean {
  if (invoice.status !== 'ISSUED') return false;
  const diff = daysUntilDue(invoice.dueDate);
  return diff !== null && diff < 0;
}

export function isInvoiceDueSoon(invoice: Invoice): boolean {
  if (invoice.status !== 'ISSUED') return false;
  const diff = daysUntilDue(invoice.dueDate);
  return diff !== null && diff >= 0 && diff <= 3;
}

export function needsRestockAlert(item: InventoryItem): boolean {
  return item.quantity <= 0 || (item.minQuantity > 0 && item.quantity <= item.minQuantity);
}

/**
 * Converts Czech bank account "prefix-number/bankCode" or "number/bankCode" to ISO 13616 Czech IBAN.
 * Exact port of czechAccountToIban() from AresApiService.kt.
 */
export function czechAccountToIban(bankAccount: string): string | null {
  const trimmed = bankAccount.replace(/\s+/g, '').trim();
  if (trimmed.toUpperCase().startsWith('CZ') && trimmed.length === 24) {
    return trimmed.toUpperCase();
  }
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const bankCode = parts[1].replace(/\D/g, '');
  if (bankCode.length !== 4) return null;

  const numParts = parts[0].split('-');
  let prefix = '';
  let accNum = '';
  if (numParts.length === 1) {
    accNum = numParts[0].replace(/\D/g, '');
  } else if (numParts.length === 2) {
    prefix = numParts[0].replace(/\D/g, '');
    accNum = numParts[1].replace(/\D/g, '');
  } else {
    return null;
  }

  if (!accNum || accNum.length > 10 || prefix.length > 6) return null;
  const bban = bankCode.padStart(4, '0') + prefix.padStart(6, '0') + accNum.padStart(10, '0');
  const rearranged = `${bban}123500`;
  const remainder = Number(BigInt(rearranged) % 97n);
  const checkDigits = String(98 - remainder).padStart(2, '0');
  return `CZ${checkDigits}${bban}`;
}

/**
 * Generates Czech Short Payment Descriptor (SPayd / QR Platba 1.0).
 */
export function buildCzechSpdQr(params: {
  iban: string;
  amount: number;
  variableSymbol: string;
  message: string;
  dueDate?: string;
  currency?: string;
}): string | null {
  const converted = czechAccountToIban(params.iban) || params.iban;
  const cleanIban = converted.replace(/\s+/g, '').toUpperCase();
  if (cleanIban.length < 15) return null;

  const amount = Math.max(0, params.amount).toFixed(2);
  const vs = params.variableSymbol.replace(/\D/g, '').slice(0, 10);
  const currency = (params.currency || 'CZK').trim().toUpperCase().slice(0, 3) || 'CZK';
  const msg = params.message
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, ' ')
    .slice(0, 60);

  const parts = ['SPD*1.0', `ACC:${cleanIban}`, `AM:${amount}`, `CC:${currency}`];
  if (vs) parts.push(`X-VS:${vs}`);
  if (params.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(params.dueDate)) {
    parts.push(`DT:${params.dueDate.replace(/-/g, '')}`);
  }
  if (msg) parts.push(`MSG:${msg}`);
  return parts.join('*');
}

function escXml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function mapPohodaVat(rate: number): string {
  if (rate === 21) return 'high';
  if (rate === 12) return 'low';
  return 'none';
}

function mapPohodaPayment(method: string): string {
  if (method === 'CASH') return 'cash';
  if (method === 'CARD') return 'creditcard';
  return 'draft';
}

/**
 * Exact port of PohodaXmlExporter.kt — Stormware POHODA XML DataPack v2.0.
 */
export function generatePohodaDataPackXml(params: {
  company: Company;
  invoices: Invoice[];
  inventory: InventoryItem[];
  warehouses: Warehouse[];
  scope: PohodaExportScope;
}): string {
  const { company, invoices, inventory, warehouses, scope } = params;
  const whMap = new Map(warehouses.map((w) => [w.id, w]));
  const ico = company.ico.replace(/\D/g, '') || '00000000';
  const packId = `SF-${Date.now() % 1000000}`;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<dat:dataPack version="2.0" id="${escXml(packId)}" ico="${escXml(ico)}" application="SkladFaktura" note="Export z aplikace SkladFaktura (${escXml(company.name)})" xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd" xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd" xmlns:stk="http://www.stormware.cz/schema/version_2/stock.xsd" xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">`,
  ];

  let idx = 1;

  if (scope === 'INVOICES' || scope === 'BOTH') {
    for (const inv of invoices.filter((i) => i.status !== 'CANCELLED')) {
      lines.push(`  <dat:dataPackItem id="INV-${idx++}" version="2.0">`);
      lines.push('    <inv:invoice version="2.0">');
      lines.push('      <inv:invoiceHeader>');
      lines.push('        <inv:invoiceType>issuedInvoice</inv:invoiceType>');
      lines.push(`        <inv:number><typ:numberRequested>${escXml(inv.invoiceNumber)}</typ:numberRequested></inv:number>`);
      if (inv.variableSymbol) {
        lines.push(`        <inv:symVar>${escXml(inv.variableSymbol)}</inv:symVar>`);
      }
      lines.push(`        <inv:date>${escXml(inv.issueDate)}</inv:date>`);
      if (inv.taxDate) lines.push(`        <inv:dateTax>${escXml(inv.taxDate)}</inv:dateTax>`);
      lines.push(`        <inv:dateDue>${escXml(inv.dueDate)}</inv:dateDue>`);
      lines.push(`        <inv:text>Faktura ${escXml(inv.invoiceNumber)}</inv:text>`);
      lines.push(`        <inv:paymentType><typ:paymentType>${mapPohodaPayment(inv.paymentMethod)}</typ:paymentType></inv:paymentType>`);
      lines.push('        <inv:myIdentity><typ:address>');
      lines.push(`          <typ:company>${escXml(inv.companyName)}</typ:company>`);
      if (company.street) lines.push(`          <typ:street>${escXml(company.street)}</typ:street>`);
      if (company.city) lines.push(`          <typ:city>${escXml(company.city)}</typ:city>`);
      if (company.zip) lines.push(`          <typ:zip>${escXml(company.zip)}</typ:zip>`);
      if (inv.companyIco) lines.push(`          <typ:ico>${escXml(inv.companyIco)}</typ:ico>`);
      if (inv.companyDic) lines.push(`          <typ:dic>${escXml(inv.companyDic)}</typ:dic>`);
      lines.push('        </typ:address></inv:myIdentity>');
      lines.push('        <inv:partnerIdentity><typ:address>');
      lines.push(`          <typ:company>${escXml(inv.clientName)}</typ:company>`);
      if (inv.clientStreet) lines.push(`          <typ:street>${escXml(inv.clientStreet)}</typ:street>`);
      if (inv.clientCity) lines.push(`          <typ:city>${escXml(inv.clientCity)}</typ:city>`);
      if (inv.clientZip) lines.push(`          <typ:zip>${escXml(inv.clientZip)}</typ:zip>`);
      if (inv.clientIco) lines.push(`          <typ:ico>${escXml(inv.clientIco)}</typ:ico>`);
      if (inv.clientDic) lines.push(`          <typ:dic>${escXml(inv.clientDic)}</typ:dic>`);
      lines.push('        </typ:address></inv:partnerIdentity>');
      if (inv.note) lines.push(`        <inv:note>${escXml(inv.note)}</inv:note>`);
      lines.push('      </inv:invoiceHeader>');
      lines.push('      <inv:invoiceDetail>');
      for (const line of inv.items) {
        lines.push('        <inv:invoiceItem>');
        lines.push(`          <inv:text>${escXml(line.name)}</inv:text>`);
        lines.push(`          <inv:quantity>${line.quantity.toFixed(2)}</inv:quantity>`);
        lines.push(`          <inv:unit>${escXml(line.unit)}</inv:unit>`);
        lines.push(`          <inv:rateVAT>${mapPohodaVat(line.vatRate)}</inv:rateVAT>`);
        lines.push(`          <inv:homeCurrency><typ:unitPrice>${line.unitPrice.toFixed(2)}</typ:unitPrice></inv:homeCurrency>`);
        if (line.sku) lines.push(`          <inv:code>${escXml(line.sku)}</inv:code>`);
        lines.push('        </inv:invoiceItem>');
      }
      lines.push('      </inv:invoiceDetail>');
      lines.push('      <inv:invoiceSummary>');
      lines.push('        <inv:homeCurrency>');
      lines.push(`          <typ:priceNone>${inv.items.filter((i) => i.vatRate === 0).reduce((s, i) => s + lineTotalWithoutVat(i), 0).toFixed(2)}</typ:priceNone>`);
      lines.push(`          <typ:priceLow>${inv.items.filter((i) => i.vatRate === 12).reduce((s, i) => s + lineTotalWithoutVat(i), 0).toFixed(2)}</typ:priceLow>`);
      lines.push(`          <typ:priceHigh>${inv.items.filter((i) => i.vatRate === 21).reduce((s, i) => s + lineTotalWithoutVat(i), 0).toFixed(2)}</typ:priceHigh>`);
      lines.push('        </inv:homeCurrency>');
      lines.push('      </inv:invoiceSummary>');
      lines.push('    </inv:invoice>');
      lines.push('  </dat:dataPackItem>');
    }
  }

  if (scope === 'STOCK' || scope === 'BOTH') {
    for (const stock of inventory) {
      const whCode = whMap.get(stock.warehouseId)?.code || 'SKLAD-SPOL';
      lines.push(`  <dat:dataPackItem id="STK-${idx++}" version="2.0">`);
      lines.push('    <stk:stock version="2.0">');
      lines.push('      <stk:stockHeader>');
      lines.push('        <stk:stockType>card</stk:stockType>');
      lines.push(`        <stk:code>${escXml(stock.sku)}</stk:code>`);
      if (stock.ean) lines.push(`        <stk:EAN>${escXml(stock.ean)}</stk:EAN>`);
      lines.push(`        <stk:name>${escXml(stock.name)}</stk:name>`);
      lines.push(`        <stk:unit>${escXml(stock.unit)}</stk:unit>`);
      lines.push(`        <stk:storage><typ:ids>${escXml(whCode)}</typ:ids></stk:storage>`);
      lines.push(`        <stk:purchasingRateVAT>${mapPohodaVat(stock.vatRate)}</stk:purchasingRateVAT>`);
      lines.push(`        <stk:sellingRateVAT>${mapPohodaVat(stock.vatRate)}</stk:sellingRateVAT>`);
      lines.push(`        <stk:count>${stock.quantity.toFixed(2)}</stk:count>`);
      lines.push(`        <stk:purchasingPrice>${stock.purchasePrice.toFixed(2)}</stk:purchasingPrice>`);
      lines.push(`        <stk:sellingPrice>${stock.salePrice.toFixed(2)}</stk:sellingPrice>`);
      if (stock.notes) lines.push(`        <stk:note>${escXml(stock.notes)}</stk:note>`);
      lines.push('      </stk:stockHeader>');
      lines.push('    </stk:stock>');
      lines.push('  </dat:dataPackItem>');
    }
  }

  lines.push('</dat:dataPack>');
  return lines.join('\r\n');
}

export function downloadTextFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function exportInventoryToCsv(
  items: InventoryItem[],
  warehouses: Warehouse[],
  companyName: string
): void {
  const whMap = new Map(warehouses.map((w) => [w.id, w.name]));
  const headers = [
    'SKU',
    'Název',
    'EAN',
    'Kategorie',
    'Sklad',
    'Množství',
    'Min. zásoba',
    'MJ',
    'Nákup bez DPH',
    'Prodej bez DPH',
    'DPH %',
    'Hodnota skladu',
    'Dodavatel',
  ];
  const esc = (v: string | number) => {
    const s = String(v ?? '');
    return s.includes(';') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const rows = items.map((i) =>
    [
      i.sku,
      i.name,
      i.ean,
      i.category,
      whMap.get(i.warehouseId) || i.warehouseId,
      i.quantity,
      i.minQuantity,
      i.unit,
      i.purchasePrice,
      i.salePrice,
      i.vatRate,
      round2(Math.max(0, i.quantity) * i.purchasePrice),
      i.supplierName,
    ]
      .map(esc)
      .join(';')
  );
  const safe = companyName.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase() || 'sklad';
  downloadTextFile(
    '\uFEFF' + [headers.join(';'), ...rows].join('\r\n'),
    `skladfaktura_${safe}_${toIsoDate()}.csv`,
    'text/csv;charset=utf-8;'
  );
}
