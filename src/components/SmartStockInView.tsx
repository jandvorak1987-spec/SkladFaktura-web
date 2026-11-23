import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  Cpu,
  Eye,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { matchExtractedToInventory, parseQuickStockCsv } from '../lib/bankParser';
import { commitBulkStockIn } from '../lib/firestoreService';
import { formatCzk, getCompanyPalette, round2 } from '../lib/format';
import {
  extractFileLocally,
  extractTextLocally,
  type LocalExtractionMethod,
} from '../lib/localDocumentReader';
import type { ExtractedDeliveryNote, ExtractedLineItem } from '../types';

type InputMode = 'FILE' | 'TEXT' | 'CSV';
type ProcessingEngine = 'LOCAL' | 'GEMINI';

const COMMON_CURRENCIES = ['CZK', 'EUR', 'USD', 'PLN', 'GBP', 'CHF', 'HUF'];

interface CnbRatesResponse {
  date: string;
  rates: Record<string, number>;
  source: 'CNB' | 'FALLBACK';
}

export function SmartStockInView() {
  const {
    workspace,
    activeCompany,
    accessibleWarehouses,
    inventory,
    extractAiDeliveryNote,
    notify,
  } = useApp();

  const palette = getCompanyPalette(activeCompany?.accentIndex);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<InputMode>('FILE');
  const [engine, setEngine] = useState<ProcessingEngine>('LOCAL');
  const [targetWarehouseId, setTargetWarehouseId] = useState<string>(
    accessibleWarehouses[0]?.id || 'shared_main'
  );
  const [rawText, setRawText] = useState('');
  const [csvText, setCsvText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [committing, setCommitting] = useState(false);
  const [loadingRate, setLoadingRate] = useState(false);
  const [lastFilePayload, setLastFilePayload] = useState<{
    base64Data: string;
    mimeType: string;
    fileName: string;
  } | null>(null);
  const [lastExtractError, setLastExtractError] = useState<string | null>(null);
  const [rawExtractedText, setRawExtractedText] = useState('');
  const [showRawText, setShowRawText] = useState(false);
  const [lastMethod, setLastMethod] = useState<LocalExtractionMethod | 'GEMINI' | null>(null);

  const [note, setNote] = useState<ExtractedDeliveryNote | null>(null);

  const effectiveWarehouseId = useMemo(() => {
    if (accessibleWarehouses.some((w) => w.id === targetWarehouseId)) return targetWarehouseId;
    return accessibleWarehouses[0]?.id || 'shared_main';
  }, [accessibleWarehouses, targetWarehouseId]);

  const applyExtractedNote = (raw: ExtractedDeliveryNote, whId: string) => {
    const currency = (raw.currency || 'CZK').toUpperCase();
    const exchangeRate = currency === 'CZK' ? 1 : Number(raw.exchangeRate || 1) || 1;
    const normalized: ExtractedDeliveryNote = {
      ...raw,
      currency,
      exchangeRate,
      exchangeRateSource: raw.exchangeRateSource || (currency === 'CZK' ? 'CZK' : 'MANUAL'),
      items: raw.items.map((item) => ({
        ...item,
        originalPurchasePrice:
          item.originalPurchasePrice !== undefined
            ? item.originalPurchasePrice
            : item.purchasePrice,
      })),
    };
    const matched = matchExtractedToInventory(normalized, inventory, whId);
    setNote(matched);
  };

  const recalcNotePrices = (
    current: ExtractedDeliveryNote,
    newCurrency: string,
    newRate: number,
    source: 'CZK' | 'CNB' | 'DOKLAD' | 'MANUAL',
    rateDate?: string,
    cnbRate?: number
  ): ExtractedDeliveryNote => {
    const safeRate = newCurrency === 'CZK' ? 1 : Math.max(0.0001, newRate);
    return {
      ...current,
      currency: newCurrency,
      exchangeRate: safeRate,
      exchangeRateSource: source,
      exchangeRateDate: rateDate !== undefined ? rateDate : current.exchangeRateDate,
      cnbRate: cnbRate !== undefined ? cnbRate : current.cnbRate,
      items: current.items.map((line) => {
        const orig =
          line.originalPurchasePrice !== undefined ? line.originalPurchasePrice : line.purchasePrice;
        const czkPurchase =
          newCurrency === 'CZK' ? round2(orig) : round2(Math.max(0, orig) * safeRate);
        return {
          ...line,
          originalPurchasePrice: orig,
          purchasePrice: czkPurchase,
          suggestedSalePrice: czkPurchase > 0 ? round2(czkPurchase * 1.25) : 0,
        };
      }),
    };
  };

  const fetchAndApplyCnbRate = async (targetCurrency: string) => {
    if (!note) return;
    if (targetCurrency === 'CZK') {
      setNote(recalcNotePrices(note, 'CZK', 1, 'CZK', '', 1));
      return;
    }
    setLoadingRate(true);
    try {
      const res = await fetch('/api/cnb-rates');
      const data = (await res.json()) as CnbRatesResponse;
      const rate = Number(data.rates?.[targetCurrency] || 0);
      if (rate > 0) {
        setNote((prev) =>
          prev
            ? recalcNotePrices(
                prev,
                targetCurrency,
                rate,
                data.source === 'CNB' ? 'CNB' : 'MANUAL',
                data.date || '',
                rate
              )
            : prev
        );
        notify(
          data.source === 'CNB'
            ? `Načten kurz ČNB: 1 ${targetCurrency} = ${rate} Kč${data.date ? ` (${data.date})` : ''}.`
            : `Použit orientační kurz 1 ${targetCurrency} = ${rate} Kč (ČNB dočasně nedostupná).`
        );
      } else {
        setNote((prev) =>
          prev ? recalcNotePrices(prev, targetCurrency, prev.exchangeRate || 1, 'MANUAL') : prev
        );
        notify(`Kurz ČNB pro měnu ${targetCurrency} nebyl nalezen – zadejte kurz ručně.`, 'error');
      }
    } catch {
      notify('Nepodařilo se načíst kurz ČNB – zadejte prosím kurz ručně.', 'error');
    } finally {
      setLoadingRate(false);
    }
  };

  const handleExchangeRateInput = (val: string) => {
    if (!note) return;
    const parsed = Number(val.replace(',', '.'));
    const cur = note.currency || 'CZK';
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setNote({ ...note, exchangeRate: 0, exchangeRateSource: 'MANUAL' });
      return;
    }
    setNote(recalcNotePrices(note, cur, parsed, 'MANUAL'));
  };

  const handleWarehouseChange = (newWhId: string) => {
    setTargetWarehouseId(newWhId);
    if (note) {
      setNote(matchExtractedToInventory(note, inventory, newWhId));
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const lower = file.name.toLowerCase();
    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
      const text = await file.text();
      if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
        const parsed = parseQuickStockCsv(text);
        if (parsed.items.length === 0) {
          notify('CSV soubor neobsahuje rozpoznatelné řádky položek.', 'error');
          return;
        }
        applyExtractedNote(parsed, effectiveWarehouseId);
        notify(`Rozpoznáno ${parsed.items.length} položek z CSV.`);
        return;
      }
      setRawText(text);
      setMode('TEXT');
      return;
    }

    setExtracting(true);
    setLastExtractError(null);
    setRawExtractedText('');
    setShowRawText(false);

    const isXmlFile = lower.endsWith('.xml') || lower.endsWith('.isdoc') || file.type.includes('xml');

    try {
      if (engine === 'LOCAL' || isXmlFile) {
        setProgressText('Zpracovávám doklad lokálně bez AI…');
        const result = await extractFileLocally(file, {
          ownCompanyIco: activeCompany?.ico,
          onProgress: (label) => setProgressText(label),
        });
        setRawExtractedText(result.rawText);
        setLastMethod(result.method);

        const methodLabel =
          result.method === 'ISDOC_XML'
            ? 'ISDOC XML'
            : result.method === 'POHODA_XML'
              ? 'POHODA XML'
              : result.method === 'PDF_TEXT'
                ? 'PDF text'
                : 'lokální OCR';

        if (result.note.items.length === 0) {
          applyExtractedNote(
            {
              ...result.note,
              items: [
                {
                  id: `manual_${Date.now()}`,
                  sku: 'SKU-001',
                  name: '',
                  ean: '',
                  quantity: 1,
                  unit: 'ks',
                  originalPurchasePrice: 0,
                  purchasePrice: 0,
                  suggestedSalePrice: 0,
                  vatRate: 21,
                  selected: true,
                },
              ],
            },
            effectiveWarehouseId
          );
          setShowRawText(true);
          notify(
            `Doklad byl přečten (${methodLabel}), ale tabulka položek má nestandardní formát. Rozpoznaný text je zobrazen níže pro rychlou kontrolu.`,
            'info'
          );
        } else {
          applyExtractedNote(result.note, effectiveWarehouseId);
          notify(
            `Lokálně (${methodLabel}) rozpoznáno ${result.note.items.length} položek z ${file.name}.`
          );
        }
        return;
      }

      // Optional Gemini AI mode
      setProgressText('AI čte položky, množství a ceny z dokladu…');
      let base64Data = '';
      let mimeType = file.type || 'image/jpeg';

      if (mimeType.startsWith('image/') && file.size > 1_500_000) {
        const compressed = await new Promise<{ data: string; mime: string }>((resolve, reject) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            const maxDim = 1800;
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('Nepodařilo se zpracovat obrázek.'));
              return;
            }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            const comma = dataUrl.indexOf(',');
            resolve({ data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl, mime: 'image/jpeg' });
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Nepodařilo se načíst obrázek.'));
          };
          img.src = objectUrl;
        });
        base64Data = compressed.data;
        mimeType = compressed.mime;
      } else {
        base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
          };
          reader.onerror = () => reject(new Error('Nepodařilo se načíst soubor.'));
          reader.readAsDataURL(file);
        });
      }

      const payload = {
        base64Data,
        mimeType,
        fileName: file.name,
      };
      setLastFilePayload(payload);
      setLastExtractError(null);

      const extracted = await extractAiDeliveryNote(payload);
      setLastMethod('GEMINI');
      applyExtractedNote(extracted, effectiveWarehouseId);
      setLastExtractError(null);
      notify(`AI rozpoznala ${extracted.items.length} položek z dokladu ${file.name}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Zpracování dokladu selhalo.';
      setLastExtractError(msg);
      notify(msg, 'error');
    } finally {
      setExtracting(false);
      setProgressText('');
    }
  };

  const handleRetryLastFile = async () => {
    if (!lastFilePayload || extracting) return;
    setExtracting(true);
    setProgressText('Znovu odesílám doklad do Gemini AI…');
    setLastExtractError(null);
    try {
      const extracted = await extractAiDeliveryNote(lastFilePayload);
      setLastMethod('GEMINI');
      applyExtractedNote(extracted, effectiveWarehouseId);
      setLastExtractError(null);
      notify(
        `AI rozpoznala ${extracted.items.length} položek z dokladu ${lastFilePayload.fileName}.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI zpracování selhalo.';
      setLastExtractError(msg);
      notify(msg, 'error');
    } finally {
      setExtracting(false);
      setProgressText('');
    }
  };

  const handleAnalyzeText = async () => {
    if (!rawText.trim()) {
      notify('Vložte prosím text dodacího listu nebo faktury.', 'error');
      return;
    }
    setExtracting(true);
    setLastExtractError(null);
    try {
      if (engine === 'LOCAL') {
        const result = await extractTextLocally(rawText.trim(), {
          ownCompanyIco: activeCompany?.ico,
        });
        setRawExtractedText(result.rawText);
        setLastMethod('TEXT');
        if (result.note.items.length === 0) {
          notify(
            'V textu se nepodařilo automaticky rozpoznat řádky s množstvím a cenou. Zkontrolujte formát nebo přepněte na záložku CSV.',
            'error'
          );
          return;
        }
        applyExtractedNote(result.note, effectiveWarehouseId);
        notify(`Lokálně rozpoznáno ${result.note.items.length} položek z textu.`);
      } else {
        const extracted = await extractAiDeliveryNote({ rawText: rawText.trim() });
        setLastMethod('GEMINI');
        applyExtractedNote(extracted, effectiveWarehouseId);
        notify(`AI extrahovala ${extracted.items.length} položek.`);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Zpracování textu selhalo.', 'error');
    } finally {
      setExtracting(false);
    }
  };

  const handleParseCsv = () => {
    if (!csvText.trim()) {
      notify('Vložte CSV nebo TSV řádky (SKU;Název;Množství;MJ;Nákupní cena;DPH).', 'error');
      return;
    }
    const parsed = parseQuickStockCsv(csvText);
    if (parsed.items.length === 0) {
      notify('Nepodařilo se načíst žádné položky. Zkontrolujte oddělovač (středník/tabulátor).', 'error');
      return;
    }
    applyExtractedNote(parsed, effectiveWarehouseId);
    notify(`Načteno ${parsed.items.length} položek z CSV.`);
  };

  const updateLine = (id: string, patch: Partial<ExtractedLineItem>) => {
    if (!note) return;
    setNote({
      ...note,
      items: note.items.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    });
  };

  const removeLine = (id: string) => {
    if (!note) return;
    setNote({ ...note, items: note.items.filter((l) => l.id !== id) });
  };

  const addEmptyLine = () => {
    if (!note) return;
    const newLine: ExtractedLineItem = {
      id: `manual_${Date.now()}`,
      sku: `SKU-${Date.now() % 10000}`,
      name: '',
      ean: '',
      quantity: 1,
      unit: 'ks',
      originalPurchasePrice: 0,
      purchasePrice: 0,
      suggestedSalePrice: 0,
      vatRate: 21,
      selected: true,
      matchedInventoryId: null,
      matchedItemName: null,
    };
    setNote({ ...note, items: [...note.items, newLine] });
  };

  const handleCommit = async () => {
    if (!workspace || !note) return;
    const selected = note.items.filter((i) => i.selected && i.name.trim() && i.quantity > 0);
    if (selected.length === 0) {
      notify('Vyberte alespoň jednu platnou položku k naskladnění.', 'error');
      return;
    }
    setCommitting(true);
    try {
      const count = await commitBulkStockIn({
        workspace,
        warehouseId: effectiveWarehouseId,
        companyId: activeCompany?.id || 'company_1',
        supplierName: note.supplierName,
        documentNumber: note.documentNumber,
        currency: note.currency || 'CZK',
        exchangeRate: note.exchangeRate || 1,
        items: note.items,
        existingInventory: inventory,
      });
      notify(`Úspěšně naskladněno ${count} položek a zapsáno do deníku pohybů.`);
      setNote(null);
      setRawText('');
      setCsvText('');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Hromadné naskladnění selhalo.', 'error');
    } finally {
      setCommitting(false);
    }
  };

  const docCurrency = (note?.currency || 'CZK').toUpperCase();
  const isForeignCurrency = docCurrency !== 'CZK';
  const docRate = isForeignCurrency ? Number(note?.exchangeRate || 1) : 1;
  const currencyOptions = useMemo(() => {
    if (COMMON_CURRENCIES.includes(docCurrency)) return COMMON_CURRENCIES;
    return [docCurrency, ...COMMON_CURRENCIES];
  }, [docCurrency]);

  const selectedCount = note ? note.items.filter((i) => i.selected).length : 0;
  const totalPurchase = note
    ? round2(
        note.items
          .filter((i) => i.selected)
          .reduce((s, i) => s + Math.max(0, i.quantity) * Math.max(0, i.purchasePrice), 0)
      )
    : 0;
  const totalOriginalForeign =
    note && isForeignCurrency
      ? round2(
          note.items
            .filter((i) => i.selected)
            .reduce(
              (s, i) =>
                s +
                Math.max(0, i.quantity) *
                  Math.max(
                    0,
                    i.originalPurchasePrice !== undefined ? i.originalPurchasePrice : i.purchasePrice
                  ),
              0
            )
        )
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Hromadné naskladnění · {activeCompany?.name}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">AI Příjemka</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Nahrajte fotku nebo PDF dodacího listu, vložte text dokladu nebo rychlý CSV seznam.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-600 whitespace-nowrap">
            Cílový sklad:
          </label>
          <select
            value={effectiveWarehouseId}
            onChange={(e) => handleWarehouseChange(e.target.value)}
            className="px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg"
          >
            {accessibleWarehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.shared ? 'Sdílený' : 'Oddělený'})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Source selector */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 self-start">
            <button
              type="button"
              onClick={() => setMode('FILE')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'FILE'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              PDF / XML / Fotka
            </button>
            <button
              type="button"
              onClick={() => setMode('TEXT')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'TEXT'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Vložit text
            </button>
            <button
              type="button"
              onClick={() => setMode('CSV')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                mode === 'CSV'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              Rychlý CSV / Excel
            </button>
          </div>

          {mode !== 'CSV' && (
            <div className="inline-flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 self-start md:self-auto">
              <button
                type="button"
                onClick={() => {
                  setEngine('LOCAL');
                  setLastExtractError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  engine === 'LOCAL'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Cpu className="w-3.5 h-3.5 text-emerald-700" />
                Lokální (bez AI · bez limitů)
              </button>
              <button
                type="button"
                onClick={() => {
                  setEngine('GEMINI');
                  setLastExtractError(null);
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  engine === 'GEMINI'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                Gemini AI
              </button>
            </div>
          )}
        </div>

        {mode === 'FILE' && (
          <div className="space-y-3">
            {lastExtractError && !extracting && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <p className="text-xs text-amber-900 leading-relaxed">{lastExtractError}</p>
                <div className="flex items-center gap-2 shrink-0">
                  {engine === 'GEMINI' && (
                    <button
                      type="button"
                      onClick={() => {
                        setEngine('LOCAL');
                        setLastExtractError(null);
                      }}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-900 bg-emerald-100 hover:bg-emerald-200 rounded-lg whitespace-nowrap"
                    >
                      <Cpu className="w-3.5 h-3.5" />
                      Přepnout na Lokální (bez AI)
                    </button>
                  )}
                  {lastFilePayload && engine === 'GEMINI' && (
                    <button
                      type="button"
                      onClick={handleRetryLastFile}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Zkusit znovu
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center bg-slate-50/50">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf,.xml,.isdoc,.csv,.tsv,.txt"
                onChange={handleFileSelected}
                className="hidden"
              />
              {extracting ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <Loader2 className="w-7 h-7 text-slate-700 animate-spin" />
                  <p className="text-sm font-medium text-slate-900">
                    {progressText || 'Čtu položky, množství a ceny z dokladu…'}
                  </p>
                </div>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-slate-400 mx-auto" />
                  <p className="mt-3 text-sm font-medium text-slate-900">
                    Nahrajte fakturu, dodací list, ISDOC/POHODA XML nebo CSV
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {engine === 'LOCAL'
                      ? 'Lokální zpracování v prohlížeči (bez AI, bez limitů a chyb 503): PDF, ISDOC/XML, JPG/PNG (lokální OCR) i CSV'
                      : 'Gemini AI extrakce: PDF, JPG, PNG, WebP (XML a CSV se vždy čtou lokálně)'}
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{ backgroundColor: palette.primary }}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95"
                  >
                    {engine === 'LOCAL' ? (
                      <Cpu className="w-4 h-4" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    Vybrat soubor k naskladnění
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {mode === 'TEXT' && (
          <div className="space-y-3">
            <textarea
              rows={6}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder="Vložte zkopírovaný text dodacího listu, e-mailu od dodavatele nebo nákupní faktury…"
              className="w-full p-3 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleAnalyzeText}
                disabled={extracting}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
              >
                {extracting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : engine === 'LOCAL' ? (
                  <Cpu className="w-4 h-4" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                {extracting
                  ? 'Zpracovávám…'
                  : engine === 'LOCAL'
                    ? 'Rozpoznat položky lokálně (bez AI)'
                    : 'Rozpoznat položky pomocí AI'}
              </button>
            </div>
          </div>
        )}

        {mode === 'CSV' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Formát sloupců oddělených středníkem nebo tabulátorem:{' '}
              <code className="font-mono text-slate-700">
                SKU;Název položky;Množství;Jednotka;Nákupní cena bez DPH;DPH %
              </code>
            </p>
            <textarea
              rows={6}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={'CAB-100;Kabel CYKY-J 3x2.5;100;m;24.50;21\nJIST-16B;Jistič B16A 1P;20;ks;89;21'}
              className="w-full p-3 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleParseCsv}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg"
              >
                <FileSpreadsheet className="w-4 h-4" />
                Načíst řádky k revizi
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Optional raw extracted text preview for local PDF / OCR inspection */}
      {rawExtractedText && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowRawText((v) => !v)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <span className="inline-flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-slate-400" />
              Rozpoznaný text z dokladu
              {lastMethod && (
                <span className="font-mono text-[11px] text-slate-400">({lastMethod})</span>
              )}
            </span>
            <span className="text-slate-500">{showRawText ? 'Skrýt' : 'Zobrazit'}</span>
          </button>
          {showRawText && (
            <pre className="px-4 py-3 text-[11px] font-mono text-slate-700 bg-slate-50 border-t border-slate-100 max-h-60 overflow-auto whitespace-pre-wrap">
              {rawExtractedText}
            </pre>
          )}
        </div>
      )}

      {/* Review & Commit table */}
      {note && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 flex-1">
              <div>
                <label className="block text-[11px] font-medium uppercase text-slate-500 mb-1">
                  Dodavatel
                </label>
                <input
                  type="text"
                  value={note.supplierName}
                  onChange={(e) => setNote({ ...note, supplierName: e.target.value })}
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase text-slate-500 mb-1">
                  Číslo dokladu
                </label>
                <input
                  type="text"
                  value={note.documentNumber}
                  onChange={(e) => setNote({ ...note, documentNumber: e.target.value })}
                  className="w-full px-3 py-1.5 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium uppercase text-slate-500 mb-1">
                  IČO dodavatele
                </label>
                <input
                  type="text"
                  value={note.supplierIco}
                  onChange={(e) => setNote({ ...note, supplierIco: e.target.value })}
                  className="w-full px-3 py-1.5 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={addEmptyLine}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                <Plus className="w-3.5 h-3.5" />
                Přidat řádek
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={committing || selectedCount === 0}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60 whitespace-nowrap"
              >
                {committing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Naskladnit ({selectedCount}) · {formatCzk(totalPurchase)}
              </button>
            </div>
          </div>

          {/* Currency & Exchange Rate Bar */}
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">Měna dokladu:</label>
                <select
                  value={docCurrency}
                  onChange={(e) => fetchAndApplyCnbRate(e.target.value)}
                  disabled={loadingRate}
                  className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-slate-200 rounded-lg"
                >
                  {currencyOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {isForeignCurrency && (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-xs font-medium text-slate-600 whitespace-nowrap">
                      Kurz (1 {docCurrency} = Kč):
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      min="0.0001"
                      value={note.exchangeRate || ''}
                      onChange={(e) => handleExchangeRateInput(e.target.value)}
                      className="w-24 px-2.5 py-1.5 text-xs font-mono text-right bg-white border border-slate-200 rounded-lg tabular-nums"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => fetchAndApplyCnbRate(docCurrency)}
                    disabled={loadingRate}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg disabled:opacity-60"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingRate ? 'animate-spin' : ''}`} />
                    Načíst kurz ČNB
                  </button>

                  <span className="text-xs text-slate-500">
                    {note.exchangeRateSource === 'CNB'
                      ? `Kurz ČNB${note.exchangeRateDate ? ` ze dne ${note.exchangeRateDate}` : ''}`
                      : note.exchangeRateSource === 'DOKLAD'
                        ? 'Kurz převzat z dokladu'
                        : 'Vlastní / ruční kurz'}
                  </span>
                </>
              )}
            </div>

            {isForeignCurrency && (
              <div className="text-xs text-slate-600 tabular-nums">
                Celkem bez DPH:{' '}
                <span className="font-semibold text-slate-900">
                  {totalOriginalForeign.toLocaleString('cs-CZ', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  {docCurrency}
                </span>{' '}
                → <span className="font-semibold text-slate-900">{formatCzk(totalPurchase)}</span> na sklad
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-2.5 px-3 w-10"></th>
                  <th className="py-2.5 px-3">SKU</th>
                  <th className="py-2.5 px-3">Název & párování na sklad</th>
                  <th className="py-2.5 px-3 w-24 text-right">Množství</th>
                  <th className="py-2.5 px-3 w-20">MJ</th>
                  {isForeignCurrency && (
                    <th className="py-2.5 px-3 w-28 text-right">Nákup ({docCurrency})</th>
                  )}
                  <th className="py-2.5 px-3 w-28 text-right">
                    {isForeignCurrency ? 'Nákup (Kč)' : 'Nákup bez DPH'}
                  </th>
                  <th className="py-2.5 px-3 w-28 text-right">Prodej bez DPH</th>
                  <th className="py-2.5 px-3 w-20">DPH</th>
                  <th className="py-2.5 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {note.items.map((line) => (
                  <tr key={line.id} className={line.selected ? '' : 'opacity-50'}>
                    <td className="py-2 px-3">
                      <input
                        type="checkbox"
                        checked={line.selected}
                        onChange={(e) => updateLine(line.id, { selected: e.target.checked })}
                        className="rounded border-slate-300"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={line.sku}
                        onChange={(e) => updateLine(line.id, { sku: e.target.value })}
                        className="w-28 px-2 py-1 text-xs font-mono border border-slate-200 rounded-md"
                      />
                    </td>
                    <td className="py-2 px-3 min-w-[220px]">
                      <input
                        type="text"
                        value={line.name}
                        onChange={(e) => updateLine(line.id, { name: e.target.value })}
                        className="w-full px-2 py-1 text-sm border border-slate-200 rounded-md"
                      />
                      <p className="mt-1 text-[11px]">
                        {line.matchedInventoryId ? (
                          <span className="text-emerald-700 font-medium">
                            Přičte se k existující kartě: {line.matchedItemName}
                          </span>
                        ) : (
                          <span className="text-slate-500">Založí se jako nová skladová karta</span>
                        )}
                      </p>
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="any"
                        min="0.01"
                        value={line.quantity}
                        onChange={(e) =>
                          updateLine(line.id, { quantity: Number(e.target.value) || 0 })
                        }
                        className="w-20 px-2 py-1 text-sm text-right border border-slate-200 rounded-md tabular-nums"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="text"
                        value={line.unit}
                        onChange={(e) => updateLine(line.id, { unit: e.target.value })}
                        className="w-16 px-2 py-1 text-xs border border-slate-200 rounded-md"
                      />
                    </td>
                    {isForeignCurrency && (
                      <td className="py-2 px-3">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={
                            line.originalPurchasePrice !== undefined
                              ? line.originalPurchasePrice
                              : line.purchasePrice
                          }
                          onChange={(e) => {
                            const orig = Number(e.target.value) || 0;
                            const czk = round2(Math.max(0, orig) * Math.max(0, docRate));
                            updateLine(line.id, {
                              originalPurchasePrice: orig,
                              purchasePrice: czk,
                              suggestedSalePrice: czk > 0 ? round2(czk * 1.25) : 0,
                            });
                          }}
                          className="w-24 px-2 py-1 text-sm text-right border border-slate-200 rounded-md tabular-nums bg-slate-50/70"
                        />
                      </td>
                    )}
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={line.purchasePrice}
                        onChange={(e) => {
                          const czk = Number(e.target.value) || 0;
                          updateLine(line.id, {
                            purchasePrice: czk,
                            originalPurchasePrice:
                              isForeignCurrency && docRate > 0 ? round2(czk / docRate) : czk,
                          });
                        }}
                        className="w-24 px-2 py-1 text-sm text-right border border-slate-200 rounded-md tabular-nums"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={line.suggestedSalePrice}
                        onChange={(e) =>
                          updateLine(line.id, { suggestedSalePrice: Number(e.target.value) || 0 })
                        }
                        className="w-24 px-2 py-1 text-sm text-right border border-slate-200 rounded-md tabular-nums"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <select
                        value={line.vatRate}
                        onChange={(e) =>
                          updateLine(line.id, { vatRate: Number(e.target.value) })
                        }
                        className="px-2 py-1 text-xs border border-slate-200 rounded-md bg-white"
                      >
                        <option value={21}>21 %</option>
                        <option value={12}>12 %</option>
                        <option value={0}>0 %</option>
                      </select>
                    </td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(line.id)}
                        className="p-1 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
