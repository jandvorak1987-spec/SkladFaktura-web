import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BarChart3,
  Download,
  FileText,
  Loader2,
  Percent,
  Receipt,
  Tag,
  TrendingUp,
  Users,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  calculateInvoiceTotals,
  computeInvoiceProfitStats,
  downloadTextFile,
  extractBrandFromProductName,
  findInventoryItemForLine,
  formatCzk,
  formatDateCz,
  formatQty,
  getCompanyPalette,
  getDocumentTypeShortLabel,
  lineTotalWithoutVat,
  round2,
  toIsoDate,
} from '../lib/format';
import type { Invoice } from '../types';

type PeriodPreset = 'THIS_MONTH' | 'LAST_MONTH' | 'THIS_QUARTER' | 'THIS_YEAR' | 'ALL';

function getPeriodRange(preset: PeriodPreset): {
  from: string;
  to: string;
  label: string;
  monthKey: string;
} {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  if (preset === 'THIS_MONTH') {
    const from = toIsoDate(new Date(y, m, 1));
    const to = toIsoDate(new Date(y, m + 1, 0));
    return {
      from,
      to,
      label: `Tento měsíc (${m + 1}/${y})`,
      monthKey: from.slice(0, 7),
    };
  }
  if (preset === 'LAST_MONTH') {
    const from = toIsoDate(new Date(y, m - 1, 1));
    const to = toIsoDate(new Date(y, m, 0));
    const dt = new Date(y, m - 1, 1);
    return {
      from,
      to,
      label: `Minulý měsíc (${dt.getMonth() + 1}/${dt.getFullYear()})`,
      monthKey: from.slice(0, 7),
    };
  }
  if (preset === 'THIS_QUARTER') {
    const qStart = Math.floor(m / 3) * 3;
    const qNum = Math.floor(m / 3) + 1;
    return {
      from: toIsoDate(new Date(y, qStart, 1)),
      to: toIsoDate(new Date(y, qStart + 3, 0)),
      label: `Q${qNum} ${y}`,
      monthKey: toIsoDate(now).slice(0, 7),
    };
  }
  if (preset === 'THIS_YEAR') {
    return {
      from: `${y}-01-01`,
      to: `${y}-12-31`,
      label: `Rok ${y}`,
      monthKey: toIsoDate(now).slice(0, 7),
    };
  }
  return {
    from: '2000-01-01',
    to: '2099-12-31',
    label: 'Všechna období',
    monthKey: toIsoDate(now).slice(0, 7),
  };
}

function getInvoiceCzkMultiplier(inv: Invoice): number {
  const cur = (inv.currency || 'CZK').toUpperCase();
  if (cur === 'CZK') return 1;
  const rate = Number(inv.exchangeRate || 1);
  return rate > 0 ? rate : 1;
}

