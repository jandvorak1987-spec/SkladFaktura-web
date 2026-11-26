import {
  applyLiveCnbRateToNote,
  parseInvoiceFromTextLines,
  parseXmlInvoice,
} from './localInvoiceParser';
import type { ExtractedDeliveryNote } from '../types';

let pdfjsLoaderPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function getPdfJs() {
  if (!pdfjsLoaderPromise) {
    pdfjsLoaderPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([pdfjsLib, workerMod]) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerMod.default;
      return pdfjsLib;
    });
  }
  return pdfjsLoaderPromise;
}

export type LocalExtractionMethod = 'ISDOC_XML' | 'POHODA_XML' | 'PDF_TEXT' | 'LOCAL_OCR' | 'TEXT';

export interface LocalExtractionResult {
  note: ExtractedDeliveryNote;
  rawText: string;
  method: LocalExtractionMethod;
}

interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

/**
 * Groups PDF.js text items by visual Y coordinate and orders columns left-to-right,
 * inserting double-spaces when horizontal gaps indicate separate table columns.
 */
function reconstructPdfPageLines(items: PositionedItem[]): string[] {
  const nonEmpty = items.filter((i) => i.str && i.str.trim().length > 0);
  if (nonEmpty.length === 0) return [];

  // Sort top-to-bottom (higher Y first in PDF coordinate space)
  nonEmpty.sort((a, b) => b.y - a.y || a.x - b.x);

  const rows: PositionedItem[][] = [];
  const yTolerance = 3.5;

  for (const item of nonEmpty) {
    const lastRow = rows[rows.length - 1];
    if (lastRow && Math.abs(lastRow[0].y - item.y) <= yTolerance) {
      lastRow.push(item);
    } else {
      rows.push([item]);
    }
  }

  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let line = '';
    for (let i = 0; i < row.length; i++) {
      const curr = row[i];
      if (i > 0) {
        const prev = row[i - 1];
        const gap = curr.x - (prev.x + prev.width);
        if (gap > 14) {
          line += '   '; // Column separator
        } else if (gap > 2) {
          line += ' ';
        }
      }
      line += curr.str;
    }
    return line.trim();
  });
}

async function preprocessImageForOcr(file: File): Promise<HTMLCanvasElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Nepodařilo se načíst obrázek pro lokální OCR.'));
      el.src = objectUrl;
    });

    const maxDim = 2200;
    const scale = Math.min(1.5, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Nepodařilo se připravit plátno pro OCR.');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Light grayscale + contrast boost for sharper Czech invoice text recognition
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    const contrast = 1.25;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const boosted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
      d[i] = boosted;
      d[i + 1] = boosted;
      d[i + 2] = boosted;
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function runLocalTesseractOcr(
  sources: Array<HTMLCanvasElement | Blob | File>,
  onProgress?: (label: string) => void
): Promise<string[]> {
  onProgress?.('Načítám lokální OCR čtečku (čeština + angličtina)…');
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('ces+eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        const pct = Math.round(m.progress * 100);
        onProgress?.(`Lokální OCR rozpoznává text (${pct} %)…`);
      }
    },
  });

  try {
    const allLines: string[] = [];
    for (let idx = 0; idx < sources.length; idx++) {
      if (sources.length > 1) {
        onProgress?.(`Lokální OCR čte stranu ${idx + 1} z ${sources.length}…`);
      }
      const { data } = await worker.recognize(sources[idx]);
      const lines = (data.text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      allLines.push(...lines);
    }
    return allLines;
  } finally {
    await worker.terminate();
  }
}

