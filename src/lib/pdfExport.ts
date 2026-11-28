/**
 * Browser PDF helpers.
 * Invoices use shared/invoicePdf.js (vector PDF, embedded Noto Sans) so the
 * download button and the B2B webhook emit the same file.
 * Inventory audits and the cashbook stay on the canvas JPEG renderer.
 */

import regularFontUrl from '../../shared/fonts/NotoSans-Regular.subset.ttf';
import boldFontUrl from '../../shared/fonts/NotoSans-Bold.subset.ttf';
import { generateInvoicePdfBytes as generateSharedInvoicePdfBytes } from '../../shared/invoicePdf.js';
import type { Company, CompanyBrandPalette, Invoice } from '../types';
import { formatCzk, formatDateCz, formatQty, getCompanyPalette } from './format';

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

let invoiceFontPromise: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;

function loadBrowserInvoiceFonts(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  if (!invoiceFontPromise) {
    invoiceFontPromise = Promise.all([
      fetch(regularFontUrl).then((response) => {
        if (!response.ok) throw new Error('Nepodařilo se načíst písmo faktury.');
        return response.arrayBuffer();
      }),
      fetch(boldFontUrl).then((response) => {
        if (!response.ok) throw new Error('Nepodařilo se načíst tučné písmo faktury.');
        return response.arrayBuffer();
      }),
    ]).then(([regular, bold]) => ({
      regular: new Uint8Array(regular),
      bold: new Uint8Array(bold),
    }));
  }
  return invoiceFontPromise;
}

/**
 * A4 invoice PDF. Same generator as GET /api/b2b-webhook?action=invoice-pdf
 * (supplier, account, IBAN, QR Platba, lines, VAT). Returns a tight Uint8Array.
 */
export async function generateInvoicePdfBytes(
  invoice: Invoice,
  company: Company | null,
  paletteOverride?: CompanyBrandPalette
): Promise<Uint8Array> {
  const fonts = await loadBrowserInvoiceFonts();
  const bytes = await generateSharedInvoicePdfBytes(invoice, company, paletteOverride, fonts);
  return new Uint8Array(bytes);
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
