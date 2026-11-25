import React, { useMemo, useState } from 'react';
import { BarChart3, Download, Percent, Receipt, TrendingUp, Users } from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  calculateInvoiceTotals,
  downloadTextFile,
  formatCzk,
  formatQty,
  getCompanyPalette,
  lineTotalWithoutVat,
  round2,
  toIsoDate,
} from '../lib/format';
import type { Invoice } from '../types';

type PeriodPreset = 'THIS_MONTH' | 'LAST_MONTH' | 'THIS_QUARTER' | 'THIS_YEAR' | 'ALL';

function getPeriodRange(preset: PeriodPreset): { from: string; to: string; label: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  if (preset === 'THIS_MONTH') {
    const from = toIsoDate(new Date(y, m, 1));
    const to = toIsoDate(new Date(y, m + 1, 0));
    return { from, to, label: `Tento měsíc (${m + 1}/${y})` };
  }
  if (preset === 'LAST_MONTH') {
    const from = toIsoDate(new Date(y, m - 1, 1));
    const to = toIsoDate(new Date(y, m, 0));
    const dt = new Date(y, m - 1, 1);
    return { from, to, label: `Minulý měsíc (${dt.getMonth() + 1}/${dt.getFullYear()})` };
  }
  if (preset === 'THIS_QUARTER') {
    const qStart = Math.floor(m / 3) * 3;
    const qNum = Math.floor(m / 3) + 1;
    return {
      from: toIsoDate(new Date(y, qStart, 1)),
      to: toIsoDate(new Date(y, qStart + 3, 0)),
      label: `Q${qNum} ${y}`,
    };
  }
  if (preset === 'THIS_YEAR') {
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `Rok ${y}` };
  }
  return { from: '2000-01-01', to: '2099-12-31', label: 'Všechna období' };
}

function getInvoiceCzkMultiplier(inv: Invoice): number {
  const cur = (inv.currency || 'CZK').toUpperCase();
  if (cur === 'CZK') return 1;
  const rate = Number(inv.exchangeRate || 1);
  return rate > 0 ? rate : 1;
}