export async function extractFileLocally(
  file: File,
  options?: { ownCompanyIco?: string; onProgress?: (label: string) => void }
): Promise<LocalExtractionResult> {
  const lower = file.name.toLowerCase();
  const onProgress = options?.onProgress;

  // 1. ISDOC / POHODA XML (100% přesné bez OCR)
  if (lower.endsWith('.xml') || lower.endsWith('.isdoc') || file.type.includes('xml')) {
    onProgress?.('Načítám elektronickou fakturu XML / ISDOC…');
    const xmlText = await file.text();
    const xmlParsed = parseXmlInvoice(xmlText);
    if (!xmlParsed) {
      throw new Error('XML soubor nemá platný formát ISDOC ani POHODA XML.');
    }
    const converted = await applyLiveCnbRateToNote(xmlParsed.note, xmlParsed.docRate);
    return {
      note: converted,
      rawText: xmlText.slice(0, 4000),
      method: xmlParsed.format,
    };
  }

  // 2. PDF (digitální textová vrstva přes PDF.js + automatický lokální OCR fallback pro skeny)
  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    onProgress?.('Čtu textovou vrstvu PDF lokálně v prohlížeči…');
    const [arrayBuffer, pdfjsLib] = await Promise.all([file.arrayBuffer(), getPdfJs()]);
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const allLines: string[] = [];
    const maxPages = Math.min(pdf.numPages, 10);

    for (let p = 1; p <= maxPages; p++) {
      const page = await pdf.getPage(p);
      const textContent = await page.getTextContent();
      const positioned: PositionedItem[] = [];
      for (const item of textContent.items) {
        if ('str' in item && item.str) {
          positioned.push({
            str: item.str,
            x: Number(item.transform?.[4] || 0),
            y: Number(item.transform?.[5] || 0),
            width: Number(item.width || 0),
          });
        }
      }
      allLines.push(...reconstructPdfPageLines(positioned));
    }

    const totalTextLen = allLines.join('').replace(/\s+/g, '').length;
    if (totalTextLen >= 40) {
      const { note, docRate } = parseInvoiceFromTextLines(allLines, {
        fileName: file.name,
        ownCompanyIco: options?.ownCompanyIco,
      });
      const converted = await applyLiveCnbRateToNote(note, docRate);
      return {
        note: converted,
        rawText: allLines.join('\n'),
        method: 'PDF_TEXT',
      };
    }

    // Scanned PDF (image-only) -> render pages to canvas and run local Tesseract OCR
    onProgress?.('PDF je naskenovaný obrázek — spouštím lokální OCR…');
    const canvases: HTMLCanvasElement[] = [];
    const scanPages = Math.min(pdf.numPages, 4);
    for (let p = 1; p <= scanPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        canvases.push(canvas);
      }
    }

    const ocrLines = await runLocalTesseractOcr(canvases, onProgress);
    const { note, docRate } = parseInvoiceFromTextLines(ocrLines, {
      fileName: file.name,
      ownCompanyIco: options?.ownCompanyIco,
    });
    const converted = await applyLiveCnbRateToNote(note, docRate);
    return {
      note: converted,
      rawText: ocrLines.join('\n'),
      method: 'LOCAL_OCR',
    };
  }

  // 3. Fotka / obrázek (JPG, PNG, WebP) -> lokální Tesseract OCR
  if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|tif|tiff)$/i.test(lower)) {
    onProgress?.('Připravuji obrázek pro lokální OCR…');
    const canvas = await preprocessImageForOcr(file);
    const ocrLines = await runLocalTesseractOcr([canvas], onProgress);
    const { note, docRate } = parseInvoiceFromTextLines(ocrLines, {
      fileName: file.name,
      ownCompanyIco: options?.ownCompanyIco,
    });
    const converted = await applyLiveCnbRateToNote(note, docRate);
    return {
      note: converted,
      rawText: ocrLines.join('\n'),
      method: 'LOCAL_OCR',
    };
  }

  throw new Error(
    'Nepodporovaný formát souboru. Nahrajte PDF, XML/ISDOC, fotku (JPG/PNG) nebo CSV.'
  );
}

export async function extractTextLocally(
  rawText: string,
  options?: { ownCompanyIco?: string }
): Promise<LocalExtractionResult> {
  const lines = rawText.split(/\r?\n/);
  const { note, docRate } = parseInvoiceFromTextLines(lines, {
    ownCompanyIco: options?.ownCompanyIco,
  });
  const converted = await applyLiveCnbRateToNote(note, docRate);
  return {
    note: converted,
    rawText,
    method: 'TEXT',
  };
}
