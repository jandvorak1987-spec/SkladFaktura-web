/**
 * Browser-native A4 PDF generator (PDF 1.4 with JPEG XObject pages rendered via HTML5 Canvas).
 * Produces crisp Czech diacritics (ěščřžýáíéůúňťď) with zero external dependencies,
 * suitable for downloading individual PDFs or bundling directly into a monthly accountant ZIP.
 */

import type { Company, CompanyBrandPalette, Invoice } from '../types';
import {
  calculateInvoiceTotals,
  formatCompanyAddress,
  formatCzk,
  formatDateCz,
  formatQty,
  getCompanyPalette,
  getDocumentTypeTitle,
  lineTotalWithoutVat,
} from './format';

// A4 at 150 DPI → 1240 x 1754 px (clean, sharp, compact ~85 KB/page JPEG)
const PAGE_W_PX = 1240;
const PAGE_H_PX = 1754;
const PDF_W_PT = 595.28;
const PDF_H_PT = 841.89;

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function canvasToJpegBytes(canvas: HTMLCanvasElement, quality = 0.86): Uint8Array {
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const base64 = dataUrl.split(',')[1] || '';
  return base64ToUint8Array(base64);
}

/**
 * Packs one or more A4 JPEG page buffers into a valid standard PDF 1.4 binary.
 */