export function ReportsVatView() {
  const { activeCompany, invoices, inventory, notify } = useApp();
  const palette = getCompanyPalette(activeCompany?.accentIndex);
  const [period, setPeriod] = useState<PeriodPreset>('THIS_MONTH');

  const range = useMemo(() => getPeriodRange(period), [period]);

  const inventoryById = useMemo(
    () => new Map(inventory.map((i) => [i.id, i])),
    [inventory]
  );
  const inventoryBySku = useMemo(
    () => new Map(inventory.map((i) => [i.sku.toLowerCase(), i])),
    [inventory]
  );

  // Only tax documents (INVOICE + CREDIT_NOTE), excluding CANCELLED, QUOTE, PROFORMA
  const taxDocuments = useMemo(() => {
    return invoices.filter((inv) => {
      if (activeCompany && inv.companyId !== activeCompany.id) return false;
      if (inv.status === 'CANCELLED') return false;
      const dt = inv.documentType || 'INVOICE';
      if (dt === 'QUOTE' || dt === 'PROFORMA') return false;
      const refDate = inv.taxDate || inv.issueDate;
      return refDate >= range.from && refDate <= range.to;
    });
  }, [invoices, activeCompany, range]);

  const metrics = useMemo(() => {
    let revenueNetCzk = 0;
    let totalVatCzk = 0;
    let totalGrossCzk = 0;
    let cogsCzk = 0;
    let paidGrossCzk = 0;

    const vatBuckets: Record<string, { label: string; base: number; vat: number; total: number }> = {
      '21': { label: 'Základní sazba 21 %', base: 0, vat: 0, total: 0 },
      '12': { label: 'Snížená sazba 12 %', base: 0, vat: 0, total: 0 },
      '0': { label: 'Osvobozeno / 0 %', base: 0, vat: 0, total: 0 },
      RC: { label: 'Přenesená daňová povinnost (Reverse Charge)', base: 0, vat: 0, total: 0 },
    };

    const productStats = new Map<
      string,
      { name: string; sku: string; qty: number; revenue: number; cost: number }
    >();
    const clientStats = new Map<
      string,
      { name: string; ico: string; count: number; revenueNet: number; revenueGross: number }
    >();

    for (const inv of taxDocuments) {
      const sign = inv.documentType === 'CREDIT_NOTE' ? -1 : 1;
      const fx = getInvoiceCzkMultiplier(inv);
      const invNet = round2(inv.totalWithoutVat * fx * sign);
      const invVat = round2(inv.totalVat * fx * sign);
      const invGross = round2(inv.totalWithVat * fx * sign);

      revenueNetCzk += invNet;
      totalVatCzk += invVat;
      totalGrossCzk += invGross;
      if (inv.status === 'PAID') {
        paidGrossCzk += invGross;
      }

      const clientKey = inv.clientIco || inv.clientName || 'Neznámý odběratel';
      const cStat = clientStats.get(clientKey) || {
        name: inv.clientName || 'Neznámý odběratel',
        ico: inv.clientIco || '',
        count: 0,
        revenueNet: 0,
        revenueGross: 0,
      };
      cStat.count += 1;
      cStat.revenueNet = round2(cStat.revenueNet + invNet);
      cStat.revenueGross = round2(cStat.revenueGross + invGross);
      clientStats.set(clientKey, cStat);

      const isVatDoc = inv.totalVat > 0 || (activeCompany?.vatPayer ?? true);
      if (inv.reverseCharge) {
        const rcBaseCzk = round2(inv.totalWithoutVat * fx * sign);
        vatBuckets.RC.base = round2(vatBuckets.RC.base + rcBaseCzk);
        vatBuckets.RC.total = round2(vatBuckets.RC.total + rcBaseCzk);
      } else {
        const invBreakdown = calculateInvoiceTotals(inv.items || [], isVatDoc).breakdown;
        for (const row of invBreakdown) {
          const bucketKey = row.rate === 21 ? '21' : row.rate === 12 ? '12' : '0';
          const baseCzk = round2(row.base * fx * sign);
          const vatCzk = isVatDoc && row.rate > 0 ? round2(baseCzk * (row.rate / 100)) : 0;
          vatBuckets[bucketKey].base = round2(vatBuckets[bucketKey].base + baseCzk);
          vatBuckets[bucketKey].vat = round2(vatBuckets[bucketKey].vat + vatCzk);
          vatBuckets[bucketKey].total = round2(vatBuckets[bucketKey].total + baseCzk + vatCzk);
        }
      }

      for (const line of inv.items || []) {
        const lineNetCzk = round2(lineTotalWithoutVat(line) * fx * sign);

        const stockCard =
          (line.inventoryItemId ? inventoryById.get(line.inventoryItemId) : undefined) ||
          (line.sku ? inventoryBySku.get(line.sku.toLowerCase()) : undefined);
        const unitCost = stockCard ? Math.max(0, stockCard.purchasePrice) : 0;
        const lineCost = round2(unitCost * (line.quantity || 0) * sign);
        cogsCzk += lineCost;

        const pKey = line.sku || line.name;
        const pStat = productStats.get(pKey) || {
          name: line.name,
          sku: line.sku || '—',
          qty: 0,
          revenue: 0,
          cost: 0,
        };
        pStat.qty = round2(pStat.qty + (line.quantity || 0) * sign);
        pStat.revenue = round2(pStat.revenue + lineNetCzk);
        pStat.cost = round2(pStat.cost + lineCost);
        productStats.set(pKey, pStat);
      }
    }

    revenueNetCzk = round2(revenueNetCzk);
    totalVatCzk = round2(totalVatCzk);
    totalGrossCzk = round2(totalGrossCzk);
    cogsCzk = round2(cogsCzk);
    const grossProfitCzk = round2(revenueNetCzk - cogsCzk);
    const marginPercent = revenueNetCzk > 0 ? round2((grossProfitCzk / revenueNetCzk) * 100) : 0;

    const topProducts = [...productStats.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12);
    const topClients = [...clientStats.values()]
      .sort((a, b) => b.revenueNet - a.revenueNet)
      .slice(0, 10);

    return {
      revenueNetCzk,
      totalVatCzk,
      totalGrossCzk,
      cogsCzk,
      grossProfitCzk,
      marginPercent,
      paidGrossCzk: round2(paidGrossCzk),
      vatRows: Object.values(vatBuckets),
      topProducts,
      topClients,
    };
  }, [taxDocuments, activeCompany, inventoryById, inventoryBySku]);

  const handleExportVatCsv = () => {
    const header =
      'Cislo dokladu;Typ;DUZP;Vystaveno;Odberatel;ICO;DIC;Mena;Kurz;Zaklad CZK;DPH CZK;Celkem CZK;ReverseCharge;Stav';
    const rows = taxDocuments.map((inv) => {
      const sign = inv.documentType === 'CREDIT_NOTE' ? -1 : 1;
      const fx = getInvoiceCzkMultiplier(inv);
      const esc = (s: string) => `"${String(s || '').replace(/"/g, '""')}"`;
      return [
        esc(inv.invoiceNumber),
        esc(inv.documentType || 'INVOICE'),
        inv.taxDate || inv.issueDate,
        inv.issueDate,
        esc(inv.clientName),
        inv.clientIco || '',
        inv.clientDic || '',
        inv.currency || 'CZK',
        fx,
        round2(inv.totalWithoutVat * fx * sign),
        round2(inv.totalVat * fx * sign),
        round2(inv.totalWithVat * fx * sign),
        inv.reverseCharge ? 'ANO' : 'NE',
        inv.status,
      ].join(';');
    });
    const csv = `\uFEFF${header}\n${rows.join('\n')}`;
    const safeComp = (activeCompany?.name || 'firma').replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();
    downloadTextFile(
      csv,
      `podklad_dph_${safeComp}_${period.toLowerCase()}_${toIsoDate()}.csv`,
      'text/csv;charset=utf-8'
    );
    notify('Podklad pro DPH a účetní (CSV) byl stažen.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Finanční analytika · {activeCompany?.name}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Přehled zisku, marže a DPH</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {range.label} · {taxDocuments.length} daňových dokladů (bez nabídek, záloh a storn)
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportVatCsv}
          style={{ backgroundColor: palette.primary }}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 whitespace-nowrap self-start md:self-auto"
        >
          <Download className="w-4 h-4" />
          Export DPH pro účetní (CSV)
        </button>
      </div>

      {/* Period selector */}
      <div className="inline-flex flex-wrap items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
        {(
          [
            ['THIS_MONTH', 'Tento měsíc'],
            ['LAST_MONTH', 'Minulý měsíc'],
            ['THIS_QUARTER', 'Tento kvartál'],
            ['THIS_YEAR', 'Letošní rok'],
            ['ALL', 'Vše'],
          ] as [PeriodPreset, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setPeriod(id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              period === id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Obrat bez DPH</span>
            <BarChart3 className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-2 tabular-nums">
            {formatCzk(metrics.revenueNetCzk)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            S DPH {formatCzk(metrics.totalGrossCzk)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>DPH na výstupu</span>
            <Receipt className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-2 tabular-nums">
            {formatCzk(metrics.totalVatCzk)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            Uhrazeno {formatCzk(metrics.paidGrossCzk)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Nákupní náklady (zboží)</span>
            <TrendingUp className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-bold text-slate-900 mt-2 tabular-nums">
            {formatCzk(metrics.cogsCzk)}
          </p>
          <p className="text-xs text-slate-500 mt-1">Dle nákupních cen na skladových kartách</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500">
            <span>Hrubý zisk / marže</span>
            <Percent className="w-4 h-4 text-emerald-600" />
          </div>
          <p className="text-2xl font-bold text-emerald-700 mt-2 tabular-nums">
            {formatCzk(metrics.grossProfitCzk)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            Průměrná marže {metrics.marginPercent} %
          </p>
        </div>
      </div>

      {/* VAT Breakdown Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Rozpis DPH podle sazeb (podklad pro Přiznání k DPH a Kontrolní hlášení)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Cizoměnové doklady jsou přepočteny uloženým kurzem ČNB do CZK. Dobropisy se automaticky odečítají.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="py-3 px-5">Sazba / režim DPH</th>
                <th className="py-3 px-5 text-right">Základ daně (CZK)</th>
                <th className="py-3 px-5 text-right">DPH na výstupu (CZK)</th>
                <th className="py-3 px-5 text-right">Celkem s DPH (CZK)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm tabular-nums">
              {metrics.vatRows.map((row) => (
                <tr key={row.label}>
                  <td className="py-3 px-5 font-medium text-slate-800">{row.label}</td>
                  <td className="py-3 px-5 text-right text-slate-700">{formatCzk(row.base)}</td>
                  <td className="py-3 px-5 text-right text-slate-700">{formatCzk(row.vat)}</td>
                  <td className="py-3 px-5 text-right font-semibold text-slate-900">
                    {formatCzk(row.total)}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td className="py-3 px-5 text-slate-900">Celkem za období</td>
                <td className="py-3 px-5 text-right text-slate-900">
                  {formatCzk(metrics.revenueNetCzk)}
                </td>
                <td className="py-3 px-5 text-right text-slate-900">
                  {formatCzk(metrics.totalVatCzk)}
                </td>
                <td className="py-3 px-5 text-right text-slate-900">
                  {formatCzk(metrics.totalGrossCzk)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Top Products & Top Clients */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900">Ziskovost a marže položek</h2>
          </div>
          {metrics.topProducts.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              V tomto období zatím nejsou žádné fakturované položky.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-2.5 px-4">Položka</th>
                    <th className="py-2.5 px-4 text-right">Prodáno</th>
                    <th className="py-2.5 px-4 text-right">Tržba</th>
                    <th className="py-2.5 px-4 text-right">Marže</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {metrics.topProducts.map((p) => {
                    const profit = round2(p.revenue - p.cost);
                    const pct = p.revenue > 0 ? round2((profit / p.revenue) * 100) : 0;
                    return (
                      <tr key={`${p.sku}_${p.name}`}>
                        <td className="py-2.5 px-4">
                          <p className="font-medium text-slate-900 truncate max-w-[220px]">
                            {p.name}
                          </p>
                          <p className="text-[11px] font-mono text-slate-400">{p.sku}</p>
                        </td>
                        <td className="py-2.5 px-4 text-right text-xs text-slate-600">
                          {formatQty(p.qty)}
                        </td>
                        <td className="py-2.5 px-4 text-right font-medium text-slate-900">
                          {formatCzk(p.revenue)}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <span className="font-semibold text-emerald-700">{formatCzk(profit)}</span>
                          <p className="text-[11px] text-slate-400">{pct} %</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">Největší odběratelé v období</h2>
          </div>
          {metrics.topClients.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              V tomto období zatím nejsou žádné doklady.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-2.5 px-4">Odběratel</th>
                    <th className="py-2.5 px-4 text-right">Dokladů</th>
                    <th className="py-2.5 px-4 text-right">Bez DPH</th>
                    <th className="py-2.5 px-4 text-right">S DPH</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {metrics.topClients.map((c) => (
                    <tr key={`${c.ico}_${c.name}`}>
                      <td className="py-2.5 px-4">
                        <p className="font-medium text-slate-900">{c.name}</p>
                        {c.ico && <p className="text-[11px] font-mono text-slate-400">IČO {c.ico}</p>}
                      </td>
                      <td className="py-2.5 px-4 text-right text-xs text-slate-600">{c.count}</td>
                      <td className="py-2.5 px-4 text-right text-slate-700">
                        {formatCzk(c.revenueNet)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-semibold text-slate-900">
                        {formatCzk(c.revenueGross)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