export function ReportsVatView() {
  const { workspace, activeCompany, invoices, inventory, movements, warehouses, notify } = useApp();
  const palette = getCompanyPalette(activeCompany?.accentIndex);
  const [period, setPeriod] = useState<PeriodPreset>('THIS_MONTH');
  const [buildingZip, setBuildingZip] = useState(false);

  const range = useMemo(() => getPeriodRange(period), [period]);

  const inventoryLookups = useMemo(() => {
    const byId = new Map(inventory.map((i) => [i.id, i]));
    const bySku = new Map<string, (typeof inventory)[number]>();
    const byName = new Map<string, (typeof inventory)[number]>();
    for (const item of inventory) {
      if (item.sku.trim()) bySku.set(item.sku.trim().toLowerCase(), item);
      if (item.name.trim()) byName.set(item.name.trim().toLowerCase(), item);
    }
    return { byId, bySku, byName };
  }, [inventory]);

  // Tax documents (INVOICE + SIMPLIFIED + CREDIT_NOTE), excluding CANCELLED, QUOTE, PROFORMA
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
    let belowCostInvoicesCount = 0;

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
    const brandStats = new Map<
      string,
      { brand: string; qty: number; revenue: number; cost: number; itemsCount: number }
    >();
    const clientStats = new Map<
      string,
      {
        name: string;
        ico: string;
        count: number;
        revenueNet: number;
        revenueGross: number;
        cost: number;
        hasBelowCost: boolean;
      }
    >();
    const invoiceProfitRows: Array<{
      id: string;
      invoiceNumber: string;
      documentType: Invoice['documentType'];
      clientName: string;
      taxDate: string;
      revenueNetCzk: number;
      costCzk: number;
      profitCzk: number;
      marginPercent: number | null;
      hasBelowCostItems: boolean;
      matchedLinesCount: number;
      totalLinesCount: number;
    }> = [];

    for (const inv of taxDocuments) {
      const sign = inv.documentType === 'CREDIT_NOTE' ? -1 : 1;
      const fx = getInvoiceCzkMultiplier(inv);
      const invNet = round2(inv.totalWithoutVat * fx * sign);
      const invVat = round2(inv.totalVat * fx * sign);
      const invGross = round2(inv.totalWithVat * fx * sign);

      const invProfit = computeInvoiceProfitStats(
        inv,
        inventoryLookups.byId,
        inventoryLookups.bySku,
        inventoryLookups.byName
      );
      const signedInvCost = round2(invProfit.costCzk * sign);
      const signedInvProfit = round2(invNet - signedInvCost);
      const invMargin =
        invProfit.matchedLinesCount > 0 && Math.abs(invNet) > 0.001
          ? round2((signedInvProfit / Math.abs(invNet)) * 100)
          : null;

      if (invProfit.hasBelowCostItems) {
        belowCostInvoicesCount += 1;
      }

      invoiceProfitRows.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        documentType: inv.documentType,
        clientName: inv.clientName,
        taxDate: inv.taxDate || inv.issueDate,
        revenueNetCzk: invNet,
        costCzk: signedInvCost,
        profitCzk: signedInvProfit,
        marginPercent: invMargin,
        hasBelowCostItems: invProfit.hasBelowCostItems,
        matchedLinesCount: invProfit.matchedLinesCount,
        totalLinesCount: invProfit.totalLinesCount,
      });

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
        cost: 0,
        hasBelowCost: false,
      };
      cStat.count += 1;
      cStat.revenueNet = round2(cStat.revenueNet + invNet);
      cStat.revenueGross = round2(cStat.revenueGross + invGross);
      cStat.cost = round2(cStat.cost + signedInvCost);
      if (invProfit.hasBelowCostItems) cStat.hasBelowCost = true;
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

        const stockCard = findInventoryItemForLine(
          line,
          inventoryLookups.byId,
          inventoryLookups.bySku,
          inventoryLookups.byName
        );
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

        const brand = extractBrandFromProductName(line.name, stockCard?.category);
        const bStat = brandStats.get(brand) || {
          brand,
          qty: 0,
          revenue: 0,
          cost: 0,
          itemsCount: 0,
        };
        bStat.qty = round2(bStat.qty + (line.quantity || 0) * sign);
        bStat.revenue = round2(bStat.revenue + lineNetCzk);
        bStat.cost = round2(bStat.cost + lineCost);
        bStat.itemsCount += 1;
        brandStats.set(brand, bStat);
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
    const topBrands = [...brandStats.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 12);
    const topClients = [...clientStats.values()]
      .sort((a, b) => b.revenueNet - a.revenueNet)
      .slice(0, 12);
    invoiceProfitRows.sort((a, b) => b.taxDate.localeCompare(a.taxDate));

    return {
      revenueNetCzk,
      totalVatCzk,
      totalGrossCzk,
      cogsCzk,
      grossProfitCzk,
      marginPercent,
      paidGrossCzk: round2(paidGrossCzk),
      belowCostInvoicesCount,
      vatRows: Object.values(vatBuckets),
      topProducts,
      topBrands,
      topClients,
      invoiceProfitRows,
    };
  }, [taxDocuments, activeCompany, inventoryLookups]);

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

  const handleQuickDownloadAccountantZip = async () => {
    if (!workspace || !activeCompany) return;
    setBuildingZip(true);
    try {
      const { generateAndDownloadMonthlyAccountantPack } = await import('../lib/accountantPack');
      const res = await generateAndDownloadMonthlyAccountantPack({
        workspaceId: workspace.id,
        company: activeCompany,
        monthKey: range.monthKey,
        invoices,
        movements,
        inventory,
        warehouses,
      });
      notify(
        `Měsíční balíček ${res.zipFileName} (${res.zipSizeKb} kB) stažen (${res.issuedInvoicesCount} PDF + POHODA XML + pokladna).`
      );
    } catch (err) {
      notify(
        err instanceof Error ? err.message : 'Stažení balíčku pro účetní selhalo.',
        'error'
      );
    } finally {
      setBuildingZip(false);
    }
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
            {range.label} · {taxDocuments.length} daňových dokladů (faktury, prodejky, dobropisy)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start md:self-auto">
          <button
            type="button"
            disabled={buildingZip || !activeCompany}
            onClick={handleQuickDownloadAccountantZip}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg whitespace-nowrap disabled:opacity-60"
          >
            {buildingZip ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Archive className="w-4 h-4" />
            )}
            Balíček účetní ({range.monthKey}.zip)
          </button>
          <button
            type="button"
            onClick={handleExportVatCsv}
            style={{ backgroundColor: palette.primary }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            Export DPH (CSV)
          </button>
        </div>
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

      {/* Below-cost alert banner */}
      {metrics.belowCostInvoicesCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 text-xs text-red-950">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">
              Upozornění na prodej pod nákupní cenou ({metrics.belowCostInvoicesCount}{' '}
              {metrics.belowCostInvoicesCount === 1 ? 'doklad' : 'doklady'} v období)
            </p>
            <p className="text-red-800 mt-0.5">
              V tabulce ziskovosti podle faktur níže jsou zvýrazněny doklady obsahující položky
              prodané pod jejich aktuální nákupní cenou na skladě.
            </p>
          </div>
        </div>
      )}

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
            <span>Reálný zisk / marže</span>
            <Percent
              className={`w-4 h-4 ${metrics.grossProfitCzk < 0 ? 'text-red-600' : 'text-emerald-600'}`}
            />
          </div>
          <p
            className={`text-2xl font-bold mt-2 tabular-nums ${
              metrics.grossProfitCzk < 0 ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {metrics.grossProfitCzk >= 0 ? '+' : ''}
            {formatCzk(metrics.grossProfitCzk)}
          </p>
          <p className="text-xs text-slate-500 mt-1 tabular-nums">
            Průměrná marže {metrics.marginPercent.toFixed(1)} %
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

      {/* Profitability by Clients & by Brands */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">
              Reálný zisk a marže podle klientů
            </h2>
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
                    <th className="py-2.5 px-3 text-right">Dokladů</th>
                    <th className="py-2.5 px-3 text-right">Bez DPH</th>
                    <th className="py-2.5 px-4 text-right">Reálný zisk / marže</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {metrics.topClients.map((c) => {
                    const profit = round2(c.revenueNet - c.cost);
                    const pct =
                      Math.abs(c.revenueNet) > 0.001
                        ? round2((profit / Math.abs(c.revenueNet)) * 100)
                        : 0;
                    return (
                      <tr key={`${c.ico}_${c.name}`} className={c.hasBelowCost ? 'bg-red-50/40' : ''}>
                        <td className="py-2.5 px-4">
                          <p className="font-medium text-slate-900 flex items-center gap-1.5">
                            <span>{c.name}</span>
                            {c.hasBelowCost && (
                              <span
                                title="Obsahuje prodej pod nákupní cenou"
                                className="text-[10px] font-semibold px-1.5 py-0.5 bg-red-100 text-red-700 rounded"
                              >
                                Pod nákupem
                              </span>
                            )}
                          </p>
                          {c.ico && <p className="text-[11px] font-mono text-slate-400">IČO {c.ico}</p>}
                        </td>
                        <td className="py-2.5 px-3 text-right text-xs text-slate-600">{c.count}</td>
                        <td className="py-2.5 px-3 text-right text-slate-700">
                          {formatCzk(c.revenueNet)}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <span
                            className={`font-semibold ${profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}
                          >
                            {profit >= 0 ? '+' : ''}
                            {formatCzk(profit)}
                          </span>
                          <p className="text-[11px] text-slate-400">{pct.toFixed(1)} %</p>
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
            <Tag className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">
              Reálný zisk a marže podle značek
            </h2>
          </div>
          {metrics.topBrands.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              V tomto období zatím nejsou žádné prodané položky.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-2.5 px-4">Značka</th>
                    <th className="py-2.5 px-3 text-right">Kusů</th>
                    <th className="py-2.5 px-3 text-right">Obrat bez DPH</th>
                    <th className="py-2.5 px-4 text-right">Reálný zisk / marže</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {metrics.topBrands.map((b) => {
                    const profit = round2(b.revenue - b.cost);
                    const pct =
                      Math.abs(b.revenue) > 0.001
                        ? round2((profit / Math.abs(b.revenue)) * 100)
                        : 0;
                    return (
                      <tr key={b.brand}>
                        <td className="py-2.5 px-4 font-semibold text-slate-900">{b.brand}</td>
                        <td className="py-2.5 px-3 text-right text-xs text-slate-600">
                          {formatQty(b.qty)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-700">
                          {formatCzk(b.revenue)}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <span
                            className={`font-semibold ${profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}
                          >
                            {profit >= 0 ? '+' : ''}
                            {formatCzk(profit)}
                          </span>
                          <p className="text-[11px] text-slate-400">{pct.toFixed(1)} %</p>
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

      {/* Profitability per Invoice & per Product */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <FileText className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">
              Zisk a marže po jednotlivých fakturách
            </h2>
          </div>
          {metrics.invoiceProfitRows.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              V tomto období zatím nejsou žádné daňové doklady.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-2.5 px-4">Doklad / Odběratel</th>
                    <th className="py-2.5 px-3 text-right">Bez DPH</th>
                    <th className="py-2.5 px-3 text-right">Nákup</th>
                    <th className="py-2.5 px-4 text-right">Zisk / Marže</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {metrics.invoiceProfitRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.hasBelowCostItems || row.profitCzk < 0 ? 'bg-red-50/50' : ''}
                    >
                      <td className="py-2.5 px-4">
                        <p className="font-mono text-xs font-semibold text-slate-900 flex items-center gap-1.5 flex-wrap">
                          <span>{row.invoiceNumber}</span>
                          <span className="font-sans text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {getDocumentTypeShortLabel(row.documentType)}
                          </span>
                          {row.hasBelowCostItems && (
                            <span className="font-sans text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                              ⚠ Pod nákupem
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 truncate max-w-[200px]">
                          {row.clientName} · {formatDateCz(row.taxDate)}
                        </p>
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700 whitespace-nowrap">
                        {formatCzk(row.revenueNetCzk)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-500 whitespace-nowrap">
                        {row.matchedLinesCount > 0 ? formatCzk(row.costCzk) : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        {row.matchedLinesCount > 0 ? (
                          <>
                            <span
                              className={`font-semibold ${
                                row.profitCzk < 0 ? 'text-red-700' : 'text-emerald-700'
                              }`}
                            >
                              {row.profitCzk >= 0 ? '+' : ''}
                              {formatCzk(row.profitCzk)}
                            </span>
                            <p className="text-[11px] text-slate-400">
                              {row.marginPercent !== null ? `${row.marginPercent.toFixed(1)} %` : '—'}
                            </p>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">Bez sklad. karet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900">Ziskovost a marže položek</h2>
          </div>
          {metrics.topProducts.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              V tomto období zatím nejsou žádné fakturované položky.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-50">
                  <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="py-2.5 px-4">Položka</th>
                    <th className="py-2.5 px-3 text-right">Prodáno</th>
                    <th className="py-2.5 px-3 text-right">Tržba</th>
                    <th className="py-2.5 px-4 text-right">Marže</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 tabular-nums">
                  {metrics.topProducts.map((p) => {
                    const profit = round2(p.revenue - p.cost);
                    const pct = p.revenue > 0 ? round2((profit / p.revenue) * 100) : 0;
                    return (
                      <tr key={`${p.sku}_${p.name}`} className={profit < 0 ? 'bg-red-50/40' : ''}>
                        <td className="py-2.5 px-4">
                          <p className="font-medium text-slate-900 truncate max-w-[210px]">
                            {p.name}
                          </p>
                          <p className="text-[11px] font-mono text-slate-400">{p.sku}</p>
                        </td>
                        <td className="py-2.5 px-3 text-right text-xs text-slate-600">
                          {formatQty(p.qty)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-medium text-slate-900">
                          {formatCzk(p.revenue)}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <span
                            className={`font-semibold ${profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}
                          >
                            {profit >= 0 ? '+' : ''}
                            {formatCzk(profit)}
                          </span>
                          <p className="text-[11px] text-slate-400">{pct.toFixed(1)} %</p>
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
  );
}
