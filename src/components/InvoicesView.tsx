import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  ArrowRightLeft,
  Ban,
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Copy,
  Edit3,
  FileMinus2,
  FilePlus2,
  FileText,
  Globe,
  Loader2,
  Mail,
  Package,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  cancelInvoice,
  deleteCancelledInvoice,
  editInvoice,
  issueInvoice,
  markInvoicePaid,
  recordInvoiceEmailAction,
  updateInvoiceTemplate,
} from '../lib/firestoreService';
import {
  addDaysIso,
  addMonthsIso,
  buildCzechSpdQr,
  calculateInvoiceTotals,
  czechAccountToIban,
  daysUntilDue,
  formatCzk,
  formatDateCz,
  formatQty,
  getCompanyPalette,
  getDocumentTypeShortLabel,
  getDocumentTypeTitle,
  getRecurringLabel,
  isInvoiceOverdue,
  lineTotalWithoutVat,
  lineTotalWithVat,
  previewNextInvoiceNumber,
  round2,
  toIsoDate,
} from '../lib/format';
import {
  INVOICE_TEMPLATES,
  type Client,
  type Company,
  type CompanyBrandPalette,
  type Invoice,
  type InvoiceDocumentType,
  type InvoiceLineItem,
  type InvoiceStatus,
  type InvoiceTemplateId,
  type PaymentMethod,
  type RecurringInterval,
} from '../types';

interface InvoicesViewProps {
  initialCreateTrigger?: number;
  prefillClient?: Client | null;
  onClearPrefillClient?: () => void;
}

type StatusFilter = 'ALL' | InvoiceStatus | 'OVERDUE' | 'RECURRING' | 'NON_TAX';

const SUPPORTED_CURRENCIES = ['CZK', 'EUR', 'USD', 'PLN', 'GBP', 'CHF'] as const;
const REVERSE_CHARGE_LEGAL_TEXT =
  'Daň odvede zákazník (§ 92a zákona č. 235/2004 Sb., o DPH – režim přenesené daňové povinnosti).';

function paymentMethodLabel(method: PaymentMethod): string {
  if (method === 'CASH') return 'Hotově';
  if (method === 'CARD') return 'Platební kartou';
  return 'Bankovním převodem';
}

