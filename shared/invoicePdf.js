/**
 * A4 invoice PDF shared by the browser download ("Stáhnout PDF") and
 * GET /api/b2b-webhook?action=invoice-pdf.
 *
 * The previous generator painted an HTML canvas (browser-only JPEG pages).
 * This module draws the same document with pdf-lib so Node and the browser
 * produce one vector PDF: supplier, customer, bank account, IBAN, QR Platba,
 * lines, VAT recap and totals — the content of the on-screen invoice.
 * Noto Sans (Latin subset, OFL) is embedded so Czech diacritics are not lost.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
import { buildCzechSpdQr, resolveSupplierPayment } from './czechPayment.js';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_BOTTOM = PAGE_H - 46;

const PALETTES = [
  { primary: '#047857', dark: '#064E3B', soft: '#ECFDF5', border: '#A7F3D0' },
  { primary: '#1D4ED8', dark: '#1E3A8A', soft: '#EFF6FF', border: '#BFDBFE' },
  { primary: '#B45309', dark: '#78350F', soft: '#FFFBEB', border: '#FDE68A' },
  { primary: '#7C3AED', dark: '#4C1D95', soft: '#F5F3FF', border: '#DDD6FE' },
  { primary: '#0F766E', dark: '#134E4A', soft: '#F0FDFA', border: '#99F6E4' },
  { primary: '#1E3F5E', dark: '#0F2942', soft: '#F1F5F9', border: '#CBD5E1' },
];

const REVERSE_CHARGE_LEGAL_TEXT =
  'Daň odvede zákazník (§ 92a zákona č. 235/2004 Sb., o DPH – režim přenesené daňové povinnosti).';

const INK = rgb(0.059, 0.09, 0.165);
const SLATE = rgb(0.2, 0.255, 0.333);
const MUTED = rgb(0.392, 0.455, 0.545);
const LINE = rgb(0.886, 0.91, 0.941);
const PAPER = rgb(0.973, 0.98, 0.988);
const WHITE = rgb(1, 1, 1);
const EMERALD = rgb(0.027, 0.471, 0.341);
const RED = rgb(0.725, 0.11, 0.11);

const czkFormatter = new Intl.NumberFormat('cs-CZ', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const qtyFormatter = new Intl.NumberFormat('cs-CZ', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function round2(value) {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(value) + 1e-10) * 100)) / 100;
}

function formatMoney(amount, currency = 'CZK') {
  const suffix = !currency || currency === 'CZK' ? 'Kč' : currency;
  const n = Number.isFinite(amount) ? amount : 0;
  return `${czkFormatter.format(n)} ${suffix}`;
}

function formatQty(value) {
  return qtyFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatDateCz(isoDate) {
  if (!isoDate) return '—';
  const parts = String(isoDate).split('-');
  if (parts.length < 3) return String(isoDate);
  return `${Number(parts[2])}. ${Number(parts[1])}. ${parts[0]}`;
}

function lineTotalWithoutVat(item) {
  const gross = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
  const disc = Math.min(100, Math.max(0, Number(item.discountPercent) || 0));
  return round2(gross * ((100 - disc) / 100));
}

function calculateInvoiceTotals(items, vatPayer) {
  const baseByRate = new Map();
  for (const item of items || []) {
    const rate = vatPayer ? Number(item.vatRate) || 0 : 0;
    const base = lineTotalWithoutVat(item);
    baseByRate.set(rate, round2((baseByRate.get(rate) || 0) + base));
  }
  const breakdown = Array.from(baseByRate.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([rate, base]) => {
      const vat = vatPayer && rate > 0 ? round2(base * (rate / 100)) : 0;
      return { rate, base, vat, total: round2(base + vat) };
    });
  const totalWithoutVat = round2(breakdown.reduce((s, r) => s + r.base, 0));
  const totalVat = round2(breakdown.reduce((s, r) => s + r.vat, 0));
  return {
    totalWithoutVat,
    totalVat,
    totalWithVat: round2(totalWithoutVat + totalVat),
    breakdown,
  };
}

function getDocumentTypeTitle(docType, vatPayer) {
  switch (docType) {
    case 'PROFORMA':
      return 'ZÁLOHOVÁ FAKTURA';
    case 'QUOTE':
      return 'CENOVÁ NABÍDKA';
    case 'CREDIT_NOTE':
      return vatPayer ? 'OPRAVNÝ DAŇOVÝ DOKLAD (DOBROPIS)' : 'DOBROPIS';
    case 'SIMPLIFIED':
      return vatPayer ? 'ZJEDNODUŠENÝ DAŇOVÝ DOKLAD' : 'PRODEJKA';
    default:
      return vatPayer ? 'FAKTURA – DAŇOVÝ DOKLAD' : 'FAKTURA';
  }
}

function getDocumentTypeShortLabel(docType) {
  switch (docType) {
    case 'PROFORMA':
      return 'Záloha';
    case 'QUOTE':
      return 'Nabídka';
    case 'CREDIT_NOTE':
      return 'Dobropis';
    case 'SIMPLIFIED':
      return 'Prodejka';
    default:
      return 'Faktura';
  }
}

function paymentLabel(method) {
  if (method === 'CASH') return 'Hotově';
  if (method === 'CARD') return 'Platební kartou';
  if (method === 'COD') return 'Dobírka';
  return 'Bankovním převodem';
}

function hexToRgb(hex) {
  const raw = String(hex || '').replace('#', '').trim();
  const h = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.padEnd(6, '0').slice(0, 6);
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return INK;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function paletteFor(company, override) {
  if (override && override.primary) return override;
  const len = PALETTES.length;
  const idx = (((Number(company && company.accentIndex) || 0) % len) + len) % len;
  return PALETTES[idx];
}

function pdfSafe(value) {
  return String(value ?? '')
    .replace(/\u202F/g, '\u00A0')
    .replace(/[^\u000A\u000D\u0020-\u024F\u00A0\u2010-\u2027\u20AC\u2212]/g, '');
}

function textWidth(font, text, size) {
  const clean = pdfSafe(text).replace(/[\r\n]+/g, ' ');
  if (!clean || !font) return 0;
  try {
    return font.widthOfTextAtSize(clean, size);
  } catch {
    return font.widthOfTextAtSize(clean.replace(/[^\x20-\x7E]/g, '?'), size);
  }
}

function wrapText(text, font, size, maxWidth) {
  const width = Math.max(8, maxWidth);
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    const pushLong = (word) => {
      let chunk = '';
      for (const ch of word) {
        const next = chunk + ch;
        if (textWidth(font, next, size) <= width) chunk = next;
        else {
          if (chunk) lines.push(chunk);
          chunk = ch;
        }
      }
      return chunk;
    };
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(font, candidate, size) <= width) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = textWidth(font, word, size) > width ? pushLong(word) : word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

function fitText(text, font, size, maxWidth) {
  let t = pdfSafe(text).replace(/[\r\n]+/g, ' ');
  if (textWidth(font, t, size) <= maxWidth) return t;
  while (t.length > 1 && textWidth(font, `${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveVatPayer(invoice, company) {
  if (num(invoice && invoice.totalVat) > 0) return true;
  if (company && typeof company.vatPayer === 'boolean') return Boolean(company.vatPayer);
  if (!company) return true;
  return Boolean(invoice && invoice.companyDic);
}

/**
 * @param {object} invoice
 * @param {object | null} company
 * @param {object | undefined} paletteOverride
 * @param {{ regular: Uint8Array | Buffer, bold: Uint8Array | Buffer }} fonts
 * @returns {Promise<Uint8Array>}
 */
