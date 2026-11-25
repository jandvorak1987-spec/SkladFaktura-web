import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  Cpu,
  Eye,
  FileSpreadsheet,
  FileText,
  Files,
  Globe,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { QtyInput, parseQtyNumber } from './QtyInput';
import { StockInDocumentModal } from './StockInDocumentModal';
import { useApp } from '../context/AppContext';
import {
  areNamesCompatible,
  findMatchingInventoryItem,
  matchExtractedToInventory,
  parseQuickStockCsv,
} from '../lib/bankParser';
import { commitBulkStockIn } from '../lib/firestoreService';
import {
  formatCzk,
  formatQty,
  formatTimestampCz,
  getCompanyPalette,
  round2,
  timestampToMs,
} from '../lib/format';
import {
  extractFileLocally,
  extractTextLocally,
  type LocalExtractionMethod,
} from '../lib/localDocumentReader';
import { categorizeItemsViaNerx } from '../lib/nerxCategorizer';
import {
  listArchivedStockInDocuments,
  mapLinesToArchivedItems,
  saveArchivedStockInDocument,
  type ArchivedStockInDocument,
} from '../lib/stockInArchive';
import type { ExtractedDeliveryNote, ExtractedLineItem, InventoryItem } from '../types';

type InputMode = 'FILE' | 'TEXT' | 'CSV' | 'ARCHIVE';
type ProcessingEngine = 'LOCAL' | 'GEMINI';

const COMMON_CURRENCIES = ['CZK', 'EUR', 'USD', 'PLN', 'GBP', 'CHF', 'HUF'];

interface CnbRatesResponse {
  date: string;
  rates: Record<string, number>;
  source: 'CNB' | 'FALLBACK';
}

interface QueuedStockInDoc {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  fileBlob?: Blob | null;
  rawText: string;
  method: LocalExtractionMethod | 'GEMINI' | 'CSV';
  note: ExtractedDeliveryNote;
}

