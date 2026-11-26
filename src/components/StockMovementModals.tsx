import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, Edit3, Link2, Loader2, Search, Trash2, X } from 'lucide-react';
import { QtyInput, parseQtyNumber } from './QtyInput';
import { deleteStockMovements, updateStockMovement } from '../lib/firestoreService';
import { formatCzk, formatQty, formatTimestampCz, round2 } from '../lib/format';
import type { InventoryItem, MovementType, StockMovement, Warehouse, Workspace } from '../types';

interface EditMovementModalProps {
  workspace: Workspace;
  movement: StockMovement;
  inventory: InventoryItem[];
  warehouses: Warehouse[];
  accentColor: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

export function EditMovementModal({
  workspace,
  movement,
  inventory,
  warehouses,
  accentColor,
  onClose,
  onSaved,
  onError,
}: EditMovementModalProps) {
  const existingCard = useMemo(
    () => (movement.itemId ? inventory.find((i) => i.id === movement.itemId) || null : null),
    [inventory, movement.itemId]
  );

  const initialDirection: 'IN' | 'OUT' = movement.quantityDelta < 0 ? 'OUT' : 'IN';
  const [movementType, setMovementType] = useState<MovementType>(movement.movementType || (initialDirection === 'IN' ? 'RECEIPT' : 'ISSUE'));
  const [direction, setDirection] = useState<'IN' | 'OUT'>(initialDirection);
  const [itemName, setItemName] = useState(movement.itemName || '');
  const [itemSku, setItemSku] = useState(movement.itemSku || '');
  const [warehouseId, setWarehouseId] = useState(
    movement.warehouseId || warehouses[0]?.id || 'shared_main'
  );
  const [targetItemId, setTargetItemId] = useState<string>(existingCard ? existingCard.id : '');
  const [cardSearch, setCardSearch] = useState('');
  const [qtyStr, setQtyStr] = useState(String(Math.abs(movement.quantityDelta || 0)));
  const [unit, setUnit] = useState(movement.unit || 'ks');
  const [unitPriceStr, setUnitPriceStr] = useState(String(movement.unitPrice ?? 0));
  const [documentRef, setDocumentRef] = useState(movement.documentRef || '');
  const [note, setNote] = useState(movement.note || '');
  const [adjustLinkedStock, setAdjustLinkedStock] = useState<boolean>(Boolean(existingCard));
  const [saving, setSaving] = useState(false);

  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);

