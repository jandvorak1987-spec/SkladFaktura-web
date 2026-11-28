import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cachedFonts = null;

/**
 * Noto Sans subsets (OFL-1.1) embedded so server-side invoice PDFs render Czech diacritics.
 * Files live next to this module so the Vercel function trace includes them.
 */
export function loadNodeInvoiceFonts() {
  if (cachedFonts) return cachedFonts;
  const regular = readFileSync(
    fileURLToPath(new URL('./fonts/NotoSans-Regular.subset.ttf', import.meta.url))
  );
  const bold = readFileSync(
    fileURLToPath(new URL('./fonts/NotoSans-Bold.subset.ttf', import.meta.url))
  );
  cachedFonts = { regular, bold };
  return cachedFonts;
}
