import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { matchExtractedToInventory, parseQuickStockCsv } from '../lib/bankParser';
import { commitBulkStockIn } from '../lib/firestoreService';
import { formatCzk, getCompanyPalette, round2 } from '../lib/format';
import type { ExtractedDeliveryNote, ExtractedLineItem } from '../types';

type InputMode = 'FILE' | 'TEXT' | 'CSV';

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
  const [targetWarehouseId, setTargetWarehouseId] = useState<string>(
    accessibleWarehouses[0]?.id || 'shared_main'
  );
  const [rawText, setRawText] = useState('');
  const [csvText, setCsvText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [committing, setCommitting] = useState(false);

  const [note, setNote] = useState<ExtractedDeliveryNote | null>(null);

  const effectiveWarehouseId = useMemo(() => {
    if (accessibleWarehouses.some((w) => w.id === targetWarehouseId)) return targetWarehouseId;
    return accessibleWarehouses[0]?.id || 'shared_main';
  }, [accessibleWarehouses, targetWarehouseId]);

  const applyExtractedNote = (raw: ExtractedDeliveryNote, whId: string) => {
    const matched = matchExtractedToInventory(raw, inventory, whId);
    setNote(matched);
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
    try {
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

      const extracted = await extractAiDeliveryNote({
        base64Data,
        mimeType,
        fileName: file.name,
      });
      applyExtractedNote(extracted, effectiveWarehouseId);
      notify(`AI rozpoznala ${extracted.items.length} položek z dokladu ${file.name}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'AI zpracování selhalo.', 'error');
    } finally {
      setExtracting(false);
    }
  };

  const handleAnalyzeText = async () => {
    if (!rawText.trim()) {
      notify('Vložte prosím text dodacího listu nebo faktury.', 'error');
      return;
    }
    setExtracting(true);
    try {
      const extracted = await extractAiDeliveryNote({ rawText: rawText.trim() });
      applyExtractedNote(extracted, effectiveWarehouseId);
      notify(`AI extrahovala ${extracted.items.length} položek.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'AI zpracování textu selhalo.', 'error');
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

  const selectedCount = note ? note.items.filter((i) => i.selected).length : 0;
  const totalPurchase = note
    ? round2(
        note.items
          .filter((i) => i.selected)
          .reduce((s, i) => s + Math.max(0, i.quantity) * Math.max(0, i.purchasePrice), 0)
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
        <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
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
            Fotka / PDF dokladu
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
            Vložit text (AI)
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

        {mode === 'FILE' && (
          <div className="border-2 border-dashed border-slate-200 rounded-xl p-8 text-center bg-slate-50/50">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,application/pdf,.csv,.tsv,.txt"
              onChange={handleFileSelected}
              className="hidden"
            />
            {extracting ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <Loader2 className="w-7 h-7 text-slate-700 animate-spin" />
                <p className="text-sm font-medium text-slate-900">
                  AI čte položky, množství a ceny z dokladu…
                </p>
              </div>
            ) : (
              <>
                <Upload className="w-8 h-8 text-slate-400 mx-auto" />
                <p className="mt-3 text-sm font-medium text-slate-900">
                  Nahrajte dodací list, nákupní fakturu nebo CSV soubor
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Podporováno: JPG, PNG, WebP, PDF (AI extrakce) a CSV/TSV
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  style={{ backgroundColor: palette.primary }}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95"
                >
                  <Sparkles className="w-4 h-4" />
                  Vybrat soubor k rozpoznání
                </button>
              </>
            )}
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
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                {extracting ? 'Zpracovávám…' : 'Rozpoznat položky pomocí AI'}
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

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-2.5 px-3 w-10"></th>
                  <th className="py-2.5 px-3">SKU</th>
                  <th className="py-2.5 px-3">Název & párování na sklad</th>
                  <th className="py-2.5 px-3 w-24 text-right">Množství</th>
                  <th className="py-2.5 px-3 w-20">MJ</th>
                  <th className="py-2.5 px-3 w-28 text-right">Nákup bez DPH</th>
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
                    <td className="py-2 px-3">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={line.purchasePrice}
                        onChange={(e) =>
                          updateLine(line.id, { purchasePrice: Number(e.target.value) || 0 })
                        }
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
