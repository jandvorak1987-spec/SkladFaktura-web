import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Download,
  Edit3,
  Folder,
  FolderTree,
  Globe,
  History,
  Layers,
  List,
  Minus,
  Package,
  Percent,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { InventoryAuditPanel } from './InventoryAuditPanel';
import { InventoryBulkModals, type BulkActionModalType } from './InventoryBulkModals';
import { NerxCategorizeModal } from './NerxCategorizeModal';
import { QtyInput } from './QtyInput';
import { useApp } from '../context/AppContext';
import {
  adjustInventoryStock,
  bulkEditInventoryFields,
  deleteInventoryItem,
  restoreOrphanMovementToInventory,
  saveInventoryItem,
  updateMinQuantity,
} from '../lib/firestoreService';
import {
  exportInventoryToCsv,
  formatCzk,
  formatQty,
  formatTimestampCz,
  getCompanyPalette,
  needsRestockAlert,
  round2,
} from '../lib/format';
import type { AppSection, InventoryItem, StockMovement } from '../types';

interface InventoryViewProps {
  onNavigate: (section: AppSection) => void;
}

type InventoryTab = 'ITEMS' | 'MOVEMENTS' | 'AUDIT';

interface ItemFormState {
  id?: string;
  sku: string;
  name: string;
  ean: string;
  category: string;
  unit: string;
  quantity: string;
  minQuantity: string;
  purchasePrice: string;
  salePrice: string;
  vatRate: number;
  warehouseId: string;
  supplierName: string;
  notes: string;
}

