import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Calculator,
  Check,
  Copy,
  Filter,
  Loader2,
  Search,
  Sparkles,
  Tag,
  X,
} from 'lucide-react';
import { QtyInput } from './QtyInput';
import { bulkApplyItemPriceChanges } from '../lib/firestoreService';
import { formatCzk, round2 } from '../lib/format';
import {
  buildChatGptPromptForInventory,
  computeItemPriceChange,
  extractQuickBrandChips,
  matchesNameQuery,
  parseBulkPriceCommands,
  type BulkPriceRule,
  type ComputedItemPriceChange,
  type PurchaseRuleMode,
  type SaleRoundingMode,
  type SaleRuleMode,
} from '../lib/priceBreakdown';
import type { InventoryItem, Warehouse, Workspace } from '../types';

interface BulkPriceEditorModalProps {
  allItems: InventoryItem[];
  preselectedItems: InventoryItem[];
  warehouses: Warehouse[];
  existingCategories: string[];
  workspace: Workspace;
  accentColor: string;
  initialTab?: 'BUILDER' | 'AI_COMMAND';
  onClose: () => void;
  onCompleted: (message: string, clearSelection?: boolean) => void;
  onError: (message: string) => void;
}

function parseOptionalNumber(raw: string): number | null {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '-' || trimmed === ',' || trimmed === '.') return null;
  const n = Number(trimmed.replace(/[\s\u00A0]+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function BulkPriceEditorModal({
  allItems,
  preselectedItems,
  warehouses,
  existingCategories,
  workspace,
  accentColor,
  initialTab = 'BUILDER',
  onClose,
  onCompleted,
  onError,
}: BulkPriceEditorModalProps) {
  const [activeTab, setActiveTab] = useState<'BUILDER' | 'AI_COMMAND'>(initialTab);
  const [busy, setBusy] = useState(false);

  // Target selection mode
  const [scopeMode, setScopeMode] = useState<'FILTER' | 'SELECTED'>(
    preselectedItems.length > 0 ? 'SELECTED' : 'FILTER'
  );
  const [nameQuery, setNameQuery] = useState('');
  const [filterCategory, setFilterCategory] = useState('ALL');
  const [filterWarehouse, setFilterWarehouse] = useState('ALL');
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

  // Purchase rule state
  const [editPurchase, setEditPurchase] = useState(true);
  const [purchaseMode, setPurchaseMode] = useState<Exclude<PurchaseRuleMode, 'NONE'>>('BREAKDOWN');
  const [goodsPriceStr, setGoodsPriceStr] = useState('');
  const [excisePriceStr, setExcisePriceStr] = useState('');
  const [purchaseValStr, setPurchaseValStr] = useState('');

  // Sale rule state
  const [editSale, setEditSale] = useState(true);
  const [saleMode, setSaleMode] = useState<Exclude<SaleRuleMode, 'NONE'>>('SET');
  const [saleValStr, setSaleValStr] = useState('');
  const [saleRounding, setSaleRounding] = useState<SaleRoundingMode>('NONE');

  // AI / ChatGPT command tab state
  const [commandText, setCommandText] = useState('');
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const quickBrands = useMemo(() => extractQuickBrandChips(allItems, 12), [allItems]);

  const hasActiveFilter =
    nameQuery.trim().length > 0 || filterCategory !== 'ALL' || filterWarehouse !== 'ALL';

  const matchedBuilderItems = useMemo(() => {
    if (scopeMode === 'SELECTED') return preselectedItems;
    if (!hasActiveFilter) return [];
    return allItems.filter((item) => {
      if (filterWarehouse !== 'ALL' && item.warehouseId !== filterWarehouse) return false;
      const cat = (item.category || '').trim();
      if (filterCategory === '__NONE__' && cat !== '') return false;
      if (filterCategory !== 'ALL' && filterCategory !== '__NONE__' && cat !== filterCategory) {
        return false;
      }
      if (nameQuery.trim() && !matchesNameQuery(item, nameQuery)) return false;
      return true;
    });
  }, [scopeMode, preselectedItems, allItems, hasActiveFilter, filterWarehouse, filterCategory, nameQuery]);

  const builderRule = useMemo<BulkPriceRule>(() => {
    const goodsPrice = parseOptionalNumber(goodsPriceStr);
    const exciseTaxPrice = parseOptionalNumber(excisePriceStr);
    const purchaseVal = parseOptionalNumber(purchaseValStr);
    const saleVal = parseOptionalNumber(saleValStr);

    return {
      purchaseMode: editPurchase ? purchaseMode : 'NONE',
      goodsPrice: editPurchase && purchaseMode === 'BREAKDOWN' ? goodsPrice : null,
      exciseTaxPrice: editPurchase && purchaseMode === 'BREAKDOWN' ? exciseTaxPrice : null,
      purchaseValue: editPurchase && purchaseMode !== 'BREAKDOWN' ? purchaseVal : null,
      saleMode: editSale ? saleMode : 'NONE',
      saleValue: editSale ? saleVal : null,
      saleRounding,
    };
  }, [
    editPurchase,
    purchaseMode,
    goodsPriceStr,
    excisePriceStr,
    purchaseValStr,
    editSale,
    saleMode,
    saleValStr,
    saleRounding,
  ]);

  const builderPreview = useMemo<ComputedItemPriceChange[]>(() => {
    return matchedBuilderItems.map((item) => computeItemPriceChange(item, builderRule));
  }, [matchedBuilderItems, builderRule]);

  const aiParsed = useMemo(
    () => parseBulkPriceCommands(commandText, allItems),
    [commandText, allItems]
  );

  const activePreviewList = activeTab === 'BUILDER' ? builderPreview : aiParsed.changes;

  const readyToApply = useMemo(
    () => activePreviewList.filter((row) => !excludedIds.has(row.item.id) && row.changed),
    [activePreviewList, excludedIds]
  );

  const toggleExclude = (id: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const appendBrandToQuery = (brand: string) => {
    setScopeMode('FILTER');
    setNameQuery((prev) => {
      const parts = prev
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const existsIdx = parts.findIndex((p) => p.toLowerCase() === brand.toLowerCase());
      if (existsIdx >= 0) {
        parts.splice(existsIdx, 1);
      } else {
        parts.push(brand);
      }
      return parts.join(', ');
    });
  };

  const handleCopyChatGptPrompt = async () => {
    const prompt = buildChatGptPromptForInventory(allItems);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 2600);
    } catch {
      onError('Nepodařilo se zkopírovat do schránky. Zkuste to prosím znovu.');
    }
  };

  const handleInsertSampleCommand = () => {
    const sampleBrand1 = quickBrands[0]?.label || 'elfliq';
    const sampleBrand2 = quickBrands[1]?.label || 'venix nex';
    setCommandText(
      [
        `${sampleBrand1}: zboží 55, kolek 35, prodej 129`,
        `${sampleBrand2}: nákup +5 Kč, marže 30%`,
      ].join('\n')
    );
  };

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readyToApply.length === 0) {
      onError('Žádná vybraná položka nemá změnu ceny k uložení.');
      return;
    }

    setBusy(true);
    try {
      const count = await bulkApplyItemPriceChanges({
        workspace,
        changes: readyToApply.map((row) => ({
          itemId: row.item.id,
          purchasePrice: row.newPurchasePrice,
          salePrice: row.newSalePrice,
          notes: row.newNotes,
        })),
      });
      onCompleted(
        `Hromadné přecenění uloženo u ${count} ${count === 1 ? 'položky' : count < 5 ? 'položek' : 'položek'}.`,
        scopeMode === 'SELECTED'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Hromadná úprava cen selhala.');
    } finally {
      setBusy(false);
    }
  };

  const liveBreakdownSum = useMemo(() => {
    const g = parseOptionalNumber(goodsPriceStr);
    const ex = parseOptionalNumber(excisePriceStr);
    if (g === null && ex === null) return null;
    return round2((g ?? 0) + (ex ?? 0));
  }, [goodsPriceStr, excisePriceStr]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/55 flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
      <form
        onSubmit={handleApply}
        className="w-full max-w-5xl bg-white border border-slate-200 rounded-xl shadow-xl flex flex-col max-h-[92vh] my-auto overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2.5">
            <Calculator className="w-5 h-5 text-slate-800 shrink-0" />
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Hromadná editace cen na skladě
              </h3>
              <p className="text-xs text-slate-500">
                Měňte nákupní cenu (včetně rozpisu zboží + kolek) i prodejní cenu u označených položek nebo podle názvu.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="px-5 pt-3 pb-2 bg-slate-50/70 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="inline-flex items-center bg-slate-200/70 p-0.5 rounded-lg">
            <button
              type="button"
              onClick={() => setActiveTab('BUILDER')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                activeTab === 'BUILDER'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              Podle názvu / výběru &amp; Zboží + Kolek
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('AI_COMMAND')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                activeTab === 'AI_COMMAND'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Bot className="w-3.5 h-3.5" />
              Příkaz z ChatGPT / AI (JSON nebo text)
            </button>
          </div>
          <span className="text-xs text-slate-500 tabular-nums">
            Celkem na skladě: <strong className="text-slate-800">{allItems.length}</strong> karet
          </span>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {activeTab === 'BUILDER' ? (
            <>
              {/* Step 1: Select target items */}
              <div className="border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/40">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    1. Které položky chcete přecenit
                  </h4>
                  <div className="inline-flex items-center bg-white border border-slate-200 p-0.5 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setScopeMode('FILTER')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                        scopeMode === 'FILTER'
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Podle názvu / filtru
                    </button>
                    <button
                      type="button"
                      disabled={preselectedItems.length === 0}
                      onClick={() => setScopeMode('SELECTED')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 ${
                        scopeMode === 'SELECTED'
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Ručně označené ({preselectedItems.length})
                    </button>
                  </div>
                </div>

                {scopeMode === 'FILTER' ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
                      <div className="md:col-span-6 relative">
                        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={nameQuery}
                          onChange={(e) => setNameQuery(e.target.value)}
                          placeholder="Napište názvy oddělené čárkou, např.: elfliq, venix nex"
                          className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
                        />
                      </div>
                      <div className="md:col-span-3">
                        <select
                          value={filterCategory}
                          onChange={(e) => setFilterCategory(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="ALL">Všechny kategorie</option>
                          {existingCategories.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                          <option value="__NONE__">Bez kategorie</option>
                        </select>
                      </div>
                      <div className="md:col-span-3">
                        <select
                          value={filterWarehouse}
                          onChange={(e) => setFilterWarehouse(e.target.value)}
                          className="w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="ALL">Všechny sklady</option>
                          {warehouses.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {quickBrands.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 mr-1">
                          <Tag className="w-3 h-3" />
                          Rychlý výběr značek:
                        </span>
                        {quickBrands.map((b) => {
                          const active = nameQuery
                            .split(',')
                            .map((s) => s.trim().toLowerCase())
                            .includes(b.label.toLowerCase());
                          return (
                            <button
                              key={b.label}
                              type="button"
                              onClick={() => appendBrandToQuery(b.label)}
                              className={`px-2 py-0.5 text-xs font-medium rounded-md border transition-colors tabular-nums ${
                                active
                                  ? 'bg-slate-900 text-white border-slate-900'
                                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {b.label} ({b.count})
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-600">
                    Úprava se použije na <strong>{preselectedItems.length}</strong> ručně zaškrtnutých položek ze seznamu skladu.
                  </p>
                )}
              </div>

              {/* Step 2: Purchase & Sale rules side by side */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Purchase price card */}
                <div
                  className={`border rounded-xl p-4 space-y-3 transition-colors ${
                    editPurchase ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50/50 opacity-70'
                  }`}
                >
                  <label className="flex items-center justify-between gap-2 cursor-pointer">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-800">
                      <input
                        type="checkbox"
                        checked={editPurchase}
                        onChange={(e) => setEditPurchase(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      2A. Nákupní cena (bez DPH)
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {editPurchase ? 'Aktivní' : 'Neměnit'}
                    </span>
                  </label>

                  {editPurchase && (
                    <>
                      <div className="grid grid-cols-2 gap-1.5">
                        {(
                          [
                            ['BREAKDOWN', 'Zboží + Kolek = Nákup'],
                            ['SET', 'Pevný nákup (Kč)'],
                            ['PERCENT', 'Změna o %'],
                            ['DELTA', 'Přičíst / odečíst Kč'],
                          ] as const
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setPurchaseMode(id)}
                            className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border text-left transition-colors ${
                              purchaseMode === id
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      {purchaseMode === 'BREAKDOWN' ? (
                        <div className="space-y-2.5 pt-1">
                          <div className="grid grid-cols-2 gap-2.5">
                            <div>
                              <label className="block text-xs font-medium text-slate-700 mb-1">
                                Cena zboží (Kč)
                              </label>
                              <QtyInput
                                value={goodsPriceStr}
                                onValueChange={setGoodsPriceStr}
                                placeholder="ponechat stávající"
                                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-700 mb-1">
                                Cena kolku (Kč)
                              </label>
                              <QtyInput
                                value={excisePriceStr}
                                onValueChange={setExcisePriceStr}
                                placeholder="např. 35"
                                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs tabular-nums">
                            <span className="text-slate-600">
                              Výsledná nákupní cena (Zboží + Kolek):
                            </span>
                            <strong className="text-slate-900">
                              {liveBreakdownSum !== null ? formatCzk(liveBreakdownSum) : '—'}
                            </strong>
                          </div>
                          <p className="text-[11px] text-slate-500">
                            Tip: Pokud vyplníte jen <strong>kolek</strong>, aplikace přičte nový kolek ke stávající ceně zboží u každé položky zvlášť.
                          </p>
                        </div>
                      ) : (
                        <div className="pt-1">
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            {purchaseMode === 'SET'
                              ? 'Nová pevná nákupní cena bez DPH (Kč)'
                              : purchaseMode === 'PERCENT'
                                ? 'Změna v % (např. 10 pro +10 %, -5 pro −5 %)'
                                : 'Rozdíl v Kč (např. 35 pro +35 Kč, -10 pro −10 Kč)'}
                          </label>
                          <QtyInput
                            allowNegative={purchaseMode !== 'SET'}
                            value={purchaseValStr}
                            onValueChange={setPurchaseValStr}
                            placeholder={purchaseMode === 'PERCENT' ? 'např. 10 nebo -5' : 'Zadejte částku'}
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Sale price card */}
                <div
                  className={`border rounded-xl p-4 space-y-3 transition-colors ${
                    editSale ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50/50 opacity-70'
                  }`}
                >
                  <label className="flex items-center justify-between gap-2 cursor-pointer">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-800">
                      <input
                        type="checkbox"
                        checked={editSale}
                        onChange={(e) => setEditSale(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      2B. Prodejní cena
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {editSale ? 'Aktivní' : 'Neměnit'}
                    </span>
                  </label>

                  {editSale && (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                        {(
                          [
                            ['SET', 'Pevná bez DPH'],
                            ['SET_WITH_VAT', 'Pevná s DPH'],
                            ['MARGIN_FROM_PURCHASE', 'Nákup + marže %'],
                            ['MARKUP_FROM_PURCHASE', 'Nákup + Kč'],
                            ['PERCENT', 'Změna o %'],
                            ['DELTA', 'Přičíst / odečíst Kč'],
                          ] as const
                        ).map(([id, label]) => (
                          <button
                            key={id}
                            type="button"
                            onClick={() => setSaleMode(id)}
                            className={`px-2 py-1.5 text-xs font-medium rounded-lg border text-left transition-colors ${
                              saleMode === id
                                ? 'bg-slate-900 text-white border-slate-900'
                                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 pt-1">
                        <div className="sm:col-span-7">
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            {saleMode === 'SET'
                              ? 'Nová prodejní cena bez DPH (Kč)'
                              : saleMode === 'SET_WITH_VAT'
                                ? 'Nová prodejní cena s DPH (Kč)'
                                : saleMode === 'MARGIN_FROM_PURCHASE'
                                  ? 'Přirážka nad nákupem (%)'
                                  : saleMode === 'MARKUP_FROM_PURCHASE'
                                    ? 'Přirážka nad nákupem (Kč)'
                                    : saleMode === 'PERCENT'
                                      ? 'Změna stávající ceny (%)'
                                      : 'Přičíst / odečíst (Kč)'}
                          </label>
                          <QtyInput
                            allowNegative={saleMode === 'PERCENT' || saleMode === 'DELTA'}
                            value={saleValStr}
                            onValueChange={setSaleValStr}
                            placeholder={
                              saleMode === 'MARGIN_FROM_PURCHASE'
                                ? 'např. 30'
                                : saleMode === 'SET_WITH_VAT'
                                  ? 'např. 149'
                                  : 'Zadejte číslo'
                            }
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                          />
                        </div>
                        <div className="sm:col-span-5">
                          <label className="block text-xs font-medium text-slate-700 mb-1">
                            Zaokrouhlení
                          </label>
                          <select
                            value={saleRounding}
                            onChange={(e) => setSaleRounding(e.target.value as SaleRoundingMode)}
                            className="w-full px-2.5 py-2 text-sm bg-white border border-slate-200 rounded-lg"
                          >
                            <option value="NONE">Přesně (haléře)</option>
                            <option value="WHOLE">Celé Kč</option>
                            <option value="ENDING_90">Na ,90 Kč</option>
                          </select>
                        </div>
                      </div>
                      {(saleMode === 'MARGIN_FROM_PURCHASE' || saleMode === 'MARKUP_FROM_PURCHASE') && (
                        <p className="text-[11px] text-slate-500">
                          Počítá se rovnou z <strong>nové výsledné nákupní ceny</strong> (včetně zboží + kolku z levého boxu).
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            /* AI / ChatGPT Command Import Tab */
            <div className="space-y-4">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-start gap-2">
                    <Sparkles className="w-4 h-4 text-emerald-700 mt-0.5 shrink-0" />
                    <div className="text-xs text-slate-700">
                      <p className="font-semibold text-slate-900">
                        Bezpečné propojení s ChatGPT / jinou AI (s živou kontrolou před uložením)
                      </p>
                      <p className="mt-0.5 text-slate-600">
                        Kolega může zadat svému ChatGPT změny cen (nebo nahrát dodavatelský ceník), zkopírovat vygenerovaný JSON sem a jedním kliknutím po kontrole náhledu uložit do sdílené databáze. Funguje i rychlý český zápis po řádcích.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={handleCopyChatGptPrompt}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap"
                    >
                      {copiedPrompt ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      {copiedPrompt ? 'Zadání zkopírováno!' : 'Kopírovat zadání pro ChatGPT'}
                    </button>
                    <button
                      type="button"
                      onClick={handleInsertSampleCommand}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg whitespace-nowrap"
                    >
                      Vložit ukázku
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Vložte JSON z ChatGPT nebo napište pravidla po řádcích (např. <span className="font-mono">elfliq: zboží 55, kolek 35, prodej 129</span>)
                </label>
                <textarea
                  rows={5}
                  value={commandText}
                  onChange={(e) => setCommandText(e.target.value)}
                  placeholder={`elfliq: zboží 55, kolek 35, prodej 129\nvenix nex: nákup 85, marže 35%\n\nnebo vložte JSON pole z ChatGPT…`}
                  className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white focus:outline-none focus:border-slate-400"
                />
              </div>

              {aiParsed.warnings.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-1 text-xs text-amber-900">
                  {aiParsed.warnings.map((w, i) => (
                    <p key={i} className="flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Live Preview Table */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                Náhled dotčených položek ({activePreviewList.length})
              </h4>
              <span className="text-xs text-slate-600 tabular-nums">
                K uložení se změnou: <strong className="text-emerald-700">{readyToApply.length}</strong>
              </span>
            </div>

            {activePreviewList.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-500">
                {activeTab === 'BUILDER'
                  ? scopeMode === 'FILTER' && !hasActiveFilter
                    ? 'Napište alespoň jeden název produktu (např. elfliq, venix nex) nebo zvolte kategorii / značku výše.'
                    : 'Zadanému filtru neodpovídá žádná skladová karta.'
                  : 'Vložte příkaz z ChatGPT nebo napište pravidlo po řádcích — zde se okamžitě zobrazí přesný náhled změn před uložením.'}
              </div>
            ) : (
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-white border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="py-2 pl-3 pr-2 w-8"></th>
                      <th className="py-2 px-3">Položka</th>
                      <th className="py-2 px-3 text-right">Nákup bez DPH</th>
                      <th className="py-2 px-3 text-right">Prodej bez DPH</th>
                      <th className="py-2 px-3 text-right">Prodej s DPH / Marže</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {activePreviewList.map((row) => {
                      const isIncluded = !excludedIds.has(row.item.id);
                      const purchaseChanged =
                        row.newPurchasePrice !== row.oldPurchasePrice ||
                        row.newGoodsPrice !== row.oldGoodsPrice ||
                        row.newExciseTaxPrice !== row.oldExciseTaxPrice;
                      const saleChanged = row.newSalePrice !== row.oldSalePrice;
                      const vatMul = 1 + (row.item.vatRate || 0) / 100;
                      const newSaleWithVat = round2(row.newSalePrice * vatMul);
                      const marginPct =
                        row.newPurchasePrice > 0
                          ? round2(((row.newSalePrice - row.newPurchasePrice) / row.newPurchasePrice) * 100)
                          : null;

                      return (
                        <tr
                          key={row.item.id}
                          className={
                            !isIncluded
                              ? 'opacity-45 bg-slate-50'
                              : row.changed
                                ? 'bg-emerald-50/25 hover:bg-emerald-50/50'
                                : 'hover:bg-slate-50/60'
                          }
                        >
                          <td className="py-2 pl-3 pr-2">
                            <input
                              type="checkbox"
                              checked={isIncluded}
                              onChange={() => toggleExclude(row.item.id)}
                              className="rounded border-slate-300 cursor-pointer"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <p className="font-medium text-slate-900">{row.item.name}</p>
                            <p className="text-[11px] text-slate-500 font-mono">
                              {row.item.sku}
                              {row.item.category ? ` · ${row.item.category}` : ''}
                            </p>
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                            <div className="inline-flex items-center gap-1 justify-end">
                              <span className="text-slate-500">{formatCzk(row.oldPurchasePrice)}</span>
                              {purchaseChanged && (
                                <>
                                  <ArrowRight className="w-3 h-3 text-slate-400" />
                                  <strong className="text-slate-900">
                                    {formatCzk(row.newPurchasePrice)}
                                  </strong>
                                </>
                              )}
                            </div>
                            {(row.newGoodsPrice !== null || row.newExciseTaxPrice !== null) && (
                              <p className="text-[10px] text-emerald-700 mt-0.5">
                                Zboží {formatCzk(row.newGoodsPrice ?? 0)} + kolek{' '}
                                {formatCzk(row.newExciseTaxPrice ?? 0)}
                              </p>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                            <div className="inline-flex items-center gap-1 justify-end">
                              <span className="text-slate-500">{formatCzk(row.oldSalePrice)}</span>
                              {saleChanged && (
                                <>
                                  <ArrowRight className="w-3 h-3 text-slate-400" />
                                  <strong className="text-emerald-800">
                                    {formatCzk(row.newSalePrice)}
                                  </strong>
                                </>
                              )}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                            <p className="text-slate-800 font-medium">
                              {formatCzk(newSaleWithVat)}
                            </p>
                            <p className="text-[10px] text-slate-500">
                              {marginPct !== null
                                ? `Přirážka ${marginPct > 0 ? '+' : ''}${marginPct} %`
                                : `DPH ${row.item.vatRate} %`}
                            </p>
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

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <p className="text-xs text-slate-500">
            Všechny změny se uloží atomicky do sdílené databáze a ihned propíšou i na Android.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Zrušit
            </button>
            <button
              type="submit"
              disabled={busy || readyToApply.length === 0}
              style={{ backgroundColor: accentColor }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-50 hover:opacity-95"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Uložit změny ({readyToApply.length})
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
