import React, { useMemo, useRef, useState } from 'react';
import { Check, ClipboardCheck, Download, Loader2, RotateCcw, ScanBarcode } from 'lucide-react';
import { QtyInput, parseQtyNumber } from './QtyInput';
import { commitInventoryAudit } from '../lib/firestoreService';
import { downloadTextFile, formatCzk, formatQty, round2, toIsoDate } from '../lib/format';
import type { InventoryItem, Warehouse, Workspace } from '../types';

interface InventoryAuditPanelProps {
  items: InventoryItem[];
  warehouses: Warehouse[];
  workspace: Workspace;
  activeCompanyId: string;
  accentColor: string;
  onNotify: (msg: string, tone?: 'success' | 'error' | 'info') => void;
}

export function InventoryAuditPanel({
  items,
  warehouses,
  workspace,
  activeCompanyId,
  accentColor,
  onNotify,
}: InventoryAuditPanelProps) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [scanInput, setScanInput] = useState('');
  const [lastScannedId, setLastScannedId] = useState<string | null>(null);
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [docRef, setDocRef] = useState(`Inventura ${toIsoDate()}`);
  const [committing, setCommitting] = useState(false);
  const scanRef = useRef<HTMLInputElement | null>(null);

  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);

  const getCounted = (item: InventoryItem): number => {
    return counts[item.id] !== undefined ? counts[item.id] : item.quantity;
  };

  const handleScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = scanInput.trim().toLowerCase();
    if (!code) return;

    const match = items.find(
      (i) =>
        (i.ean && i.ean.trim().toLowerCase() === code) ||
        i.sku.trim().toLowerCase() === code ||
        i.name.trim().toLowerCase() === code
    );

    if (!match) {
      onNotify(`Kód "${scanInput.trim()}" nebyl nalezen v zobrazených skladových kartách.`, 'error');
      setScanInput('');
      return;
    }

    setCounts((prev) => {
      const current = prev[match.id] !== undefined ? prev[match.id] : 0;
      return { ...prev, [match.id]: round2(current + 1) };
    });
    setLastScannedId(match.id);
    setScanInput('');
    onNotify(`Naskenováno +1 ${match.unit}: ${match.name}`, 'info');
    scanRef.current?.focus();
  };

  const rows = useMemo(() => {
    return items
      .map((item) => {
        const counted = getCounted(item);
        const delta = round2(counted - item.quantity);
        const diffValue = round2(delta * Math.max(0, item.purchasePrice));
        return { item, counted, delta, diffValue };
      })
      .filter((r) => !onlyDiffs || r.delta !== 0);
  }, [items, counts, onlyDiffs]);

  const summary = useMemo(() => {
    let diffCount = 0;
    let surplusValue = 0;
    let shortageValue = 0;
    for (const item of items) {
      const counted = getCounted(item);
      const delta = round2(counted - item.quantity);
      if (delta !== 0) {
        diffCount++;
        const val = round2(delta * Math.max(0, item.purchasePrice));
        if (val >= 0) surplusValue = round2(surplusValue + val);
        else shortageValue = round2(shortageValue + val);
      }
    }
    return {
      diffCount,
      surplusValue,
      shortageValue,
      netValue: round2(surplusValue + shortageValue),
    };
  }, [items, counts]);

  const handleZeroAllForFullScan = () => {
    const zeroed: Record<string, number> = {};
    for (const item of items) zeroed[item.id] = 0;
    setCounts(zeroed);
    onNotify('Všechny napočítané stavy nastaveny na 0 – můžete skenovat čtečkou od nuly.', 'info');
    scanRef.current?.focus();
  };

  const handleReset = () => {
    setCounts({});
    setLastScannedId(null);
  };

  const handleExportAuditCsv = () => {
    const header = 'SKU;EAN;Nazev;Sklad;Evidovany stav;Skutecny stav;Rozdil;MJ;Hodnota rozdilu CZK';
    const lines = items.map((item) => {
      const counted = getCounted(item);
      const delta = round2(counted - item.quantity);
      const val = round2(delta * Math.max(0, item.purchasePrice));
      const esc = (s: string) => `"${String(s || '').replace(/"/g, '""')}"`;
      return [
        esc(item.sku),
        esc(item.ean),
        esc(item.name),
        esc(whMap.get(item.warehouseId) || item.warehouseId),
        item.quantity,
        counted,
        delta,
        esc(item.unit),
        val,
      ].join(';');
    });
    downloadTextFile(
      `\uFEFF${header}\n${lines.join('\n')}`,
      `inventurni_protokol_${toIsoDate()}.csv`,
      'text/csv;charset=utf-8'
    );
    onNotify('Inventurní protokol (CSV) byl stažen.');
  };

  const handleCommitAudit = async () => {
    const adjustments = items
      .map((item) => ({ item, countedQty: getCounted(item) }))
      .filter((a) => round2(a.countedQty - a.item.quantity) !== 0);
    if (adjustments.length === 0) {
      onNotify('Nejsou zadány žádné rozdíly k zaúčtování.', 'info');
      return;
    }
    setCommitting(true);
    try {
      const count = await commitInventoryAudit({
        workspace,
        activeCompanyId,
        adjustments,
        documentRef: docRef.trim() || `Inventura ${toIsoDate()}`,
      });
      setCounts({});
      setLastScannedId(null);
      onNotify(`Inventura uzavřena: srovnáno ${count} položek a zapsáno do deníku pohybů.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Uzavření inventury selhalo.', 'error');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Scanner & Audit Control Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <form onSubmit={handleScanSubmit} className="flex-1 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Skenování čárového kódu (EAN / SKU čtečkou nebo ručně + Enter)
              </label>
              <div className="relative">
                <ScanBarcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={scanRef}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="Naskenujte EAN nebo zadejte SKU a stiskněte Enter (+1 ks)…"
                  className="w-full pl-9 pr-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
                />
              </div>
            </div>
            <button
              type="submit"
              className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap"
            >
              +1 započítat
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={docRef}
              onChange={(e) => setDocRef(e.target.value)}
              placeholder="Název inventury"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg w-44"
            />
            <button
              type="button"
              onClick={handleZeroAllForFullScan}
              className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
              title="Nastaví všechny skutečné stavy na 0 pro kompletní fyzické přepočítání čtečkou"
            >
              Vynulovat pro plný sken
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </button>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4 text-xs tabular-nums">
            <label className="inline-flex items-center gap-1.5 text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyDiffs}
                onChange={(e) => setOnlyDiffs(e.target.checked)}
                className="rounded border-slate-300"
              />
              Jen položky s rozdílem ({summary.diffCount})
            </label>
            <span className="text-emerald-700 font-medium">
              Přebytky: +{formatCzk(summary.surplusValue)}
            </span>
            <span className="text-red-700 font-medium">
              Manka: {formatCzk(summary.shortageValue)}
            </span>
            <span className="font-semibold text-slate-900">
              Čistý rozdíl: {summary.netValue >= 0 ? '+' : ''}
              {formatCzk(summary.netValue)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportAuditCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <Download className="w-3.5 h-3.5" />
              Protokol CSV
            </button>
            <button
              type="button"
              disabled={committing || summary.diffCount === 0}
              onClick={handleCommitAudit}
              style={{ backgroundColor: accentColor }}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-50"
            >
              {committing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Uzavřít inventuru ({summary.diffCount} rozdílů)
            </button>
          </div>
        </div>
      </div>

      {/* Audit Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-12 text-center">
            <ClipboardCheck className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-slate-900">
              {onlyDiffs ? 'Žádné inventurní rozdíly' : 'Žádné položky pro inventuru'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Položka / SKU / EAN</th>
                  <th className="py-3 px-4">Sklad</th>
                  <th className="py-3 px-4 text-right">Evidovaný stav</th>
                  <th className="py-3 px-4 text-right w-36">Skutečný stav</th>
                  <th className="py-3 px-4 text-right">Rozdíl</th>
                  <th className="py-3 px-4 text-right">Hodnota rozdílu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {rows.map(({ item, counted, delta, diffValue }) => (
                  <tr
                    key={item.id}
                    className={
                      lastScannedId === item.id
                        ? 'bg-emerald-50/60'
                        : delta !== 0
                          ? 'bg-amber-50/40'
                          : 'hover:bg-slate-50/50'
                    }
                  >
                    <td className="py-2.5 px-4">
                      <p className="font-medium text-slate-900">{item.name}</p>
                      <p className="text-xs text-slate-500 font-mono">
                        {item.sku}
                        {item.ean ? ` · EAN ${item.ean}` : ''}
                      </p>
                    </td>
                    <td className="py-2.5 px-4 text-xs text-slate-600">
                      {whMap.get(item.warehouseId) || item.warehouseId}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-slate-600">
                      {formatQty(item.quantity)} {item.unit}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <QtyInput
                          value={counted}
                          onValueChange={(cleaned) =>
                            setCounts((prev) => ({
                              ...prev,
                              [item.id]: parseQtyNumber(cleaned),
                            }))
                          }
                          className="w-24 px-2 py-1 text-sm text-right border border-slate-200 rounded-md tabular-nums bg-white"
                        />
                        <span className="text-xs text-slate-500">{item.unit}</span>
                      </div>
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-semibold tabular-nums whitespace-nowrap ${
                        delta > 0
                          ? 'text-emerald-700'
                          : delta < 0
                            ? 'text-red-700'
                            : 'text-slate-400'
                      }`}
                    >
                      {delta > 0 ? `+${formatQty(delta)}` : formatQty(delta)} {item.unit}
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right text-xs font-medium tabular-nums whitespace-nowrap ${
                        diffValue > 0
                          ? 'text-emerald-700'
                          : diffValue < 0
                            ? 'text-red-700'
                            : 'text-slate-400'
                      }`}
                    >
                      {diffValue > 0 ? `+${formatCzk(diffValue)}` : formatCzk(diffValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