function InvoiceDocumentPreview({
  invoice,
  company,
  palette,
  vatPayer,
  deliveryNoteMode = false,
}: {
  invoice: Invoice;
  company?: Company | null;
  palette: CompanyBrandPalette;
  vatPayer: boolean;
  deliveryNoteMode?: boolean;
}) {
  const docType: InvoiceDocumentType = invoice.documentType || 'INVOICE';
  const isCreditNote = docType === 'CREDIT_NOTE';
  const isQuote = docType === 'QUOTE';
  const isProforma = docType === 'PROFORMA';
  const isReverseCharge = Boolean(invoice.reverseCharge);
  const showVatColumns = vatPayer && !isReverseCharge;
  const amountSign = isCreditNote ? -1 : 1;

  const template: InvoiceTemplateId = invoice.invoiceTemplate || 'CLASSIC';
  const totals = calculateInvoiceTotals(invoice.items, showVatColumns);
  const resolvedBankAccount = invoice.companyBankAccount || company?.bankAccount || '';
  const resolvedIban = (
    invoice.companyIban ||
    company?.iban ||
    (resolvedBankAccount ? czechAccountToIban(resolvedBankAccount) : '') ||
    ''
  )
    .replace(/\s+/g, '')
    .toUpperCase();

  const isCashPayment = invoice.paymentMethod === 'CASH';
  const allowQr = !isCashPayment && !isQuote && !isCreditNote && Boolean(resolvedIban);
  const spdPayload = allowQr
    ? buildCzechSpdQr({
        iban: resolvedIban,
        amount: Math.max(0, invoice.totalWithVat - invoice.paidAmount) || invoice.totalWithVat,
        variableSymbol: invoice.variableSymbol || invoice.invoiceNumber.replace(/\D/g, ''),
        message: `${getDocumentTypeShortLabel(docType)} ${invoice.invoiceNumber}`,
        dueDate: invoice.dueDate,
        currency: invoice.currency || 'CZK',
      })
    : null;

  const currency = (invoice.currency || 'CZK').toUpperCase();
  const fxRate = currency !== 'CZK' && invoice.exchangeRate && invoice.exchangeRate > 0 ? invoice.exchangeRate : 1;
  const showFxCzkSummary = currency !== 'CZK' && fxRate > 0;

  if (deliveryNoteMode) {
    return (
      <div className="print-invoice bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6 text-slate-900">
        <div
          className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 border-b-2"
          style={{ borderColor: palette.primary }}
        >
          <div>
            <p
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: palette.primary }}
            >
              Dodací list (bez cen)
            </p>
            <h2 className="text-2xl font-bold mt-1 font-mono text-slate-900">
              č. DL-{invoice.invoiceNumber}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              K dokladu č. <span className="font-mono text-slate-700">{invoice.invoiceNumber}</span>
            </p>
          </div>
          <div className="text-left sm:text-right text-xs text-slate-600 space-y-0.5 tabular-nums">
            <p>
              Datum vyskladnění:{' '}
              <strong className="text-slate-900">{formatDateCz(invoice.issueDate)}</strong>
            </p>
            <p>
              Počet položek: <strong className="text-slate-900">{invoice.items.length}</strong>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="rounded-lg p-4 bg-slate-50 border border-slate-200">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Dodavatel (odesílatel)
            </p>
            <p className="mt-1.5 text-base font-bold text-slate-900">{invoice.companyName}</p>
            <p className="text-xs text-slate-600 mt-1">{invoice.companyAddress || '—'}</p>
            <div className="mt-2 text-xs text-slate-600 font-mono">
              {invoice.companyIco && <p>IČO: {invoice.companyIco}</p>}
            </div>
          </div>
          <div className="rounded-lg p-4 bg-slate-50 border border-slate-200">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Odběratel (příjemce)
            </p>
            <p className="mt-1.5 text-base font-bold text-slate-900">{invoice.clientName}</p>
            <p className="text-xs text-slate-600 mt-1">
              {[invoice.clientStreet, [invoice.clientZip, invoice.clientCity].filter(Boolean).join(' ')]
                .filter(Boolean)
                .join(', ') || '—'}
            </p>
            <div className="mt-2 text-xs text-slate-600 font-mono">
              {invoice.clientIco && <p>IČO: {invoice.clientIco}</p>}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr
                className="border-b-2 text-[11px] uppercase tracking-wider text-slate-600"
                style={{ borderColor: palette.primary }}
              >
                <th className="py-2 pr-3 w-10">#</th>
                <th className="py-2 px-2">SKU / Kód</th>
                <th className="py-2 px-2">Název zboží / popis</th>
                <th className="py-2 px-2 text-right">Množství</th>
                <th className="py-2 pl-2 text-center w-24">Kontrola</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoice.items.map((item, idx) => (
                <tr key={`${item.sku}-${idx}`}>
                  <td className="py-2.5 pr-3 text-slate-400 tabular-nums">{idx + 1}.</td>
                  <td className="py-2.5 px-2 font-mono text-slate-600 whitespace-nowrap">
                    {item.sku || '—'}
                  </td>
                  <td className="py-2.5 px-2 font-medium text-slate-900">{item.name}</td>
                  <td className="py-2.5 px-2 text-right font-semibold tabular-nums whitespace-nowrap">
                    {formatQty(item.quantity)} {item.unit}
                  </td>
                  <td className="py-2.5 pl-2 text-center">
                    <span className="inline-block w-4 h-4 border border-slate-400 rounded-xs align-middle" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {invoice.note && (
          <p className="text-xs text-slate-600 border-t border-slate-100 pt-3">
            <strong className="text-slate-800">Poznámka k dodávce:</strong> {invoice.note}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-10 mt-6 border-t border-slate-200 text-xs text-slate-600">
          <div>
            <p className="font-semibold text-slate-800">Zboží předal (dodavatel)</p>
            <div className="mt-10 border-b border-slate-400" />
            <p className="mt-1.5 text-[11px] text-slate-500">Datum, jméno a podpis</p>
          </div>
          <div>
            <p className="font-semibold text-slate-800">Zboží převzal v pořádku (odběratel)</p>
            <div className="mt-10 border-b border-slate-400" />
            <p className="mt-1.5 text-[11px] text-slate-500">Datum, jméno, razítko a podpis</p>
          </div>
        </div>
      </div>
    );
  }

  const isBanner = template === 'MODERN_BANNER';
  const isMinimal = template === 'MINIMAL';
  const isSidebar = template === 'EXECUTIVE_SIDEBAR';
  const docTitle = getDocumentTypeTitle(docType, vatPayer);

  const bodyContent = (
    <div className="space-y-6 text-slate-900">
      {/* Header */}
      {isBanner ? (
        <div
          style={{ backgroundColor: palette.primary }}
          className="text-white rounded-lg p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div>
            <p className="text-xs uppercase tracking-widest opacity-80">{docTitle}</p>
            <h2 className="text-2xl font-bold mt-1 font-mono">{invoice.invoiceNumber}</h2>
            <p className="text-sm opacity-90 mt-1">{invoice.companyName}</p>
            {invoice.relatedInvoiceNumber && (
              <p className="text-xs opacity-80 mt-1 font-mono">
                K dokladu č. {invoice.relatedInvoiceNumber}
              </p>
            )}
          </div>
          <div className="text-left sm:text-right tabular-nums">
            <p className="text-xs uppercase opacity-80">
              {isCreditNote ? 'Celkem k vrácení' : isQuote ? 'Nabídková cena' : 'Celkem k úhradě'}
            </p>
            <p className="text-2xl font-bold mt-0.5">
              {formatCzk(amountSign * invoice.totalWithVat, currency)}
            </p>
            <p className="text-xs opacity-90 mt-1">
              {isQuote ? 'Platnost do' : 'Splatnost'} {formatDateCz(invoice.dueDate)} · VS{' '}
              {invoice.variableSymbol}
            </p>
          </div>
        </div>
      ) : (
        <div
          className={`flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 ${
            isMinimal ? 'border-b border-slate-200' : 'border-b-2'
          }`}
          style={isMinimal ? undefined : { borderColor: palette.primary }}
        >
          <div>
            <p
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: isMinimal ? '#64748B' : palette.primary }}
            >
              {docTitle}
            </p>
            <h2 className="text-2xl font-bold mt-1 font-mono text-slate-900">
              č. {invoice.invoiceNumber}
            </h2>
            {invoice.relatedInvoiceNumber && (
              <p className="text-xs text-slate-500 mt-1">
                Vázáno na doklad č.{' '}
                <strong className="font-mono text-slate-800">{invoice.relatedInvoiceNumber}</strong>
              </p>
            )}
          </div>
          <div className="text-left sm:text-right text-xs text-slate-600 space-y-0.5 tabular-nums">
            <p>
              Variabilní symbol:{' '}
              <strong className="font-mono text-slate-900">{invoice.variableSymbol}</strong>
            </p>
            <p>
              Datum vystavení:{' '}
              <strong className="text-slate-900">{formatDateCz(invoice.issueDate)}</strong>
            </p>
            {vatPayer && !isQuote && !isProforma && invoice.taxDate && (
              <p>
                DUZP: <strong className="text-slate-900">{formatDateCz(invoice.taxDate)}</strong>
              </p>
            )}
            <p>
              {isQuote ? 'Platnost nabídky do:' : 'Datum splatnosti:'}{' '}
              <strong className="text-slate-900">{formatDateCz(invoice.dueDate)}</strong>
            </p>
            {showFxCzkSummary && (
              <p>
                Kurz ČNB:{' '}
                <strong className="text-slate-900">
                  1 {currency} = {fxRate} Kč
                </strong>
              </p>
            )}
          </div>
        </div>
      )}

      {/* Non-tax document notice */}
      {isProforma && (
        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2">
          Tento doklad není daňovým dokladem. Daňový doklad (ostrá faktura) bude vystaven po připsání platby.
        </div>
      )}

      {/* Supplier & Client */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div
          className={`rounded-lg p-4 ${
            isMinimal ? 'bg-transparent border border-slate-100' : 'bg-slate-50 border border-slate-200'
          }`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Dodavatel
          </p>
          <p className="mt-1.5 text-base font-bold text-slate-900">{invoice.companyName}</p>
          <p className="text-xs text-slate-600 mt-1">{invoice.companyAddress || '—'}</p>
          <div className="mt-3 text-xs text-slate-600 space-y-0.5 font-mono">
            {invoice.companyIco && <p>IČO: {invoice.companyIco}</p>}
            {invoice.companyDic && <p>DIČ: {invoice.companyDic}</p>}
            {!vatPayer && <p className="font-sans text-slate-500">Neplátce DPH</p>}
          </div>
        </div>

        <div
          className={`rounded-lg p-4 ${
            isMinimal ? 'bg-transparent border border-slate-100' : 'bg-slate-50 border border-slate-200'
          }`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Odběratel
          </p>
          <p className="mt-1.5 text-base font-bold text-slate-900">{invoice.clientName}</p>
          <p className="text-xs text-slate-600 mt-1">
            {[invoice.clientStreet, [invoice.clientZip, invoice.clientCity].filter(Boolean).join(' ')]
              .filter(Boolean)
              .join(', ') || '—'}
          </p>
          <div className="mt-3 text-xs text-slate-600 space-y-0.5 font-mono">
            {invoice.clientIco && <p>IČO: {invoice.clientIco}</p>}
            {invoice.clientDic && <p>DIČ: {invoice.clientDic}</p>}
            {invoice.clientEmail && (
              <p className="font-sans text-slate-500">E-mail: {invoice.clientEmail}</p>
            )}
          </div>
        </div>
      </div>

      {/* Payment info & QR (hidden for Quotes) */}
      {!isQuote && (
        <div
          className="rounded-lg p-4 border flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          style={{
            backgroundColor: isMinimal ? '#FFFFFF' : palette.soft,
            borderColor: isMinimal ? '#E2E8F0' : palette.border,
          }}
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
            <div>
              <p className="text-slate-500">Způsob úhrady</p>
              <p className="font-semibold text-slate-900 mt-0.5">
                {paymentMethodLabel(invoice.paymentMethod)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Bankovní účet</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {resolvedBankAccount || '—'}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Variabilní symbol</p>
              <p className="font-mono font-semibold text-slate-900 mt-0.5">
                {invoice.variableSymbol || '—'}
              </p>
            </div>
            {resolvedIban && (
              <div className="col-span-2 sm:col-span-3">
                <p className="text-slate-500">IBAN</p>
                <p className="font-mono text-slate-800 mt-0.5">{resolvedIban}</p>
              </div>
            )}
          </div>

          {spdPayload ? (
            <div className="flex items-center gap-3 bg-white p-2.5 rounded-lg border border-slate-200 self-start sm:self-auto shrink-0">
              <QRCodeSVG value={spdPayload} size={92} level="M" />
              <div className="text-[11px] text-slate-600 leading-tight">
                <p className="font-semibold text-slate-900">QR Platba</p>
                <p className="mt-0.5">Naskenujte v</p>
                <p>mobilní bance</p>
              </div>
            </div>
          ) : (
            !isCashPayment &&
            !isCreditNote && (
              <div className="no-print text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-[220px]">
                Pro zobrazení <strong>QR Platby</strong> doplňte v <em>Nastavení → Firemní údaje</em>{' '}
                číslo účtu (např. <span className="font-mono">123456789/2010</span>) nebo IBAN.
              </div>
            )
          )}
        </div>
      )}

      {/* Items table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr
              className="border-b-2 text-[11px] uppercase tracking-wider"
              style={{
                borderColor: isMinimal ? '#CBD5E1' : palette.primary,
                color: '#475569',
              }}
            >
              <th className="py-2 pr-3">Položka</th>
              <th className="py-2 px-2 text-right">Množství</th>
              <th className="py-2 px-2 text-right">Cena / MJ</th>
              <th className="py-2 px-2 text-right">Sleva</th>
              {showVatColumns && <th className="py-2 px-2 text-right">DPH</th>}
              <th className="py-2 pl-2 text-right">Celkem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {invoice.items.map((item, idx) => (
              <tr key={`${item.sku}-${idx}`}>
                <td className="py-2.5 pr-3">
                  <p className="font-medium text-slate-900">{item.name}</p>
                  {item.sku && <p className="text-[11px] font-mono text-slate-400">{item.sku}</p>}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">
                  {isCreditNote ? '−' : ''}
                  {formatQty(item.quantity)} {item.unit}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">
                  {formatCzk(item.unitPrice, currency)}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap text-slate-500">
                  {item.discountPercent > 0 ? `${item.discountPercent} %` : '—'}
                </td>
                {showVatColumns && (
                  <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap text-slate-600">
                    {item.vatRate} %
                  </td>
                )}
                <td className="py-2.5 pl-2 text-right font-semibold tabular-nums whitespace-nowrap">
                  {formatCzk(
                    amountSign *
                      (showVatColumns ? lineTotalWithVat(item, true) : lineTotalWithoutVat(item)),
                    currency
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Reverse charge / Legal notice */}
      {(isReverseCharge || invoice.legalNotice) && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
          <strong className="text-slate-900">Zákonná doložka: </strong>
          {invoice.legalNotice || REVERSE_CHARGE_LEGAL_TEXT}
        </div>
      )}

      {/* VAT Summary + Grand total */}
      <div className="flex flex-col sm:flex-row justify-between gap-6 pt-4 border-t border-slate-200">
        <div className="flex-1 text-xs text-slate-600 space-y-3">
          {showVatColumns && totals.breakdown.length > 0 && (
            <table className="w-full max-w-xs text-left border-collapse">
              <thead>
                <tr className="text-[10px] uppercase text-slate-400 border-b border-slate-100">
                  <th className="py-1">Sazba</th>
                  <th className="py-1 text-right">Základ</th>
                  <th className="py-1 text-right">DPH</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 tabular-nums">
                {totals.breakdown.map((row) => (
                  <tr key={row.rate}>
                    <td className="py-1">{row.rate} %</td>
                    <td className="py-1 text-right">
                      {formatCzk(amountSign * row.base, currency)}
                    </td>
                    <td className="py-1 text-right">
                      {formatCzk(amountSign * row.vat, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {showFxCzkSummary && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 max-w-xs space-y-1 tabular-nums">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Přepočet do CZK pro DPH (kurz {fxRate} Kč/{currency})
              </p>
              <div className="flex justify-between">
                <span>Základ v CZK:</span>
                <span className="font-medium text-slate-800">
                  {formatCzk(amountSign * round2(invoice.totalWithoutVat * fxRate), 'CZK')}
                </span>
              </div>
              {showVatColumns && (
                <div className="flex justify-between">
                  <span>DPH v CZK:</span>
                  <span className="font-medium text-slate-800">
                    {formatCzk(amountSign * round2(invoice.totalVat * fxRate), 'CZK')}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-1 border-t border-slate-200 font-semibold text-slate-900">
                <span>Celkem v CZK:</span>
                <span>{formatCzk(amountSign * round2(invoice.totalWithVat * fxRate), 'CZK')}</span>
              </div>
            </div>
          )}

          {invoice.note && (
            <p className="text-xs text-slate-600">
              <strong className="text-slate-800">Poznámka:</strong> {invoice.note}
            </p>
          )}
        </div>

        <div className="sm:w-64 space-y-1.5 text-sm tabular-nums">
          <div className="flex justify-between text-slate-600">
            <span>Základ bez DPH</span>
            <span>{formatCzk(amountSign * invoice.totalWithoutVat, currency)}</span>
          </div>
          {showVatColumns && (
            <div className="flex justify-between text-slate-600">
              <span>DPH celkem</span>
              <span>{formatCzk(amountSign * invoice.totalVat, currency)}</span>
            </div>
          )}
          <div
            className="flex justify-between pt-2 mt-2 border-t text-base font-bold"
            style={{ borderColor: palette.primary, color: palette.dark }}
          >
            <span>
              {isCreditNote ? 'Celkem k vrácení' : isQuote ? 'Celkem nabídka' : 'Celkem k úhradě'}
            </span>
            <span>{formatCzk(amountSign * invoice.totalWithVat, currency)}</span>
          </div>
          {invoice.status === 'PAID' && (
            <p className="text-xs font-medium text-emerald-700 text-right pt-1">
              {isCreditNote ? 'Vypořádáno' : 'Uhrazeno'}{' '}
              {invoice.paidDate ? formatDateCz(invoice.paidDate) : ''}
            </p>
          )}
          {invoice.status === 'CANCELLED' && (
            <p className="text-xs font-semibold text-red-700 text-right pt-1">STORNOVÁNO</p>
          )}
        </div>
      </div>
    </div>
  );

  if (isSidebar) {
    return (
      <div className="print-invoice bg-white border border-slate-200 rounded-xl overflow-hidden flex">
        <div
          style={{ backgroundColor: palette.dark }}
          className="w-3 sm:w-5 shrink-0"
          aria-hidden="true"
        />
        <div className="flex-1 p-6 sm:p-8">{bodyContent}</div>
      </div>
    );
  }

  return (
    <div className="print-invoice bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
      {bodyContent}
    </div>
  );
}

export function InvoicesView({
  initialCreateTrigger = 0,
  prefillClient = null,
  onClearPrefillClient,
}: InvoicesViewProps) {
  const {
    workspace,
    isCurrentUserAdmin,
    activeCompany,
    accessibleWarehouses,
    inventory,
    clients,
    invoices,
    lookupAres,
    notify,
  } = useApp();

  const palette = getCompanyPalette(activeCompany?.accentIndex);

  const [mode, setMode] = useState<'LIST' | 'CREATE' | 'EDIT' | 'DETAIL'>('LIST');
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const [deliveryNoteMode, setDeliveryNoteMode] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');

  // Create form state
  const [documentType, setDocumentType] = useState<InvoiceDocumentType>('INVOICE');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [variableSymbol, setVariableSymbol] = useState('');
  const [issueDate, setIssueDate] = useState(toIsoDate());
  const [taxDate, setTaxDate] = useState(toIsoDate());
  const [dueDate, setDueDate] = useState(addDaysIso(toIsoDate(), 14));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [invoiceTemplate, setInvoiceTemplate] = useState<InvoiceTemplateId>('CLASSIC');
  const [currency, setCurrency] = useState<string>('CZK');
  const [exchangeRate, setExchangeRate] = useState<string>('1');
  const [cnbBusy, setCnbBusy] = useState(false);
  const [cnbDate, setCnbDate] = useState('');
  const [reverseCharge, setReverseCharge] = useState(false);
  const [legalNotice, setLegalNotice] = useState('');
  const [relatedInvoiceNumber, setRelatedInvoiceNumber] = useState('');
  const [recurringInterval, setRecurringInterval] = useState<RecurringInterval>('NONE');
  const [deductFromStock, setDeductFromStock] = useState(true);
  const [note, setNote] = useState('');

  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientIco, setClientIco] = useState('');
  const [clientDic, setClientDic] = useState('');
  const [clientStreet, setClientStreet] = useState('');
  const [clientCity, setClientCity] = useState('');
  const [clientZip, setClientZip] = useState('');
  const [clientEmail, setClientEmail] = useState('');

  const [items, setItems] = useState<InvoiceLineItem[]>([]);
  const [aresBusy, setAresBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteConfirmInvoice, setDeleteConfirmInvoice] = useState<Invoice | null>(null);
  const [deletingInvoice, setDeletingInvoice] = useState(false);

  const accessibleItems = useMemo(() => {
    const whIds = new Set(accessibleWarehouses.map((w) => w.id));
    return inventory.filter((i) => whIds.has(i.warehouseId));
  }, [inventory, accessibleWarehouses]);

  const companyInvoices = useMemo(
    () => invoices.filter((i) => !activeCompany || i.companyId === activeCompany.id),
    [invoices, activeCompany]
  );

  const selectedInvoice = useMemo(
    () => invoices.find((i) => i.id === selectedInvoiceId) || null,
    [invoices, selectedInvoiceId]
  );

  const suggestNumberForType = (type: InvoiceDocumentType, refNum?: string) => {
    const baseNext = activeCompany ? previewNextInvoiceNumber(activeCompany) : `20260001`;
    const stamp = toIsoDate().replace(/-/g, '').slice(2);
    const seq = String(companyInvoices.length + 1).padStart(3, '0');
    if (type === 'PROFORMA') return `ZAL-${stamp}-${seq}`;
    if (type === 'QUOTE') return `NAB-${stamp}-${seq}`;
    if (type === 'CREDIT_NOTE') return refNum ? `DOB-${refNum}` : `DOB-${stamp}-${seq}`;
    return baseNext;
  };

  const fetchCnbRate = async (targetCurrency: string) => {
    const code = targetCurrency.toUpperCase();
    if (code === 'CZK') {
      setExchangeRate('1');
      setCnbDate('');
      return;
    }
    setCnbBusy(true);
    try {
      const resp = await fetch('/api/cnb-rates');
      const data = await resp.json();
      if (!resp.ok || !data?.rates?.[code]) {
        throw new Error(data?.error || `Kurz pro ${code} nebyl nalezen.`);
      }
      setExchangeRate(String(data.rates[code]));
      setCnbDate(data.date || '');
      notify(`Kurz ČNB (${data.date || 'dnes'}): 1 ${code} = ${data.rates[code]} Kč.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Načtení kurzu ČNB selhalo.', 'error');
    } finally {
      setCnbBusy(false);
    }
  };

  const handleCurrencyChange = (nextCurrency: string) => {
    setCurrency(nextCurrency);
    if (nextCurrency === 'CZK') {
      setExchangeRate('1');
      setCnbDate('');
    } else {
      fetchCnbRate(nextCurrency);
    }
  };

  const handleDocumentTypeChange = (nextType: InvoiceDocumentType) => {
    setDocumentType(nextType);
    if (mode === 'CREATE') {
      const num = suggestNumberForType(nextType, relatedInvoiceNumber || undefined);
      setInvoiceNumber(num);
      setVariableSymbol(num.replace(/\D/g, ''));
      setDeductFromStock(nextType === 'INVOICE' || nextType === 'CREDIT_NOTE');
    }
  };

  const startNewInvoice = (
    client?: Client | null,
    initialType: InvoiceDocumentType = 'INVOICE'
  ) => {
    const today = toIsoDate();
    const nextNum = suggestNumberForType(initialType);
    setDocumentType(initialType);
    setInvoiceNumber(nextNum);
    setVariableSymbol(nextNum.replace(/\D/g, ''));
    setIssueDate(today);
    setTaxDate(today);
    setDueDate(addDaysIso(today, 14));
    setPaymentMethod('BANK_TRANSFER');
    setInvoiceTemplate(activeCompany?.invoiceTemplate || 'CLASSIC');
    setCurrency('CZK');
    setExchangeRate('1');
    setCnbDate('');
    setReverseCharge(false);
    setLegalNotice('');
    setRelatedInvoiceNumber('');
    setRecurringInterval('NONE');
    setDeductFromStock(initialType === 'INVOICE' || initialType === 'CREDIT_NOTE');
    setNote('');

    if (client) {
      setClientId(client.id);
      setClientName(client.name);
      setClientIco(client.ico);
      setClientDic(client.dic);
      setClientStreet(client.street);
      setClientCity(client.city);
      setClientZip(client.zip);
      setClientEmail(client.email || '');
    } else {
      setClientId('');
      setClientName('');
      setClientIco('');
      setClientDic('');
      setClientStreet('');
      setClientCity('');
      setClientZip('');
      setClientEmail('');
    }

    setItems([
      {
        inventoryItemId: '',
        warehouseId: '',
        sku: '',
        name: '',
        quantity: 1,
        unit: 'ks',
        unitPrice: 0,
        vatRate: activeCompany?.vatPayer ? 21 : 0,
        discountPercent: 0,
      },
    ]);
    setEditingInvoice(null);
    setDeliveryNoteMode(false);
    setMode('CREATE');
  };

  const populateFromInvoice = (
    source: Invoice,
    overrides: {
      docType: InvoiceDocumentType;
      invNum: string;
      issue: string;
      due: string;
      related?: string;
      deduct: boolean;
      recurring?: RecurringInterval;
    }
  ) => {
    setDocumentType(overrides.docType);
    setInvoiceNumber(overrides.invNum);
    setVariableSymbol(overrides.invNum.replace(/\D/g, ''));
    setIssueDate(overrides.issue);
    setTaxDate(overrides.issue);
    setDueDate(overrides.due);
    setPaymentMethod(source.paymentMethod || 'BANK_TRANSFER');
    setInvoiceTemplate(source.invoiceTemplate || activeCompany?.invoiceTemplate || 'CLASSIC');
    setCurrency(source.currency || 'CZK');
    setExchangeRate(String(source.exchangeRate && source.exchangeRate > 0 ? source.exchangeRate : 1));
    setCnbDate('');
    setReverseCharge(Boolean(source.reverseCharge));
    setLegalNotice(source.legalNotice || '');
    setRelatedInvoiceNumber(overrides.related ?? '');
    setRecurringInterval(overrides.recurring ?? 'NONE');
    setDeductFromStock(overrides.deduct);
    setNote(source.note || '');
    setClientId(source.clientId || '');
    setClientName(source.clientName || '');
    setClientIco(source.clientIco || '');
    setClientDic(source.clientDic || '');
    setClientStreet(source.clientStreet || '');
    setClientCity(source.clientCity || '');
    setClientZip(source.clientZip || '');
    const matchedClient = clients.find(
      (c) => c.id === source.clientId || (source.clientIco && c.ico === source.clientIco)
    );
    setClientEmail(source.clientEmail || matchedClient?.email || '');
    setItems(source.items.map((l) => ({ ...l })));
    setEditingInvoice(null);
    setDeliveryNoteMode(false);
    setMode('CREATE');
  };

  const startDuplicateInvoice = (source: Invoice) => {
    const today = toIsoDate();
    const docType: InvoiceDocumentType = source.documentType || 'INVOICE';
    populateFromInvoice(source, {
      docType,
      invNum: suggestNumberForType(docType),
      issue: today,
      due: addDaysIso(today, 14),
      deduct: docType === 'INVOICE' ? source.deductedFromStock : docType === 'CREDIT_NOTE',
      recurring: source.recurringInterval || 'NONE',
    });
  };

  const startConvertToInvoice = (source: Invoice) => {
    const today = toIsoDate();
    populateFromInvoice(source, {
      docType: 'INVOICE',
      invNum: suggestNumberForType('INVOICE'),
      issue: today,
      due: addDaysIso(today, 14),
      related: source.invoiceNumber,
      deduct: true,
      recurring: 'NONE',
    });
    notify(`Připravena ostrá faktura z dokladu ${source.invoiceNumber}.`, 'info');
  };

  const startCreditNote = (source: Invoice) => {
    const today = toIsoDate();
    populateFromInvoice(source, {
      docType: 'CREDIT_NOTE',
      invNum: suggestNumberForType('CREDIT_NOTE', source.invoiceNumber),
      issue: today,
      due: addDaysIso(today, 14),
      related: source.invoiceNumber,
      deduct: source.deductedFromStock,
      recurring: 'NONE',
    });
    notify(`Připraven dobropis k faktuře ${source.invoiceNumber}.`, 'info');
  };

  const startNextRecurringPeriod = (source: Invoice) => {
    const interval = source.recurringInterval || 'MONTHLY';
    const months = interval === 'YEARLY' ? 12 : interval === 'QUARTERLY' ? 3 : 1;
    const baseIssue = source.issueDate || toIsoDate();
    const nextIssue = addMonthsIso(baseIssue, months);
    const origDueOffset =
      source.issueDate && source.dueDate
        ? Math.max(
            1,
            Math.round(
              (new Date(`${source.dueDate}T00:00:00`).getTime() -
                new Date(`${source.issueDate}T00:00:00`).getTime()) /
                86400000
            )
          )
        : 14;
    const nextDue = addDaysIso(nextIssue, origDueOffset);
    const docType: InvoiceDocumentType = source.documentType || 'INVOICE';

    populateFromInvoice(source, {
      docType,
      invNum: suggestNumberForType(docType),
      issue: nextIssue,
      due: nextDue,
      related: source.invoiceNumber,
      deduct: source.deductedFromStock,
      recurring: interval,
    });
    notify(
      `Předvyplněno další období (${getRecurringLabel(interval).toLowerCase()}) od ${formatDateCz(nextIssue)}.`,
      'info'
    );
  };

  const startEditInvoice = (source: Invoice) => {
    setDocumentType(source.documentType || 'INVOICE');
    setInvoiceNumber(source.invoiceNumber);
    setVariableSymbol(source.variableSymbol);
    setIssueDate(source.issueDate);
    setTaxDate(source.taxDate || source.issueDate);
    setDueDate(source.dueDate);
    setPaymentMethod(source.paymentMethod || 'BANK_TRANSFER');
    setInvoiceTemplate(source.invoiceTemplate || activeCompany?.invoiceTemplate || 'CLASSIC');
    setCurrency(source.currency || 'CZK');
    setExchangeRate(String(source.exchangeRate && source.exchangeRate > 0 ? source.exchangeRate : 1));
    setCnbDate('');
    setReverseCharge(Boolean(source.reverseCharge));
    setLegalNotice(source.legalNotice || '');
    setRelatedInvoiceNumber(source.relatedInvoiceNumber || '');
    setRecurringInterval(source.recurringInterval || 'NONE');
    setDeductFromStock(source.deductedFromStock);
    setNote(source.note || '');
    setClientId(source.clientId || '');
    setClientName(source.clientName || '');
    setClientIco(source.clientIco || '');
    setClientDic(source.clientDic || '');
    setClientStreet(source.clientStreet || '');
    setClientCity(source.clientCity || '');
    setClientZip(source.clientZip || '');
    setClientEmail(source.clientEmail || '');
    setItems(source.items.map((l) => ({ ...l })));
    setEditingInvoice(source);
    setDeliveryNoteMode(false);
    setMode('EDIT');
  };

  useEffect(() => {
    if (initialCreateTrigger > 0) {
      startNewInvoice(prefillClient);
      onClearPrefillClient?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCreateTrigger]);

  const filteredInvoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return companyInvoices.filter((inv) => {
      if (statusFilter === 'OVERDUE' && !isInvoiceOverdue(inv)) return false;
      if (
        statusFilter === 'RECURRING' &&
        (!inv.recurringInterval || inv.recurringInterval === 'NONE')
      ) {
        return false;
      }
      if (
        statusFilter === 'NON_TAX' &&
        inv.documentType !== 'QUOTE' &&
        inv.documentType !== 'PROFORMA' &&
        inv.documentType !== 'CREDIT_NOTE'
      ) {
        return false;
      }
      if (
        statusFilter !== 'ALL' &&
        statusFilter !== 'OVERDUE' &&
        statusFilter !== 'RECURRING' &&
        statusFilter !== 'NON_TAX' &&
        inv.status !== statusFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.clientName.toLowerCase().includes(q) ||
        inv.variableSymbol.toLowerCase().includes(q) ||
        inv.clientIco.toLowerCase().includes(q)
      );
    });
  }, [companyInvoices, statusFilter, search]);

  const effectiveDraftVatPayer = (activeCompany?.vatPayer ?? true) && !reverseCharge;
  const draftTotals = useMemo(
    () => calculateInvoiceTotals(items, effectiveDraftVatPayer),
    [items, effectiveDraftVatPayer]
  );

  const handleSelectClient = (id: string) => {
    setClientId(id);
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    setClientName(c.name);
    setClientIco(c.ico);
    setClientDic(c.dic);
    setClientStreet(c.street);
    setClientCity(c.city);
    setClientZip(c.zip);
    setClientEmail(c.email || '');
  };

  const handleInlineAres = async () => {
    const clean = clientIco.replace(/\D/g, '');
    if (clean.length !== 8) {
      notify('Zadejte 8místné IČO odběratele.', 'error');
      return;
    }
    setAresBusy(true);
    try {
      const s = await lookupAres(clean);
      setClientIco(s.ico);
      setClientDic(s.dic || clientDic);
      setClientName(s.name || clientName);
      setClientStreet(s.street || clientStreet);
      setClientCity(s.city || clientCity);
      setClientZip(s.zip || clientZip);
      notify(`Načteno z ARES: ${s.name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Dotaz na ARES selhal.', 'error');
    } finally {
      setAresBusy(false);
    }
  };

  const addStockItemLine = (stockItemId: string) => {
    const stock = accessibleItems.find((i) => i.id === stockItemId);
    if (!stock) return;
    setItems((prev) => {
      const cleaned = prev.filter((l) => l.name.trim().length > 0 || l.unitPrice > 0);
      return [
        ...cleaned,
        {
          inventoryItemId: stock.id,
          warehouseId: stock.warehouseId,
          sku: stock.sku,
          name: stock.name,
          quantity: 1,
          unit: stock.unit || 'ks',
          unitPrice: stock.salePrice,
          vatRate: activeCompany?.vatPayer ? stock.vatRate : 0,
          discountPercent: 0,
        },
      ];
    });
  };

  const updateLine = (idx: number, patch: Partial<InvoiceLineItem>) => {
    setItems((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)));
  };

  const handleIssueInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || !activeCompany) return;
    if (!clientName.trim()) {
      notify('Vyplňte název odběratele.', 'error');
      return;
    }
    const parsedFx = currency === 'CZK' ? 1 : Number(exchangeRate.replace(',', '.')) || 0;
    if (currency !== 'CZK' && parsedFx <= 0) {
      notify('Zadejte platný směnný kurz v Kč nebo jej načtěte z ČNB.', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        company: activeCompany,
        documentType,
        invoiceNumber,
        variableSymbol,
        issueDate,
        taxDate,
        dueDate,
        paymentMethod,
        currency,
        exchangeRate: parsedFx,
        reverseCharge,
        legalNotice: legalNotice.trim() || (reverseCharge ? REVERSE_CHARGE_LEGAL_TEXT : ''),
        relatedInvoiceNumber: relatedInvoiceNumber.trim(),
        recurringInterval,
        clientId,
        clientName,
        clientIco,
        clientDic,
        clientStreet,
        clientCity,
        clientZip,
        clientEmail: clientEmail.trim(),
        note,
        deductFromStock:
          documentType === 'QUOTE' || documentType === 'PROFORMA' ? false : deductFromStock,
        invoiceTemplate,
        items,
      };

      const label = getDocumentTypeShortLabel(documentType);

      if (mode === 'EDIT' && editingInvoice) {
        const updatedId = await editInvoice({
          workspace,
          originalInvoice: editingInvoice,
          inventory,
          isAdmin: isCurrentUserAdmin,
          payload,
        });
        notify(`Změny na dokladu ${invoiceNumber} byly uloženy.`);
        setEditingInvoice(null);
        setSelectedInvoiceId(updatedId);
        setDeliveryNoteMode(false);
        setMode('DETAIL');
      } else {
        const newId = await issueInvoice({
          workspace,
          inventory,
          payload,
        });
        notify(`${label} ${invoiceNumber} byla vystavena.`);
        setSelectedInvoiceId(newId);
        setDeliveryNoteMode(false);
        setMode('DETAIL');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Uložení dokladu selhalo.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSendEmail = async (inv: Invoice, isReminder: boolean) => {
    const matchedClient = clients.find(
      (c) => c.id === inv.clientId || (inv.clientIco && c.ico === inv.clientIco)
    );
    const toEmail = inv.clientEmail || matchedClient?.email || '';
    const curr = inv.currency || 'CZK';
    const docLabel = getDocumentTypeShortLabel(inv.documentType);
    const bankAcc = inv.companyBankAccount || activeCompany?.bankAccount || '';
    const diff = daysUntilDue(inv.dueDate);
    const overdueDays = diff !== null && diff < 0 ? Math.abs(diff) : 0;
    const reminderNum = (inv.reminderCount || 0) + 1;

    const subject = isReminder
      ? `${reminderNum}. upomínka – neuhrazená faktura č. ${inv.invoiceNumber} (${inv.companyName})`
      : `${docLabel} č. ${inv.invoiceNumber} – ${inv.companyName}`;

    const bodyLines = isReminder
      ? [
          'Dobrý den,',
          '',
          `dovolujeme si Vám připomenout neuhrazenou fakturu č. ${inv.invoiceNumber}, která je ${overdueDays} dní po datu splatnosti (${formatDateCz(inv.dueDate)}).`,
          '',
          `Částka k úhradě: ${formatCzk(Math.max(0, inv.totalWithVat - inv.paidAmount) || inv.totalWithVat, curr)}`,
          `Číslo účtu: ${bankAcc || 'viz doklad'}`,
          `Variabilní symbol: ${inv.variableSymbol || inv.invoiceNumber}`,
          '',
          'Pokud jste platbu již odeslali, považujte prosím tento e-mail za bezpředmětný.',
          '',
          `S pozdravem,`,
          inv.companyName,
        ]
      : [
          'Dobrý den,',
          '',
          `v příloze zasíláme doklad ${docLabel.toLowerCase()} č. ${inv.invoiceNumber} ze dne ${formatDateCz(inv.issueDate)}.`,
          '',
          `Celková částka: ${formatCzk(inv.totalWithVat, curr)}`,
          inv.documentType === 'QUOTE'
            ? `Platnost nabídky do: ${formatDateCz(inv.dueDate)}`
            : `Datum splatnosti: ${formatDateCz(inv.dueDate)}`,
          ...(inv.documentType !== 'QUOTE' && inv.documentType !== 'CREDIT_NOTE'
            ? [
                `Číslo účtu: ${bankAcc || 'viz doklad'}`,
                `Variabilní symbol: ${inv.variableSymbol || inv.invoiceNumber}`,
              ]
            : []),
          '',
          'S pozdravem,',
          inv.companyName,
        ];

    const body = bodyLines.join('\n');

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(`${subject}\n\n${body}`);
      }
    } catch {
      // Clipboard may be blocked in iframe; continue opening mailto
    }

    const mailtoUrl = `mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
    const link = document.createElement('a');
    link.href = mailtoUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (workspace) {
      await recordInvoiceEmailAction(workspace.id, inv, isReminder);
    }

    notify(
      isReminder
        ? `${reminderNum}. upomínka byla připravena v e-mailovém klientu (text zkopírován do schránky).`
        : `E-mail s údaji dokladu ${inv.invoiceNumber} byl připraven (text zkopírován do schránky). Tip: pro přiložení PDF klikněte na Tisk / PDF A4.`
    );
  };

  const handleMarkPaid = async (inv: Invoice) => {
    if (!workspace) return;
    try {
      await markInvoicePaid(workspace.id, inv);
      notify(`Faktura ${inv.invoiceNumber} označena jako uhrazená.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Akce se nezdařila.', 'error');
    }
  };

  const handleCancel = async (inv: Invoice) => {
    if (!workspace) return;
    try {
      await cancelInvoice(workspace.id, inv);
      notify(`Faktura ${inv.invoiceNumber} byla stornována.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Storno selhalo.', 'error');
    }
  };

  const handleConfirmDeleteCancelled = async () => {
    if (!workspace || !deleteConfirmInvoice) return;
    setDeletingInvoice(true);
    try {
      const num = deleteConfirmInvoice.invoiceNumber;
      const deletedId = deleteConfirmInvoice.id;
      await deleteCancelledInvoice(workspace.id, deleteConfirmInvoice);
      setDeleteConfirmInvoice(null);
      if (selectedInvoiceId === deletedId) {
        setSelectedInvoiceId(null);
        setMode('LIST');
      }
      notify(`Stornovaná faktura ${num} byla trvale smazána ze seznamu.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Smazání faktury selhalo.', 'error');
    } finally {
      setDeletingInvoice(false);
    }
  };

  const deleteConfirmModal = deleteConfirmInvoice ? (
    <div className="no-print fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-2 text-red-700">
          <Trash2 className="w-4 h-4 shrink-0" />
          <h3 className="text-base font-semibold">
            Smazat stornovanou fakturu {deleteConfirmInvoice.invoiceNumber}?
          </h3>
        </div>
        <p className="text-sm text-slate-600">
          Faktura pro odběratele <strong>{deleteConfirmInvoice.clientName}</strong> bude trvale
          odstraněna ze seznamu i ze sdílené databáze. Tuto akci nelze vrátit zpět.
        </p>
        <div className="pt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={deletingInvoice}
            onClick={() => setDeleteConfirmInvoice(null)}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            Zrušit
          </button>
          <button
            type="button"
            disabled={deletingInvoice}
            onClick={handleConfirmDeleteCancelled}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-60"
          >
            {deletingInvoice && <Loader2 className="w-4 h-4 animate-spin" />}
            Trvale smazat
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const handleChangeInvoiceTemplate = async (inv: Invoice, tpl: InvoiceTemplateId) => {
    if (!workspace || inv.status === 'CANCELLED') return;
    try {
      await updateInvoiceTemplate(workspace.id, inv.id, tpl);
      notify('Vizuální šablona faktury byla změněna.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Změna šablony selhala.', 'error');
    }
  };

  // DETAIL VIEW
  if (mode === 'DETAIL' && selectedInvoice) {
    const isVatPayer = selectedInvoice.totalVat > 0 || (activeCompany?.vatPayer ?? true);
    const activeTpl: InvoiceTemplateId = selectedInvoice.invoiceTemplate || 'CLASSIC';
    const selDocType: InvoiceDocumentType = selectedInvoice.documentType || 'INVOICE';
    const selOverdue = isInvoiceOverdue(selectedInvoice);
    const canConvert = selDocType === 'QUOTE' || selDocType === 'PROFORMA';
    const canCreditNote = selDocType === 'INVOICE' && selectedInvoice.status !== 'CANCELLED';
    const hasRecurring =
      Boolean(selectedInvoice.recurringInterval) && selectedInvoice.recurringInterval !== 'NONE';

    return (
      <div className="space-y-5">
        <div className="no-print flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setDeliveryNoteMode(false);
                setMode('LIST');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <ArrowLeft className="w-4 h-4" />
              Zpět na seznam
            </button>
            <div>
              <h1 className="text-lg font-bold text-slate-900 font-mono">
                {getDocumentTypeShortLabel(selDocType)} {selectedInvoice.invoiceNumber}
              </h1>
              <p className="text-xs text-slate-500">
                {selectedInvoice.clientName} ·{' '}
                {selectedInvoice.exportedToPohoda ? 'Exportováno do POHODY' : 'Zatím neexportováno'}
                {selectedInvoice.sentAt && ` · Odesláno ${formatDateCz(selectedInvoice.sentAt)}`}
                {selectedInvoice.reminderCount && selectedInvoice.reminderCount > 0
                  ? ` · ${selectedInvoice.reminderCount}× upomínka`
                  : ''}
                {hasRecurring && ` · ${getRecurringLabel(selectedInvoice.recurringInterval)}`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canConvert && selectedInvoice.status !== 'CANCELLED' && (
              <button
                type="button"
                onClick={() => startConvertToInvoice(selectedInvoice)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-blue-800 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg"
              >
                <ArrowRightLeft className="w-4 h-4" />
                Převést na fakturu
              </button>
            )}
            {canCreditNote && (
              <button
                type="button"
                onClick={() => startCreditNote(selectedInvoice)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                <FileMinus2 className="w-4 h-4" />
                Dobropis
              </button>
            )}
            {hasRecurring && (
              <button
                type="button"
                onClick={() => startNextRecurringPeriod(selectedInvoice)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                <CalendarClock className="w-4 h-4" />
                Další období
              </button>
            )}
            {selectedInvoice.status !== 'CANCELLED' && (
              <button
                type="button"
                onClick={() => handleSendEmail(selectedInvoice, false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                <Mail className="w-4 h-4" />
                E-mail
              </button>
            )}
            {selOverdue && selDocType !== 'QUOTE' && (
              <button
                type="button"
                onClick={() => handleSendEmail(selectedInvoice, true)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-lg"
              >
                <BellRing className="w-4 h-4" />
                Upomínka{selectedInvoice.reminderCount ? ` (${selectedInvoice.reminderCount + 1}.)` : ''}
              </button>
            )}
            {selectedInvoice.status !== 'CANCELLED' && (
              <button
                type="button"
                onClick={() => startEditInvoice(selectedInvoice)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                <Edit3 className="w-4 h-4" />
                Upravit
              </button>
            )}
            <button
              type="button"
              onClick={() => startDuplicateInvoice(selectedInvoice)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <Copy className="w-4 h-4" />
              Duplikovat
            </button>
            {selectedInvoice.status === 'ISSUED' && (
              <>
                <button
                  type="button"
                  onClick={() => handleMarkPaid(selectedInvoice)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 rounded-lg"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Uhrazeno
                </button>
                <button
                  type="button"
                  onClick={() => handleCancel(selectedInvoice)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-red-700 bg-white border border-slate-200 hover:bg-red-50 rounded-lg"
                >
                  <Ban className="w-4 h-4" />
                  Stornovat
                </button>
              </>
            )}
            {selectedInvoice.status === 'CANCELLED' && isCurrentUserAdmin && (
              <button
                type="button"
                onClick={() => setDeleteConfirmInvoice(selectedInvoice)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 rounded-lg"
              >
                <Trash2 className="w-4 h-4" />
                Smazat ze seznamu
              </button>
            )}
            <button
              type="button"
              onClick={() => window.print()}
              style={{ backgroundColor: palette.primary }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95"
            >
              <Printer className="w-4 h-4" />
              {deliveryNoteMode ? 'Tisk dodacího listu A4' : 'Tisk / PDF A4'}
            </button>
          </div>
        </div>

        {/* Live template & Delivery Note switcher */}
        <div className="no-print bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
            <button
              type="button"
              onClick={() => setDeliveryNoteMode(false)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                !deliveryNoteMode
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              {getDocumentTypeShortLabel(selDocType)}
            </button>
            <button
              type="button"
              onClick={() => setDeliveryNoteMode(true)}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                deliveryNoteMode
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ClipboardList className="w-3.5 h-3.5" />
              Dodací list (bez cen)
            </button>
          </div>

          {!deliveryNoteMode && selectedInvoice.status !== 'CANCELLED' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-slate-500 mr-1">Šablona:</span>
              {INVOICE_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleChangeInvoiceTemplate(selectedInvoice, t.id)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    activeTpl === t.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {t.labelCz}
                </button>
              ))}
            </div>
          )}
        </div>

        <InvoiceDocumentPreview
          invoice={selectedInvoice}
          company={activeCompany}
          palette={palette}
          vatPayer={isVatPayer}
          deliveryNoteMode={deliveryNoteMode}
        />
        {deleteConfirmModal}
      </div>
    );
  }

  // CREATE / EDIT VIEW
  if (mode === 'CREATE' || mode === 'EDIT') {
    const isEditing = mode === 'EDIT' && editingInvoice !== null;
    const fxNum = currency === 'CZK' ? 1 : Number(exchangeRate.replace(',', '.')) || 0;
    const isNonStockDoc = documentType === 'QUOTE' || documentType === 'PROFORMA';

    return (
      <form onSubmit={handleIssueInvoice} className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                if (isEditing && editingInvoice) {
                  setSelectedInvoiceId(editingInvoice.id);
                  setEditingInvoice(null);
                  setMode('DETAIL');
                } else {
                  setMode('LIST');
                }
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <ArrowLeft className="w-4 h-4" />
              Zpět
            </button>
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                {isEditing
                  ? `Úprava dokladu ${editingInvoice.invoiceNumber}`
                  : `Nový doklad · ${getDocumentTypeShortLabel(documentType)}`}
              </h1>
              <p className="text-xs text-slate-500">
                {isEditing
                  ? 'Případná změna množství u skladových položek automaticky dorovná stav skladu.'
                  : `Vystavitel: ${activeCompany?.name} (${activeCompany?.vatPayer ? 'Plátce DPH' : 'Neplátce DPH'})`}
              </p>
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            style={{ backgroundColor: palette.primary }}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FilePlus2 className="w-4 h-4" />}
            {isEditing ? 'Uložit změny' : `Vystavit (${getDocumentTypeShortLabel(documentType)})`} ·{' '}
            {formatCzk(
              (documentType === 'CREDIT_NOTE' ? -1 : 1) * draftTotals.totalWithVat,
              currency
            )}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Document metadata */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Údaje dokladu</h2>
              {relatedInvoiceNumber && (
                <span className="text-[11px] font-mono text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                  K dokladu {relatedInvoiceNumber}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Typ dokladu</label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {(
                    [
                      ['INVOICE', 'Faktura'],
                      ['PROFORMA', 'Záloha'],
                      ['QUOTE', 'Nabídka'],
                      ['CREDIT_NOTE', 'Dobropis'],
                    ] as [InvoiceDocumentType, string][]
                  ).map(([tId, tLabel]) => (
                    <button
                      key={tId}
                      type="button"
                      onClick={() => handleDocumentTypeChange(tId)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        documentType === tId
                          ? 'bg-slate-900 border-slate-900 text-white'
                          : 'bg-white border-slate-200 text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {tLabel}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Číslo dokladu *</label>
                <input
                  type="text"
                  required
                  value={invoiceNumber}
                  onChange={(e) => {
                    setInvoiceNumber(e.target.value);
                    setVariableSymbol(e.target.value.replace(/\D/g, ''));
                  }}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Variabilní symbol</label>
                <input
                  type="text"
                  value={variableSymbol}
                  onChange={(e) => setVariableSymbol(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Datum vystavení</label>
                <input
                  type="date"
                  value={issueDate}
                  onChange={(e) => {
                    setIssueDate(e.target.value);
                    setTaxDate(e.target.value);
                    setDueDate(addDaysIso(e.target.value, 14));
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {documentType === 'QUOTE' ? 'Platnost nabídky do' : 'Datum splatnosti'}
                </label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">DUZP</label>
                <input
                  type="date"
                  value={taxDate}
                  onChange={(e) => setTaxDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Způsob úhrady</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="BANK_TRANSFER">Bankovní převod</option>
                  <option value="CASH">Hotově</option>
                  <option value="CARD">Platební karta</option>
                </select>
              </div>

              {/* Currency + ČNB Exchange Rate */}
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Měna dokladu</label>
                <div className="relative">
                  <Globe className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <select
                    value={currency}
                    onChange={(e) => handleCurrencyChange(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-sm font-medium border border-slate-200 rounded-lg bg-white"
                  >
                    {SUPPORTED_CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Opakovaná fakturace
                </label>
                <select
                  value={recurringInterval}
                  onChange={(e) => setRecurringInterval(e.target.value as RecurringInterval)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="NONE">Jednorázová</option>
                  <option value="MONTHLY">Měsíčně</option>
                  <option value="QUARTERLY">Čtvrtletně</option>
                  <option value="YEARLY">Ročně</option>
                </select>
              </div>

              {currency !== 'CZK' && (
                <div className="col-span-2 bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[140px]">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Kurz (1 {currency} = Kč){cnbDate ? ` · ČNB ${cnbDate}` : ''}
                    </label>
                    <input
                      type="number"
                      step="any"
                      min="0.0001"
                      value={exchangeRate}
                      onChange={(e) => setExchangeRate(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm font-mono border border-slate-200 rounded-lg bg-white tabular-nums"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={cnbBusy}
                    onClick={() => fetchCnbRate(currency)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg whitespace-nowrap"
                  >
                    {cnbBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                    Načíst kurz ČNB
                  </button>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Šablona PDF</label>
                <select
                  value={invoiceTemplate}
                  onChange={(e) => setInvoiceTemplate(e.target.value as InvoiceTemplateId)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {INVOICE_TEMPLATES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.labelCz}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Vázaný doklad č.
                </label>
                <input
                  type="text"
                  value={relatedInvoiceNumber}
                  onChange={(e) => setRelatedInvoiceNumber(e.target.value)}
                  placeholder="Volitelné (např. ZAL / původní FA)"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
                <label
                  className={`inline-flex items-center gap-2 text-xs font-medium cursor-pointer ${
                    isNonStockDoc ? 'text-slate-400' : 'text-slate-700'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={isNonStockDoc}
                    checked={isNonStockDoc ? false : deductFromStock}
                    onChange={(e) => setDeductFromStock(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  {documentType === 'CREDIT_NOTE'
                    ? 'Vrátit zboží zpět na sklad'
                    : isNonStockDoc
                      ? 'Nabídky a zálohy neodepisují sklad'
                      : 'Automaticky odepsat ze skladu'}
                </label>

                {activeCompany?.vatPayer && (
                  <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={reverseCharge}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setReverseCharge(checked);
                        if (checked && !legalNotice.trim()) {
                          setLegalNotice(REVERSE_CHARGE_LEGAL_TEXT);
                        } else if (!checked && legalNotice === REVERSE_CHARGE_LEGAL_TEXT) {
                          setLegalNotice('');
                        }
                      }}
                      className="rounded border-slate-300"
                    />
                    Přenesená daňová povinnost (Reverse Charge)
                  </label>
                )}
              </div>

              {reverseCharge && (
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Zákonná doložka na dokladu
                  </label>
                  <input
                    type="text"
                    value={legalNotice}
                    onChange={(e) => setLegalNotice(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-lg bg-slate-50"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Client details with picker + ARES */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">Odběratel</h2>
              <select
                value={clientId}
                onChange={(e) => handleSelectClient(e.target.value)}
                className="max-w-[220px] px-2.5 py-1 text-xs border border-slate-200 rounded-lg bg-slate-50"
              >
                <option value="">Vybrat z adresáře…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.ico ? `(${c.ico})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">IČO odběratele</label>
                  <input
                    type="text"
                    value={clientIco}
                    onChange={(e) => setClientIco(e.target.value)}
                    placeholder="8místné IČO"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleInlineAres}
                  disabled={aresBusy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
                >
                  {aresBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Building2 className="w-3.5 h-3.5" />
                  )}
                  ARES
                </button>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Název odběratele *</label>
                <input
                  type="text"
                  required
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">DIČ</label>
                <input
                  type="text"
                  value={clientDic}
                  onChange={(e) => setClientDic(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  E-mail odběratele
                </label>
                <input
                  type="email"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  placeholder="fakturace@klient.cz"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Ulice</label>
                <input
                  type="text"
                  value={clientStreet}
                  onChange={(e) => setClientStreet(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Město</label>
                <input
                  type="text"
                  value={clientCity}
                  onChange={(e) => setClientCity(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">PSČ</label>
                <input
                  type="text"
                  value={clientZip}
                  onChange={(e) => setClientZip(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Line items */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">Položky faktury</h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1.5">
                <Package className="w-4 h-4 text-slate-400" />
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      addStockItemLine(e.target.value);
                      e.target.value = '';
                    }
                  }}
                  className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-slate-50 max-w-xs"
                >
                  <option value="">+ Přidat položku ze skladu…</option>
                  {accessibleItems.map((stock) => (
                    <option key={stock.id} value={stock.id}>
                      {stock.name} ({formatQty(stock.quantity)} {stock.unit} · {formatCzk(stock.salePrice)})
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() =>
                  setItems((prev) => [
                    ...prev,
                    {
                      inventoryItemId: '',
                      warehouseId: '',
                      sku: '',
                      name: '',
                      quantity: 1,
                      unit: 'ks',
                      unitPrice: 0,
                      vatRate: activeCompany?.vatPayer ? 21 : 0,
                      discountPercent: 0,
                    },
                  ])
                }
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
              >
                <Plus className="w-3.5 h-3.5" />
                Volný řádek
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-2">Název položky</th>
                  <th className="py-2 px-2 w-24 text-right">Množství</th>
                  <th className="py-2 px-2 w-20">MJ</th>
                  <th className="py-2 px-2 w-32 text-right">Cena bez DPH</th>
                  <th className="py-2 px-2 w-20 text-right">Sleva %</th>
                  {effectiveDraftVatPayer && <th className="py-2 px-2 w-20">DPH</th>}
                  <th className="py-2 pl-2 w-32 text-right">Celkem</th>
                  <th className="py-2 pl-2 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((line, idx) => (
                  <tr key={idx}>
                    <td className="py-2 pr-2 min-w-[200px]">
                      <input
                        type="text"
                        required
                        value={line.name}
                        onChange={(e) => updateLine(idx, { name: e.target.value })}
                        placeholder="Název zboží nebo služby"
                        className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-md"
                      />
                      {line.inventoryItemId && (
                        <p className="text-[11px] text-emerald-700 mt-0.5">
                          Propojeno se skladem ({line.sku})
                        </p>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        step="any"
                        min="0.01"
                        value={line.quantity}
                        onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) || 0 })}
                        className="w-20 px-2 py-1.5 text-sm text-right border border-slate-200 rounded-md tabular-nums"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="text"
                        value={line.unit}
                        onChange={(e) => updateLine(idx, { unit: e.target.value })}
                        className="w-16 px-2 py-1.5 text-xs border border-slate-200 rounded-md"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        value={line.unitPrice}
                        onChange={(e) =>
                          updateLine(idx, { unitPrice: Number(e.target.value) || 0 })
                        }
                        className="w-28 px-2 py-1.5 text-sm text-right border border-slate-200 rounded-md tabular-nums"
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        step="any"
                        min="0"
                        max="100"
                        value={line.discountPercent}
                        onChange={(e) =>
                          updateLine(idx, { discountPercent: Number(e.target.value) || 0 })
                        }
                        className="w-16 px-2 py-1.5 text-sm text-right border border-slate-200 rounded-md tabular-nums"
                      />
                    </td>
                    {effectiveDraftVatPayer && (
                      <td className="py-2 px-2">
                        <select
                          value={line.vatRate}
                          onChange={(e) => updateLine(idx, { vatRate: Number(e.target.value) })}
                          className="px-2 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
                        >
                          <option value={21}>21 %</option>
                          <option value={12}>12 %</option>
                          <option value={0}>0 %</option>
                        </select>
                      </td>
                    )}
                    <td className="py-2 pl-2 text-right font-semibold tabular-nums whitespace-nowrap">
                      {formatCzk(
                        effectiveDraftVatPayer
                          ? lineTotalWithVat(line, true)
                          : lineTotalWithoutVat(line),
                        currency
                      )}
                    </td>
                    <td className="py-2 pl-2 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          setItems((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))
                        }
                        className="p-1 text-slate-400 hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pt-4 border-t border-slate-100 flex flex-col sm:flex-row justify-between gap-4">
            <div className="flex-1 max-w-md">
              <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka na dokladu</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Volitelná poznámka pro odběratele"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div className="sm:w-72 space-y-1 text-sm tabular-nums">
              <div className="flex justify-between text-slate-600">
                <span>Celkem bez DPH</span>
                <span>{formatCzk(draftTotals.totalWithoutVat, currency)}</span>
              </div>
              {effectiveDraftVatPayer && (
                <div className="flex justify-between text-slate-600">
                  <span>DPH</span>
                  <span>{formatCzk(draftTotals.totalVat, currency)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-slate-900 pt-1.5 border-t border-slate-200">
                <span>
                  {documentType === 'CREDIT_NOTE' ? 'Celkem k vrácení' : 'Celkem k úhradě'}
                </span>
                <span>
                  {formatCzk(
                    (documentType === 'CREDIT_NOTE' ? -1 : 1) * draftTotals.totalWithVat,
                    currency
                  )}
                </span>
              </div>
              {currency !== 'CZK' && fxNum > 0 && (
                <div className="flex justify-between text-xs text-slate-500 pt-1">
                  <span>Přepočet CZK (kurz {fxNum})</span>
                  <span>{formatCzk(round2(draftTotals.totalWithVat * fxNum), 'CZK')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </form>
    );
  }

  // LIST VIEW
  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Vydané doklady · {activeCompany?.name}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Faktury</h1>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {companyInvoices.length} vystavených dokladů · Další číslo{' '}
            <span className="font-mono text-slate-700">
              {activeCompany ? previewNextInvoiceNumber(activeCompany) : '—'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start md:self-auto">
          <button
            type="button"
            onClick={() => startNewInvoice(null, 'QUOTE')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap"
          >
            + Nabídka
          </button>
          <button
            type="button"
            onClick={() => startNewInvoice(null, 'PROFORMA')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap"
          >
            + Záloha
          </button>
          <button
            type="button"
            onClick={() => startNewInvoice(null, 'INVOICE')}
            style={{ backgroundColor: palette.primary }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 whitespace-nowrap"
          >
            <FilePlus2 className="w-4 h-4" />
            Nová faktura
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="inline-flex flex-wrap items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 self-start">
          {(
            [
              ['ALL', 'Vše'],
              ['ISSUED', 'Neuhrazené'],
              ['OVERDUE', 'Po splatnosti'],
              ['PAID', 'Uhrazené'],
              ['NON_TAX', 'Nabídky / Zálohy / Dobropisy'],
              ['RECURRING', 'Opakované'],
              ['CANCELLED', 'Stornované'],
            ] as [StatusFilter, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setStatusFilter(id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                statusFilter === id
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 lg:max-w-xs">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Hledat číslo, klienta, VS, IČO…"
            className="w-full pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-400"
          />
        </div>
      </div>

      {/* Invoices table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredInvoices.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-slate-900">Žádné doklady</p>
            <p className="mt-1 text-xs text-slate-500">
              Vystavte fakturu, zálohu nebo cenovou nabídku s QR platbou a automatickým skladem.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Číslo / Typ</th>
                  <th className="py-3 px-4">Odběratel</th>
                  <th className="py-3 px-4">Vystaveno / Splatnost</th>
                  <th className="py-3 px-4 text-right">Částka s DPH</th>
                  <th className="py-3 px-4">Stav</th>
                  <th className="py-3 px-4 text-right">Akce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredInvoices.map((inv) => {
                  const overdue = isInvoiceOverdue(inv);
                  const diff = daysUntilDue(inv.dueDate);
                  const rowDocType: InvoiceDocumentType = inv.documentType || 'INVOICE';
                  const isRowCredit = rowDocType === 'CREDIT_NOTE';
                  const canRowConvert =
                    (rowDocType === 'QUOTE' || rowDocType === 'PROFORMA') &&
                    inv.status !== 'CANCELLED';
                  const isRowRecurring =
                    Boolean(inv.recurringInterval) && inv.recurringInterval !== 'NONE';
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => {
                        setSelectedInvoiceId(inv.id);
                        setDeliveryNoteMode(false);
                        setMode('DETAIL');
                      }}
                      className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-slate-900">{inv.invoiceNumber}</span>
                          {rowDocType !== 'INVOICE' && (
                            <span
                              className={`font-sans text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                rowDocType === 'CREDIT_NOTE'
                                  ? 'bg-red-50 text-red-700'
                                  : rowDocType === 'PROFORMA'
                                    ? 'bg-blue-50 text-blue-700'
                                    : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {getDocumentTypeShortLabel(rowDocType)}
                            </span>
                          )}
                          {isRowRecurring && (
                            <span className="font-sans text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                              {getRecurringLabel(inv.recurringInterval)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500">
                          VS {inv.variableSymbol}
                          {inv.reverseCharge && ' · PDP'}
                          {inv.currency && inv.currency !== 'CZK' && ` · ${inv.currency}`}
                        </p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900">{inv.clientName}</p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {inv.clientIco ? `IČO ${inv.clientIco}` : '—'}
                          {inv.exportedToPohoda && ' · POHODA ✓'}
                          {inv.sentAt && ' · E-mail ✓'}
                          {inv.reminderCount && inv.reminderCount > 0
                            ? ` · ${inv.reminderCount}× upomínka`
                            : ''}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        <p>{formatDateCz(inv.issueDate)}</p>
                        <p className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>
                          {rowDocType === 'QUOTE' ? 'Platnost' : 'Splatnost'}{' '}
                          {formatDateCz(inv.dueDate)}
                          {overdue && diff !== null && ` (${Math.abs(diff)} d)`}
                        </p>
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-semibold tabular-nums whitespace-nowrap ${
                          isRowCredit ? 'text-red-700' : 'text-slate-900'
                        }`}
                      >
                        {formatCzk((isRowCredit ? -1 : 1) * inv.totalWithVat, inv.currency)}
                      </td>
                      <td className="py-3 px-4 text-xs font-medium whitespace-nowrap">
                        {inv.status === 'PAID' ? (
                          <span className="text-emerald-700">
                            {isRowCredit ? 'Vypořádáno' : 'Uhrazeno'}
                          </span>
                        ) : inv.status === 'CANCELLED' ? (
                          <span className="text-slate-400">Stornováno</span>
                        ) : overdue && rowDocType !== 'QUOTE' ? (
                          <span className="text-red-600">Po splatnosti</span>
                        ) : (
                          <span className="text-amber-700">Vystaveno</span>
                        )}
                      </td>
                      <td
                        className="py-3 px-4 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1">
                          {canRowConvert && (
                            <button
                              type="button"
                              onClick={() => startConvertToInvoice(inv)}
                              title="Převést na ostrou fakturu"
                              className="p-1.5 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-md"
                            >
                              <ArrowRightLeft className="w-4 h-4" />
                            </button>
                          )}
                          {isRowRecurring && inv.status !== 'CANCELLED' && (
                            <button
                              type="button"
                              onClick={() => startNextRecurringPeriod(inv)}
                              title="Vystavit fakturu pro další období"
                              className="p-1.5 text-emerald-600 hover:text-emerald-800 hover:bg-emerald-50 rounded-md"
                            >
                              <CalendarClock className="w-4 h-4" />
                            </button>
                          )}
                          {overdue && rowDocType !== 'QUOTE' && (
                            <button
                              type="button"
                              onClick={() => handleSendEmail(inv, true)}
                              title="Odeslat upomínku e-mailem"
                              className="p-1.5 text-amber-600 hover:text-amber-800 hover:bg-amber-50 rounded-md"
                            >
                              <BellRing className="w-4 h-4" />
                            </button>
                          )}
                          {inv.status !== 'CANCELLED' && (
                            <button
                              type="button"
                              onClick={() => startEditInvoice(inv)}
                              title="Upravit doklad"
                              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => startDuplicateInvoice(inv)}
                            title="Duplikovat doklad"
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                          {inv.status === 'CANCELLED' && isCurrentUserAdmin && (
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmInvoice(inv)}
                              title="Trvale smazat stornovanou fakturu"
                              className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-md"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deleteConfirmModal}
    </div>
  );
}