function buildPdfFromJpegPages(pages: Uint8Array[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0]; // 1-indexed object table
  let bytePos = 0;

  const pushStr = (s: string) => {
    const b = encoder.encode(s);
    chunks.push(b);
    bytePos += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    chunks.push(b);
    bytePos += b.length;
  };
  const beginObj = (id: number) => {
    offsets[id] = bytePos;
    pushStr(`${id} 0 obj\n`);
  };

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  const pageCount = pages.length;
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // For each page i (0..pageCount-1):
  //   pageObj = 3 + i * 3
  //   imgObj  = 4 + i * 3
  //   cntObj  = 5 + i * 3
  beginObj(1);
  pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kidsRef = Array.from({ length: pageCount }, (_, i) => `${3 + i * 3} 0 R`).join(' ');
  beginObj(2);
  pushStr(`<< /Type /Pages /Kids [${kidsRef}] /Count ${pageCount} >>\nendobj\n`);

  for (let i = 0; i < pageCount; i++) {
    const pageObj = 3 + i * 3;
    const imgObj = 4 + i * 3;
    const cntObj = 5 + i * 3;
    const jpeg = pages[i];

    beginObj(pageObj);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_W_PT.toFixed(2)} ${PDF_H_PT.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${cntObj} 0 R >>\nendobj\n`
    );

    beginObj(imgObj);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${PAGE_W_PX} /Height ${PAGE_H_PX} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    );
    pushBytes(jpeg);
    pushStr('\nendstream\nendobj\n');

    const contentStream = `q\n${PDF_W_PT.toFixed(2)} 0 0 ${PDF_H_PT.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(contentStream);
    beginObj(cntObj);
    pushStr(`<< /Length ${contentBytes.length} >>\nstream\n`);
    pushBytes(contentBytes);
    pushStr('endstream\nendobj\n');
  }

  const totalObjs = 2 + pageCount * 3;
  const xrefPos = bytePos;
  pushStr(`xref\n0 ${totalObjs + 1}\n`);
  pushStr('0000000000 65535 f \n');
  for (let id = 1; id <= totalObjs; id++) {
    pushStr(`${String(offsets[id] || 0).padStart(10, '0')} 00000 n \n`);
  }
  pushStr(
    `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  );

  const out = new Uint8Array(bytePos);
  let cursor = 0;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.length;
  }
  return out;
}

function createPageCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W_PX;
  canvas.height = PAGE_H_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Nelze inicializovat 2D plátno pro PDF export.');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, PAGE_W_PX, PAGE_H_PX);
  ctx.textBaseline = 'top';
  return { canvas, ctx };
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const rawLines = String(text || '').split(/\r?\n/);
  const result: string[] = [];
  for (const raw of rawLines) {
    const words = raw.split(/\s+/);
    let current = '';
    for (const w of words) {
      const candidate = current ? `${current} ${w}` : w;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
      } else {
        if (current) result.push(current);
        current = w;
      }
    }
    if (current || raw === '') result.push(current);
  }
  return result;
}

function drawRight(ctx: CanvasRenderingContext2D, text: string, rightX: number, y: number) {
  const w = ctx.measureText(text).width;
  ctx.fillText(text, rightX - w, y);
}

function paymentLabel(method: string): string {
  if (method === 'CASH') return 'Hotově';
  if (method === 'CARD') return 'Platební kartou';
  return 'Bankovní převod';
}

/**
 * Generates a real A4 PDF file (Uint8Array) for any issued invoice, credit note,
 * proforma, quote, or simplified tax receipt (prodejka).
 */
export function generateInvoicePdfBytes(
  invoice: Invoice,
  company: Company | null,
  paletteOverride?: CompanyBrandPalette
): Uint8Array {
  const palette = paletteOverride || getCompanyPalette(company?.accentIndex);
  const vatPayer = Boolean(company?.vatPayer ?? invoice.companyDic);
  const effectiveVat = vatPayer && !invoice.reverseCharge;
  const totals = calculateInvoiceTotals(invoice.items || [], effectiveVat);
  const isSimplified = invoice.documentType === 'SIMPLIFIED';
  const cur = invoice.currency || 'CZK';
  const title = getDocumentTypeTitle(invoice.documentType, vatPayer);

  const pages: Uint8Array[] = [];
  let { canvas, ctx } = createPageCanvas();
  const M = 76;
  const W = PAGE_W_PX - M * 2;
  let y = 0;

  const drawHeader = (isContPage: boolean) => {
    // Accent bar
    ctx.fillStyle = palette.primary;
    ctx.fillRect(0, 0, PAGE_W_PX, 18);

    y = 56;
    ctx.fillStyle = palette.primary;
    ctx.font = 'bold 26px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText(title + (isContPage ? ' (pokračování)' : ''), M, y);

    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 28px system-ui, -apple-system, Segoe UI, sans-serif';
    drawRight(ctx, `č. ${invoice.invoiceNumber}`, PAGE_W_PX - M, y - 2);
    y += 44;

    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(M, y);
    ctx.lineTo(PAGE_W_PX - M, y);
    ctx.stroke();
    y += 24;
  };

  drawHeader(false);

  // Supplier & Client boxes
  const colGap = 36;
  const colW = (W - colGap) / 2;
  const boxTop = y;

  // Supplier (left)
  ctx.fillStyle = '#64748B';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillText('DODAVATEL', M, y);
  let ly = y + 26;
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 22px system-ui, sans-serif';
  for (const line of wrapText(ctx, invoice.companyName || company?.name || '', colW)) {
    ctx.fillText(line, M, ly);
    ly += 28;
  }
  ctx.fillStyle = '#334155';
  ctx.font = '18px system-ui, sans-serif';
  const supAddr = invoice.companyAddress || (company ? formatCompanyAddress(company) : '');
  if (supAddr) {
    for (const line of wrapText(ctx, supAddr, colW)) {
      ctx.fillText(line, M, ly);
      ly += 24;
    }
  }
  if (invoice.companyIco) {
    ctx.fillText(`IČO: ${invoice.companyIco}`, M, ly);
    ly += 24;
  }
  if (invoice.companyDic) {
    ctx.fillText(`DIČ: ${invoice.companyDic}`, M, ly);
    ly += 24;
  } else {
    ctx.fillText('Neplátce DPH', M, ly);
    ly += 24;
  }
  if (invoice.companyBankAccount && !isSimplified) {
    ctx.fillText(`Účet: ${invoice.companyBankAccount}`, M, ly);
    ly += 24;
  }

  // Client (right)
  const rx = M + colW + colGap;
  ctx.fillStyle = '#64748B';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillText(isSimplified ? 'ODBĚRATEL (ZJEDNODUŠENÝ DOKLAD)' : 'ODBĚRATEL', rx, boxTop);
  let ry = boxTop + 26;
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 22px system-ui, sans-serif';
  const clientName = invoice.clientName || 'Konečný zákazník (Prodejka)';
  for (const line of wrapText(ctx, clientName, colW)) {
    ctx.fillText(line, rx, ry);
    ry += 28;
  }
  ctx.fillStyle = '#334155';
  ctx.font = '18px system-ui, sans-serif';
  const clientAddr = [invoice.clientStreet, [invoice.clientZip, invoice.clientCity].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  if (clientAddr) {
    for (const line of wrapText(ctx, clientAddr, colW)) {
      ctx.fillText(line, rx, ry);
      ry += 24;
    }
  }
  if (invoice.clientIco) {
    ctx.fillText(`IČO: ${invoice.clientIco}`, rx, ry);
    ry += 24;
  }
  if (invoice.clientDic) {
    ctx.fillText(`DIČ: ${invoice.clientDic}`, rx, ry);
    ry += 24;
  }
  if (isSimplified) {
    ctx.fillStyle = '#64748B';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('Vystaveno dle § 30a zákona č. 235/2004 Sb. (do 10 000 Kč s DPH).', rx, ry + 4);
    ry += 26;
  }

  y = Math.max(ly, ry) + 22;

  // Metadata strip
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(M, y, W, 84);
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(M, y, W, 84);

  const metaCols = [
    ['Datum vystavení', formatDateCz(invoice.issueDate)],
    ['DUZP', formatDateCz(invoice.taxDate || invoice.issueDate)],
    ['Splatnost', formatDateCz(invoice.dueDate || invoice.issueDate)],
    ['Způsob úhrady', paymentLabel(invoice.paymentMethod)],
    ['Variabilní symbol', invoice.variableSymbol || invoice.invoiceNumber],
  ];
  const metaW = W / metaCols.length;
  metaCols.forEach(([lbl, val], i) => {
    const mx = M + i * metaW + 14;
    ctx.fillStyle = '#64748B';
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText(lbl, mx, y + 16);
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText(val, mx, y + 42);
  });
  y += 108;

  // Items table header
  const drawTableHeader = () => {
    ctx.fillStyle = palette.primary;
    ctx.fillRect(M, y, W, 42);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText('Položka', M + 12, y + 12);
    drawRight(ctx, 'Množství', M + W - 440, y + 12);
    drawRight(ctx, 'Cena/MJ', M + W - 300, y + 12);
    drawRight(ctx, 'DPH', M + W - 210, y + 12);
    drawRight(ctx, 'Bez DPH', M + W - 115, y + 12);
    drawRight(ctx, 'Celkem', M + W - 12, y + 12);
    y += 46;
  };
  drawTableHeader();

  // Table rows
  (invoice.items || []).forEach((item, idx) => {
    ctx.font = '17px system-ui, sans-serif';
    const nameLines = wrapText(ctx, item.name || 'Položka', W - 540);
    const rowH = Math.max(36, nameLines.length * 22 + 14);

    if (y + rowH > PAGE_H_PX - 280) {
      pages.push(canvasToJpegBytes(canvas));
      ({ canvas, ctx } = createPageCanvas());
      drawHeader(true);
      drawTableHeader();
    }

    if (idx % 2 === 1) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(M, y, W, rowH);
    }

    ctx.fillStyle = '#0F172A';
    ctx.font = '17px system-ui, sans-serif';
    nameLines.forEach((nl, li) => {
      ctx.fillText(nl, M + 12, y + 9 + li * 22);
    });

    const net = lineTotalWithoutVat(item);
    const rate = effectiveVat ? item.vatRate || 0 : 0;
    const gross = net + (net * rate) / 100;

    ctx.fillStyle = '#334155';
    drawRight(ctx, `${formatQty(item.quantity)} ${item.unit}`, M + W - 440, y + 9);
    drawRight(ctx, formatCzk(item.unitPrice, cur), M + W - 300, y + 9);
    drawRight(ctx, effectiveVat ? `${rate} %` : '0 %', M + W - 210, y + 9);
    drawRight(ctx, formatCzk(net, cur), M + W - 115, y + 9);
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 17px system-ui, sans-serif';
    drawRight(ctx, formatCzk(gross, cur), M + W - 12, y + 9);

    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M, y + rowH);
    ctx.lineTo(M + W, y + rowH);
    ctx.stroke();

    y += rowH;
  });

  y += 28;
  if (y > PAGE_H_PX - 340) {
    pages.push(canvasToJpegBytes(canvas));
    ({ canvas, ctx } = createPageCanvas());
    drawHeader(true);
  }

  // VAT breakdown & grand total box (right side)
  const sumW = 460;
  const sumX = M + W - sumW;
  let sy = y;

  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(sumX, sy, sumW, 38 + totals.breakdown.length * 28 + 64);
  ctx.strokeStyle = '#CBD5E1';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(sumX, sy, sumW, 38 + totals.breakdown.length * 28 + 64);

  ctx.fillStyle = '#475569';
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.fillText('Rekapitulace DPH (§ 37 ZDPH)', sumX + 14, sy + 12);
  sy += 38;

  ctx.font = '16px system-ui, sans-serif';
  for (const row of totals.breakdown) {
    ctx.fillStyle = '#334155';
    ctx.fillText(`Sazba ${row.rate} %`, sumX + 14, sy);
    drawRight(ctx, `Základ: ${formatCzk(row.base, cur)}`, sumX + sumW - 165, sy);
    drawRight(ctx, `DPH: ${formatCzk(row.vat, cur)}`, sumX + sumW - 14, sy);
    sy += 28;
  }

  ctx.fillStyle = palette.primary;
  ctx.fillRect(sumX, sy + 8, sumW, 52);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 20px system-ui, sans-serif';
  ctx.fillText(invoice.status === 'PAID' ? 'UHRAZENO CELKEM' : 'CELKEM K ÚHRADĚ', sumX + 14, sy + 22);
  ctx.font = 'bold 24px system-ui, sans-serif';
  drawRight(ctx, formatCzk(totals.totalWithVat, cur), sumX + sumW - 14, sy + 20);

  // Legal notice & notes (left side)
  const noteMaxW = W - sumW - 32;
  let ny = y;
  if (invoice.legalNotice) {
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 16px system-ui, sans-serif';
    ctx.fillText('Zákonná upozornění a doložky:', M, ny);
    ny += 24;
    ctx.fillStyle = '#334155';
    ctx.font = '15px system-ui, sans-serif';
    for (const line of wrapText(ctx, invoice.legalNotice, noteMaxW)) {
      ctx.fillText(line, M, ny);
      ny += 21;
    }
    ny += 12;
  }
  if (invoice.note) {
    ctx.fillStyle = '#475569';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText('Poznámka:', M, ny);
    ny += 22;
    ctx.font = '15px system-ui, sans-serif';
    for (const line of wrapText(ctx, invoice.note, noteMaxW)) {
      ctx.fillText(line, M, ny);
      ny += 20;
    }
  }

  // Footer
  ctx.fillStyle = '#94A3B8';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText(
    `Vygenerováno systémem SkladFaktura · ${invoice.companyName} · Strana ${pages.length + 1}`,
    M,
    PAGE_H_PX - 54
  );

  pages.push(canvasToJpegBytes(canvas));
  return buildPdfFromJpegPages(pages);
}

export interface InventoryAuditPdfRow {
  sku: string;
  ean: string;
  name: string;
  warehouseName: string;
  unit: string;
  systemQty: number;
  actualQty: number;
  delta: number;
  purchasePrice: number;
  valueDelta: number;
}

/**
 * Generates an official A4 Inventory Audit Protocol PDF ("Inventurní protokol").
 */
export function generateInventoryAuditPdfBytes(params: {
  company: Company | null;
  docRef: string;
  auditDate: string;
  warehouseLabel: string;
  auditorEmail: string;
  rows: InventoryAuditPdfRow[];
  totalCounted: number;
  shortageValue: number;
  surplusValue: number;
  netValue: number;
}): Uint8Array {
  const {
    company,
    docRef,
    auditDate,
    warehouseLabel,
    auditorEmail,
    rows,
    totalCounted,
    shortageValue,
    surplusValue,
    netValue,
  } = params;
  const palette = getCompanyPalette(company?.accentIndex);
  const pages: Uint8Array[] = [];
  let { canvas, ctx } = createPageCanvas();
  const M = 70;
  const W = PAGE_W_PX - M * 2;
  let y = 0;

  const drawHeader = (isCont: boolean) => {
    ctx.fillStyle = palette.primary;
    ctx.fillRect(0, 0, PAGE_W_PX, 18);
    y = 54;
    ctx.fillStyle = palette.primary;
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillText('INVENTURNÍ PROTOKOL SKLADU' + (isCont ? ' (pokračování)' : ''), M, y);
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 22px system-ui, sans-serif';
    drawRight(ctx, docRef, PAGE_W_PX - M, y + 2);
    y += 44;
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(M, y);
    ctx.lineTo(PAGE_W_PX - M, y);
    ctx.stroke();
    y += 22;
  };

  drawHeader(false);

  // Meta grid
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(M, y, W, 114);
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(M, y, W, 114);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText(company?.name || 'Společnost', M + 16, y + 16);
  ctx.fillStyle = '#475569';
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillText(
    `IČO: ${company?.ico || '—'} · DIČ: ${company?.dic || '—'}`,
    M + 16,
    y + 44
  );
  ctx.fillText(`Sklad: ${warehouseLabel} · Inventarizoval: ${auditorEmail || '—'}`, M + 16, y + 72);

  drawRight(ctx, `Datum inventury: ${formatDateCz(auditDate)}`, M + W - 16, y + 18);
  drawRight(ctx, `Spočítáno položek: ${totalCounted}`, M + W - 16, y + 46);
  drawRight(
    ctx,
    `Čistý rozdíl: ${netValue >= 0 ? '+' : ''}${formatCzk(netValue)}`,
    M + W - 16,
    y + 74
  );
  y += 136;

  // Summary boxes
  const boxW = (W - 32) / 3;
  const kpis: Array<[string, string, string]> = [
    ['Manko celkem (nákup)', formatCzk(shortageValue), '#DC2626'],
    ['Přebytek celkem (nákup)', `+${formatCzk(surplusValue)}`, '#047857'],
    ['Čistý inventurní rozdíl', `${netValue >= 0 ? '+' : ''}${formatCzk(netValue)}`, '#0F172A'],
  ];
  kpis.forEach(([label, val, color], i) => {
    const bx = M + i * (boxW + 16);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(bx, y, boxW, 74);
    ctx.strokeStyle = '#CBD5E1';
    ctx.strokeRect(bx, y, boxW, 74);
    ctx.fillStyle = '#64748B';
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillText(label, bx + 14, y + 14);
    ctx.fillStyle = color;
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText(val, bx + 14, y + 38);
  });
  y += 96;

  const drawTableHeader = () => {
    ctx.fillStyle = palette.primary;
    ctx.fillRect(M, y, W, 40);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText('SKU / EAN', M + 10, y + 12);
    ctx.fillText('Název položky', M + 210, y + 12);
    drawRight(ctx, 'Sklad', M + W - 360, y + 12);
    drawRight(ctx, 'Skutečnost', M + W - 260, y + 12);
    drawRight(ctx, 'Rozdíl', M + W - 165, y + 12);
    drawRight(ctx, 'Rozdíl Kč', M + W - 12, y + 12);
    y += 44;
  };
  drawTableHeader();

  rows.forEach((row, idx) => {
    ctx.font = '15px system-ui, sans-serif';
    const nameLines = wrapText(ctx, row.name, W - 640);
    const rowH = Math.max(36, nameLines.length * 20 + 14);

    if (y + rowH > PAGE_H_PX - 230) {
      pages.push(canvasToJpegBytes(canvas));
      ({ canvas, ctx } = createPageCanvas());
      drawHeader(true);
      drawTableHeader();
    }

    if (idx % 2 === 1) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(M, y, W, rowH);
    }

    ctx.fillStyle = '#475569';
    ctx.font = '14px monospace';
    ctx.fillText((row.sku || row.ean || '—').slice(0, 18), M + 10, y + 10);

    ctx.fillStyle = '#0F172A';
    ctx.font = '15px system-ui, sans-serif';
    nameLines.forEach((nl, li) => ctx.fillText(nl, M + 210, y + 9 + li * 20));

    ctx.fillStyle = '#475569';
    drawRight(ctx, `${formatQty(row.systemQty)} ${row.unit}`, M + W - 360, y + 9);
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 15px system-ui, sans-serif';
    drawRight(ctx, `${formatQty(row.actualQty)} ${row.unit}`, M + W - 260, y + 9);

    ctx.fillStyle = row.delta < 0 ? '#DC2626' : row.delta > 0 ? '#047857' : '#64748B';
    drawRight(
      ctx,
      `${row.delta > 0 ? '+' : ''}${formatQty(row.delta)} ${row.unit}`,
      M + W - 165,
      y + 9
    );
    drawRight(
      ctx,
      `${row.valueDelta > 0 ? '+' : ''}${formatCzk(row.valueDelta)}`,
      M + W - 12,
      y + 9
    );

    ctx.strokeStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(M, y + rowH);
    ctx.lineTo(M + W, y + rowH);
    ctx.stroke();

    y += rowH;
  });

  if (y > PAGE_H_PX - 210) {
    pages.push(canvasToJpegBytes(canvas));
    ({ canvas, ctx } = createPageCanvas());
    drawHeader(true);
  }

  // Signature block
  y += 56;
  ctx.strokeStyle = '#94A3B8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(M, y + 54);
  ctx.lineTo(M + 360, y + 54);
  ctx.moveTo(PAGE_W_PX - M - 360, y + 54);
  ctx.lineTo(PAGE_W_PX - M, y + 54);
  ctx.stroke();

  ctx.fillStyle = '#475569';
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillText('Inventuru provedl (podpis)', M, y + 64);
  ctx.fillText('Schválil jednatel / vedoucí skladu (podpis)', PAGE_W_PX - M - 360, y + 64);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText(
    `SkladFaktura · Inventurní protokol ${docRef} · Strana ${pages.length + 1}`,
    M,
    PAGE_H_PX - 54
  );

  pages.push(canvasToJpegBytes(canvas));
  return buildPdfFromJpegPages(pages);
}

export interface CashbookEntry {
  date: string;
  docNumber: string;
  partner: string;
  description: string;
  incomeCzk: number;
  expenseCzk: number;
}

/**
 * Generates an A4 Cashbook ("Pokladní kniha") PDF for the Monthly Accountant Pack.
 */
export function generateCashbookPdfBytes(params: {
  company: Company | null;
  monthKey: string;
  entries: CashbookEntry[];
  totalIncome: number;
  totalExpense: number;
}): Uint8Array {
  const { company, monthKey, entries, totalIncome, totalExpense } = params;
  const palette = getCompanyPalette(company?.accentIndex);
  const pages: Uint8Array[] = [];
  let { canvas, ctx } = createPageCanvas();
  const M = 70;
  const W = PAGE_W_PX - M * 2;
  let y = 0;

  const drawHeader = (isCont: boolean) => {
    ctx.fillStyle = palette.primary;
    ctx.fillRect(0, 0, PAGE_W_PX, 18);
    y = 54;
    ctx.fillStyle = palette.primary;
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillText(`POKLADNÍ KNIHA — ${monthKey}` + (isCont ? ' (pokračování)' : ''), M, y);
    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 20px system-ui, sans-serif';
    drawRight(ctx, company?.name || '', PAGE_W_PX - M, y + 4);
    y += 42;
    ctx.fillStyle = '#475569';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(
      `IČO: ${company?.ico || '—'} · DIČ: ${company?.dic || '—'} · Hotovostní doklady za období ${monthKey}`,
      M,
      y
    );
    y += 32;
  };

  drawHeader(false);

  const drawTableHeader = () => {
    ctx.fillStyle = palette.primary;
    ctx.fillRect(M, y, W, 40);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText('Datum', M + 10, y + 12);
    ctx.fillText('Doklad', M + 135, y + 12);
    ctx.fillText('Partner / Popis', M + 295, y + 12);
    drawRight(ctx, 'Příjem (Kč)', M + W - 170, y + 12);
    drawRight(ctx, 'Výdej (Kč)', M + W - 12, y + 12);
    y += 44;
  };
  drawTableHeader();

  if (entries.length === 0) {
    ctx.fillStyle = '#64748B';
    ctx.font = '18px system-ui, sans-serif';
    ctx.fillText('V tomto měsíci nebyly evidovány žádné hotovostní doklady.', M + 12, y + 24);
    y += 72;
  } else {
    entries.forEach((e, idx) => {
      const rowH = 38;
      if (y + rowH > PAGE_H_PX - 180) {
        pages.push(canvasToJpegBytes(canvas));
        ({ canvas, ctx } = createPageCanvas());
        drawHeader(true);
        drawTableHeader();
      }
      if (idx % 2 === 1) {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(M, y, W, rowH);
      }
      ctx.fillStyle = '#334155';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText(formatDateCz(e.date), M + 10, y + 10);
      ctx.font = 'bold 15px monospace';
      ctx.fillText(e.docNumber.slice(0, 16), M + 135, y + 10);
      ctx.fillStyle = '#0F172A';
      ctx.font = '15px system-ui, sans-serif';
      ctx.fillText(`${e.partner} — ${e.description}`.slice(0, 48), M + 295, y + 10);

      ctx.fillStyle = '#047857';
      ctx.font = 'bold 15px system-ui, sans-serif';
      drawRight(ctx, e.incomeCzk > 0 ? formatCzk(e.incomeCzk) : '—', M + W - 170, y + 10);
      ctx.fillStyle = '#DC2626';
      drawRight(ctx, e.expenseCzk > 0 ? formatCzk(e.expenseCzk) : '—', M + W - 12, y + 10);

      ctx.strokeStyle = '#E2E8F0';
      ctx.beginPath();
      ctx.moveTo(M, y + rowH);
      ctx.lineTo(M + W, y + rowH);
      ctx.stroke();
      y += rowH;
    });
  }

  y += 26;
  ctx.fillStyle = '#F1F5F9';
  ctx.fillRect(M, y, W, 62);
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 18px system-ui, sans-serif';
  ctx.fillText('SOUČET ZA MĚSÍC', M + 16, y + 20);
  ctx.fillStyle = '#047857';
  drawRight(ctx, `Příjmy: ${formatCzk(totalIncome)}`, M + W - 260, y + 20);
  ctx.fillStyle = '#0F172A';
  drawRight(ctx, `Bilance: ${formatCzk(totalIncome - totalExpense)}`, M + W - 16, y + 20);

  ctx.fillStyle = '#94A3B8';
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillText(`SkladFaktura · Pokladní kniha ${monthKey}`, M, PAGE_H_PX - 54);

  pages.push(canvasToJpegBytes(canvas));
  return buildPdfFromJpegPages(pages);
}

export function downloadPdfBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