  const filteredCards = useMemo(() => {
    const q = cardSearch.trim().toLowerCase();
    const sorted = [...inventory].sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    if (!q) return sorted;
    return sorted.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        (i.ean || '').toLowerCase().includes(q)
    );
  }, [inventory, cardSearch]);

  const selectedCard = useMemo(
    () => (targetItemId ? inventory.find((i) => i.id === targetItemId) || null : null),
    [inventory, targetItemId]
  );

  const handleCardSelect = (newId: string) => {
    setTargetItemId(newId);
    const chosen = newId ? inventory.find((i) => i.id === newId) : undefined;
    if (chosen) {
      setWarehouseId(chosen.warehouseId || warehouseId);
      setAdjustLinkedStock(true);
    }
  };

  const syncFromSelectedCard = () => {
    if (!selectedCard) return;
    setItemName(selectedCard.name);
    setItemSku(selectedCard.sku);
    setUnit(selectedCard.unit || 'ks');
    setWarehouseId(selectedCard.warehouseId || warehouseId);
  };

  const handleTypeChange = (nextType: MovementType) => {
    setMovementType(nextType);
    if (nextType === 'RECEIPT') setDirection('IN');
    else if (nextType === 'ISSUE') setDirection('OUT');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = itemName.trim();
    if (!cleanName) {
      onError('Zadejte název položky.');
      return;
    }
    const absQty = parseQtyNumber(qtyStr);
    if (absQty <= 0) {
      onError('Množství musí být větší než 0.');
      return;
    }
    const signedDelta = direction === 'OUT' ? -round2(absQty) : round2(absQty);
    const parsedPrice = Math.max(0, round2(Number(unitPriceStr.replace(',', '.')) || 0));

    setSaving(true);
    try {
      await updateStockMovement({
        workspace,
        movement,
        existingInventory: inventory,
        patch: {
          itemName: cleanName,
          itemSku: itemSku.trim(),
          warehouseId,
          movementType,
          quantityDelta: signedDelta,
          unit: unit.trim() || 'ks',
          unitPrice: parsedPrice,
          documentRef: documentRef.trim(),
          note: note.trim(),
          targetItemId: targetItemId || '',
        },
        adjustLinkedStock,
      });
      onSaved(
        adjustLinkedStock && (existingCard || selectedCard)
          ? `Pohyb „${cleanName}“ byl upraven a stav skladu byl přepočítán.`
          : `Pohyb „${cleanName}“ byl ručně upraven.`
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Úprava pohybu selhala.');
    } finally {
      setSaving(false);
    }
  };

  const parsedAbsQty = parseQtyNumber(qtyStr);
  const signedPreview = direction === 'OUT' ? -round2(parsedAbsQty) : round2(parsedAbsQty);
  const pricePreview = Math.max(0, round2(Number(unitPriceStr.replace(',', '.')) || 0));

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <Edit3 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900 truncate">
                Ruční úprava skladového pohybu
              </h3>
              <p className="text-xs text-slate-500">
                Vytvořeno {formatTimestampCz(movement.createdAt)} · původně{' '}
                {movement.quantityDelta > 0 ? '+' : ''}
                {formatQty(movement.quantityDelta)} {movement.unit}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
            aria-label="Zavřít"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto p-5 space-y-4">
          {/* Movement type & direction */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Typ pohybu</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: 'RECEIPT', label: 'Příjem (+)' },
                    { id: 'ISSUE', label: 'Výdej (−)' },
                    { id: 'ADJUSTMENT', label: 'Korekce' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleTypeChange(opt.id)}
                    className={`px-2 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      movementType === opt.id
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {movementType === 'ADJUSTMENT' && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Směr korekce
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDirection('IN')}
                    className={`px-2 py-1.5 text-xs font-medium rounded-lg border ${
                      direction === 'IN'
                        ? 'bg-emerald-700 text-white border-emerald-700'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    + Přičíst na sklad
                  </button>
                  <button
                    type="button"
                    onClick={() => setDirection('OUT')}
                    className={`px-2 py-1.5 text-xs font-medium rounded-lg border ${
                      direction === 'OUT'
                        ? 'bg-amber-700 text-white border-amber-700'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    − Odečíst ze skladu
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Sklad</label>
              <select
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/15"
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Item Name & SKU */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Název položky *
              </label>
              <input
                type="text"
                required
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15"
                placeholder="Např. Oxva Xlim Go Lite Mist White"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">SKU / kód</label>
              <input
                type="text"
                value={itemSku}
                onChange={(e) => setItemSku(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15"
                placeholder="Např. OXV-GL-MW"
              />
            </div>
          </div>

          {/* Quantity, Unit, Unit Price */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Množství ({direction === 'OUT' ? '−' : '+'}) *
              </label>
              <QtyInput
                value={qtyStr}
                onValueChange={setQtyStr}
                placeholder="Počet"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-slate-900/15"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Jednotka (MJ)</label>
              <input
                type="text"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15"
                placeholder="ks"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Jednotková cena (Kč)
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={unitPriceStr}
                onChange={(e) => setUnitPriceStr(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-slate-900/15"
                placeholder="0"
              />
            </div>
          </div>

          {/* Linked inventory card picker */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Link2 className="w-3.5 h-3.5 text-slate-500" />
                Připojená skladová karta
              </label>
              {selectedCard && (
                <button
                  type="button"
                  onClick={syncFromSelectedCard}
                  className="text-[11px] font-medium text-slate-700 hover:text-slate-950 underline"
                >
                  Přepsat název a SKU podle karty
                </button>
              )}
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={cardSearch}
                onChange={(e) => setCardSearch(e.target.value)}
                placeholder="Filtrovat skladovou kartu podle názvu, SKU nebo EAN…"
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/10"
              />
            </div>

            <select
              value={targetItemId}
              onChange={(e) => handleCardSelect(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-slate-900/15"
            >
              <option value="">— Nepřipojeno k žádné kartě (pouze záznam v deníku) —</option>
              {filteredCards.slice(0, 250).map((card) => (
                <option key={card.id} value={card.id}>
                  {card.name} [{card.sku}] · {whMap.get(card.warehouseId) || card.warehouseId} ·{' '}
                  {formatQty(card.quantity)} {card.unit}
                </option>
              ))}
            </select>

            {(existingCard || selectedCard) && (
              <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={adjustLinkedStock}
                  onChange={(e) => setAdjustLinkedStock(e.target.checked)}
                  className="mt-0.5 rounded border-slate-300"
                />
                <span className="text-xs text-slate-700 leading-relaxed">
                  <strong>Promítnout změnu i do stavu skladové karty</strong>
                  <span className="block text-[11px] text-slate-500">
                    {existingCard && selectedCard && existingCard.id === selectedCard.id
                      ? `Rozdíl množství (${signedPreview - movement.quantityDelta >= 0 ? '+' : ''}${formatQty(
                          round2(signedPreview - movement.quantityDelta)
                        )} ${unit}) se automaticky upraví na kartě „${selectedCard.name}“.`
                      : existingCard && selectedCard
                        ? `Odečte původní pohyb z „${existingCard.name}“ a přičte nový pohyb na „${selectedCard.name}“.`
                        : !existingCard && selectedCard
                          ? `Přičte ${signedPreview >= 0 ? '+' : ''}${formatQty(signedPreview)} ${unit} ke kartě „${selectedCard.name}“.`
                          : existingCard
                            ? `Odpojí pohyb od karty „${existingCard.name}“ a vrátí původní množství zpět.`
                            : ''}
                  </span>
                </span>
              </label>
            )}
          </div>

          {/* Document Ref & Note */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Číslo dokladu</label>
              <input
                type="text"
                value={documentRef}
                onChange={(e) => setDocumentRef(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15"
                placeholder="Např. 20260214"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15"
                placeholder="Volitelná poznámka"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-200">
            <p className="text-xs text-slate-500 tabular-nums">
              Celkem:{' '}
              <strong className="text-slate-900">
                {formatCzk(Math.abs(signedPreview) * pricePreview)}
              </strong>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
              >
                Zrušit
              </button>
              <button
                type="submit"
                disabled={saving}
                style={{ backgroundColor: accentColor }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                {saving ? 'Ukládám…' : 'Uložit změny'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DeleteMovementModalProps {
  workspace: Workspace;
  movements: StockMovement[];
  inventory: InventoryItem[];
  title?: string;
  onClose: () => void;
  onDeleted: (message: string) => void;
  onError: (message: string) => void;
}

export function DeleteMovementModal({
  workspace,
  movements,
  inventory,
  title,
  onClose,
  onDeleted,
  onError,
}: DeleteMovementModalProps) {
  const inventoryById = useMemo(() => new Map(inventory.map((i) => [i.id, i])), [inventory]);
  const linkedCount = useMemo(
    () => movements.filter((m) => m.itemId && inventoryById.has(m.itemId)).length,
    [movements, inventoryById]
  );

  const [revertStock, setRevertStock] = useState<boolean>(false);
  const [deleting, setDeleting] = useState(false);

  const isBulk = movements.length > 1;
  const single = movements[0];

  const handleConfirm = async () => {
    setDeleting(true);
    try {
      const count = await deleteStockMovements({
        workspace,
        movements,
        existingInventory: inventory,
        revertStock: linkedCount > 0 ? revertStock : false,
      });
      onDeleted(
        isBulk
          ? `Odstraněno ${count} skladových pohybů${linkedCount > 0 && revertStock ? ' a stav skladu byl vrácen zpět' : ''}.`
          : `Pohyb „${single.itemName}“ byl odstraněn${linkedCount > 0 && revertStock ? ' a stav karty byl vrácen zpět' : ''}.`
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Odstranění pohybu selhalo.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="p-5 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-900">
                {title ||
                  (isBulk
                    ? `Odstranit ${movements.length} skladových pohybů?`
                    : 'Odstranit skladový pohyb?')}
              </h3>
              {isBulk ? (
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Chystáte se trvale odstranit <strong>{movements.length}</strong> záznamů z deníku
                  pohybů. Tato akce je nevratná.
                </p>
              ) : (
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  <strong>{single.itemName}</strong> ({single.quantityDelta > 0 ? '+' : ''}
                  {formatQty(single.quantityDelta)} {single.unit}
                  {single.documentRef ? ` · doklad ${single.documentRef}` : ''}) bude trvale
                  odstraněn z deníku pohybů.
                </p>
              )}
            </div>
          </div>

          {linkedCount > 0 && (
            <label className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={revertStock}
                onChange={(e) => setRevertStock(e.target.checked)}
                className="mt-0.5 rounded border-amber-400"
              />
              <span className="text-xs text-amber-950 leading-relaxed">
                <strong>Vrátit množství zpět i na skladové kartě</strong>
                <span className="block text-[11px] text-amber-800 mt-0.5">
                  {isBulk
                    ? `U ${linkedCount} připojených pohybů odečte příjmy / vrátí výdeje ze stavu karet ve skladu.`
                    : `Odečte ${single.quantityDelta > 0 ? `+${formatQty(single.quantityDelta)}` : formatQty(single.quantityDelta)} ${single.unit} ze stavu připojené skladové karty.`}
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg"
          >
            Zrušit
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={handleConfirm}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-60"
          >
            {deleting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            {deleting
              ? 'Odstraňuji…'
              : isBulk
                ? `Odstranit (${movements.length})`
                : 'Odstranit pohyb'}
          </button>
        </div>
      </div>
    </div>
  );
}
