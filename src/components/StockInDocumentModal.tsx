import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileText,
  GitBranch,
  Loader2,
  Paperclip,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { areNamesCompatible } from '../lib/bankParser';
import {
  restoreOrphanMovementToInventory,
  splitMislinkedMovements,
} from '../lib/firestoreService';
import { formatCzk, formatQty, formatTimestampCz } from '../lib/format';
import {
  deleteArchivedStockInDocument,
  saveArchivedStockInDocument,
  type ArchivedStockInDocument,
} from '../lib/stockInArchive';
import type { InventoryItem, StockMovement, Warehouse, Workspace } from '../types';

interface StockInDocumentModalProps {
  workspace: Workspace;
  documentRef: string;
  archivedDoc?: ArchivedStockInDocument | null;
  movements: StockMovement[];
  inventory: InventoryItem[];
  warehouses: Warehouse[];
  accentColor: string;
  onClose: () => void;
  onArchiveChanged: () => void;
  onNotify: (msg: string, tone?: 'success' | 'error' | 'info') => void;
}

export function StockInDocumentModal({
  workspace,
  documentRef,
  archivedDoc,
  movements,
  inventory,
  warehouses,
  accentColor,
  onClose,
  onArchiveChanged,
  onNotify,
}: StockInDocumentModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [localDoc, setLocalDoc] = useState<ArchivedStockInDocument | null>(archivedDoc || null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string>('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    setLocalDoc(archivedDoc || null);
  }, [archivedDoc]);

  const blob = localDoc?.fileBlob || null;
  const mime = (localDoc?.mimeType || blob?.type || '').toLowerCase();
  const isPdf = mime.includes('pdf') || (localDoc?.fileName || '').toLowerCase().endsWith('.pdf');
  const isImage =
    mime.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp)$/i.test(localDoc?.fileName || '');
  const isTextLike =
    !isPdf &&
    !isImage &&
    (mime.includes('xml') ||
      mime.includes('text') ||
      mime.includes('csv') ||
      /\.(xml|isdoc|csv|tsv|txt)$/i.test(localDoc?.fileName || ''));

  useEffect(() => {
    if (!blob) {
      setBlobUrl(null);
      setTextPreview(localDoc?.rawText || '');
      return;
    }
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    if (isTextLike) {
      blob
        .text()
        .then((t) => setTextPreview(t.slice(0, 50000)))
        .catch(() => setTextPreview(localDoc?.rawText || ''));
    } else {
      setTextPreview(localDoc?.rawText || '');
    }
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [blob, isTextLike, localDoc?.rawText]);

  const inventoryById = useMemo(() => new Map(inventory.map((i) => [i.id, i])), [inventory]);
  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);

  const docMovements = useMemo(
    () =>
      movements.filter(
        (m) => (m.documentRef || '').trim() === documentRef.trim() && m.quantityDelta > 0
      ),
    [movements, documentRef]
  );

  const mislinkedPairs = useMemo(() => {
    const out: Array<{ movement: StockMovement; wrongCard: InventoryItem }> = [];
    for (const mov of docMovements) {
      const card = mov.itemId ? inventoryById.get(mov.itemId) : undefined;
      if (card && !areNamesCompatible(mov.itemName, card.name)) {
        out.push({ movement: mov, wrongCard: card });
      }
    }
    return out;
  }, [docMovements, inventoryById]);

  const totalValue = useMemo(
    () =>
      docMovements.reduce(
        (s, m) => s + Math.abs(m.quantityDelta) * Math.max(0, m.unitPrice || 0),
        0
      ),
    [docMovements]
  );

  const handleAttachFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setAttaching(true);
    try {
      const saved = await saveArchivedStockInDocument({
        id: localDoc?.id,
        workspaceId: workspace.id,
        documentNumber: documentRef,
        supplierName: localDoc?.supplierName || '',
        supplierIco: localDoc?.supplierIco || '',
        warehouseId: localDoc?.warehouseId || docMovements[0]?.warehouseId || 'shared_main',
        companyId: localDoc?.companyId || docMovements[0]?.companyId || 'company_1',
        currency: localDoc?.currency || 'CZK',
        exchangeRate: localDoc?.exchangeRate || 1,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size,
        fileBlob: file,
        rawText: localDoc?.rawText || '',
        items:
          localDoc?.items ||
          docMovements.map((m) => ({
            sku: m.itemSku,
            name: m.itemName,
            ean: '',
            category: '',
            quantity: m.quantityDelta,
            unit: m.unit,
            purchasePrice: m.unitPrice,
            salePrice: 0,
            vatRate: 21,
          })),
      });
      setLocalDoc(saved);
      onArchiveChanged();
      onNotify(`Doklad „${file.name}“ byl uložen k příjemce ${documentRef}.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Uložení přílohy selhalo.', 'error');
    } finally {
      setAttaching(false);
    }
  };

  const handleDownload = () => {
    if (!blobUrl || !localDoc) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = localDoc.fileName || `doklad-${documentRef}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDeleteArchive = async () => {
    if (!localDoc) return;
    try {
      await deleteArchivedStockInDocument(localDoc.id);
      setLocalDoc(null);
      onArchiveChanged();
      onNotify('Uložená příloha dokladu byla odstraněna z archivu.', 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Odstranění přílohy selhalo.', 'error');
    }
  };

  const handleSplitSingle = async (mov: StockMovement, wrongCard: InventoryItem) => {
    setBusyId(mov.id);
    try {
      await splitMislinkedMovements({
        workspace,
        pairs: [{ movement: mov, wrongCard }],
        allInventory: inventory,
      });
      onNotify(
        `Položka „${mov.itemName}“ (+${formatQty(mov.quantityDelta)} ${mov.unit}) byla oddělena z „${wrongCard.name}“ na vlastní kartu.`
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Oddělení položky selhalo.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSplitAllInDoc = async () => {
    if (mislinkedPairs.length === 0) return;
    setBusyId('ALL_SPLIT');
    try {
      const count = await splitMislinkedMovements({
        workspace,
        pairs: mislinkedPairs,
        allInventory: inventory,
      });
      onNotify(`Odděleno ${count} chybně sloučených položek na vlastní skladové karty.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Hromadné oddělení selhalo.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRestoreOrphan = async (mov: StockMovement) => {
    setBusyId(mov.id);
    try {
      await restoreOrphanMovementToInventory({
        workspace,
        movement: mov,
        existingInventory: inventory,
      });
      onNotify(`Karta „${mov.itemName}“ (+${formatQty(mov.quantityDelta)} ${mov.unit}) zapsána na sklad.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Zápis na sklad selhal.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-xl overflow-hidden my-6 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5 min-w-0">
            <FileText className="w-5 h-5 text-slate-700 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900 truncate">
                Doklad příjemky: {documentRef}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {localDoc?.supplierName ? `${localDoc.supplierName} · ` : ''}
                {docMovements.length} pohybů na sklad · Celkem {formatCzk(totalValue)}
                {localDoc?.fileName ? ` · Příloha: ${localDoc.fileName}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/*,.xml,.isdoc,.csv,.tsv,.txt"
              onChange={handleAttachFile}
              className="hidden"
            />
            <button
              type="button"
              disabled={attaching}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              {attaching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Paperclip className="w-3.5 h-3.5" />
              )}
              {blob ? 'Nahradit soubor' : 'Přiložit originál (PDF / foto)'}
            </button>
            {blobUrl && (
              <button
                type="button"
                onClick={handleDownload}
                style={{ backgroundColor: accentColor }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-95"
              >
                <Download className="w-3.5 h-3.5" />
                Stáhnout
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-700"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-5">
          {/* Original file viewer */}
          {blob && blobUrl ? (
            <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
              <div className="px-4 py-2 bg-white border-b border-slate-200 flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700 truncate">
                  Originální doklad: {localDoc?.fileName}{' '}
                  {localDoc?.fileSize ? `(${Math.max(1, Math.round(localDoc.fileSize / 1024))} kB)` : ''}
                </span>
                <button
                  type="button"
                  onClick={handleDeleteArchive}
                  className="inline-flex items-center gap-1 text-slate-400 hover:text-red-600"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Odstranit přílohu
                </button>
              </div>
              {isPdf ? (
                <iframe
                  src={blobUrl}
                  title={localDoc?.fileName || documentRef}
                  className="w-full h-[460px] bg-white"
                />
              ) : isImage ? (
                <div className="p-4 flex justify-center bg-slate-100 max-h-[460px] overflow-auto">
                  <img
                    src={blobUrl}
                    alt={localDoc?.fileName || documentRef}
                    className="max-w-full max-h-[420px] object-contain rounded-lg border border-slate-200 bg-white"
                  />
                </div>
              ) : isTextLike && textPreview ? (
                <pre className="p-4 text-[11px] font-mono text-slate-700 max-h-80 overflow-auto whitespace-pre-wrap">
                  {textPreview}
                </pre>
              ) : (
                <div className="p-6 text-center text-xs text-slate-500">
                  Náhled tohoto typu souboru není podporován — klikněte nahoře na <strong>Stáhnout</strong>.
                </div>
              )}
            </div>
          ) : (
            <div className="border border-dashed border-slate-300 rounded-xl p-5 bg-slate-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-slate-800">
                  K tomuto dokladu zatím není přiložen originální soubor (PDF / fotka / XML)
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Nové příjemky na webu ukládají originál automaticky. Ke starším dokladům (např. z Androidu) jej můžete kdykoli přiložit pro dohledání chyby.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg shrink-0"
              >
                <Paperclip className="w-3.5 h-3.5" />
                Přiložit soubor
              </button>
            </div>
          )}

          {/* Mislinked warning inside document */}
          {mislinkedPairs.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                <div className="text-xs text-amber-900">
                  <p className="font-semibold">
                    U tohoto dokladu se {mislinkedPairs.length} položek přičetlo pod jiný název karty
                  </p>
                  <p className="mt-0.5 text-amber-800">
                    Jedním kliknutím odečtete kusy z chybných karet a založíte/napárujete správné skladové karty.
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={busyId === 'ALL_SPLIT'}
                onClick={handleSplitAllInDoc}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-amber-700 hover:bg-amber-800 rounded-lg shrink-0 disabled:opacity-60"
              >
                <GitBranch className="w-3.5 h-3.5" />
                {busyId === 'ALL_SPLIT'
                  ? 'Odděluji…'
                  : `Oddělit vše na vlastní karty (${mislinkedPairs.length})`}
              </button>
            </div>
          )}

          {/* Stocked-in movements table for this document */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
              Naskladněné položky z dokladu ({docMovements.length})
            </div>
            {docMovements.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                V deníku pohybů nejsou pro tento doklad žádné záznamy.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] uppercase tracking-wider text-slate-500">
                      <th className="py-2.5 px-3">Položka na dokladu</th>
                      <th className="py-2.5 px-3">Aktuálně připojeno ke kartě ve skladu</th>
                      <th className="py-2.5 px-3 text-right">Množství</th>
                      <th className="py-2.5 px-3 text-right">Cena / ks</th>
                      <th className="py-2.5 px-3 text-right">Oprava</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {docMovements.map((mov) => {
                      const card = mov.itemId ? inventoryById.get(mov.itemId) : undefined;
                      const isMislinked = Boolean(card && !areNamesCompatible(mov.itemName, card.name));
                      return (
                        <tr
                          key={mov.id}
                          className={
                            isMislinked
                              ? 'bg-amber-50/60'
                              : !card
                                ? 'bg-red-50/50'
                                : 'hover:bg-slate-50/50'
                          }
                        >
                          <td className="py-2.5 px-3">
                            <p className="font-medium text-slate-900">{mov.itemName}</p>
                            <p className="text-[11px] font-mono text-slate-500">
                              {mov.itemSku} · {formatTimestampCz(mov.createdAt)}
                            </p>
                          </td>
                          <td className="py-2.5 px-3">
                            {card ? (
                              <div>
                                <p
                                  className={`font-medium ${
                                    isMislinked ? 'text-amber-900' : 'text-emerald-800'
                                  }`}
                                >
                                  {card.name}
                                  {isMislinked && ' (jiný název!)'}
                                </p>
                                <p className="text-[11px] text-slate-500 tabular-nums">
                                  SKU {card.sku} · {whMap.get(card.warehouseId) || card.warehouseId} ·
                                  Stav: <strong>{formatQty(card.quantity)} {card.unit}</strong>
                                </p>
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 font-medium text-red-700">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                Karta ve skladu neexistuje
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                            +{formatQty(mov.quantityDelta)} {mov.unit}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-700 tabular-nums whitespace-nowrap">
                            {formatCzk(mov.unitPrice || 0)}
                          </td>
                          <td className="py-2.5 px-3 text-right whitespace-nowrap">
                            {isMislinked && card ? (
                              <button
                                type="button"
                                disabled={busyId === mov.id}
                                onClick={() => handleSplitSingle(mov, card)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-md disabled:opacity-50"
                              >
                                <GitBranch className="w-3 h-3" />
                                {busyId === mov.id ? 'Odděluji…' : 'Oddělit na vlastní kartu'}
                              </button>
                            ) : !card ? (
                              <button
                                type="button"
                                disabled={busyId === mov.id}
                                onClick={() => handleRestoreOrphan(mov)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md disabled:opacity-50"
                              >
                                <RotateCcw className="w-3 h-3" />
                                {busyId === mov.id ? 'Zapisuji…' : 'Zapsat na sklad'}
                              </button>
                            ) : (
                              <span className="text-[11px] text-emerald-700 font-medium">V pořádku</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
