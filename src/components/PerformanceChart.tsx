import React, { useMemo, useState } from 'react';
import { formatCzk, round2, timestampToMs, toIsoDate } from '../lib/format';
import type { Invoice, StockMovement } from '../types';

type ChartMode = 'CASHFLOW' | 'SALES_STOCK';
type TimeRange = '6M' | '12M' | '30D' | '7D';

interface PerformanceChartProps {
  invoices: Invoice[];
  movements: StockMovement[];
  accentPrimary: string;
  vatPayer?: boolean;
}

interface ChartBucket {
  key: string;
  label: string;
  invoiced: number;
  paid: number;
  stockInValue: number;
  stockOutValue: number;
  // Fakturoid-style Cashflow metrics (CZK)
  incomeCzk: number;
  expenseCzk: number;
  outputVatCzk: number;
  inputVatEstCzk: number;
  vatDueEstimateCzk: number;
}

const MONTH_NAMES = ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čvn', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro'];

function dateToMonthKey(iso: string): string {
  return (iso || '').slice(0, 7);
}

function movementDateIso(m: StockMovement): string {
  const ms = timestampToMs(m.createdAt);
  return toIsoDate(new Date(ms));
}

function getInvoiceFx(inv: Invoice): number {
  const cur = (inv.currency || 'CZK').toUpperCase();
  if (cur === 'CZK') return 1;
  const fx = Number(inv.exchangeRate || 1);
  return fx > 0 ? fx : 1;
}

