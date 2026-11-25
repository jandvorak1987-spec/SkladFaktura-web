import React, { useMemo } from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  FilePlus2,
  Landmark,
  Package,
  Sparkles,
  Users,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  daysUntilDue,
  formatCzk,
  formatDateCz,
  formatQty,
  formatTimestampCz,
  getCompanyPalette,
  isInvoiceOverdue,
  round2,
} from '../lib/format';
import type { AppSection } from '../types';
import { PerformanceChart } from './PerformanceChart';

interface DashboardViewProps {
  onNavigate: (section: AppSection) => void;
  onQuickCreateInvoice: () => void;
}

export function DashboardView({ onNavigate, onQuickCreateInvoice }: DashboardViewProps) {
  const {
    activeCompany,
    isReadOnlyAccountant,
    accessibleWarehouses,
    inventory,
    movements,
    invoices,
    bankTransactions,
    lowStockItems,
    overdueInvoices,
    clients,
  } = useApp();

  const palette = getCompanyPalette(activeCompany?.accentIndex);
  const whIds = useMemo(() => new Set(accessibleWarehouses.map((w) => w.id)), [accessibleWarehouses]);
  const whNameMap = useMemo(
    () => new Map(accessibleWarehouses.map((w) => [w.id, w.name])),
    [accessibleWarehouses]
  );

  const companyInventory = useMemo(
    () => inventory.filter((i) => whIds.has(i.warehouseId)),
    [inventory, whIds]
  );

  const companyInvoices = useMemo(
    () => invoices.filter((i) => !activeCompany || i.companyId === activeCompany.id),
    [invoices, activeCompany]
  );

  const companyMovements = useMemo(
    () =>
      movements.filter(
        (m) =>
          whIds.has(m.warehouseId) && (!activeCompany || m.companyId === activeCompany.id || !m.companyId)
      ),
    [movements, whIds, activeCompany]
  );

  const companyBankTx = useMemo(
    () => bankTransactions.filter((t) => !activeCompany || t.companyId === activeCompany.id),
    [bankTransactions, activeCompany]
  );

  const kpis = useMemo(() => {
    const stockValue = round2(
      companyInventory.reduce((s, i) => s + Math.max(0, i.quantity) * Math.max(0, i.purchasePrice), 0)
    );
    const activeInvoices = companyInvoices.filter((i) => i.status !== 'CANCELLED');
    const unpaidInvoices = activeInvoices.filter((i) => i.status === 'ISSUED');
    const unpaidTotal = round2(
      unpaidInvoices.reduce((s, i) => s + Math.max(0, i.totalWithVat - i.paidAmount), 0)
    );
    const paidTotal = round2(
      activeInvoices.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.totalWithVat, 0)
    );
    const unmatchedIncoming = companyBankTx.filter(
      (t) => t.matchStatus === 'UNMATCHED' && t.amount > 0
    );

    return {
      stockValue,
      skuCount: companyInventory.length,
      unpaidCount: unpaidInvoices.length,
      unpaidTotal,
      paidTotal,
      unmatchedIncomingCount: unmatchedIncoming.length,
    };
  }, [companyInventory, companyInvoices, companyBankTx]);

  const recentInvoices = companyInvoices.slice(0, 6);
  const recentMovements = companyMovements.slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Header row with quick actions */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Přehled aktivní firmy
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">
            {activeCompany?.name || 'SkladFaktura'}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {activeCompany?.ico ? `IČO ${activeCompany.ico}` : 'Doplňte IČO v nastavení'}
            {' · '}
            {activeCompany?.vatPayer ? 'Plátce DPH' : 'Neplátce DPH'}
            {' · '}
            {accessibleWarehouses.length} přístupné sklady
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isReadOnlyAccountant ? (
            <>
              <button
                type="button"
                onClick={() => onNavigate('smart-stock-in')}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-4 h-4 text-slate-600" />
                AI Příjemka
              </button>
              <button
                type="button"
                onClick={() => onNavigate('bank-matching')}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap"
              >
                <Landmark className="w-4 h-4 text-slate-600" />
                Párování banky
              </button>
              <button
                type="button"
                onClick={onQuickCreateInvoice}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white hover:opacity-95 rounded-lg transition-opacity whitespace-nowrap"
              >
                <FilePlus2 className="w-4 h-4" />
                Nová faktura
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              style={{ backgroundColor: palette.primary }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white hover:opacity-95 rounded-lg transition-opacity whitespace-nowrap"
            >
              <Archive className="w-4 h-4" />
              Měsíční balíček pro účetní (ZIP)
            </button>
          )}
        </div>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('inventory')}
          className="text-left bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Hodnota zásob
            </span>
            <Package className="w-4 h-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {formatCzk(kpis.stockValue)}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {kpis.skuCount} položek · {lowStockItems.length} pod minimem
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('invoices')}
          className="text-left bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Neuhrazené pohledávky
            </span>
            <AlertTriangle
              className={`w-4 h-4 ${overdueInvoices.length > 0 ? 'text-red-600' : 'text-slate-400'}`}
            />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {formatCzk(kpis.unpaidTotal)}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {kpis.unpaidCount} otevřených ·{' '}
            <span className={overdueInvoices.length > 0 ? 'text-red-600 font-medium' : ''}>
              {overdueInvoices.length} po splatnosti
            </span>
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('bank-matching')}
          className="text-left bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Uhrazeno celkem
            </span>
            <Landmark className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">
            {formatCzk(kpis.paidTotal)}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {kpis.unmatchedIncomingCount} nespárovaných příchozích plateb
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('clients')}
          className="text-left bg-white border border-slate-200 hover:border-slate-300 rounded-xl p-5 transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Adresář klientů
            </span>
            <Users className="w-4 h-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900 tabular-nums">{clients.length}</p>
          <p className="mt-1 text-xs text-slate-500">
            Sdíleno pro obě firmy · napojeno na ARES
          </p>
        </button>
      </div>

      {/* Alerts callout if any */}
      {(lowStockItems.length > 0 || overdueInvoices.length > 0) && (
        <div className="bg-amber-50/70 border border-amber-200 rounded-xl px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm text-amber-950">
            <Bell className="w-4 h-4 text-amber-700 shrink-0" />
            <span>
              <strong>Centrum upozornění:</strong>{' '}
              {lowStockItems.length > 0 && `${lowStockItems.length} položek má nízký stav zásob`}
              {lowStockItems.length > 0 && overdueInvoices.length > 0 && ' · '}
              {overdueInvoices.length > 0 && `${overdueInvoices.length} faktur je po splatnosti`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('alerts')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-900 hover:text-amber-700 whitespace-nowrap"
          >
            Otevřít upozornění
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Monthly Cashflow & Realtime Performance Chart */}
      <PerformanceChart
        invoices={companyInvoices}
        movements={companyMovements}
        accentPrimary={palette.primary}
        vatPayer={activeCompany?.vatPayer ?? true}
      />

      {/* Recent Invoices + Recent Stock Movements */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Poslední faktury</h2>
            <button
              type="button"
              onClick={() => onNavigate('invoices')}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
            >
              Všechny faktury
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {recentInvoices.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Pro firmu {activeCompany?.name} zatím nejsou vystaveny žádné faktury.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentInvoices.map((inv) => {
                const overdue = isInvoiceOverdue(inv);
                const diff = daysUntilDue(inv.dueDate);
                return (
                  <button
                    key={inv.id}
                    type="button"
                    onClick={() => onNavigate('invoices')}
                    className="w-full text-left px-5 py-3.5 hover:bg-slate-50 transition-colors flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {inv.clientName || 'Bez názvu klienta'}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        <span className="font-mono text-slate-700">{inv.invoiceNumber}</span>
                        {' · '}
                        Splatnost {formatDateCz(inv.dueDate)}
                        {overdue && diff !== null && (
                          <span className="text-red-600 font-medium">
                            {' · '}
                            {Math.abs(diff)} dní po splatnosti
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-slate-900 tabular-nums">
                        {formatCzk(inv.totalWithVat, inv.currency)}
                      </p>
                      <p
                        className={`text-xs font-medium mt-0.5 ${
                          inv.status === 'PAID'
                            ? 'text-emerald-700'
                            : inv.status === 'CANCELLED'
                              ? 'text-slate-400'
                              : overdue
                                ? 'text-red-600'
                                : 'text-amber-700'
                        }`}
                      >
                        {inv.status === 'PAID'
                          ? 'Uhrazeno'
                          : inv.status === 'CANCELLED'
                            ? 'Stornováno'
                            : overdue
                              ? 'Po splatnosti'
                              : 'Vystaveno'}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Poslední skladové pohyby</h2>
            <button
              type="button"
              onClick={() => onNavigate('inventory')}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
            >
              Otevřít sklad
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {recentMovements.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              Zatím nebyly zaznamenány žádné pohyby zboží.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {recentMovements.map((mov) => {
                const isReceipt = mov.quantityDelta > 0;
                return (
                  <div
                    key={mov.id}
                    className="px-5 py-3.5 flex items-center justify-between gap-4"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                          isReceipt
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {isReceipt ? (
                          <ArrowDownLeft className="w-4 h-4" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {mov.itemName}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 truncate">
                          {whNameMap.get(mov.warehouseId) || 'Sklad'}
                          {' · '}
                          {mov.documentRef || mov.note}
                          {' · '}
                          {formatTimestampCz(mov.createdAt)}
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p
                        className={`text-sm font-semibold tabular-nums ${
                          isReceipt ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {isReceipt ? '+' : ''}
                        {formatQty(mov.quantityDelta)} {mov.unit}
                      </p>
                      {mov.unitPrice > 0 && (
                        <p className="text-xs text-slate-400 tabular-nums">
                          {formatCzk(Math.abs(mov.quantityDelta) * mov.unitPrice)}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
