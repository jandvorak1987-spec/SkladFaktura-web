import React, { useMemo, useState } from 'react';
import { formatCzk, round2, timestampToMs, toIsoDate } from '../lib/format';
import type { Invoice, StockMovement } from '../types';

type TimeRange = '7D' | '30D' | '6M';
type MetricFilter = 'ALL' | 'SALES' | 'STOCK';

interface PerformanceChartProps {
  invoices: Invoice[];
  movements: StockMovement[];
  accentPrimary: string;
}

interface ChartBucket {
  key: string;
  label: string;
  invoiced: number;
  paid: number;
  stockInValue: number;
  stockOutValue: number;
}

const MONTH_NAMES = ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čvn', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro'];

function dateToMonthKey(iso: string): string {
  return iso.slice(0, 7);
}

function movementDateIso(m: StockMovement): string {
  const ms = timestampToMs(m.createdAt);
  return toIsoDate(new Date(ms));
}

export function PerformanceChart({
  invoices,
  movements,
  accentPrimary,
}: PerformanceChartProps) {
  const [range, setRange] = useState<TimeRange>('30D');
  const [metric, setMetric] = useState<MetricFilter>('ALL');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const buckets = useMemo<ChartBucket[]>(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const result: ChartBucket[] = [];
    const map = new Map<string, ChartBucket>();

    if (range === '6M') {
      for (let i = 5; i >= 0; i--) {
        const dt = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        const bucket: ChartBucket = {
          key,
          label: `${MONTH_NAMES[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`,
          invoiced: 0,
          paid: 0,
          stockInValue: 0,
          stockOutValue: 0,
        };
        result.push(bucket);
        map.set(key, bucket);
      }
    } else {
      const days = range === '7D' ? 7 : 30;
      for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(today.getTime() - i * 86400000);
        const key = toIsoDate(dt);
        const bucket: ChartBucket = {
          key,
          label: `${dt.getDate()}.${dt.getMonth() + 1}.`,
          invoiced: 0,
          paid: 0,
          stockInValue: 0,
          stockOutValue: 0,
        };
        result.push(bucket);
        map.set(key, bucket);
      }
    }

    for (const inv of invoices) {
      if (inv.status === 'CANCELLED') continue;
      const issueKey = range === '6M' ? dateToMonthKey(inv.issueDate) : inv.issueDate;
      const bIssue = map.get(issueKey);
      if (bIssue) {
        bIssue.invoiced = round2(bIssue.invoiced + inv.totalWithVat);
      }
      if (inv.paidAmount > 0 && inv.paidDate) {
        const paidKey = range === '6M' ? dateToMonthKey(inv.paidDate) : inv.paidDate;
        const bPaid = map.get(paidKey);
        if (bPaid) {
          bPaid.paid = round2(bPaid.paid + inv.paidAmount);
        }
      }
    }

    for (const mov of movements) {
      const iso = movementDateIso(mov);
      const key = range === '6M' ? dateToMonthKey(iso) : iso;
      const b = map.get(key);
      if (!b) continue;
      const val = Math.abs(mov.quantityDelta) * Math.max(0, mov.unitPrice || 0);
      if (mov.quantityDelta > 0) {
        b.stockInValue = round2(b.stockInValue + val);
      } else if (mov.quantityDelta < 0) {
        b.stockOutValue = round2(b.stockOutValue + val);
      }
    }

    return result;
  }, [invoices, movements, range]);

  const totals = useMemo(() => {
    return buckets.reduce(
      (acc, b) => ({
        invoiced: round2(acc.invoiced + b.invoiced),
        paid: round2(acc.paid + b.paid),
        stockIn: round2(acc.stockIn + b.stockInValue),
        stockOut: round2(acc.stockOut + b.stockOutValue),
      }),
      { invoiced: 0, paid: 0, stockIn: 0, stockOut: 0 }
    );
  }, [buckets]);

  const maxVal = useMemo(() => {
    let m = 1;
    for (const b of buckets) {
      if (metric === 'ALL' || metric === 'SALES') {
        m = Math.max(m, b.invoiced, b.paid);
      }
      if (metric === 'ALL' || metric === 'STOCK') {
        m = Math.max(m, b.stockInValue, b.stockOutValue);
      }
    }
    return m;
  }, [buckets, metric]);

  const chartWidth = 760;
  const chartHeight = 220;
  const padLeft = 12;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 28;
  const plotW = chartWidth - padLeft - padRight;
  const plotH = chartHeight - padTop - padBottom;

  const slotW = plotW / Math.max(1, buckets.length);
  const activeBucket = hoverIdx !== null ? buckets[hoverIdx] : null;

  const buildLinePath = (getter: (b: ChartBucket) => number) => {
    return buckets
      .map((b, idx) => {
        const x = padLeft + idx * slotW + slotW / 2;
        const y = padTop + plotH - (getter(b) / maxVal) * plotH;
        return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">Vývoj tržeb a skladových pohybů</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Živý přehled fakturace, úhrad a hodnoty naskladnění/výdeje aktivní firmy
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            {(
              [
                ['7D', '7 dní'],
                ['30D', '30 dní'],
                ['6M', '6 měsíců'],
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

          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            {(
              [
                ['ALL', 'Vše'],
                ['SALES', 'Prodej'],
                ['STOCK', 'Sklad'],
              ] as [MetricFilter, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setMetric(id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  metric === id
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
      <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4 border-t border-slate-100">
        {(metric === 'ALL' || metric === 'SALES') && (
          <>
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
          </>
        )}
        {(metric === 'ALL' || metric === 'STOCK') && (
          <>
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
          </>
        )}
      </div>

      {/* SVG chart */}
      <div className="mt-4 relative">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-56 overflow-visible select-none"
          onMouseLeave={() => setHoverIdx(null)}
        >
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

          {/* Bars for Sales */}
          {(metric === 'ALL' || metric === 'SALES') &&
            buckets.map((b, idx) => {
              const groupW = Math.min(28, slotW * 0.68);
              const barW = Math.max(3, groupW / 2 - 1);
              const centerX = padLeft + idx * slotW + slotW / 2;
              const invH = (b.invoiced / maxVal) * plotH;
              const paidH = (b.paid / maxVal) * plotH;

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
          {(metric === 'ALL' || metric === 'STOCK') && buckets.length > 1 && (
            <>
              <path
                d={buildLinePath((b) => b.stockInValue)}
                fill="none"
                stroke="#0284C7"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={buildLinePath((b) => b.stockOutValue)}
                fill="none"
                stroke="#D97706"
                strokeWidth="2"
                strokeDasharray="4 3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {/* Hover capture columns & X labels */}
          {buckets.map((b, idx) => {
            const x = padLeft + idx * slotW;
            const showLabel =
              range === '7D' ||
              range === '6M' ||
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
            </span>
            <span>Přejeďte myší mimo graf pro celkový součet</span>
          </div>
        )}
      </div>
    </div>
  );
}