export function PerformanceChart({
  invoices,
  movements,
  accentPrimary,
  vatPayer = true,
}: PerformanceChartProps) {
  const [chartMode, setChartMode] = useState<ChartMode>('CASHFLOW');
  const [range, setRange] = useState<TimeRange>('6M');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const isMonthly = range === '6M' || range === '12M';

  const buckets = useMemo<ChartBucket[]>(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const result: ChartBucket[] = [];
    const map = new Map<string, ChartBucket>();

    const makeEmpty = (key: string, label: string): ChartBucket => ({
      key,
      label,
      invoiced: 0,
      paid: 0,
      stockInValue: 0,
      stockOutValue: 0,
      incomeCzk: 0,
      expenseCzk: 0,
      outputVatCzk: 0,
      inputVatEstCzk: 0,
      vatDueEstimateCzk: 0,
    });

    if (isMonthly) {
      const months = range === '12M' ? 12 : 6;
      for (let i = months - 1; i >= 0; i--) {
        const dt = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        const bucket = makeEmpty(
          key,
          `${MONTH_NAMES[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`
        );
        result.push(bucket);
        map.set(key, bucket);
      }
    } else {
      const days = range === '7D' ? 7 : 30;
      for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(today.getTime() - i * 86400000);
        const key = toIsoDate(dt);
        const bucket = makeEmpty(key, `${dt.getDate()}.${dt.getMonth() + 1}.`);
        result.push(bucket);
        map.set(key, bucket);
      }
    }

    for (const inv of invoices) {
      if (inv.status === 'CANCELLED') continue;
      const dt = inv.documentType || 'INVOICE';
      if (dt === 'QUOTE' || dt === 'PROFORMA') continue;

      const fx = getInvoiceFx(inv);
      const sign = dt === 'CREDIT_NOTE' ? -1 : 1;
      const refDate = inv.taxDate || inv.issueDate;
      const issueKey = isMonthly ? dateToMonthKey(refDate) : refDate;
      const bIssue = map.get(issueKey);
      if (bIssue) {
        const grossCzk = round2(inv.totalWithVat * fx * sign);
        const vatCzk = round2(inv.totalVat * fx * sign);
        bIssue.invoiced = round2(bIssue.invoiced + grossCzk);
        bIssue.incomeCzk = round2(bIssue.incomeCzk + grossCzk);
        if (vatPayer && !inv.reverseCharge) {
          bIssue.outputVatCzk = round2(bIssue.outputVatCzk + vatCzk);
        }
      }
      if (inv.paidAmount > 0 && inv.paidDate) {
        const paidKey = isMonthly ? dateToMonthKey(inv.paidDate) : inv.paidDate;
        const bPaid = map.get(paidKey);
        if (bPaid) {
          bPaid.paid = round2(bPaid.paid + inv.paidAmount * fx * sign);
        }
      }
    }

    for (const mov of movements) {
      const iso = movementDateIso(mov);
      const key = isMonthly ? dateToMonthKey(iso) : iso;
      const b = map.get(key);
      if (!b) continue;
      const netVal = round2(Math.abs(mov.quantityDelta) * Math.max(0, mov.unitPrice || 0));
      if (mov.quantityDelta > 0) {
        b.stockInValue = round2(b.stockInValue + netVal);
        // Treat stock receipts (excluding credit-note returns) as purchase expenses
        const isCreditReturn = /^DOB\b/i.test(mov.documentRef || '');
        if (!isCreditReturn && mov.movementType === 'RECEIPT') {
          const estInputVat = vatPayer ? round2(netVal * 0.21) : 0;
          b.expenseCzk = round2(b.expenseCzk + netVal + estInputVat);
          b.inputVatEstCzk = round2(b.inputVatEstCzk + estInputVat);
        }
      } else if (mov.quantityDelta < 0) {
        b.stockOutValue = round2(b.stockOutValue + netVal);
      }
    }

    for (const b of result) {
      b.vatDueEstimateCzk = vatPayer ? round2(b.outputVatCzk - b.inputVatEstCzk) : 0;
    }

    return result;
  }, [invoices, movements, range, isMonthly, vatPayer]);

  const totals = useMemo(() => {
    return buckets.reduce(
      (acc, b) => ({
        invoiced: round2(acc.invoiced + b.invoiced),
        paid: round2(acc.paid + b.paid),
        stockIn: round2(acc.stockIn + b.stockInValue),
        stockOut: round2(acc.stockOut + b.stockOutValue),
        income: round2(acc.income + b.incomeCzk),
        expense: round2(acc.expense + b.expenseCzk),
        vatDue: round2(acc.vatDue + b.vatDueEstimateCzk),
      }),
      { invoiced: 0, paid: 0, stockIn: 0, stockOut: 0, income: 0, expense: 0, vatDue: 0 }
    );
  }, [buckets]);

  const maxVal = useMemo(() => {
    let m = 1;
    for (const b of buckets) {
      if (chartMode === 'CASHFLOW') {
        m = Math.max(m, Math.abs(b.incomeCzk), Math.abs(b.expenseCzk), Math.abs(b.vatDueEstimateCzk));
      } else {
        m = Math.max(m, b.invoiced, b.paid, b.stockInValue, b.stockOutValue);
      }
    }
    return m;
  }, [buckets, chartMode]);

  const chartWidth = 760;
  const chartHeight = 235;
  const padLeft = 14;
  const padRight = 14;
  const padTop = 18;
  const padBottom = 30;
  const plotW = chartWidth - padLeft - padRight;
  const plotH = chartHeight - padTop - padBottom;

  const slotW = plotW / Math.max(1, buckets.length);
  const activeBucket = hoverIdx !== null ? buckets[hoverIdx] : null;

  const valueToY = (v: number) => {
    const clamped = Math.max(0, v);
    return padTop + plotH - (clamped / maxVal) * plotH;
  };

  const buildSmoothPath = (getter: (b: ChartBucket) => number) => {
    if (buckets.length === 0) return '';
    const pts = buckets.map((b, idx) => ({
      x: padLeft + idx * slotW + slotW / 2,
      y: valueToY(getter(b)),
    }));
    if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const cx = (p0.x + p1.x) / 2;
      d += ` C ${cx.toFixed(1)} ${p0.y.toFixed(1)}, ${cx.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
    }
    return d;
  };

  const buildAreaPath = (getter: (b: ChartBucket) => number) => {
    if (buckets.length < 2) return '';
    const line = buildSmoothPath(getter);
    const firstX = padLeft + slotW / 2;
    const lastX = padLeft + (buckets.length - 1) * slotW + slotW / 2;
    const baseY = padTop + plotH;
    return `${line} L ${lastX.toFixed(1)} ${baseY.toFixed(1)} L ${firstX.toFixed(1)} ${baseY.toFixed(1)} Z`;
  };

  const shownIncome = activeBucket ? activeBucket.incomeCzk : totals.income;
  const shownExpense = activeBucket ? activeBucket.expenseCzk : totals.expense;
  const shownNetCashflow = round2(shownIncome - shownExpense);
  const shownVatDue = activeBucket ? activeBucket.vatDueEstimateCzk : totals.vatDue;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {chartMode === 'CASHFLOW'
              ? 'Měsíční cashflow (Příjmy vs. Náklady vs. Odhad DPH)'
              : 'Vývoj tržeb a skladových pohybů'}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            {chartMode === 'CASHFLOW'
              ? 'Přehledná křivka tržeb z daňových dokladů, nákupních nákladů a odhadu DPH k odvodu'
              : 'Živý přehled fakturace, úhrad a hodnoty naskladnění/výdeje aktivní firmy'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            {(
              [
                ['CASHFLOW', 'Cashflow & DPH'],
                ['SALES_STOCK', 'Fakturace & Sklad'],
              ] as [ChartMode, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setChartMode(id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  chartMode === id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            {(
              [
                ['6M', '6M'],
                ['12M', '12M'],
                ['30D', '30D'],
                ['7D', '7D'],
              ] as [TimeRange, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setRange(id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  range === id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary strip */}
      {chartMode === 'CASHFLOW' ? (
        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4 border-t border-slate-100">
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-600" />
              Příjmy (s DPH)
            </p>
            <p className="mt-0.5 text-sm font-bold text-emerald-700 tabular-nums">
              {formatCzk(shownIncome)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-rose-500" />
              Náklady (nákup zásob)
            </p>
            <p className="mt-0.5 text-sm font-bold text-rose-700 tabular-nums">
              {formatCzk(shownExpense)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-800" />
              Bilance (Příjmy − Náklady)
            </p>
            <p
              className={`mt-0.5 text-sm font-bold tabular-nums ${
                shownNetCashflow < 0 ? 'text-rose-700' : 'text-slate-900'
              }`}
            >
              {shownNetCashflow >= 0 ? '+' : ''}
              {formatCzk(shownNetCashflow)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-violet-600" />
              {vatPayer ? 'Odhad DPH k odvodu' : 'DPH (neplátce)'}
            </p>
            <p
              className={`mt-0.5 text-sm font-bold tabular-nums ${
                shownVatDue > 0 ? 'text-violet-700' : 'text-emerald-700'
              }`}
            >
              {vatPayer
                ? `${shownVatDue > 0 ? '' : 'Nadměrný odpočet '}${formatCzk(Math.abs(shownVatDue))}`
                : '0,00 Kč'}
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4 border-t border-slate-100">
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-xs"
                style={{ backgroundColor: accentPrimary }}
              />
              Vyfakturováno
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
              {formatCzk(activeBucket ? activeBucket.invoiced : totals.invoiced)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-xs bg-emerald-600" />
              Uhrazeno
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
              {formatCzk(activeBucket ? activeBucket.paid : totals.paid)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-xs bg-sky-600" />
              Příjem na sklad
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
              {formatCzk(activeBucket ? activeBucket.stockInValue : totals.stockIn)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-xs bg-amber-600" />
              Výdej ze skladu
            </p>
            <p className="mt-0.5 text-sm font-semibold text-slate-900 tabular-nums">
              {formatCzk(activeBucket ? activeBucket.stockOutValue : totals.stockOut)}
            </p>
          </div>
        </div>
      )}

      {/* SVG chart */}
      <div className="mt-4 relative">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-60 overflow-visible select-none"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="cfIncomeGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#059669" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#059669" stopOpacity="0.01" />
            </linearGradient>
            <linearGradient id="cfExpenseGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#E11D48" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#E11D48" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Horizontal grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padTop + plotH * (1 - ratio);
            return (
              <line
                key={ratio}
                x1={padLeft}
                x2={chartWidth - padRight}
                y1={y}
                y2={y}
                stroke="#E2E8F0"
                strokeWidth="1"
                strokeDasharray={ratio === 0 ? undefined : '3 3'}
              />
            );
          })}

          {chartMode === 'CASHFLOW' ? (
            <>
              {/* Smooth area + curve for Income */}
              {buckets.length > 1 && (
                <>
                  <path d={buildAreaPath((b) => b.incomeCzk)} fill="url(#cfIncomeGrad)" />
                  <path d={buildAreaPath((b) => b.expenseCzk)} fill="url(#cfExpenseGrad)" />

                  <path
                    d={buildSmoothPath((b) => b.incomeCzk)}
                    fill="none"
                    stroke="#059669"
                    strokeWidth="2.75"
                    strokeLinecap="round"
                  />
                  <path
                    d={buildSmoothPath((b) => b.expenseCzk)}
                    fill="none"
                    stroke="#E11D48"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                  {vatPayer && (
                    <path
                      d={buildSmoothPath((b) => Math.max(0, b.vatDueEstimateCzk))}
                      fill="none"
                      stroke="#7C3AED"
                      strokeWidth="2.25"
                      strokeDasharray="6 4"
                      strokeLinecap="round"
                    />
                  )}
                </>
              )}

              {/* Data point markers (always visible on monthly view, or on hover) */}
              {buckets.map((b, idx) => {
                const cx = padLeft + idx * slotW + slotW / 2;
                const isHovered = hoverIdx === idx;
                if (!isMonthly && !isHovered) return null;
                return (
                  <g key={`pts-${b.key}`}>
                    <circle
                      cx={cx}
                      cy={valueToY(b.incomeCzk)}
                      r={isHovered ? 5 : 3.2}
                      fill="#059669"
                      stroke="#FFFFFF"
                      strokeWidth="1.5"
                    />
                    <circle
                      cx={cx}
                      cy={valueToY(b.expenseCzk)}
                      r={isHovered ? 5 : 3.2}
                      fill="#E11D48"
                      stroke="#FFFFFF"
                      strokeWidth="1.5"
                    />
                    {vatPayer && (
                      <circle
                        cx={cx}
                        cy={valueToY(Math.max(0, b.vatDueEstimateCzk))}
                        r={isHovered ? 4.5 : 2.8}
                        fill="#7C3AED"
                        stroke="#FFFFFF"
                        strokeWidth="1.5"
                      />
                    )}
                  </g>
                );
              })}
            </>
          ) : (
            <>
              {/* Bars for Sales */}
              {buckets.map((b, idx) => {
                const groupW = Math.min(28, slotW * 0.68);
                const barW = Math.max(3, groupW / 2 - 1);
                const centerX = padLeft + idx * slotW + slotW / 2;
                const invH = (Math.max(0, b.invoiced) / maxVal) * plotH;
                const paidH = (Math.max(0, b.paid) / maxVal) * plotH;

                return (
                  <g key={`sales-${b.key}`}>
                    {b.invoiced > 0 && (
                      <rect
                        x={centerX - barW - 1}
                        y={padTop + plotH - invH}
                        width={barW}
                        height={Math.max(2, invH)}
                        rx={2}
                        fill={accentPrimary}
                        opacity={hoverIdx === null || hoverIdx === idx ? 0.85 : 0.35}
                      />
                    )}
                    {b.paid > 0 && (
                      <rect
                        x={centerX + 1}
                        y={padTop + plotH - paidH}
                        width={barW}
                        height={Math.max(2, paidH)}
                        rx={2}
                        fill="#059669"
                        opacity={hoverIdx === null || hoverIdx === idx ? 0.9 : 0.35}
                      />
                    )}
                  </g>
                );
              })}

              {/* Lines for Stock Movements */}
              {buckets.length > 1 && (
                <>
                  <path
                    d={buildSmoothPath((b) => b.stockInValue)}
                    fill="none"
                    stroke="#0284C7"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d={buildSmoothPath((b) => b.stockOutValue)}
                    fill="none"
                    stroke="#D97706"
                    strokeWidth="2"
                    strokeDasharray="4 3"
                    strokeLinecap="round"
                  />
                </>
              )}
            </>
          )}

          {/* Hover capture columns & X labels */}
          {buckets.map((b, idx) => {
            const x = padLeft + idx * slotW;
            const showLabel =
              range === '7D' ||
              range === '6M' ||
              range === '12M' ||
              idx === 0 ||
              idx === buckets.length - 1 ||
              idx % 5 === 0;
            return (
              <g key={`col-${b.key}`} onMouseEnter={() => setHoverIdx(idx)}>
                {hoverIdx === idx && (
                  <rect
                    x={x}
                    y={padTop}
                    width={slotW}
                    height={plotH}
                    fill="#0F172A"
                    opacity={0.04}
                  />
                )}
                <rect
                  x={x}
                  y={padTop}
                  width={slotW}
                  height={plotH + padBottom}
                  fill="transparent"
                />
                {showLabel && (
                  <text
                    x={x + slotW / 2}
                    y={chartHeight - 6}
                    textAnchor="middle"
                    className="fill-slate-400 text-[10px] font-mono"
                  >
                    {b.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {activeBucket && (
          <div className="mt-1 text-xs text-slate-500 flex items-center justify-between">
            <span>
              Vybrané období: <strong className="text-slate-800">{activeBucket.label}</strong>
              {chartMode === 'CASHFLOW' && vatPayer && (
                <span className="ml-2 text-slate-400">
                  (DPH výstup {formatCzk(activeBucket.outputVatCzk)} − odhad vstup{' '}
                  {formatCzk(activeBucket.inputVatEstCzk)})
                </span>
              )}
            </span>
            <span>Přejeďte myší mimo graf pro celkový součet</span>
          </div>
        )}
      </div>
    </div>
  );
}