export async function generateInvoicePdfBytes(invoice, company, paletteOverride, fonts) {
  if (!fonts || !fonts.regular || !fonts.bold) {
    throw new Error('Chybí vložené písmo pro PDF faktury.');
  }

  const docType = invoice.documentType || 'INVOICE';
  const isCredit = docType === 'CREDIT_NOTE';
  const isQuote = docType === 'QUOTE';
  const isProforma = docType === 'PROFORMA';
  const isSimplified = docType === 'SIMPLIFIED';
  const amountSign = isCredit ? -1 : 1;
  const vatPayer = resolveVatPayer(invoice, company);
  const showVat = vatPayer && !invoice.reverseCharge;
  const currency = String(invoice.currency || 'CZK').toUpperCase();
  const fxRate = currency !== 'CZK' && num(invoice.exchangeRate) > 0 ? num(invoice.exchangeRate) : 1;
  const showFx = currency !== 'CZK' && fxRate > 0;
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const totals = calculateInvoiceTotals(items, showVat);
  const totalWithoutVat = num(invoice.totalWithoutVat, totals.totalWithoutVat);
  const totalVat = num(invoice.totalVat, totals.totalVat);
  const totalWithVat = num(invoice.totalWithVat, totals.totalWithVat);
  const palette = paletteFor(company, paletteOverride);
  const template = String(invoice.invoiceTemplate || (company && company.invoiceTemplate) || 'CLASSIC');
  const theme = {
    id: template,
    primary: hexToRgb(palette.primary),
    dark: hexToRgb(palette.dark),
    soft: hexToRgb(palette.soft || '#F8FAFC'),
    border: hexToRgb(palette.border || '#E2E8F0'),
    banner: template === 'MODERN_BANNER',
    minimal: template === 'MINIMAL',
    sidebar: template === 'EXECUTIVE_SIDEBAR',
  };
  const payment = resolveSupplierPayment(invoice, company);
  const title = getDocumentTypeTitle(docType, vatPayer);
  const variableSymbol = String(invoice.variableSymbol || String(invoice.invoiceNumber || '').replace(/\D/g, '') || '');

  const allowQr = invoice.paymentMethod !== 'CASH' && !isQuote && !isCredit && Boolean(payment.supplierIban);
  const outstanding = Math.max(0, round2(totalWithVat - num(invoice.paidAmount)));
  const qrPayload = allowQr
    ? buildCzechSpdQr({
        iban: payment.supplierIban,
        amount: outstanding || totalWithVat,
        variableSymbol,
        message: `${getDocumentTypeShortLabel(docType)} ${invoice.invoiceNumber || ''}`,
        dueDate: invoice.dueDate,
        currency,
      })
    : null;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });

  const left0 = theme.sidebar ? 28 : 40;
  const right = 40;
  const pages = [];
  let page = null;
  let y = 0;

  const contentWidth = () => PAGE_W - left0 - right;

  const drawText = (target, text, x, top, size, font, color) => {
    const clean = pdfSafe(text).replace(/[\r\n]+/g, ' ');
    if (!clean) return;
    const opts = { x, y: PAGE_H - top - size, size, font, color: color || INK };
    try {
      target.drawText(clean, opts);
    } catch {
      target.drawText(clean.replace(/[^\x20-\x7E]/g, '?'), opts);
    }
  };

  const drawRight = (target, text, rightX, top, size, font, color) => {
    const clean = pdfSafe(text).replace(/[\r\n]+/g, ' ');
    const w = textWidth(font, clean, size);
    drawText(target, clean, rightX - w, top, size, font, color);
  };

  const drawRect = (target, x, top, w, h, color, border, borderWidth) => {
    if (w <= 0 || h <= 0) return;
    target.drawRectangle({
      x,
      y: PAGE_H - top - h,
      width: w,
      height: h,
      color: color || WHITE,
      borderColor: border,
      borderWidth: border ? borderWidth || 0.6 : 0,
    });
  };

  const drawHLine = (target, x1, x2, top, color, thickness) => {
    const yy = PAGE_H - top;
    target.drawLine({
      start: { x: x1, y: yy },
      end: { x: x2, y: yy },
      thickness: thickness || 0.7,
      color: color || LINE,
    });
  };

  const drawWrapped = (target, text, x, top, size, font, color, maxWidth, leading) => {
    const lines = wrapText(text, font, size, maxWidth);
    let cursor = top;
    for (const line of lines) {
      drawText(target, line, x, cursor, size, font, color);
      cursor += leading;
    }
    return cursor;
  };

  const drawChrome = (isFirst) => {
    if (theme.sidebar) drawRect(page, 0, 0, 12, PAGE_H, theme.dark);
    if (!theme.minimal && !(theme.banner && isFirst)) {
      drawRect(page, 0, 0, PAGE_W, 7, theme.primary);
    }
  };

  const newPage = (isFirst) => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    drawChrome(isFirst);
    y = isFirst ? (theme.minimal ? 32 : 24) : 22;
    if (!isFirst) {
      drawText(
        page,
        `${title}  č. ${invoice.invoiceNumber || ''} (pokračování)`,
        left0,
        y,
        9,
        bold,
        theme.minimal ? MUTED : theme.primary
      );
      y += 14;
      drawHLine(page, left0, PAGE_W - right, y, theme.minimal ? LINE : theme.primary, theme.minimal ? 0.6 : 1.2);
      y += 12;
    }
    return page;
  };

  const need = (height) => {
    if (y + height <= CONTENT_BOTTOM) return false;
    newPage(false);
    return true;
  };

  const drawQr = (target, payload, x, top, size) => {
    let symbol;
    try {
      symbol = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    } catch {
      return;
    }
    const count = symbol.modules.size;
    const quiet = 2;
    const moduleSize = size / (count + quiet * 2);
    drawRect(target, x, top, size, size, WHITE, LINE, 0.6);
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (!symbol.modules.get(row, col)) continue;
        const mx = x + (col + quiet) * moduleSize;
        const my = top + (row + quiet) * moduleSize;
        target.drawRectangle({
          x: mx,
          y: PAGE_H - my - moduleSize,
          width: moduleSize + 0.2,
          height: moduleSize + 0.2,
          color: INK,
        });
      }
    }
  };

  newPage(true);
  const W = contentWidth();

  if (theme.banner) {
    const bannerH = showFx ? 78 : 70;
    drawRect(page, left0, y, W, bannerH, theme.primary);
    drawText(page, title, left0 + 14, y + 12, 8, bold, WHITE);
    drawText(page, `č. ${invoice.invoiceNumber || ''}`, left0 + 14, y + 26, 16, bold, WHITE);
    drawText(page, invoice.companyName || (company && company.name) || '', left0 + 14, y + 48, 9, regular, WHITE);
    const totalLabel = isCredit ? 'Celkem k vrácení' : isQuote ? 'Nabídková cena' : 'Celkem k úhradě';
    drawRight(page, totalLabel, PAGE_W - right - 14, y + 12, 8, regular, WHITE);
    drawRight(page, formatMoney(amountSign * totalWithVat, currency), PAGE_W - right - 14, y + 26, 14, bold, WHITE);
    drawRight(
      page,
      `${isQuote ? 'Platnost do' : 'Splatnost'} ${formatDateCz(invoice.dueDate)}   VS ${variableSymbol}`,
      PAGE_W - right - 14,
      y + 48,
      8,
      regular,
      WHITE
    );
    y += bannerH + 14;
  } else {
    const meta = [
      ['Variabilní symbol', variableSymbol || '—'],
      ['Datum vystavení', formatDateCz(invoice.issueDate)],
    ];
    if (vatPayer && !isQuote && !isProforma && invoice.taxDate) {
      meta.push(['DUZP', formatDateCz(invoice.taxDate)]);
    }
    meta.push([isQuote ? 'Platnost nabídky do' : 'Datum splatnosti', formatDateCz(invoice.dueDate)]);
    if (showFx) meta.push(['Kurz ČNB', `1 ${currency} = ${fxRate} Kč`]);

    drawText(page, title, left0, y, 9, bold, theme.minimal ? MUTED : theme.primary);
    let metaTop = y;
    const metaX = PAGE_W - right - 210;
    for (const [label, value] of meta) {
      drawText(page, label, metaX, metaTop, 8, regular, MUTED);
      drawRight(page, value, PAGE_W - right, metaTop, 8, bold, INK);
      metaTop += 12;
    }
    y += 14;
    drawText(page, `č. ${invoice.invoiceNumber || ''}`, left0, y, 16, bold, INK);
    y += 22;
    if (invoice.relatedInvoiceNumber) {
      drawText(page, `Vázáno na doklad č. ${invoice.relatedInvoiceNumber}`, left0, y, 8, regular, MUTED);
      y += 12;
    }
    y = Math.max(y, metaTop) + 6;
    drawHLine(page, left0, PAGE_W - right, y, theme.minimal ? LINE : theme.primary, theme.minimal ? 0.6 : 1.6);
    y += 12;
  }

  if (isProforma) {
    const note = 'Tento doklad není daňovým dokladem. Daňový doklad (ostrá faktura) bude vystaven po připsání platby.';
    const lines = wrapText(note, regular, 8, W - 16);
    const h = 10 + lines.length * 11;
    drawRect(page, left0, y, W, h, PAPER, LINE, 0.6);
    let ty = y + 6;
    for (const line of lines) {
      drawText(page, line, left0 + 8, ty, 8, regular, SLATE);
      ty += 11;
    }
    y += h + 10;
  }

  if (isSimplified) {
    drawText(
      page,
      'Vystaveno dle § 30a zákona č. 235/2004 Sb. (do 10 000 Kč s DPH).',
      left0,
      y,
      8,
      regular,
      MUTED
    );
    y += 14;
  }

  const colGap = 12;
  const colW = (W - colGap) / 2;

  function partyRows(party) {
    const rows = [];
    rows.push({ text: party.name || '—', bold: true, size: 11, color: INK });
    if (party.address) rows.push({ text: party.address, size: 8, color: SLATE });
    if (party.ico) rows.push({ text: `IČO: ${party.ico}`, size: 8, color: SLATE });
    if (party.dic) rows.push({ text: `DIČ: ${party.dic}`, size: 8, color: SLATE });
    if (party.extra) rows.push({ text: party.extra, size: 8, color: MUTED });
    return rows;
  }

  function partyBlockHeight(rows, width) {
    let h = 28;
    for (const row of rows) {
      const font = row.bold ? bold : regular;
      const wrapped = wrapText(row.text, font, row.size, width - 16);
      h += wrapped.length * (row.bold ? 14 : 11);
    }
    return h;
  }

  function drawPartyCard(target, x, top, w, h, label, rows) {
    drawRect(target, x, top, w, h, theme.minimal ? WHITE : PAPER, LINE, 0.7);
    drawText(target, label.toUpperCase(), x + 8, top + 8, 7.5, bold, MUTED);
    let ty = top + 22;
    for (const row of rows) {
      const font = row.bold ? bold : regular;
      const wrapped = wrapText(row.text, font, row.size, w - 16);
      for (const line of wrapped) {
        drawText(target, line, x + 8, ty, row.size, font, row.color);
        ty += row.bold ? 14 : 11;
      }
    }
  }

  const clientAddress = [invoice.clientStreet, [invoice.clientZip, invoice.clientCity].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  const supplierRows = partyRows({
    name: invoice.companyName || (company && company.name) || '',
    address: invoice.companyAddress || '',
    ico: invoice.companyIco,
    dic: invoice.companyDic,
    extra: !vatPayer ? 'Neplátce DPH' : '',
  });
  const clientRows = partyRows({
    name: invoice.clientName || 'Konečný zákazník',
    address: clientAddress,
    ico: invoice.clientIco,
    dic: invoice.clientDic,
    extra: invoice.clientEmail ? `E-mail: ${invoice.clientEmail}` : '',
  });
  const partyH = Math.max(partyBlockHeight(supplierRows, colW), partyBlockHeight(clientRows, colW));
  need(partyH + 8);
  drawPartyCard(page, left0, y, colW, partyH, 'Dodavatel', supplierRows);
  drawPartyCard(page, left0 + colW + colGap, y, colW, partyH, 'Odběratel', clientRows);
  y += partyH + 12;

  if (!isQuote) {
    const qrSize = qrPayload ? 64 : 0;
    const qrGap = qrSize ? qrSize + 18 : 0;
    const textW = W - 20 - qrGap;
    const fieldW = textW / 3;
    const ibanLines = payment.supplierIban ? wrapText(payment.supplierIban, regular, 8, textW) : [];
    const textH = 32 + (ibanLines.length ? 16 + ibanLines.length * 11 : 0);
    const qrBlockH = qrSize ? qrSize + 16 : 0;
    const boxH = Math.max(textH, qrBlockH) + 16;
    need(boxH + 8);
    drawRect(page, left0, y, W, boxH, theme.minimal ? WHITE : theme.soft, theme.minimal ? LINE : theme.border, 0.8);
    const fields = [
      ['Způsob úhrady', paymentLabel(invoice.paymentMethod)],
      ['Bankovní účet', payment.supplierAccount || '—'],
      ['Variabilní symbol', variableSymbol || '—'],
    ];
    fields.forEach(([label, value], i) => {
      const fx = left0 + 8 + i * fieldW;
      drawText(page, label, fx, y + 8, 7.5, regular, MUTED);
      drawText(page, fitText(value, bold, 9, fieldW - 8), fx, y + 18, 9, bold, INK);
    });
    if (ibanLines.length) {
      drawText(page, 'IBAN', left0 + 8, y + 34, 7.5, regular, MUTED);
      let iy = y + 44;
      for (const line of ibanLines) {
        drawText(page, line, left0 + 8, iy, 8, regular, SLATE);
        iy += 11;
      }
    }
    if (qrPayload) {
      const qx = left0 + W - 12 - qrSize;
      drawQr(page, qrPayload, qx, y + 10, qrSize);
      const qrLabel = 'QR Platba';
      const labelW = textWidth(bold, qrLabel, 7);
      drawText(page, qrLabel, qx + Math.max(0, (qrSize - labelW) / 2), y + 12 + qrSize, 7, bold, INK);
    }
    y += boxH + 12;
  }

  const columns = tableColumns(W, showVat);
  const drawTableHeader = () => {
    need(18);
    drawTextRowLabels();
    y += 12;
    drawHLine(page, left0, PAGE_W - right, y, theme.minimal ? LINE : theme.primary, theme.minimal ? 0.6 : 1.4);
    y += 6;
  };
  const drawTextRowLabels = () => {
    let x = left0;
    for (const col of columns) {
      const label = col.label;
      if (col.align === 'right') drawRight(page, label, x + col.w - 2, y, 7.5, bold, MUTED);
      else drawText(page, label, x + 2, y, 7.5, bold, MUTED);
      x += col.w;
    }
  };
  drawTableHeader();

  items.forEach((item) => {
    const nameFontSize = 9;
    const nameLines = wrapText(item.name || 'Položka', regular, nameFontSize, columns[0].w - 6);
    const sku = String(item.sku || '').trim();
    const rowH = 6 + nameLines.length * 11 + (sku ? 10 : 0) + 4;
    if (y + rowH > CONTENT_BOTTOM) {
      newPage(false);
      drawTableHeader();
    }
    let x = left0;
    let ny = y + 3;
    for (const line of nameLines) {
      drawText(page, line, x + 2, ny, nameFontSize, regular, INK);
      ny += 11;
    }
    if (sku) drawText(page, sku, x + 2, ny, 7, regular, MUTED);
    const net = lineTotalWithoutVat(item);
    const cells = {
      qty: `${isCredit ? '−' : ''}${formatQty(num(item.quantity))} ${item.unit || ''}`.trim(),
      price: formatMoney(num(item.unitPrice), currency),
      disc: num(item.discountPercent) > 0 ? `${num(item.discountPercent)} %` : '—',
      vat: showVat ? `${num(item.vatRate)} %` : '',
      total: formatMoney(amountSign * net, currency),
    };
    x = left0;
    for (const col of columns) {
      if (col.key !== 'name') {
        const value = cells[col.key] || '';
        drawRight(page, value, x + col.w - 2, y + 3, 8.5, col.key === 'total' ? bold : regular, col.key === 'disc' ? MUTED : INK);
      }
      x += col.w;
    }
    y += rowH;
    drawHLine(page, left0, PAGE_W - right, y, LINE, 0.4);
  });
  y += 12;

  const rawNotice = String(
    invoice.legalNotice || (invoice.reverseCharge ? REVERSE_CHARGE_LEGAL_TEXT : '')
  ).trim();
  if (rawNotice) {
    const noticeLines = rawNotice.split('\n').map((l) => l.trim()).filter(Boolean);
    const body = noticeLines.length === 1 ? `Zákonná doložka: ${noticeLines[0]}` : noticeLines.map((l) => `• ${l}`).join('\n');
    const heading = noticeLines.length > 1 ? 'Zákonné doložky a povinnosti:' : '';
    const wrapped = [
      ...(heading ? wrapText(heading, bold, 8, W - 16) : []),
      ...wrapText(body, regular, 8, W - 16),
    ];
    const h = 10 + wrapped.length * 11;
    need(h + 8);
    drawRect(page, left0, y, W, h, PAPER, LINE, 0.6);
    let ty = y + 6;
    wrapped.forEach((line, i) => {
      const font = heading && i === 0 ? bold : regular;
      drawText(page, line, left0 + 8, ty, 8, font, i === 0 && heading ? INK : SLATE);
      ty += 11;
    });
    y += h + 10;
  }

  const summaryH = 28 + (showVat ? 16 : 0) + 22 + (invoice.status === 'PAID' || invoice.status === 'CANCELLED' ? 14 : 0);
  const sumW = 198;
  const sumX = PAGE_W - right - sumW;
  const leftW = Math.max(160, sumX - left0 - 18);
  const breakdownH = showVat && totals.breakdown.length
    ? 16 + 12 + totals.breakdown.length * 12
    : 0;
  const fxLines = showFx
    ? [
        `Přepočet do CZK (kurz ${fxRate} Kč/${currency})`,
        `Základ: ${formatMoney(amountSign * round2(totalWithoutVat * fxRate), 'CZK')}`,
        ...(showVat ? [`DPH: ${formatMoney(amountSign * round2(totalVat * fxRate), 'CZK')}`] : []),
        `Celkem: ${formatMoney(amountSign * round2(totalWithVat * fxRate), 'CZK')}`,
      ]
    : [];
  const noteText = String(invoice.note || '').trim();
  const noteLines = noteText ? wrapText(noteText, regular, 8, leftW) : [];
  const noteH = noteLines.length ? 16 + noteLines.length * 11 : 0;
  const fxH = fxLines.length ? 8 + fxLines.length * 11 : 0;
  const leftBlockH = breakdownH + fxH + noteH;
  const blockH = Math.max(summaryH, leftBlockH) + 4;
  need(blockH);

  if (showVat && totals.breakdown.length) {
    const colSazba = left0;
    const colBase = left0 + leftW * 0.42;
    const colVat = left0 + leftW * 0.68;
    const colGross = left0 + leftW;
    drawText(page, 'Rekapitulace DPH', left0, y, 8, bold, MUTED);
    let by = y + 14;
    drawText(page, 'Sazba', colSazba, by, 7, bold, MUTED);
    drawRight(page, 'Základ', colBase, by, 7, bold, MUTED);
    drawRight(page, 'DPH', colVat, by, 7, bold, MUTED);
    drawRight(page, 'Celkem s DPH', colGross, by, 7, bold, MUTED);
    by += 11;
    for (const row of totals.breakdown) {
      drawText(page, `${row.rate} %`, colSazba, by, 8, regular, SLATE);
      drawRight(page, formatMoney(amountSign * row.base, currency), colBase, by, 8, regular, SLATE);
      drawRight(page, formatMoney(amountSign * row.vat, currency), colVat, by, 8, regular, SLATE);
      drawRight(page, formatMoney(amountSign * row.total, currency), colGross, by, 8, bold, INK);
      by += 12;
    }
  }

  if (fxLines.length) {
    const fxTop = y + breakdownH + 4;
    fxLines.forEach((line, i) => {
      drawText(
        page,
        fitText(line, i === 0 || i === fxLines.length - 1 ? bold : regular, 7.5, leftW),
        left0,
        fxTop + i * 11,
        7.5,
        i === 0 || i === fxLines.length - 1 ? bold : regular,
        i === 0 ? MUTED : INK
      );
    });
  }

  if (noteLines.length) {
    const noteTop = y + breakdownH + fxH + 2;
    drawText(page, 'Poznámka:', left0, noteTop, 8, bold, INK);
    let ny = noteTop + 12;
    for (const line of noteLines) {
      drawText(page, line, left0, ny, 8, regular, SLATE);
      ny += 11;
    }
  }

  drawRect(page, sumX, y, sumW, summaryH, PAPER, LINE, 0.7);
  let sy = y + 8;
  drawText(page, 'Základ bez DPH', sumX + 8, sy, 8, regular, SLATE);
  drawRight(page, formatMoney(amountSign * totalWithoutVat, currency), sumX + sumW - 8, sy, 8, regular, INK);
  sy += 14;
  if (showVat) {
    drawText(page, 'DPH celkem', sumX + 8, sy, 8, regular, SLATE);
    drawRight(page, formatMoney(amountSign * totalVat, currency), sumX + sumW - 8, sy, 8, regular, INK);
    sy += 14;
  }
  drawHLine(page, sumX + 8, sumX + sumW - 8, sy + 2, theme.primary, 1);
  sy += 8;
  const grandLabel = isCredit ? 'Celkem k vrácení' : isQuote ? 'Celkem nabídka' : 'Celkem k úhradě';
  drawText(page, grandLabel, sumX + 8, sy, 8, bold, theme.dark);
  drawRight(page, formatMoney(amountSign * totalWithVat, currency), sumX + sumW - 8, sy, 9, bold, theme.dark);
  if (invoice.status === 'PAID') {
    drawRight(
      page,
      `${isCredit ? 'Vypořádáno' : 'Uhrazeno'}${invoice.paidDate ? ` ${formatDateCz(invoice.paidDate)}` : ''}`,
      sumX + sumW - 8,
      sy + 14,
      7.5,
      bold,
      EMERALD
    );
  } else if (invoice.status === 'CANCELLED') {
    drawRight(page, 'STORNOVÁNO', sumX + sumW - 8, sy + 14, 8, bold, RED);
  }

  const companyName = invoice.companyName || (company && company.name) || '';
  pages.forEach((p, index) => {
    const footer = fitText(
      `Vygenerováno systémem SkladFaktura  ·  ${companyName}  ·  Strana ${index + 1}`,
      regular,
      8,
      PAGE_W - left0 - right
    );
    drawText(p, footer, left0, PAGE_H - 28, 8, regular, rgb(0.58, 0.64, 0.72));
  });

  pdf.setTitle(pdfSafe(`Faktura ${invoice.invoiceNumber || ''}`).slice(0, 120));
  pdf.setAuthor(pdfSafe(companyName).slice(0, 120));
  pdf.setCreator('SkladFaktura');
  pdf.setProducer('SkladFaktura');

  const bytes = await pdf.save();
  return new Uint8Array(bytes);
}

function tableColumns(width, showVat) {
  const qty = 68;
  const price = 72;
  const disc = 40;
  const vat = showVat ? 36 : 0;
  const total = 84;
  const name = Math.max(80, width - qty - price - disc - vat - total);
  const cols = [
    { key: 'name', label: 'POLOŽKA', w: name, align: 'left' },
    { key: 'qty', label: 'MNOŽSTVÍ', w: qty, align: 'right' },
    { key: 'price', label: 'CENA / MJ', w: price, align: 'right' },
    { key: 'disc', label: 'SLEVA', w: disc, align: 'right' },
  ];
  if (showVat) cols.push({ key: 'vat', label: 'DPH', w: vat, align: 'right' });
  cols.push({ key: 'total', label: showVat ? 'BEZ DPH' : 'CELKEM', w: total, align: 'right' });
  return cols;
}