export function InventoryView({ onNavigate }: InventoryViewProps) {
  const {
    workspace,
    activeCompany,
    accessibleWarehouses,
    inventory,
    movements,
    notify,
  } = useApp();

  const palette = getCompanyPalette(activeCompany?.accentIndex);

  const [tab, setTab] = useState<InventoryTab>('ITEMS');
  const [search, setSearch] = useState('');
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('ALL');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [groupByCategory, setGroupByCategory] = useState<boolean>(true);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renamingCategoryVal, setRenamingCategoryVal] = useState('');
  const [restoringMovId, setRestoringMovId] = useState<string | null>(null);
  const [onlyLowStock, setOnlyLowStock] = useState(false);

  const [editingItem, setEditingItem] = useState<ItemFormState | null>(null);
  const [saving, setSaving] = useState(false);

  const [adjustTarget, setAdjustTarget] = useState<InventoryItem | null>(null);
  const [adjustMode, setAdjustMode] = useState<'RECEIPT' | 'ISSUE'>('RECEIPT');
  const [adjustQty, setAdjustQty] = useState('1');
  const [adjustDocRef, setAdjustDocRef] = useState('');
  const [adjustNote, setAdjustNote] = useState('');

  const [editingMinId, setEditingMinId] = useState<string | null>(null);
  const [editingMinVal, setEditingMinVal] = useState('');

  // Bulk selection & actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkModal, setBulkModal] = useState<BulkActionModalType>(null);
  const [nerxTargetItems, setNerxTargetItems] = useState<InventoryItem[] | null>(null);

  const whMap = useMemo(
    () => new Map(accessibleWarehouses.map((w) => [w.id, w])),
    [accessibleWarehouses]
  );

  const inventoryById = useMemo(() => new Map(inventory.map((i) => [i.id, i])), [inventory]);

  const accessibleItems = useMemo(() => {
    const allowed = new Set(accessibleWarehouses.map((w) => w.id));
    return inventory.filter((i) => allowed.has(i.warehouseId));
  }, [inventory, accessibleWarehouses]);

  const warehouseScopedItems = useMemo(() => {
    if (selectedWarehouseId === 'ALL') return accessibleItems;
    return accessibleItems.filter((i) => i.warehouseId === selectedWarehouseId);
  }, [accessibleItems, selectedWarehouseId]);

  const categorySummary = useMemo(() => {
    const counts = new Map<string, number>();
    let uncategorized = 0;
    for (const item of warehouseScopedItems) {
      const cat = (item.category || '').trim();
      if (!cat) uncategorized++;
      else counts.set(cat, (counts.get(cat) || 0) + 1);
    }
    const list = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'cs'))
      .map(([name, count]) => ({ name, count }));
    return { list, uncategorized };
  }, [warehouseScopedItems]);

  const allWorkspaceCategories = useMemo(() => {
    const set = new Set<string>();
    for (const item of inventory) {
      const cat = (item.category || '').trim();
      if (cat) set.add(cat);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'cs'));
  }, [inventory]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return warehouseScopedItems.filter((item) => {
      const cat = (item.category || '').trim();
      if (selectedCategory === '__NONE__' && cat !== '') return false;
      if (selectedCategory !== 'ALL' && selectedCategory !== '__NONE__' && cat !== selectedCategory) {
        return false;
      }
      if (onlyLowStock && !needsRestockAlert(item)) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q) ||
        item.ean.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q) ||
        item.supplierName.toLowerCase().includes(q)
      );
    });
  }, [warehouseScopedItems, selectedCategory, onlyLowStock, search]);

  const groupedByCategory = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    for (const item of filteredItems) {
      const key = (item.category || '').trim() || '__NONE__';
      const arr = map.get(key) || [];
      arr.push(item);
      map.set(key, arr);
    }
    const entries = Array.from(map.entries()).sort((a, b) => {
      if (a[0] === '__NONE__') return 1;
      if (b[0] === '__NONE__') return -1;
      return a[0].localeCompare(b[0], 'cs');
    });
    return entries.map(([key, items]) => {
      const totalValue = round2(
        items.reduce((s, i) => s + Math.max(0, i.quantity) * Math.max(0, i.purchasePrice), 0)
      );
      const totalQty = round2(items.reduce((s, i) => s + Math.max(0, i.quantity), 0));
      return {
        key,
        label: key === '__NONE__' ? 'Bez kategorie' : key,
        isUncategorized: key === '__NONE__',
        items,
        totalValue,
        totalQty,
      };
    });
  }, [filteredItems]);

  const filteredMovements = useMemo(() => {
    const allowed = new Set(accessibleWarehouses.map((w) => w.id));
    const q = search.trim().toLowerCase();
    return movements.filter((m) => {
      if (!allowed.has(m.warehouseId)) return false;
      if (selectedWarehouseId !== 'ALL' && m.warehouseId !== selectedWarehouseId) return false;
      if (!q) return true;
      return (
        m.itemName.toLowerCase().includes(q) ||
        m.itemSku.toLowerCase().includes(q) ||
        m.documentRef.toLowerCase().includes(q) ||
        m.note.toLowerCase().includes(q)
      );
    });
  }, [movements, accessibleWarehouses, selectedWarehouseId, search]);

  const totalFilteredValue = useMemo(
    () =>
      round2(
        filteredItems.reduce(
          (sum, i) => sum + Math.max(0, i.quantity) * Math.max(0, i.purchasePrice),
          0
        )
      ),
    [filteredItems]
  );

  const openNewItem = (presetCategory?: string) => {
    const defaultWh =
      selectedWarehouseId !== 'ALL'
        ? selectedWarehouseId
        : accessibleWarehouses[0]?.id || 'shared_main';
    const defaultCat =
      presetCategory !== undefined
        ? presetCategory
        : selectedCategory !== 'ALL' && selectedCategory !== '__NONE__'
          ? selectedCategory
          : '';
    setEditingItem({
      sku: '',
      name: '',
      ean: '',
      category: defaultCat,
      unit: 'ks',
      quantity: '',
      minQuantity: '5',
      purchasePrice: '',
      salePrice: '',
      vatRate: 21,
      warehouseId: defaultWh,
      supplierName: '',
      notes: '',
    });
  };

  const selectedItems = useMemo(
    () => accessibleItems.filter((i) => selectedIds.has(i.id)),
    [accessibleItems, selectedIds]
  );

  const allFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((item) => selectedIds.has(item.id));

  const toggleSelectItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const item of filteredItems) next.delete(item.id);
      } else {
        for (const item of filteredItems) next.add(item.id);
      }
      return next;
    });
  };

  const openEditItem = (item: InventoryItem) => {
    setEditingItem({
      id: item.id,
      sku: item.sku,
      name: item.name,
      ean: item.ean,
      category: item.category,
      unit: item.unit,
      quantity: String(item.quantity),
      minQuantity: String(item.minQuantity),
      purchasePrice: String(item.purchasePrice),
      salePrice: String(item.salePrice),
      vatRate: item.vatRate,
      warehouseId: item.warehouseId,
      supplierName: item.supplierName,
      notes: item.notes,
    });
  };

  const openDuplicateItem = (item: InventoryItem) => {
    setEditingItem({
      sku: `${item.sku}-KOP`.slice(0, 64),
      name: `${item.name} (kopie)`.slice(0, 200),
      ean: '',
      category: item.category,
      unit: item.unit,
      quantity: '',
      minQuantity: String(item.minQuantity),
      purchasePrice: String(item.purchasePrice),
      salePrice: String(item.salePrice),
      vatRate: item.vatRate,
      warehouseId: item.warehouseId,
      supplierName: item.supplierName,
      notes: item.notes,
    });
  };

  const handleSaveItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || !editingItem) return;
    setSaving(true);
    try {
      await saveInventoryItem({
        workspace,
        activeCompanyId: activeCompany?.id || 'company_1',
        item: {
          id: editingItem.id,
          sku: editingItem.sku,
          name: editingItem.name,
          ean: editingItem.ean,
          category: editingItem.category,
          unit: editingItem.unit,
          quantity: Number(editingItem.quantity.replace(',', '.')) || 0,
          minQuantity: Number(editingItem.minQuantity.replace(',', '.')) || 0,
          purchasePrice: Number(editingItem.purchasePrice.replace(',', '.')) || 0,
          salePrice: Number(editingItem.salePrice.replace(',', '.')) || 0,
          vatRate: editingItem.vatRate,
          warehouseId: editingItem.warehouseId,
          supplierName: editingItem.supplierName,
          notes: editingItem.notes,
        },
      });
      notify(editingItem.id ? 'Skladová karta uložena.' : 'Nová položka byla přidána na sklad.');
      setEditingItem(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Nepodařilo se uložit položku.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || !adjustTarget) return;
    const rawQty = Math.abs(Number(adjustQty.replace(',', '.')) || 0);
    if (rawQty <= 0) {
      notify('Zadejte množství větší než 0.', 'error');
      return;
    }
    setSaving(true);
    try {
      const delta = adjustMode === 'RECEIPT' ? rawQty : -rawQty;
      await adjustInventoryStock({
        workspace,
        item: adjustTarget,
        delta,
        activeCompanyId: activeCompany?.id || 'company_1',
        documentRef: adjustDocRef.trim() || (adjustMode === 'RECEIPT' ? 'Příjemka' : 'Výdejka'),
        note: adjustNote.trim(),
      });
      notify(
        `${adjustMode === 'RECEIPT' ? 'Naskladněno' : 'Vydáno'} ${formatQty(rawQty)} ${adjustTarget.unit} (${adjustTarget.name}).`
      );
      setAdjustTarget(null);
      setAdjustQty('1');
      setAdjustDocRef('');
      setAdjustNote('');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Úprava stavu skladu selhala.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMinQty = async (item: InventoryItem) => {
    if (!workspace) return;
    const val = Math.max(0, Number(editingMinVal.replace(',', '.')) || 0);
    try {
      await updateMinQuantity(workspace.id, item.id, val);
      notify(`Minimální zásoba pro ${item.name} nastavena na ${formatQty(val)} ${item.unit}.`);
      setEditingMinId(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Změna minima se nezdařila.', 'error');
    }
  };

  const handleDelete = async (item: InventoryItem) => {
    if (!workspace) return;
    try {
      await deleteInventoryItem(workspace.id, item.id);
      notify(`Položka ${item.name} byla odstraněna ze skladu.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Položku se nepodařilo smazat.', 'error');
    }
  };

  const toggleCategoryCollapse = (catKey: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catKey)) next.delete(catKey);
      else next.add(catKey);
      return next;
    });
  };

  const toggleSelectCategoryItems = (itemsInCat: InventoryItem[]) => {
    const allSelected = itemsInCat.length > 0 && itemsInCat.every((i) => selectedIds.has(i.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of itemsInCat) {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  };

  const handleRenameCategorySubmit = async (oldCatName: string) => {
    if (!workspace) return;
    const newName = renamingCategoryVal.trim().slice(0, 80);
    if (!newName || newName === oldCatName) {
      setRenamingCategory(null);
      return;
    }
    const itemsToUpdate = inventory.filter((i) => (i.category || '').trim() === oldCatName);
    if (itemsToUpdate.length === 0) {
      setRenamingCategory(null);
      return;
    }
    try {
      await bulkEditInventoryFields({
        workspace,
        items: itemsToUpdate,
        patch: { category: newName },
      });
      if (selectedCategory === oldCatName) setSelectedCategory(newName);
      notify(`Kategorie „${oldCatName}“ byla přejmenována na „${newName}“ (${itemsToUpdate.length} karet).`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Přejmenování kategorie selhalo.', 'error');
    } finally {
      setRenamingCategory(null);
    }
  };

  const handleRestoreOrphanMovement = async (mov: StockMovement) => {
    if (!workspace) return;
    setRestoringMovId(mov.id);
    try {
      await restoreOrphanMovementToInventory({
        workspace,
        movement: mov,
      });
      notify(
        `Karta „${mov.itemName}“ (+${formatQty(mov.quantityDelta)} ${mov.unit}) byla zapsána na sklad.`
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Obnovení karty na sklad selhalo.', 'error');
    } finally {
      setRestoringMovId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Skladové hospodářství · {activeCompany?.name}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Sklad a pohyby</h1>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {filteredItems.length} položek · Skladová hodnota {formatCzk(totalFilteredValue)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              exportInventoryToCsv(
                filteredItems,
                accessibleWarehouses,
                activeCompany?.name || 'sklad'
              )
            }
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => {
              const uncat = filteredItems.filter((i) => !(i.category || '').trim());
              const targets = uncat.length > 0 ? uncat : filteredItems;
              if (targets.length === 0) {
                notify('Ve filtru nejsou žádné položky ke kategorizaci.', 'info');
                return;
              }
              setNerxTargetItems(targets);
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg transition-colors whitespace-nowrap"
          >
            <Globe className="w-4 h-4" />
            Kategorizovat (Nerx.cz)
          </button>
          <button
            type="button"
            onClick={() => onNavigate('smart-stock-in')}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
          >
            <Sparkles className="w-4 h-4" />
            AI Příjemka
          </button>
          <button
            type="button"
            onClick={() => openNewItem()}
            style={{ backgroundColor: palette.primary }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white hover:opacity-95 rounded-lg transition-opacity whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Nová položka
          </button>
        </div>
      </div>

      {/* Tabs + Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 self-start">
            <button
              type="button"
              onClick={() => setTab('ITEMS')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === 'ITEMS'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Package className="w-3.5 h-3.5" />
              Skladové karty ({accessibleItems.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('MOVEMENTS')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === 'MOVEMENTS'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              Deník pohybů ({filteredMovements.length})
            </button>
            <button
              type="button"
              onClick={() => setTab('AUDIT')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                tab === 'AUDIT'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ClipboardCheck className="w-3.5 h-3.5" />
              Inventura
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 flex-1 lg:justify-end">
            <div className="relative flex-1 sm:flex-initial sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Hledat název, SKU, EAN, doklad…"
                className="w-full pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-400"
              />
            </div>

            {tab === 'ITEMS' && (
              <>
                <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setGroupByCategory(true)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      groupByCategory
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <FolderTree className="w-3.5 h-3.5" />
                    Dle kategorií
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupByCategory(false)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      !groupByCategory
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <List className="w-3.5 h-3.5" />
                    Seznam
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setOnlyLowStock((v) => !v)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                    onlyLowStock
                      ? 'bg-amber-50 border-amber-300 text-amber-900'
                      : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Pouze pod minimem
                </button>
              </>
            )}
          </div>
        </div>

        {/* Warehouse segmented filter */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={() => setSelectedWarehouseId('ALL')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              selectedWarehouseId === 'ALL'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            Všechny přístupné sklady
          </button>
          {accessibleWarehouses.map((wh) => (
            <button
              key={wh.id}
              type="button"
              onClick={() => setSelectedWarehouseId(wh.id)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                selectedWarehouseId === wh.id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {wh.name}
              {wh.shared ? ' · Sdílený' : ' · Oddělený'}
            </button>
          ))}
        </div>

        {/* Category filter bar */}
        {tab === 'ITEMS' && (categorySummary.list.length > 0 || categorySummary.uncategorized > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-slate-400 mr-1">
              <Tag className="w-3 h-3" />
              Kategorie:
            </span>
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
                selectedCategory === 'ALL'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              Vše ({warehouseScopedItems.length})
            </button>
            {categorySummary.list.map((cat) => (
              <button
                key={cat.name}
                type="button"
                onClick={() => setSelectedCategory(cat.name)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
                  selectedCategory === cat.name
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {cat.name} ({cat.count})
              </button>
            ))}
            {categorySummary.uncategorized > 0 && (
              <button
                type="button"
                onClick={() => setSelectedCategory('__NONE__')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap tabular-nums ${
                  selectedCategory === '__NONE__'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                Bez kategorie ({categorySummary.uncategorized})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main Content */}
      {tab === 'ITEMS' ? (
        <div className="space-y-3">
          {/* Bulk Action Bar */}
          {selectedItems.length > 0 && (
            <div className="bg-slate-900 text-white rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold tabular-nums">
                  Vybráno {selectedItems.length}{' '}
                  {selectedItems.length === 1
                    ? 'položka'
                    : selectedItems.length < 5
                      ? 'položky'
                      : 'položek'}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="text-xs text-slate-300 hover:text-white underline underline-offset-2"
                >
                  Zrušit výběr
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setBulkModal('PRICES')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Percent className="w-3.5 h-3.5" />
                  Ceny
                </button>
                <button
                  type="button"
                  onClick={() => setBulkModal('QUANTITY')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Layers className="w-3.5 h-3.5" />
                  Množství
                </button>
                <button
                  type="button"
                  onClick={() => setNerxTargetItems(selectedItems)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600/90 hover:bg-emerald-600 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Globe className="w-3.5 h-3.5" />
                  Kategorie (Nerx.cz)
                </button>
                <button
                  type="button"
                  onClick={() => setBulkModal('FIELDS')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg transition-colors whitespace-nowrap"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Hromadná editace
                </button>
                <button
                  type="button"
                  onClick={() => setBulkModal('DUPLICATE')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Kopírovat
                </button>
                <button
                  type="button"
                  onClick={() => setBulkModal('DELETE')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-600/90 hover:bg-red-600 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Smazat
                </button>
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filteredItems.length === 0 ? (
            <div className="p-12 text-center">
              <Package className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="mt-3 text-sm font-medium text-slate-900">Žádné skladové položky</p>
              <p className="mt-1 text-xs text-slate-500">
                Přidejte první položku ručně nebo naskladněte dodací list přes AI Příjemku.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 pl-4 pr-2 w-10">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllFiltered}
                        title="Vybrat vše zobrazené"
                        className="rounded border-slate-300 cursor-pointer"
                      />
                    </th>
                    <th className="py-3 px-4">Položka / SKU</th>
                    <th className="py-3 px-4">Sklad</th>
                    <th className="py-3 px-4 text-right">Stav</th>
                    <th className="py-3 px-4 text-right">Min. zásoba</th>
                    <th className="py-3 px-4 text-right">Nákup / Prodej</th>
                    <th className="py-3 px-4 text-right">Akce</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {(groupByCategory
                    ? groupedByCategory
                    : [
                        {
                          key: '__FLAT__',
                          label: '',
                          isUncategorized: false,
                          items: filteredItems,
                          totalValue: totalFilteredValue,
                          totalQty: 0,
                        },
                      ]
                  ).map((group) => {
                    const isCollapsed =
                      groupByCategory && collapsedCategories.has(group.key);
                    const allGroupSelected =
                      group.items.length > 0 &&
                      group.items.every((i) => selectedIds.has(i.id));

                    return (
                      <React.Fragment key={group.key}>
                        {groupByCategory && (
                          <tr className="bg-slate-50 border-t border-b border-slate-200">
                            <td className="py-2.5 pl-4 pr-2">
                              <input
                                type="checkbox"
                                checked={allGroupSelected}
                                onChange={() => toggleSelectCategoryItems(group.items)}
                                title={`Vybrat všechny položky v kategorii ${group.label}`}
                                className="rounded border-slate-300 cursor-pointer"
                              />
                            </td>
                            <td colSpan={4} className="py-2.5 px-4">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => toggleCategoryCollapse(group.key)}
                                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900 hover:text-slate-700"
                                >
                                  {isCollapsed ? (
                                    <ChevronRight className="w-4 h-4 text-slate-400" />
                                  ) : (
                                    <ChevronDown className="w-4 h-4 text-slate-400" />
                                  )}
                                  <Folder className="w-4 h-4 text-slate-500" />
                                  <span
                                    className={
                                      group.isUncategorized ? 'italic text-slate-500 font-medium' : ''
                                    }
                                  >
                                    {group.label}
                                  </span>
                                </button>

                                <span className="text-xs text-slate-500 tabular-nums">
                                  ({group.items.length}{' '}
                                  {group.items.length === 1
                                    ? 'karta'
                                    : group.items.length < 5
                                      ? 'karty'
                                      : 'karet'}{' '}
                                  · {formatQty(group.totalQty)} ks)
                                </span>

                                {!group.isUncategorized &&
                                  (renamingCategory === group.key ? (
                                    <div className="inline-flex items-center gap-1 ml-1">
                                      <input
                                        type="text"
                                        value={renamingCategoryVal}
                                        onChange={(e) => setRenamingCategoryVal(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') {
                                            e.preventDefault();
                                            handleRenameCategorySubmit(group.key);
                                          } else if (e.key === 'Escape') {
                                            setRenamingCategory(null);
                                          }
                                        }}
                                        className="px-2 py-0.5 text-xs bg-white border border-slate-300 rounded-md w-40"
                                        autoFocus
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleRenameCategorySubmit(group.key)}
                                        className="p-1 text-emerald-700 hover:bg-emerald-100 rounded"
                                        title="Uložit nový název kategorie"
                                      >
                                        <Check className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setRenamingCategory(null)}
                                        className="p-1 text-slate-400 hover:text-slate-700 rounded"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setRenamingCategory(group.key);
                                        setRenamingCategoryVal(group.key);
                                      }}
                                      title="Přejmenovat tuto kategorii u všech položek"
                                      className="p-1 text-slate-400 hover:text-slate-700 rounded transition-colors"
                                    >
                                      <Edit3 className="w-3.5 h-3.5" />
                                    </button>
                                  ))}
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-right text-xs font-semibold text-slate-700 tabular-nums whitespace-nowrap">
                              {formatCzk(group.totalValue)}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                type="button"
                                onClick={() =>
                                  openNewItem(group.isUncategorized ? '' : group.key)
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded-md transition-colors whitespace-nowrap"
                              >
                                <Plus className="w-3.5 h-3.5" />
                                Přidat
                              </button>
                            </td>
                          </tr>
                        )}

                        {!isCollapsed &&
                          group.items.map((item) => {
                            const low = needsRestockAlert(item);
                            const wh = whMap.get(item.warehouseId);
                            const isSelected = selectedIds.has(item.id);
                            return (
                              <tr
                                key={item.id}
                                className={`transition-colors ${
                                  isSelected ? 'bg-slate-50' : 'hover:bg-slate-50/60'
                                }`}
                              >
                                <td className="py-3 pl-4 pr-2">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelectItem(item.id)}
                                    className="rounded border-slate-300 cursor-pointer"
                                  />
                                </td>
                                <td className="py-3 px-4">
                                  <p className="font-medium text-slate-900">{item.name}</p>
                                  <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                                    <span className="font-mono text-slate-700">{item.sku}</span>
                                    {item.ean && ` · EAN ${item.ean}`}
                                    {!groupByCategory && item.category && ` · ${item.category}`}
                                  </p>
                                </td>
                                <td className="py-3 px-4 text-xs text-slate-600">
                                  <p className="font-medium text-slate-800">
                                    {wh?.name || item.warehouseId}
                                  </p>
                                  <p className="text-slate-400">
                                    {wh?.shared ? 'Sdílený sklad' : 'Oddělený sklad'}
                                  </p>
                                </td>
                                <td className="py-3 px-4 text-right tabular-nums">
                                  <span
                                    className={`font-semibold ${
                                      item.quantity <= 0
                                        ? 'text-red-700'
                                        : low
                                          ? 'text-amber-700'
                                          : 'text-slate-900'
                                    }`}
                                  >
                                    {formatQty(item.quantity)} {item.unit}
                                  </span>
                                  {low && (
                                    <p className="text-[11px] text-amber-700 font-medium">
                                      {item.quantity <= 0 ? 'Vyprodáno' : 'Pod minimem'}
                                    </p>
                                  )}
                                </td>
                                <td className="py-3 px-4 text-right tabular-nums">
                                  {editingMinId === item.id ? (
                                    <div className="inline-flex items-center gap-1 justify-end">
                                      <QtyInput
                                        value={editingMinVal}
                                        onValueChange={(val) => setEditingMinVal(val)}
                                        className="w-16 px-2 py-1 text-xs text-right border border-slate-300 rounded-md tabular-nums"
                                        autoFocus
                                      />
                                      <button
                                        type="button"
                                        onClick={() => handleSaveMinQty(item)}
                                        className="px-2 py-1 text-xs font-medium text-white bg-slate-900 rounded-md"
                                      >
                                        OK
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => setEditingMinId(null)}
                                        className="p-1 text-slate-400 hover:text-slate-700"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingMinId(item.id);
                                        setEditingMinVal(String(item.minQuantity));
                                      }}
                                      className="text-xs text-slate-600 hover:text-slate-900 underline decoration-dotted underline-offset-4"
                                      title="Kliknutím upravíte minimální zásobu"
                                    >
                                      {formatQty(item.minQuantity)} {item.unit}
                                    </button>
                                  )}
                                </td>
                                <td className="py-3 px-4 text-right tabular-nums">
                                  <p className="text-sm font-medium text-slate-900">
                                    {formatCzk(item.salePrice)}
                                  </p>
                                  <p className="text-xs text-slate-500">
                                    Nákup {formatCzk(item.purchasePrice)} · DPH {item.vatRate} %
                                  </p>
                                </td>
                                <td className="py-3 px-4 text-right">
                                  <div className="inline-flex items-center gap-1 justify-end">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setAdjustTarget(item);
                                        setAdjustMode('RECEIPT');
                                        setAdjustQty('1');
                                      }}
                                      title="Rychlý příjem"
                                      className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-md transition-colors"
                                    >
                                      <Plus className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setAdjustTarget(item);
                                        setAdjustMode('ISSUE');
                                        setAdjustQty('1');
                                      }}
                                      title="Rychlý výdej"
                                      className="p-1.5 text-amber-700 hover:bg-amber-50 rounded-md transition-colors"
                                    >
                                      <Minus className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openEditItem(item)}
                                      title="Upravit kartu"
                                      className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                                    >
                                      <Edit3 className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => openDuplicateItem(item)}
                                      title="Kopírovat položku"
                                      className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors"
                                    >
                                      <Copy className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDelete(item)}
                                      title="Smazat položku"
                                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </div>
        </div>
      ) : tab === 'AUDIT' && workspace ? (
        <InventoryAuditPanel
          items={filteredItems}
          warehouses={accessibleWarehouses}
          workspace={workspace}
          activeCompanyId={activeCompany?.id || 'company_1'}
          accentColor={palette.primary}
          onNotify={notify}
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {filteredMovements.length === 0 ? (
            <div className="p-12 text-center text-sm text-slate-500">
              Žádné skladové pohyby neodpovídají filtru.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-3 px-4">Datum</th>
                    <th className="py-3 px-4">Typ</th>
                    <th className="py-3 px-4">Položka</th>
                    <th className="py-3 px-4">Sklad & Doklad</th>
                    <th className="py-3 px-4 text-right">Množství</th>
                    <th className="py-3 px-4 text-right">Hodnota</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {filteredMovements.map((mov) => {
                    const isReceipt = mov.quantityDelta > 0;
                    const linkedItem = mov.itemId ? inventoryById.get(mov.itemId) : undefined;
                    return (
                      <tr key={mov.id} className="hover:bg-slate-50/60">
                        <td className="py-3 px-4 text-xs text-slate-500 tabular-nums whitespace-nowrap">
                          {formatTimestampCz(mov.createdAt)}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-medium ${
                              isReceipt ? 'text-emerald-700' : 'text-amber-700'
                            }`}
                          >
                            {isReceipt ? (
                              <ArrowDownLeft className="w-3.5 h-3.5" />
                            ) : (
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            )}
                            {isReceipt ? 'Příjem' : 'Výdej'}
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <p className="font-medium text-slate-900">{mov.itemName}</p>
                          <p className="text-xs font-mono text-slate-500">{mov.itemSku}</p>
                          {linkedItem ? (
                            <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                              Na skladě: <strong className="text-slate-700">{formatQty(linkedItem.quantity)} {linkedItem.unit}</strong>
                              {linkedItem.category ? ` · ${linkedItem.category}` : ''}
                            </p>
                          ) : (
                            <div className="mt-1 flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800">
                                <AlertTriangle className="w-3 h-3" />
                                Karta ve skladu neexistuje
                              </span>
                              {isReceipt && (
                                <button
                                  type="button"
                                  disabled={restoringMovId === mov.id}
                                  onClick={() => handleRestoreOrphanMovement(mov)}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded transition-colors disabled:opacity-50"
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  {restoringMovId === mov.id ? 'Ukládám…' : 'Zapsat na sklad'}
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600">
                          <p className="font-medium text-slate-800">
                            {whMap.get(mov.warehouseId)?.name || mov.warehouseId}
                          </p>
                          <p className="text-slate-500">
                            {mov.documentRef}
                            {mov.note ? ` · ${mov.note}` : ''}
                          </p>
                        </td>
                        <td
                          className={`py-3 px-4 text-right font-semibold tabular-nums whitespace-nowrap ${
                            isReceipt ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {isReceipt ? '+' : ''}
                          {formatQty(mov.quantityDelta)} {mov.unit}
                        </td>
                        <td className="py-3 px-4 text-right text-slate-700 tabular-nums whitespace-nowrap">
                          {formatCzk(Math.abs(mov.quantityDelta) * (mov.unitPrice || 0))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modal: Quick Stock Adjust */}
      {adjustTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleQuickAdjust}
            className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {adjustMode === 'RECEIPT' ? 'Příjem na sklad' : 'Výdej ze skladu'}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {adjustTarget.name} · aktuálně {formatQty(adjustTarget.quantity)}{' '}
                  {adjustTarget.unit}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAdjustTarget(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAdjustMode('RECEIPT')}
                className={`py-2 text-xs font-medium rounded-lg border ${
                  adjustMode === 'RECEIPT'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                + Příjem
              </button>
              <button
                type="button"
                onClick={() => setAdjustMode('ISSUE')}
                className={`py-2 text-xs font-medium rounded-lg border ${
                  adjustMode === 'ISSUE'
                    ? 'bg-amber-50 border-amber-300 text-amber-800'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                − Výdej
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Množství ({adjustTarget.unit})
              </label>
              <QtyInput
                required
                value={adjustQty}
                onValueChange={(val) => setAdjustQty(val)}
                placeholder="Zadejte počet kusů"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Číslo dokladu / reference
              </label>
              <input
                type="text"
                value={adjustDocRef}
                onChange={(e) => setAdjustDocRef(e.target.value)}
                placeholder="Např. DL-2026-041"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka</label>
              <input
                type="text"
                value={adjustNote}
                onChange={(e) => setAdjustNote(e.target.value)}
                placeholder="Volitelná poznámka k pohybu"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdjustTarget(null)}
                className="px-3.5 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Zrušit
              </button>
              <button
                type="submit"
                disabled={saving}
                style={{ backgroundColor: palette.primary }}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
              >
                {saving ? 'Ukládám…' : 'Potvrdit pohyb'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: Create/Edit Inventory Item */}
      {editingItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleSaveItem}
            className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                {editingItem.id ? 'Upravit skladovou kartu' : 'Nová skladová položka'}
              </h3>
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Název zboží *
                </label>
                <input
                  type="text"
                  required
                  value={editingItem.name}
                  onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">SKU / Kód</label>
                <input
                  type="text"
                  value={editingItem.sku}
                  onChange={(e) => setEditingItem({ ...editingItem, sku: e.target.value })}
                  placeholder="Automaticky pokud prázdné"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">EAN kód</label>
                <input
                  type="text"
                  value={editingItem.ean}
                  onChange={(e) => setEditingItem({ ...editingItem, ean: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Sklad</label>
                <select
                  value={editingItem.warehouseId}
                  onChange={(e) => setEditingItem({ ...editingItem, warehouseId: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {accessibleWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.shared ? 'Sdílený' : 'Oddělený'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Kategorie</label>
                <input
                  type="text"
                  list="inventory-categories-list"
                  value={editingItem.category}
                  onChange={(e) => setEditingItem({ ...editingItem, category: e.target.value })}
                  placeholder="Vyberte nebo zadejte novou…"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
                <datalist id="inventory-categories-list">
                  {allWorkspaceCategories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Množství</label>
                  <QtyInput
                    allowNegative
                    value={editingItem.quantity}
                    onValueChange={(val) => setEditingItem({ ...editingItem, quantity: val })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Min. zásoba
                  </label>
                  <QtyInput
                    value={editingItem.minQuantity}
                    onValueChange={(val) =>
                      setEditingItem({ ...editingItem, minQuantity: val })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Jednotka</label>
                  <input
                    type="text"
                    value={editingItem.unit}
                    onChange={(e) => setEditingItem({ ...editingItem, unit: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:col-span-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nákupní cena bez DPH
                  </label>
                  <QtyInput
                    value={editingItem.purchasePrice}
                    onValueChange={(val) =>
                      setEditingItem({ ...editingItem, purchasePrice: val })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Prodejní cena bez DPH
                  </label>
                  <QtyInput
                    value={editingItem.salePrice}
                    onValueChange={(val) => setEditingItem({ ...editingItem, salePrice: val })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Sazba DPH</label>
                  <select
                    value={editingItem.vatRate}
                    onChange={(e) =>
                      setEditingItem({ ...editingItem, vatRate: Number(e.target.value) })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                  >
                    <option value={21}>21 %</option>
                    <option value={12}>12 %</option>
                    <option value={0}>0 %</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Dodavatel</label>
                <input
                  type="text"
                  value={editingItem.supplierName}
                  onChange={(e) => setEditingItem({ ...editingItem, supplierName: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka</label>
                <input
                  type="text"
                  value={editingItem.notes}
                  onChange={(e) => setEditingItem({ ...editingItem, notes: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingItem(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Zrušit
              </button>
              <button
                type="submit"
                disabled={saving}
                style={{ backgroundColor: palette.primary }}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
              >
                {saving ? 'Ukládám…' : 'Uložit kartu'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Bulk Action Modals */}
      {workspace && (
        <InventoryBulkModals
          modal={bulkModal}
          selectedItems={selectedItems}
          warehouses={accessibleWarehouses}
          existingCategories={allWorkspaceCategories}
          workspace={workspace}
          activeCompanyId={activeCompany?.id || 'company_1'}
          accentColor={palette.primary}
          onClose={() => setBulkModal(null)}
          onCompleted={(msg, clearSel) => {
            notify(msg);
            setBulkModal(null);
            if (clearSel) setSelectedIds(new Set());
          }}
          onError={(msg) => notify(msg, 'error')}
        />
      )}
      {/* Nerx.cz Auto-Categorization Modal */}
      {nerxTargetItems && workspace && (
        <NerxCategorizeModal
          items={nerxTargetItems}
          existingCategories={allWorkspaceCategories}
          workspace={workspace}
          accentColor={palette.primary}
          onClose={() => setNerxTargetItems(null)}
          onCompleted={(msg) => {
            notify(msg);
            setNerxTargetItems(null);
            setSelectedIds(new Set());
          }}
          onError={(msg) => notify(msg, 'error')}
        />
      )}
    </div>
  );
}
