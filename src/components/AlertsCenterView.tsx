import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Package,
  Plus,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { QtyInput } from './QtyInput';
import { adjustInventoryStock, markInvoicePaid, updateMinQuantity } from '../lib/firestoreService';
import {
  daysUntilDue,
  formatCzk,
  formatDateCz,
  formatQty,
  isInvoiceDueSoon,
  isInvoiceOverdue,
  round2,
} from '../lib/format';
import type { AppSection, InventoryItem, Invoice } from '../types';

interface AlertsCenterViewProps {
  onNavigate: (section: AppSection) => void;
}

type AlertsTab = 'STOCK' | 'INVOICES';

export function AlertsCenterView({ onNavigate }: AlertsCenterViewProps) {
  const {
    workspace,
    activeCompany,
    accessibleWarehouses,
    lowStockItems,
    invoices,
    notify,
  } = useApp();

  const [tab, setTab] = useState<AlertsTab>('STOCK');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restockQtyMap, setRestockQtyMap] = useState<Record<string, string>>({});
  const [minEditMap, setMinEditMap] = useState<Record<string, string>>({});

  const whMap = useMemo(
    () => new Map(accessibleWarehouses.map((w) => [w.id, w.name])),
    [accessibleWarehouses]
  );

  const alertInvoices = useMemo(() => {
    return invoices
      .filter(
        (i) =>
          (!activeCompany || i.companyId === activeCompany.id) &&
          (isInvoiceOverdue(i) || isInvoiceDueSoon(i))
      )
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [invoices, activeCompany]);

  const handleQuickRestock = async (item: InventoryItem) => {
    if (!workspace) return;
    const raw = restockQtyMap[item.id] || String(Math.max(1, Math.ceil(item.minQuantity - item.quantity + 1)));
    const delta = Math.abs(Number(raw.replace(',', '.')) || 0);
    if (delta <= 0) return;
    setBusyId(item.id);
    try {
      await adjustInventoryStock({
        workspace,
        item,
        delta,
        activeCompanyId: activeCompany?.id || 'company_1',
        documentRef: 'Doplnění z upozornění',
        note: 'Rychlé doplnění nízké zásoby',
      });
      notify(`Doplněno +${formatQty(delta)} ${item.unit} (${item.name}).`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Doplnění se nezdařilo.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleUpdateMin = async (item: InventoryItem) => {
    if (!workspace) return;
    const val = Math.max(0, Number((minEditMap[item.id] ?? String(item.minQuantity)).replace(',', '.')) || 0);
    setBusyId(`min_${item.id}`);
    try {
      await updateMinQuantity(workspace.id, item.id, val);
      notify(`Minimální zásoba upravena na ${formatQty(val)} ${item.unit}.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Úprava minima selhala.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleMarkPaid = async (invoice: Invoice) => {
    if (!workspace) return;
    setBusyId(invoice.id);
    try {
      await markInvoicePaid(workspace.id, invoice);
      notify(`Faktura ${invoice.invoiceNumber} označena jako uhrazená.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Označení úhrady selhalo.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          Hlídání zásob a splatností · {activeCompany?.name}
        </p>
        <h1 className="text-2xl font-bold text-slate-900 mt-1">Centrum upozornění</h1>
        <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
          {lowStockItems.length} položek s nízkou zásobou · {alertInvoices.length} faktur po nebo těsně před splatností
        </p>
      </div>

      {/* Tabs */}
      <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
        <button
          type="button"
          onClick={() => setTab('STOCK')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
            tab === 'STOCK'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Package className="w-3.5 h-3.5" />
          Nízký stav zásob ({lowStockItems.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('INVOICES')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
            tab === 'INVOICES'
              ? 'bg-white text-slate-900 shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          Splatnost faktur ({alertInvoices.length})
        </button>
      </div>

      {tab === 'STOCK' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {lowStockItems.length === 0 ? (
            <div className="p-12 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
              <p className="mt-3 text-sm font-medium text-slate-900">Všechny zásoby jsou nad minimem</p>
              <p className="mt-1 text-xs text-slate-500">
                Žádná položka v přístupných skladech nepotřebuje okamžité doplnění.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {lowStockItems.map((item) => {
                const suggested = Math.max(1, Math.ceil(item.minQuantity - item.quantity + 1));
                const restockVal = restockQtyMap[item.id] ?? String(suggested);
                const minVal = minEditMap[item.id] ?? String(item.minQuantity);

                return (
                  <div
                    key={item.id}
                    className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <AlertTriangle
                          className={`w-4 h-4 shrink-0 ${
                            item.quantity <= 0 ? 'text-red-600' : 'text-amber-600'
                          }`}
                        />
                        <p className="text-sm font-semibold text-slate-900 truncate">{item.name}</p>
                      </div>
                      <p className="text-xs text-slate-500 mt-1 tabular-nums">
                        <span className="font-mono text-slate-700">{item.sku}</span> ·{' '}
                        {whMap.get(item.warehouseId) || item.warehouseId} · Aktuálně{' '}
                        <strong className={item.quantity <= 0 ? 'text-red-700' : 'text-amber-700'}>
                          {formatQty(item.quantity)} {item.unit}
                        </strong>{' '}
                        (minimum {formatQty(item.minQuantity)} {item.unit})
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-slate-500">Min:</span>
                        <QtyInput
                          value={minVal}
                          onValueChange={(cleaned) =>
                            setMinEditMap((prev) => ({ ...prev, [item.id]: cleaned }))
                          }
                          className="w-16 px-2 py-1 text-xs text-right border border-slate-200 rounded-md tabular-nums"
                        />
                        <button
                          type="button"
                          disabled={busyId === `min_${item.id}`}
                          onClick={() => handleUpdateMin(item)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md"
                        >
                          Uložit
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <QtyInput
                          value={restockVal}
                          onValueChange={(cleaned) =>
                            setRestockQtyMap((prev) => ({ ...prev, [item.id]: cleaned }))
                          }
                          className="w-16 px-2 py-1 text-xs text-right border border-slate-200 rounded-md tabular-nums"
                        />
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => handleQuickRestock(item)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-md whitespace-nowrap"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Naskladnit
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          {alertInvoices.length === 0 ? (
            <div className="p-12 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
              <p className="mt-3 text-sm font-medium text-slate-900">
                Žádné faktury po ani těsně před splatností
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Všechny splatné pohledávky aktivní firmy jsou vyřízené.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {alertInvoices.map((inv) => {
                const diff = daysUntilDue(inv.dueDate);
                const overdue = diff !== null && diff < 0;
                const remaining = round2(Math.max(0, inv.totalWithVat - inv.paidAmount));

                return (
                  <div
                    key={inv.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {inv.clientName}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        <span className="font-mono text-slate-700">{inv.invoiceNumber}</span> · VS{' '}
                        {inv.variableSymbol} · Splatnost {formatDateCz(inv.dueDate)} ·{' '}
                        <span className={overdue ? 'text-red-600 font-medium' : 'text-amber-700 font-medium'}>
                          {overdue
                            ? `${Math.abs(diff || 0)} dní po splatnosti`
                            : diff === 0
                              ? 'Splatná dnes'
                              : `Splatná za ${diff} dny`}
                        </span>
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <span className="text-sm font-bold text-slate-900 tabular-nums mr-2">
                        {formatCzk(remaining, inv.currency)}
                      </span>
                      <button
                        type="button"
                        disabled={busyId === inv.id}
                        onClick={() => handleMarkPaid(inv)}
                        className="px-3 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-md whitespace-nowrap"
                      >
                        Označit uhrazeno
                      </button>
                      <button
                        type="button"
                        onClick={() => onNavigate('bank-matching')}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md whitespace-nowrap"
                      >
                        Banka
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
