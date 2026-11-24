import React, { useState } from 'react';
import { Copy, Layers, Loader2, Percent, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { QtyInput } from './QtyInput';
import {
  bulkAdjustInventoryQuantity,
  bulkDeleteInventoryItems,
  bulkDuplicateInventoryItems,
  bulkEditInventoryFields,
  bulkUpdateInventoryPrices,
} from '../lib/firestoreService';
import { formatCzk, formatQty, round2 } from '../lib/format';
import type { InventoryItem, Warehouse, Workspace } from '../types';

export type BulkActionModalType = 'PRICES' | 'QUANTITY' | 'FIELDS' | 'DUPLICATE' | 'DELETE' | null;

interface InventoryBulkModalsProps {
  modal: BulkActionModalType;
  selectedItems: InventoryItem[];
  warehouses: Warehouse[];
  existingCategories?: string[];
  workspace: Workspace;
  activeCompanyId: string;
  accentColor: string;
  onClose: () => void;
  onCompleted: (message: string, clearSelection?: boolean) => void;
  onError: (message: string) => void;
}

export function InventoryBulkModals({
  modal,
  selectedItems,
  warehouses,
  existingCategories = [],
  workspace,
  activeCompanyId,
  accentColor,
  onClose,
  onCompleted,
  onError,
}: InventoryBulkModalsProps) {
  const [busy, setBusy] = useState(false);

  // Prices state
  const [priceTarget, setPriceTarget] = useState<'SALE' | 'PURCHASE' | 'BOTH'>('SALE');
  const [priceMode, setPriceMode] = useState<'PERCENT' | 'DELTA' | 'SET' | 'MARGIN_FROM_PURCHASE'>(
    'PERCENT'
  );
  const [priceValue, setPriceValue] = useState('10');

  // Quantity state
  const [qtyMode, setQtyMode] = useState<'ADD' | 'SUBTRACT' | 'SET'>('ADD');
  const [qtyValue, setQtyValue] = useState('1');
  const [qtyDocRef, setQtyDocRef] = useState('Hromadná úprava');
  const [qtyNote, setQtyNote] = useState('');

  // Fields state (opt-in per field)
  const [editCategory, setEditCategory] = useState(false);
  const [categoryVal, setCategoryVal] = useState('');
  const [editVat, setEditVat] = useState(false);
  const [vatVal, setVatVal] = useState(21);
  const [editWarehouse, setEditWarehouse] = useState(false);
  const [warehouseVal, setWarehouseVal] = useState(warehouses[0]?.id || 'shared_main');
  const [editSupplier, setEditSupplier] = useState(false);
  const [supplierVal, setSupplierVal] = useState('');
  const [editMinQty, setEditMinQty] = useState(false);
  const [minQtyVal, setMinQtyVal] = useState('5');
  const [editUnit, setEditUnit] = useState(false);
  const [unitVal, setUnitVal] = useState('ks');

  // Duplicate state
  const [dupWarehouseId, setDupWarehouseId] = useState(warehouses[0]?.id || 'shared_main');
  const [dupResetQty, setDupResetQty] = useState(true);
  const [dupSkuSuffix, setDupSkuSuffix] = useState('-KOP');

  if (!modal || selectedItems.length === 0) return null;

  const sample = selectedItems[0];
  const parsedPriceVal = Number(priceValue.replace(',', '.')) || 0;
  const previewPrice = (() => {
    if (priceMode === 'MARGIN_FROM_PURCHASE') {
      return Math.max(0, round2(sample.purchasePrice * (1 + parsedPriceVal / 100)));
    }
    const base = priceTarget === 'PURCHASE' ? sample.purchasePrice : sample.salePrice;
    if (priceMode === 'PERCENT') return Math.max(0, round2(base * (1 + parsedPriceVal / 100)));
    if (priceMode === 'DELTA') return Math.max(0, round2(base + parsedPriceVal));
    return Math.max(0, round2(parsedPriceVal));
  })();

  const handlePricesSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const count = await bulkUpdateInventoryPrices({
        workspace,
        items: selectedItems,
        targetField: priceTarget,
        mode: priceMode,
        value: parsedPriceVal,
      });
      onCompleted(`Ceny byly hromadně upraveny u ${count} položek.`, true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Hromadná úprava cen selhala.');
    } finally {
      setBusy(false);
    }
  };

  const handleQtySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = Number(qtyValue.replace(',', '.'));
    if (!Number.isFinite(val) || (qtyMode !== 'SET' && val <= 0)) {
      onError('Zadejte platné množství.');
      return;
    }
    setBusy(true);
    try {
      const count = await bulkAdjustInventoryQuantity({
        workspace,
        items: selectedItems,
        activeCompanyId,
        mode: qtyMode,
        value: val,
        documentRef: qtyDocRef,
        note: qtyNote,
      });
      onCompleted(`Množství bylo upraveno u ${count} položek a zapsáno do deníku pohybů.`, true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Hromadná úprava množství selhala.');
    } finally {
      setBusy(false);
    }
  };

  const handleFieldsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const patch: Parameters<typeof bulkEditInventoryFields>[0]['patch'] = {};
    if (editCategory) patch.category = categoryVal;
    if (editVat) patch.vatRate = vatVal;
    if (editWarehouse) patch.warehouseId = warehouseVal;
    if (editSupplier) patch.supplierName = supplierVal;
    if (editMinQty) patch.minQuantity = Number(minQtyVal.replace(',', '.')) || 0;
    if (editUnit) patch.unit = unitVal;

    if (Object.keys(patch).length === 0) {
      onError('Zaškrtněte alespoň jeden parametr, který chcete hromadně změnit.');
      return;
    }

    setBusy(true);
    try {
      const count = await bulkEditInventoryFields({
        workspace,
        items: selectedItems,
        patch,
      });
      onCompleted(`Parametry byly hromadně aktualizovány u ${count} položek.`, true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Hromadná editace selhala.');
    } finally {
      setBusy(false);
    }
  };

  const handleDuplicateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const count = await bulkDuplicateInventoryItems({
        workspace,
        items: selectedItems,
        activeCompanyId,
        targetWarehouseId: dupWarehouseId,
        resetQuantity: dupResetQty,
        skuSuffix: dupSkuSuffix,
      });
      onCompleted(`Zkopírováno ${count} položek do zvoleného skladu.`, true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Hromadné kopírování selhalo.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSubmit = async () => {
    setBusy(true);
    try {
      const count = await bulkDeleteInventoryItems(
        workspace.id,
        selectedItems.map((i) => i.id)
      );
      onCompleted(`Odstraněno ${count} skladových položek.`, true);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Hromadné smazání selhalo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      {modal === 'PRICES' && (
        <form
          onSubmit={handlePricesSubmit}
          className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Percent className="w-4 h-4 text-slate-700" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">Hromadná úprava cen</h3>
                <p className="text-xs text-slate-500">Vybráno {selectedItems.length} položek</p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Způsob přecenění</label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['PERCENT', 'Změnit o procenta (%)'],
                  ['DELTA', 'Přičíst / odečíst Kč'],
                  ['SET', 'Nastavit pevnou cenu'],
                  ['MARGIN_FROM_PURCHASE', 'Prodej = Nákup + marže %'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPriceMode(id)}
                  className={`py-2 px-2.5 text-xs font-medium rounded-lg border text-left transition-colors ${
                    priceMode === id
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {priceMode !== 'MARGIN_FROM_PURCHASE' && (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Kterou cenu změnit</label>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['SALE', 'Prodejní'],
                    ['PURCHASE', 'Nákupní'],
                    ['BOTH', 'Obě ceny'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPriceTarget(id)}
                    className={`py-2 text-xs font-medium rounded-lg border transition-colors ${
                      priceTarget === id
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {priceMode === 'PERCENT'
                ? 'Procentuální změna (např. 10 pro +10 %, -15 pro slevu 15 %)'
                : priceMode === 'DELTA'
                  ? 'Částka v Kč bez DPH (záporná pro snížení)'
                  : priceMode === 'SET'
                    ? 'Nová pevná cena bez DPH (Kč)'
                    : 'Přirážka nad nákupní cenou v % (např. 30 pro +30 %)'}
            </label>
            <input
              type="number"
              step="any"
              required
              value={priceValue}
              onChange={(e) => setPriceValue(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
            />
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 tabular-nums">
            Ukázka na první vybrané kartě (<strong>{sample.name}</strong>):{' '}
            {priceMode === 'MARGIN_FROM_PURCHASE' ? (
              <>
                nákup {formatCzk(sample.purchasePrice)} → nový prodej{' '}
                <strong className="text-slate-900">{formatCzk(previewPrice)}</strong>
              </>
            ) : (
              <>
                {formatCzk(priceTarget === 'PURCHASE' ? sample.purchasePrice : sample.salePrice)} →{' '}
                <strong className="text-slate-900">{formatCzk(previewPrice)}</strong>
              </>
            )}
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={busy}
              style={{ backgroundColor: accentColor }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Přecenit {selectedItems.length} položek
            </button>
          </div>
        </form>
      )}

      {modal === 'QUANTITY' && (
        <form
          onSubmit={handleQtySubmit}
          className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-slate-700" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">Hromadná úprava množství</h3>
                <p className="text-xs text-slate-500">
                  Vybráno {selectedItems.length} položek · zapíše se do deníku pohybů
                </p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['ADD', '+ Přičíst'],
                ['SUBTRACT', '− Odečíst'],
                ['SET', '= Nastavit stav'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setQtyMode(id)}
                className={`py-2 text-xs font-medium rounded-lg border transition-colors ${
                  qtyMode === id
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              {qtyMode === 'SET' ? 'Nový skladový stav pro všechny vybrané karty' : 'Množství'}
            </label>
            <QtyInput
              required
              allowNegative={qtyMode === 'SET'}
              value={qtyValue}
              onValueChange={setQtyValue}
              placeholder="Zadejte číslo"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Doklad / reference</label>
              <input
                type="text"
                value={qtyDocRef}
                onChange={(e) => setQtyDocRef(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka</label>
              <input
                type="text"
                value={qtyNote}
                onChange={(e) => setQtyNote(e.target.value)}
                placeholder="Např. Inventura 2026"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-600 tabular-nums">
            Ukázka ({sample.name}): {formatQty(sample.quantity)} {sample.unit} →{' '}
            <strong className="text-slate-900">
              {formatQty(
                qtyMode === 'ADD'
                  ? round2(sample.quantity + Math.abs(Number(qtyValue.replace(',', '.')) || 0))
                  : qtyMode === 'SUBTRACT'
                    ? round2(sample.quantity - Math.abs(Number(qtyValue.replace(',', '.')) || 0))
                    : round2(Number(qtyValue.replace(',', '.')) || 0)
              )}{' '}
              {sample.unit}
            </strong>
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={busy}
              style={{ backgroundColor: accentColor }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Upravit množství ({selectedItems.length})
            </button>
          </div>
        </form>
      )}

      {modal === 'FIELDS' && (
        <form
          onSubmit={handleFieldsSubmit}
          className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-slate-700" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">Hromadná editace parametrů</h3>
                <p className="text-xs text-slate-500">
                  Zaškrtněte pouze pole, která chcete přepsat u {selectedItems.length} položek
                </p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={editWarehouse}
                onChange={(e) => setEditWarehouse(e.target.checked)}
                className="rounded border-slate-300"
              />
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Přesunout do skladu
                </label>
                <select
                  disabled={!editWarehouse}
                  value={warehouseVal}
                  onChange={(e) => setWarehouseVal(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white disabled:bg-slate-50 disabled:text-slate-400"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.shared ? 'Sdílený' : 'Oddělený'})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={editCategory}
                onChange={(e) => setEditCategory(e.target.checked)}
                className="rounded border-slate-300"
              />
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">Kategorie</label>
                <input
                  type="text"
                  list="bulk-categories-list"
                  disabled={!editCategory}
                  value={categoryVal}
                  onChange={(e) => setCategoryVal(e.target.value)}
                  placeholder="Vyberte existující nebo napište novou…"
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                />
                <datalist id="bulk-categories-list">
                  {existingCategories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={editVat}
                onChange={(e) => setEditVat(e.target.checked)}
                className="rounded border-slate-300"
              />
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">Sazba DPH</label>
                <select
                  disabled={!editVat}
                  value={vatVal}
                  onChange={(e) => setVatVal(Number(e.target.value))}
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg bg-white disabled:bg-slate-50 disabled:text-slate-400"
                >
                  <option value={21}>21 %</option>
                  <option value={12}>12 %</option>
                  <option value={0}>0 %</option>
                </select>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={editSupplier}
                onChange={(e) => setEditSupplier(e.target.checked)}
                className="rounded border-slate-300"
              />
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">Dodavatel</label>
                <input
                  type="text"
                  disabled={!editSupplier}
                  value={supplierVal}
                  onChange={(e) => setSupplierVal(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={editMinQty}
                  onChange={(e) => setEditMinQty(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Min. zásoba</label>
                  <QtyInput
                    disabled={!editMinQty}
                    value={minQtyVal}
                    onValueChange={setMinQtyVal}
                    className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg tabular-nums disabled:bg-slate-50"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={editUnit}
                  onChange={(e) => setEditUnit(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Jednotka (MJ)</label>
                  <input
                    type="text"
                    disabled={!editUnit}
                    value={unitVal}
                    onChange={(e) => setUnitVal(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={busy}
              style={{ backgroundColor: accentColor }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Použít na {selectedItems.length} položek
            </button>
          </div>
        </form>
      )}

      {modal === 'DUPLICATE' && (
        <form
          onSubmit={handleDuplicateSubmit}
          className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <Copy className="w-4 h-4 text-slate-700" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">Hromadné kopírování položek</h3>
                <p className="text-xs text-slate-500">
                  Zkopíruje {selectedItems.length} vybraných karet včetně cen, DPH a dodavatele
                </p>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Cílový sklad</label>
            <select
              value={dupWarehouseId}
              onChange={(e) => setDupWarehouseId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.shared ? 'Sdílený' : 'Oddělený'})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Přípona SKU (při kopírování do jiného skladu můžete nechat prázdné)
            </label>
            <input
              type="text"
              value={dupSkuSuffix}
              onChange={(e) => setDupSkuSuffix(e.target.value)}
              placeholder="-KOP"
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
            />
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={dupResetQty}
              onChange={(e) => setDupResetQty(e.target.checked)}
              className="rounded border-slate-300"
            />
            U zkopírovaných karet nastavit počáteční množství na 0 (doporučeno)
          </label>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={busy}
              style={{ backgroundColor: accentColor }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Zkopírovat {selectedItems.length} položek
            </button>
          </div>
        </form>
      )}

      {modal === 'DELETE' && (
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2 text-red-700">
              <Trash2 className="w-4 h-4" />
              <h3 className="text-base font-semibold">Smazat {selectedItems.length} položek?</h3>
            </div>
            <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-sm text-slate-600">
            Vybrané skladové karty budou trvale odstraněny ze skladu (historie již proběhlých pohybů a
            vystavených faktur zůstane zachována).
          </p>
          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Zrušit
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleDeleteSubmit}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-60"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Trvale smazat ({selectedItems.length})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