export function SmartStockInView() {
  const {
    workspace,
    activeCompany,
    warehouses,
    accessibleWarehouses,
    inventory,
    movements,
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
  const [committingAll, setCommittingAll] = useState(false);
  const [loadingRate, setLoadingRate] = useState(false);
  const [lastFilePayload, setLastFilePayload] = useState<{
    base64Data: string;
    mimeType: string;
    fileName: string;
    fileBlob?: Blob;
  } | null>(null);
  const [lastExtractError, setLastExtractError] = useState<string | null>(null);
  const [showRawText, setShowRawText] = useState(false);

  // Multi-document queue (supports 1 or N documents at once)
  const [queuedDocs, setQueuedDocs] = useState<QueuedStockInDoc[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);

  const [defaultCategory, setDefaultCategory] = useState('');
  const [categorizingNerx, setCategorizingNerx] = useState(false);

  // Stock-in document archive
  const [archivedDocs, setArchivedDocs] = useState<ArchivedStockInDocument[]>([]);
  const [archiveTick, setArchiveTick] = useState(0);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [viewingDocRef, setViewingDocRef] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace?.id) return;
    let active = true;
    listArchivedStockInDocuments(workspace.id).then((docs) => {
      if (active) setArchivedDocs(docs);
    });
    return () => {
      active = false;
    };
  }, [workspace?.id, archiveTick]);

  const activeDoc = useMemo(
    () => queuedDocs.find((d) => d.id === activeDocId) || queuedDocs[0] || null,
    [queuedDocs, activeDocId]
  );

  const note = activeDoc?.note || null;

  const setNote = (
    updater:
      | ExtractedDeliveryNote
      | null
      | ((prev: ExtractedDeliveryNote | null) => ExtractedDeliveryNote | null)
  ) => {
    setQueuedDocs((prevDocs) => {
      const current = prevDocs.find((d) => d.id === activeDocId) || prevDocs[0];
      if (!current) return prevDocs;
      const nextNote = typeof updater === 'function' ? updater(current.note) : updater;
      if (!nextNote) {
        return prevDocs.filter((d) => d.id !== current.id);
      }
      return prevDocs.map((d) => (d.id === current.id ? { ...d, note: nextNote } : d));
    });
  };

  const effectiveWarehouseId = useMemo(() => {
    if (accessibleWarehouses.some((w) => w.id === targetWarehouseId)) return targetWarehouseId;
    return accessibleWarehouses[0]?.id || 'shared_main';
  }, [accessibleWarehouses, targetWarehouseId]);

  const whNameMap = useMemo(
    () => new Map(accessibleWarehouses.map((w) => [w.id, w.name])),
    [accessibleWarehouses]
  );

  const inventoryById = useMemo(() => new Map(inventory.map((i) => [i.id, i])), [inventory]);

  const targetWhInventory = useMemo(
    () =>
      inventory
        .filter((i) => i.warehouseId === effectiveWarehouseId)
        .sort((a, b) => a.name.localeCompare(b.name, 'cs')),
    [inventory, effectiveWarehouseId]
  );

  const existingCategories = useMemo(() => {
    const set = new Set<string>();
    for (const item of inventory) {
      const cat = (item.category || '').trim();
      if (cat) set.add(cat);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'cs'));
  }, [inventory]);

  const sanitizeExtractedUnit = (rawUnit?: string): string => {
    const trimmed = (rawUnit || '').trim();
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
      clean === 'kus' ||
      clean === 'kusy' ||
      clean === 'kusu' ||
      clean === 'kusů' ||
      clean === 'pcs' ||
      clean === 'pc' ||
      clean === 'ea' ||
      clean === 'st' ||
      clean === 'stk' ||
      clean === 'pce' ||
      clean === 'h87'
    ) {
      return 'ks';
    }
    return trimmed.slice(0, 20);
  };

  const normalizeAndMatchNote = (raw: ExtractedDeliveryNote, whId: string): ExtractedDeliveryNote => {
    const currency = (raw.currency || 'CZK').toUpperCase();
    const exchangeRate = currency === 'CZK' ? 1 : Number(raw.exchangeRate || 1) || 1;
    const normalized: ExtractedDeliveryNote = {
      ...raw,
      currency,
      exchangeRate,
      exchangeRateSource: raw.exchangeRateSource || (currency === 'CZK' ? 'CZK' : 'MANUAL'),
      items: raw.items.map((item) => ({
        ...item,
        unit: sanitizeExtractedUnit(item.unit),
        originalPurchasePrice:
          item.originalPurchasePrice !== undefined
            ? item.originalPurchasePrice
            : item.purchasePrice,
      })),
    };
    const matched = matchExtractedToInventory(normalized, inventory, whId);
    return {
      ...matched,
      items: matched.items.map((line) => {
        if (line.matchedInventoryId) {
          const existing = inventoryById.get(line.matchedInventoryId);
          if (existing?.unit && existing.unit.toLowerCase() !== 'ml') {
            return { ...line, unit: existing.unit };
          }
        }
        return line;
      }),
    };
  };

  const enqueueDocs = (newDocs: QueuedStockInDoc[]) => {
    if (newDocs.length === 0) return;
    setQueuedDocs((prev) => [...prev, ...newDocs]);
    setActiveDocId(newDocs[0].id);
  };

  const removeQueuedDoc = (docId: string) => {
    setQueuedDocs((prev) => {
      const remaining = prev.filter((d) => d.id !== docId);
      if (activeDocId === docId) {
        setActiveDocId(remaining[0]?.id || null);
      }
      return remaining;
    });
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
    setQueuedDocs((prev) =>
      prev.map((d) => ({
        ...d,
        note: matchExtractedToInventory(d.note, inventory, newWhId),
      }))
    );
  };

  const extractSingleFile = async (
    file: File,
    index: number,
    total: number
  ): Promise<QueuedStockInDoc | null> => {
    const prefix = total > 1 ? `(${index + 1}/${total}) ${file.name}: ` : '';
    const lower = file.name.toLowerCase();

    if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
      const text = await file.text();
      const parsed = parseQuickStockCsv(text);
      if (parsed.items.length === 0) {
        notify(`${file.name}: CSV soubor neobsahuje rozpoznatelné řádky položek.`, 'error');
        return null;
      }
      return {
        id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        fileName: file.name,
        mimeType: file.type || 'text/csv',
        fileSize: file.size,
        fileBlob: file,
        rawText: text,
        method: 'CSV',
        note: normalizeAndMatchNote(parsed, effectiveWarehouseId),
      };
    }

    if (lower.endsWith('.txt')) {
      const text = await file.text();
      const result = await extractTextLocally(text, { ownCompanyIco: activeCompany?.ico });
      return {
        id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        fileName: file.name,
        mimeType: file.type || 'text/plain',
        fileSize: file.size,
        fileBlob: file,
        rawText: result.rawText,
        method: 'TEXT',
        note: normalizeAndMatchNote(result.note, effectiveWarehouseId),
      };
    }

    const isXmlFile = lower.endsWith('.xml') || lower.endsWith('.isdoc') || file.type.includes('xml');

    if (engine === 'LOCAL' || isXmlFile) {
      setProgressText(`${prefix}Zpracovávám doklad lokálně bez AI…`);
      const result = await extractFileLocally(file, {
        ownCompanyIco: activeCompany?.ico,
        onProgress: (label) => setProgressText(`${prefix}${label}`),
      });

      const baseNote: ExtractedDeliveryNote =
        result.note.items.length > 0
          ? result.note
          : {
              ...result.note,
              items: [
                {
                  id: `manual_${Date.now()}_${index}`,
                  sku: '',
                  name: '',
                  ean: '',
                  quantity: 0,
                  unit: 'ks',
                  originalPurchasePrice: 0,
                  purchasePrice: 0,
                  suggestedSalePrice: 0,
                  vatRate: 21,
                  selected: true,
                },
              ],
            };

      if (result.note.items.length === 0) {
        setShowRawText(true);
      }

      return {
        id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        fileBlob: file,
        rawText: result.rawText,
        method: result.method,
        note: normalizeAndMatchNote(baseNote, effectiveWarehouseId),
      };
    }

    // Optional Gemini AI mode
    setProgressText(`${prefix}AI čte položky, množství a ceny z dokladu…`);
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

    const payload = { base64Data, mimeType, fileName: file.name };
    setLastFilePayload({ ...payload, fileBlob: file });

    const extracted = await extractAiDeliveryNote(payload);
    return {
      id: `q_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
      fileName: file.name,
      mimeType: file.type || mimeType,
      fileSize: file.size,
      fileBlob: file,
      rawText: '',
      method: 'GEMINI',
      note: normalizeAndMatchNote(extracted, effectiveWarehouseId),
    };
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = Array.from(e.target.files || []);
    if (fileList.length === 0) return;
    e.target.value = '';

    setExtracting(true);
    setLastExtractError(null);
    setShowRawText(false);

    const added: QueuedStockInDoc[] = [];
    let failedCount = 0;

    try {
      for (let i = 0; i < fileList.length; i++) {
        try {
          const docItem = await extractSingleFile(fileList[i], i, fileList.length);
          if (docItem) added.push(docItem);
        } catch (err) {
          failedCount++;
          const msg = err instanceof Error ? err.message : 'Zpracování dokladu selhalo.';
          setLastExtractError(`${fileList[i].name}: ${msg}`);
          notify(`${fileList[i].name}: ${msg}`, 'error');
        }
      }

      if (added.length > 0) {
        enqueueDocs(added);
        const totalLines = added.reduce((s, d) => s + d.note.items.length, 0);
        if (added.length === 1) {
          notify(`Načten doklad ${added[0].fileName} (${totalLines} položek).`);
        } else {
          notify(
            `Načteno ${added.length} dokladů k hromadnému naskladnění (celkem ${totalLines} položek)${failedCount > 0 ? `, ${failedCount} selhalo` : ''}.`
          );
        }
      }
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
      const extracted = await extractAiDeliveryNote({
        base64Data: lastFilePayload.base64Data,
        mimeType: lastFilePayload.mimeType,
        fileName: lastFilePayload.fileName,
      });
      const queued: QueuedStockInDoc = {
        id: `q_${Date.now()}_retry`,
        fileName: lastFilePayload.fileName,
        mimeType: lastFilePayload.mimeType,
        fileSize: lastFilePayload.fileBlob?.size || 0,
        fileBlob: lastFilePayload.fileBlob || null,
        rawText: '',
        method: 'GEMINI',
        note: normalizeAndMatchNote(extracted, effectiveWarehouseId),
      };
      enqueueDocs([queued]);
      notify(`AI rozpoznala ${extracted.items.length} položek z dokladu ${lastFilePayload.fileName}.`);
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
        if (result.note.items.length === 0) {
          notify(
            'V textu se nepodařilo automaticky rozpoznat řádky s množstvím a cenou. Zkontrolujte formát nebo přepněte na záložku CSV.',
            'error'
          );
          return;
        }
        const blob = new Blob([rawText.trim()], { type: 'text/plain;charset=utf-8' });
        enqueueDocs([
          {
            id: `q_${Date.now()}_text`,
            fileName: `${result.note.documentNumber || 'text-doklad'}.txt`,
            mimeType: 'text/plain',
            fileSize: blob.size,
            fileBlob: blob,
            rawText: result.rawText,
            method: 'TEXT',
            note: normalizeAndMatchNote(result.note, effectiveWarehouseId),
          },
        ]);
        notify(`Lokálně rozpoznáno ${result.note.items.length} položek z textu.`);
      } else {
        const extracted = await extractAiDeliveryNote({ rawText: rawText.trim() });
        const blob = new Blob([rawText.trim()], { type: 'text/plain;charset=utf-8' });
        enqueueDocs([
          {
            id: `q_${Date.now()}_text_ai`,
            fileName: `${extracted.documentNumber || 'text-doklad'}.txt`,
            mimeType: 'text/plain',
            fileSize: blob.size,
            fileBlob: blob,
            rawText: rawText.trim(),
            method: 'GEMINI',
            note: normalizeAndMatchNote(extracted, effectiveWarehouseId),
          },
        ]);
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
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    enqueueDocs([
      {
        id: `q_${Date.now()}_csv`,
        fileName: `${parsed.documentNumber || 'import'}.csv`,
        mimeType: 'text/csv',
        fileSize: blob.size,
        fileBlob: blob,
        rawText: csvText,
        method: 'CSV',
        note: normalizeAndMatchNote(parsed, effectiveWarehouseId),
      },
    ]);
    notify(`Načteno ${parsed.items.length} položek z CSV.`);
  };

  const updateLine = (id: string, patch: Partial<ExtractedLineItem>) => {
    if (!note) return;
    const shouldRematch =
      (patch.sku !== undefined || patch.name !== undefined || patch.ean !== undefined) &&
      patch.matchedInventoryId === undefined;
    const otherWhInventory = shouldRematch
      ? inventory.filter((i) => i.warehouseId !== effectiveWarehouseId)
      : [];

    setNote({
      ...note,
      items: note.items.map((line) => {
        if (line.id !== id) return line;
        const updated = { ...line, ...patch };
        if (shouldRematch && !updated.manualMatchLock) {
          const matched = findMatchingInventoryItem(updated, targetWhInventory);
          if (matched) {
            return {
              ...updated,
              matchedInventoryId: matched.id,
              matchedItemName: matched.name,
              matchedOtherWarehouseId: null,
            };
          }
          const otherMatch = findMatchingInventoryItem(updated, otherWhInventory);
          return {
            ...updated,
            matchedInventoryId: null,
            matchedItemName: null,
            matchedOtherWarehouseId: otherMatch?.warehouseId || null,
          };
        }
        return updated;
      }),
    });
  };

  const handleManualMatchChange = (lineId: string, selectedInventoryId: string) => {
    if (!note) return;
    const chosen = selectedInventoryId
      ? inventory.find((i) => i.id === selectedInventoryId) || null
      : null;
    updateLine(lineId, {
      matchedInventoryId: chosen?.id || null,
      matchedItemName: chosen?.name || null,
      matchedOtherWarehouseId: null,
      manualMatchLock: true,
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
      sku: '',
      name: '',
      ean: '',
      category: '',
      quantity: 0,
      unit: 'ks',
      originalPurchasePrice: 0,
      purchasePrice: 0,
      suggestedSalePrice: 0,
      vatRate: 21,
      selected: true,
      matchedInventoryId: null,
      matchedItemName: null,
      matchedOtherWarehouseId: null,
    };
    setNote({ ...note, items: [...note.items, newLine] });
  };

  const handleCategorizeNoteViaNerx = async () => {
    if (!note || note.items.length === 0 || categorizingNerx) return;
    setCategorizingNerx(true);
    try {
      const matches = await categorizeItemsViaNerx(
        note.items.map((line) => ({
          id: line.id,
          name: line.name,
          sku: line.sku,
          ean: line.ean,
        }))
      );
      const matchMap = new Map(matches.map((m) => [m.id, m]));
      let nerxMatched = 0;
      let ruleMatched = 0;
      setNote((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((line) => {
            const m = matchMap.get(line.id);
            if (!m || !m.category) return line;
            if (m.source === 'NERX') nerxMatched++;
            else if (m.source === 'RULE') ruleMatched++;
            return { ...line, category: m.category };
          }),
        };
      });
      notify(
        `Kategorie určeny: ${nerxMatched}× přímo z Nerx.cz${ruleMatched > 0 ? `, ${ruleMatched}× podle pravidla` : ''}.`
      );
    } catch (err) {
      notify(
        err instanceof Error ? err.message : 'Porovnání s katalogem Nerx.cz selhalo.',
        'error'
      );
    } finally {
      setCategorizingNerx(false);
    }
  };

  const archiveCommittedDoc = async (docItem: QueuedStockInDoc) => {
    if (!workspace) return;
    try {
      await saveArchivedStockInDocument({
        workspaceId: workspace.id,
        documentNumber: (docItem.note.documentNumber || docItem.fileName || 'Příjemka').slice(0, 100),
        supplierName: docItem.note.supplierName || '',
        supplierIco: docItem.note.supplierIco || '',
        warehouseId: effectiveWarehouseId,
        companyId: activeCompany?.id || 'company_1',
        currency: docItem.note.currency || 'CZK',
        exchangeRate: docItem.note.exchangeRate || 1,
        fileName: docItem.fileName,
        mimeType: docItem.mimeType,
        fileSize: docItem.fileSize,
        fileBlob: docItem.fileBlob || null,
        rawText: docItem.rawText || '',
        items: mapLinesToArchivedItems(docItem.note.items, defaultCategory),
      });
      setArchiveTick((t) => t + 1);
    } catch {
      // Non-fatal: stock-in itself succeeded even if browser storage is restricted
    }
  };

  const handleCommitActive = async () => {
    if (!workspace || !activeDoc) return;
    const selected = activeDoc.note.items.filter(
      (i) => i.selected && i.name.trim() && i.quantity > 0
    );
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
        supplierName: activeDoc.note.supplierName,
        documentNumber: activeDoc.note.documentNumber || activeDoc.fileName,
        defaultCategory,
        currency: activeDoc.note.currency || 'CZK',
        exchangeRate: activeDoc.note.exchangeRate || 1,
        items: activeDoc.note.items,
        existingInventory: inventory,
      });
      await archiveCommittedDoc(activeDoc);
      removeQueuedDoc(activeDoc.id);
      if (queuedDocs.length <= 1) {
        setRawText('');
        setCsvText('');
      }
      notify(`Naskladněno ${count} položek a originál dokladu byl uložen do archivu.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Hromadné naskladnění selhalo.', 'error');
    } finally {
      setCommitting(false);
    }
  };

  const handleCommitAllQueued = async () => {
    if (!workspace || queuedDocs.length === 0) return;
    const validDocs = queuedDocs.filter((d) =>
      d.note.items.some((i) => i.selected && i.name.trim() && i.quantity > 0)
    );
    if (validDocs.length === 0) {
      notify('Žádný z nahraných dokladů neobsahuje platné položky k naskladnění.', 'error');
      return;
    }

    setCommittingAll(true);
    let totalItemsCommitted = 0;
    let committedDocCount = 0;
    const committedIds = new Set<string>();

    // Maintain a running in-memory inventory copy across documents in this batch
    // so if two invoices share the same product, the second adds to the first cleanly
    const runningInventory: InventoryItem[] = inventory.map((i) => ({ ...i }));

    try {
      for (const qDoc of validDocs) {
        const rematched = matchExtractedToInventory(qDoc.note, runningInventory, effectiveWarehouseId);
        const count = await commitBulkStockIn({
          workspace,
          warehouseId: effectiveWarehouseId,
          companyId: activeCompany?.id || 'company_1',
          supplierName: rematched.supplierName,
          documentNumber: rematched.documentNumber || qDoc.fileName,
          defaultCategory,
          currency: rematched.currency || 'CZK',
          exchangeRate: rematched.exchangeRate || 1,
          items: rematched.items,
          existingInventory: runningInventory,
          onCardMutated: (mutatedCard) => {
            const idx = runningInventory.findIndex((i) => i.id === mutatedCard.id);
            if (idx >= 0) runningInventory[idx] = mutatedCard;
            else runningInventory.push(mutatedCard);
          },
        });

        await archiveCommittedDoc(qDoc);
        committedIds.add(qDoc.id);
        committedDocCount++;
        totalItemsCommitted += count;
      }

      setQueuedDocs((prev) => prev.filter((d) => !committedIds.has(d.id)));
      setActiveDocId(null);
      setRawText('');
      setCsvText('');
      notify(
        `Hromadně naskladněno ${committedDocCount} dokladů (${totalItemsCommitted} položek) a všechny originály uloženy do archivu.`
      );
    } catch (err) {
      if (committedIds.size > 0) {
        setQueuedDocs((prev) => prev.filter((d) => !committedIds.has(d.id)));
      }
      notify(
        err instanceof Error ? err.message : 'Hromadné naskladnění více dokladů selhalo.',
        'error'
      );
    } finally {
      setCommittingAll(false);
    }
  };

  // Merge local IndexedDB archive + historical receipt documentRefs from Firestore movements
  const mergedArchiveEntries = useMemo(() => {
    const byRef = new Map<
      string,
      {
        documentRef: string;
        supplierName: string;
        latestMs: number;
        itemCount: number;
        totalValue: number;
        hasFile: boolean;
        fileName: string;
        archivedDoc: ArchivedStockInDocument | null;
        mislinkedCount: number;
        orphanCount: number;
      }
    >();

    for (const d of archivedDocs) {
      const ref = (d.documentNumber || d.fileName || d.id).trim();
      const existing = byRef.get(ref);
      if (!existing || d.createdAtMs > existing.latestMs) {
        byRef.set(ref, {
          documentRef: ref,
          supplierName: d.supplierName || '',
          latestMs: d.createdAtMs,
          itemCount: d.items.length,
          totalValue: round2(d.items.reduce((s, i) => s + i.quantity * i.purchasePrice, 0)),
          hasFile: Boolean(d.fileBlob),
          fileName: d.fileName || '',
          archivedDoc: d,
          mislinkedCount: 0,
          orphanCount: 0,
        });
      }
    }

    // Group Firestore receipt movements by documentRef
    const movGroups = new Map<string, typeof movements>();
    for (const mov of movements) {
      if (mov.quantityDelta <= 0) continue;
      const ref = (mov.documentRef || '').trim();
      if (!ref || ref === 'Ruční úprava' || ref === 'Příjemka') continue;
      const arr = movGroups.get(ref) || [];
      arr.push(mov);
      movGroups.set(ref, arr);
    }

    for (const [ref, movs] of movGroups.entries()) {
      let mislinkedCount = 0;
      let orphanCount = 0;
      let totalValue = 0;
      let latestMs = 0;
      for (const m of movs) {
        totalValue += Math.abs(m.quantityDelta) * Math.max(0, m.unitPrice || 0);
        const ms = timestampToMs(m.createdAt);
        if (ms > latestMs) latestMs = ms;
        const card = m.itemId ? inventoryById.get(m.itemId) : undefined;
        if (!card) orphanCount++;
        else if (!areNamesCompatible(m.itemName, card.name)) mislinkedCount++;
      }

      const existing = byRef.get(ref);
      if (existing) {
        existing.itemCount = movs.length;
        existing.totalValue = round2(totalValue);
        existing.latestMs = Math.max(existing.latestMs, latestMs);
        existing.mislinkedCount = mislinkedCount;
        existing.orphanCount = orphanCount;
      } else {
        const noteSupplier = movs[0]?.note?.replace(/^Příjemka\s*[–-]\s*/i, '') || '';
        byRef.set(ref, {
          documentRef: ref,
          supplierName: noteSupplier,
          latestMs,
          itemCount: movs.length,
          totalValue: round2(totalValue),
          hasFile: false,
          fileName: '',
          archivedDoc: null,
          mislinkedCount,
          orphanCount,
        });
      }
    }

    const q = archiveSearch.trim().toLowerCase();
    return Array.from(byRef.values())
      .filter((entry) => {
        if (!q) return true;
        return (
          entry.documentRef.toLowerCase().includes(q) ||
          entry.supplierName.toLowerCase().includes(q) ||
          entry.fileName.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.latestMs - a.latestMs);
  }, [archivedDocs, movements, inventoryById, archiveSearch]);

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

  const grandTotalQueuedCzk = useMemo(
    () =>
      round2(
        queuedDocs.reduce(
          (sum, d) =>
            sum +
            d.note.items
              .filter((i) => i.selected)
              .reduce((s, i) => s + Math.max(0, i.quantity) * Math.max(0, i.purchasePrice), 0),
          0
        )
      ),
    [queuedDocs]
  );

  const totalQueuedSelectedItems = useMemo(
    () =>
      queuedDocs.reduce(
        (sum, d) =>
          sum + d.note.items.filter((i) => i.selected && i.name.trim() && i.quantity > 0).length,
        0
      ),
    [queuedDocs]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Hromadné naskladnění & archiv dokladů · {activeCompany?.name}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">AI Příjemka</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Nahrajte jeden nebo více dokladů najednou (PDF, XML, fotky, CSV) — každý doklad se po naskladnění uloží do archivu.
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
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="inline-flex flex-wrap items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 self-start">
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
              PDF / XML / Fotky
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
            <button
              type="button"
              onClick={() => setMode('ARCHIVE')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors tabular-nums ${
                mode === 'ARCHIVE'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              Archiv dokladů ({mergedArchiveEntries.length})
            </button>
          </div>

          {mode !== 'CSV' && mode !== 'ARCHIVE' && (
            <div className="inline-flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 self-start lg:self-auto">
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

        {/* Hidden multi-file input accessible from both upload dropzone and "+ Přidat další doklady" */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,.xml,.isdoc,.csv,.tsv,.txt"
          onChange={handleFilesSelected}
          className="hidden"
        />

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
              {extracting ? (
                <div className="flex flex-col items-center gap-3 py-4">
                  <Loader2 className="w-7 h-7 text-slate-700 animate-spin" />
                  <p className="text-sm font-medium text-slate-900">
                    {progressText || 'Čtu položky, množství a ceny z dokladů…'}
                  </p>
                </div>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-slate-400 mx-auto" />
                  <p className="mt-3 text-sm font-medium text-slate-900">
                    Nahrajte jeden nebo více dokladů najednou (PDF, ISDOC/POHODA XML, fotky, CSV)
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {engine === 'LOCAL'
                      ? 'Lokální zpracování bez limitů a chyb 503 · Můžete označit více souborů najednou pro hromadné naskladnění'
                      : 'Gemini AI extrakce: PDF, JPG, PNG, WebP (XML a CSV se vždy čtou lokálně)'}
                  </p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    style={{ backgroundColor: palette.primary }}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95"
                  >
                    <Files className="w-4 h-4" />
                    Vybrat doklad(y) k naskladnění
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

        {mode === 'ARCHIVE' && (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <p className="text-xs text-slate-500">
                Uchované doklady z příjemek včetně originálních PDF/fotek a přehledu naskladněných položek. Kliknutím doklad otevřete.
              </p>
              <div className="relative sm:w-64">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={archiveSearch}
                  onChange={(e) => setArchiveSearch(e.target.value)}
                  placeholder="Hledat č. dokladu, dodavatele…"
                  className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            {mergedArchiveEntries.length === 0 ? (
              <div className="p-8 text-center border border-dashed border-slate-200 rounded-xl text-xs text-slate-500">
                Zatím nejsou k dispozici žádné doklady příjemek. Po naskladnění se zde každý doklad automaticky uloží.
              </div>
            ) : (
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                        <th className="py-2.5 px-4">Číslo dokladu</th>
                        <th className="py-2.5 px-4">Dodavatel / Soubor</th>
                        <th className="py-2.5 px-4">Datum</th>
                        <th className="py-2.5 px-4 text-right">Položek</th>
                        <th className="py-2.5 px-4 text-right">Hodnota</th>
                        <th className="py-2.5 px-4 text-right">Akce</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mergedArchiveEntries.map((entry) => (
                        <tr
                          key={entry.documentRef}
                          className={
                            entry.mislinkedCount > 0 || entry.orphanCount > 0
                              ? 'bg-amber-50/40 hover:bg-amber-50/70'
                              : 'hover:bg-slate-50/60'
                          }
                        >
                          <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                            {entry.documentRef}
                            {entry.mislinkedCount > 0 && (
                              <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-sans font-medium text-amber-800">
                                <AlertTriangle className="w-3 h-3" />
                                {entry.mislinkedCount}× jiná karta
                              </span>
                            )}
                            {entry.orphanCount > 0 && (
                              <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-sans font-medium text-red-700">
                                <AlertTriangle className="w-3 h-3" />
                                {entry.orphanCount}× chybí
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4">
                            <p className="font-medium text-slate-800">
                              {entry.supplierName || '—'}
                            </p>
                            {entry.hasFile ? (
                              <p className="text-[11px] text-emerald-700 inline-flex items-center gap-1 mt-0.5">
                                <Paperclip className="w-3 h-3" />
                                {entry.fileName || 'Originální soubor uložen'}
                              </p>
                            ) : (
                              <p className="text-[11px] text-slate-400 mt-0.5">
                                Bez přiloženého souboru (lze přiložit po otevření)
                              </p>
                            )}
                          </td>
                          <td className="py-3 px-4 text-slate-500 tabular-nums whitespace-nowrap">
                            {entry.latestMs
                              ? new Date(entry.latestMs).toLocaleString('cs-CZ')
                              : formatTimestampCz(null)}
                          </td>
                          <td className="py-3 px-4 text-right font-medium text-slate-700 tabular-nums">
                            {entry.itemCount}
                          </td>
                          <td className="py-3 px-4 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                            {formatCzk(entry.totalValue)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setViewingDocRef(entry.documentRef)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Otevřít doklad
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
        )}
      </div>

      {/* Multi-document queue bar (shown whenever 1+ documents are loaded) */}
      {queuedDocs.length > 0 && mode !== 'ARCHIVE' && (
        <div className="bg-slate-900 text-white rounded-xl p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Files className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-xs font-semibold tabular-nums">
                Fronta k naskladnění: {queuedDocs.length}{' '}
                {queuedDocs.length === 1 ? 'doklad' : queuedDocs.length < 5 ? 'doklady' : 'dokladů'}{' '}
                · {totalQueuedSelectedItems} položek · {formatCzk(grandTotalQueuedCzk)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={extracting}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                Přidat další doklady
              </button>
              {queuedDocs.length > 1 && (
                <button
                  type="button"
                  disabled={committingAll || committing || totalQueuedSelectedItems === 0}
                  onClick={handleCommitAllQueued}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 whitespace-nowrap"
                >
                  {committingAll ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Check className="w-3.5 h-3.5" />
                  )}
                  {committingAll
                    ? 'Naskladňuji všechny doklady…'
                    : `Naskladnit vše (${queuedDocs.length} dokladů · ${formatCzk(grandTotalQueuedCzk)})`}
                </button>
              )}
            </div>
          </div>

          {queuedDocs.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-white/10">
              {queuedDocs.map((d) => {
                const isActive = d.id === activeDoc?.id;
                const docItemsCount = d.note.items.filter((i) => i.selected).length;
                return (
                  <div
                    key={d.id}
                    className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg text-xs transition-colors ${
                      isActive
                        ? 'bg-white text-slate-900 font-semibold'
                        : 'bg-white/10 text-slate-200 hover:bg-white/20'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveDocId(d.id)}
                      className="inline-flex items-center gap-1.5 max-w-[220px] truncate"
                    >
                      {d.fileBlob && <Paperclip className="w-3 h-3 shrink-0 opacity-70" />}
                      <span className="truncate">
                        {d.note.documentNumber || d.fileName}
                      </span>
                      <span className="opacity-70 tabular-nums">({docItemsCount})</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeQueuedDoc(d.id)}
                      title="Odebrat z fronty"
                      className={`p-0.5 rounded ${
                        isActive ? 'hover:bg-slate-200' : 'hover:bg-white/20'
                      }`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Optional raw extracted text preview for local PDF / OCR inspection */}
      {activeDoc?.rawText && mode !== 'ARCHIVE' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowRawText((v) => !v)}
            className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
          >
            <span className="inline-flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-slate-400" />
              Rozpoznaný text z dokladu ({activeDoc.fileName})
              <span className="font-mono text-[11px] text-slate-400">({activeDoc.method})</span>
            </span>
            <span className="text-slate-500">{showRawText ? 'Skrýt' : 'Zobrazit'}</span>
          </button>
          {showRawText && (
            <pre className="px-4 py-3 text-[11px] font-mono text-slate-700 bg-slate-50 border-t border-slate-100 max-h-60 overflow-auto whitespace-pre-wrap">
              {activeDoc.rawText}
            </pre>
          )}
        </div>
      )}

      {/* Review & Commit table */}
      {note && mode !== 'ARCHIVE' && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
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
              <div>
                <label className="block text-[11px] font-medium uppercase text-slate-500 mb-1">
                  Kategorie nových karet
                </label>
                <input
                  type="text"
                  list="smart-stock-categories"
                  value={defaultCategory}
                  onChange={(e) => setDefaultCategory(e.target.value)}
                  placeholder="Volitelná kategorie…"
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg"
                />
                <datalist id="smart-stock-categories">
                  {existingCategories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCategorizeNoteViaNerx}
                disabled={categorizingNerx || note.items.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg disabled:opacity-60 whitespace-nowrap"
              >
                {categorizingNerx ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Globe className="w-3.5 h-3.5" />
                )}
                {categorizingNerx ? 'Porovnávám s Nerx.cz…' : 'Určit kategorie (Nerx.cz)'}
              </button>
              <button
                type="button"
                onClick={addEmptyLine}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                Přidat řádek
              </button>
              <button
                type="button"
                onClick={handleCommitActive}
                disabled={committing || committingAll || selectedCount === 0}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60 whitespace-nowrap"
              >
                {committing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                {queuedDocs.length > 1 ? 'Naskladnit tento' : 'Naskladnit'} ({selectedCount}) ·{' '}
                {formatCzk(totalPurchase)}
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
                  <th className="py-2.5 px-3">Název, párování & kategorie</th>
                  <th className="py-2.5 px-3 w-24 text-right">Množství</th>
                  <th className="py-2.5 px-3 w-24">
                    <div className="flex items-center gap-1.5">
                      <span>MJ</span>
                      {note.items.some((i) => i.unit.trim().toLowerCase() !== 'ks') && (
                        <button
                          type="button"
                          onClick={() => {
                            setNote({
                              ...note,
                              items: note.items.map((i) => ({ ...i, unit: 'ks' })),
                            });
                            notify('Všechny řádky přepnuty na jednotku „ks“.');
                          }}
                          title="Nastavit u všech řádků jednotku ks"
                          className="px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded whitespace-nowrap"
                        >
                          Vše ks
                        </button>
                      )}
                    </div>
                  </th>
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
                        placeholder="Auto unikátní"
                        onChange={(e) => updateLine(line.id, { sku: e.target.value })}
                        className="w-28 px-2 py-1 text-xs font-mono border border-slate-200 rounded-md"
                      />
                    </td>
                    <td className="py-2 px-3 min-w-[260px]">
                      <input
                        type="text"
                        value={line.name}
                        onChange={(e) => updateLine(line.id, { name: e.target.value })}
                        className="w-full px-2 py-1 text-sm border border-slate-200 rounded-md"
                      />
                      <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        <select
                          value={line.matchedInventoryId || ''}
                          onChange={(e) => handleManualMatchChange(line.id, e.target.value)}
                          className={`w-full px-2 py-1 text-[11px] rounded-md border bg-white ${
                            line.matchedInventoryId
                              ? 'border-emerald-300 text-emerald-800 font-medium bg-emerald-50/40'
                              : 'border-slate-200 text-slate-600'
                          }`}
                        >
                          <option value="">+ Založit jako novou skladovou kartu</option>
                          {targetWhInventory.map((inv) => (
                            <option key={inv.id} value={inv.id}>
                              Přičíst k: {inv.name} ({inv.sku} · {formatQty(inv.quantity)}{' '}
                              {inv.unit})
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          list="smart-stock-categories"
                          value={line.category || ''}
                          onChange={(e) => updateLine(line.id, { category: e.target.value })}
                          placeholder="Kategorie (nebo dle hlavičky)…"
                          className="w-full px-2 py-1 text-[11px] border border-slate-200 rounded-md bg-white text-slate-700"
                        />
                        {!line.matchedInventoryId && line.matchedOtherWarehouseId && (
                          <p className="sm:col-span-2 text-[11px] text-amber-700">
                            Pozor: karta existuje ve skladu „
                            {whNameMap.get(line.matchedOtherWarehouseId) ||
                              line.matchedOtherWarehouseId}
                            “ — přepněte cílový sklad nahoře.
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <QtyInput
                        value={line.quantity}
                        onValueChange={(cleaned) =>
                          updateLine(line.id, { quantity: parseQtyNumber(cleaned) })
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
                        <QtyInput
                          value={
                            line.originalPurchasePrice !== undefined
                              ? line.originalPurchasePrice
                              : line.purchasePrice
                          }
                          onValueChange={(cleaned) => {
                            const orig = parseQtyNumber(cleaned);
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
                      <QtyInput
                        value={line.purchasePrice}
                        onValueChange={(cleaned) => {
                          const czk = parseQtyNumber(cleaned);
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
                      <QtyInput
                        value={line.suggestedSalePrice}
                        onValueChange={(cleaned) =>
                          updateLine(line.id, { suggestedSalePrice: parseQtyNumber(cleaned) })
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

      {/* Document Archive Viewer Modal */}
      {viewingDocRef && workspace && (
        <StockInDocumentModal
          workspace={workspace}
          documentRef={viewingDocRef}
          archivedDoc={
            mergedArchiveEntries.find((e) => e.documentRef === viewingDocRef)?.archivedDoc || null
          }
          movements={movements}
          inventory={inventory}
          warehouses={warehouses}
          accentColor={palette.primary}
          onClose={() => setViewingDocRef(null)}
          onArchiveChanged={() => setArchiveTick((t) => t + 1)}
          onNotify={notify}
        />
      )}
    </div>
  );
}
