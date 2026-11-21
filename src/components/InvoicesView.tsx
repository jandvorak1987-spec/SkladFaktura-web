import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  Ban,
  Building2,
  CheckCircle2,
  Copy,
  Edit3,
  FilePlus2,
  FileText,
  Loader2,
  Package,
  Plus,
  Printer,
  Search,
  Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  cancelInvoice,
  editInvoice,
  issueInvoice,
  markInvoicePaid,
  updateInvoiceTemplate,
} from '../lib/firestoreService';
import {
  addDaysIso,
  buildCzechSpdQr,
  calculateInvoiceTotals,
  czechAccountToIban,
  daysUntilDue,
  formatCzk,
  formatDateCz,
  formatQty,
  getCompanyPalette,
  isInvoiceOverdue,
  lineTotalWithoutVat,
  lineTotalWithVat,
  previewNextInvoiceNumber,
  toIsoDate,
} from '../lib/format';
import {
  INVOICE_TEMPLATES,
  type Client,
  type Company,
  type CompanyBrandPalette,
  type Invoice,
  type InvoiceLineItem,
  type InvoiceStatus,
  type InvoiceTemplateId,
  type PaymentMethod,
} from '../types';

interface InvoicesViewProps {
  initialCreateTrigger?: number;
  prefillClient?: Client | null;
  onClearPrefillClient?: () => void;
}

type StatusFilter = 'ALL' | InvoiceStatus | 'OVERDUE';

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
}: {
  invoice: Invoice;
  company?: Company | null;
  palette: CompanyBrandPalette;
  vatPayer: boolean;
}) {
  const template: InvoiceTemplateId = invoice.invoiceTemplate || 'CLASSIC';
  const totals = calculateInvoiceTotals(invoice.items, vatPayer);
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
  const spdPayload =
    !isCashPayment && resolvedIban
      ? buildCzechSpdQr({
          iban: resolvedIban,
          amount: Math.max(0, invoice.totalWithVat - invoice.paidAmount) || invoice.totalWithVat,
          variableSymbol: invoice.variableSymbol || invoice.invoiceNumber.replace(/\D/g, ''),
          message: `Faktura ${invoice.invoiceNumber}`,
          dueDate: invoice.dueDate,
          currency: invoice.currency || 'CZK',
        })
      : null;

  const isBanner = template === 'MODERN_BANNER';
  const isMinimal = template === 'MINIMAL';
  const isSidebar = template === 'EXECUTIVE_SIDEBAR';

  const bodyContent = (
    <div className="space-y-6 text-slate-900">
      {/* Header */}
      {isBanner ? (
        <div
          style={{ backgroundColor: palette.primary }}
          className="text-white rounded-lg p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
        >
          <div>
            <p className="text-xs uppercase tracking-widest opacity-80">
              {vatPayer ? 'Faktura – Daňový doklad' : 'Faktura'}
            </p>
            <h2 className="text-2xl font-bold mt-1 font-mono">{invoice.invoiceNumber}</h2>
            <p className="text-sm opacity-90 mt-1">{invoice.companyName}</p>
          </div>
          <div className="text-left sm:text-right tabular-nums">
            <p className="text-xs uppercase opacity-80">Celkem k úhradě</p>
            <p className="text-2xl font-bold mt-0.5">
              {formatCzk(invoice.totalWithVat, invoice.currency)}
            </p>
            <p className="text-xs opacity-90 mt-1">
              Splatnost {formatDateCz(invoice.dueDate)} · VS {invoice.variableSymbol}
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
              {vatPayer ? 'Faktura – Daňový doklad' : 'Faktura'}
            </p>
            <h2 className="text-2xl font-bold mt-1 font-mono text-slate-900">
              č. {invoice.invoiceNumber}
            </h2>
          </div>
          <div className="text-left sm:text-right text-xs text-slate-600 space-y-0.5 tabular-nums">
            <p>
              Variabilní symbol:{' '}
              <strong className="font-mono text-slate-900">{invoice.variableSymbol}</strong>
            </p>
            <p>
              Datum vystavení: <strong className="text-slate-900">{formatDateCz(invoice.issueDate)}</strong>
            </p>
            {vatPayer && invoice.taxDate && (
              <p>
                DUZP: <strong className="text-slate-900">{formatDateCz(invoice.taxDate)}</strong>
              </p>
            )}
            <p>
              Datum splatnosti:{' '}
              <strong className="text-slate-900">{formatDateCz(invoice.dueDate)}</strong>
            </p>
          </div>
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
          </div>
        </div>
      </div>

      {/* Payment info & QR */}
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
          !isCashPayment && (
            <div className="no-print text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-[220px]">
              Pro zobrazení <strong>QR Platby</strong> doplňte v <em>Nastavení → Firemní údaje</em>{' '}
              číslo účtu (např. <span className="font-mono">123456789/2010</span>) nebo IBAN.
            </div>
          )
        )}
      </div>

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
              {vatPayer && <th className="py-2 px-2 text-right">DPH</th>}
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
                  {formatQty(item.quantity)} {item.unit}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">
                  {formatCzk(item.unitPrice, invoice.currency)}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap text-slate-500">
                  {item.discountPercent > 0 ? `${item.discountPercent} %` : '—'}
                </td>
                {vatPayer && (
                  <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap text-slate-600">
                    {item.vatRate} %
                  </td>
                )}
                <td className="py-2.5 pl-2 text-right font-semibold tabular-nums whitespace-nowrap">
                  {formatCzk(
                    vatPayer ? lineTotalWithVat(item, true) : lineTotalWithoutVat(item),
                    invoice.currency
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* VAT Summary + Grand total */}
      <div className="flex flex-col sm:flex-row justify-between gap-6 pt-4 border-t border-slate-200">
        <div className="flex-1 text-xs text-slate-600">
          {vatPayer && totals.breakdown.length > 0 && (
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
                    <td className="py-1 text-right">{formatCzk(row.base, invoice.currency)}</td>
                    <td className="py-1 text-right">{formatCzk(row.vat, invoice.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {invoice.note && (
            <p className="mt-4 text-xs text-slate-600">
              <strong className="text-slate-800">Poznámka:</strong> {invoice.note}
            </p>
          )}
        </div>

        <div className="sm:w-64 space-y-1.5 text-sm tabular-nums">
          <div className="flex justify-between text-slate-600">
            <span>Základ bez DPH</span>
            <span>{formatCzk(invoice.totalWithoutVat, invoice.currency)}</span>
          </div>
          {vatPayer && (
            <div className="flex justify-between text-slate-600">
              <span>DPH celkem</span>
              <span>{formatCzk(invoice.totalVat, invoice.currency)}</span>
            </div>
          )}
          <div
            className="flex justify-between pt-2 mt-2 border-t text-base font-bold"
            style={{ borderColor: palette.primary, color: palette.dark }}
          >
            <span>Celkem k úhradě</span>
            <span>{formatCzk(invoice.totalWithVat, invoice.currency)}</span>
          </div>
          {invoice.status === 'PAID' && (
            <p className="text-xs font-medium text-emerald-700 text-right pt-1">
              Uhrazeno {invoice.paidDate ? formatDateCz(invoice.paidDate) : ''}
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');

  // Create form state
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [variableSymbol, setVariableSymbol] = useState('');
  const [issueDate, setIssueDate] = useState(toIsoDate());
  const [taxDate, setTaxDate] = useState(toIsoDate());
  const [dueDate, setDueDate] = useState(addDaysIso(toIsoDate(), 14));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('BANK_TRANSFER');
  const [invoiceTemplate, setInvoiceTemplate] = useState<InvoiceTemplateId>('CLASSIC');
  const [deductFromStock, setDeductFromStock] = useState(true);
  const [note, setNote] = useState('');

  const [clientId, setClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientIco, setClientIco] = useState('');
  const [clientDic, setClientDic] = useState('');
  const [clientStreet, setClientStreet] = useState('');
  const [clientCity, setClientCity] = useState('');
  const [clientZip, setClientZip] = useState('');

  const [items, setItems] = useState<InvoiceLineItem[]>([]);
  const [aresBusy, setAresBusy] = useState(false);
  const [saving, setSaving] = useState(false);

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

  const startNewInvoice = (client?: Client | null) => {
    const today = toIsoDate();
    const nextNum = activeCompany ? previewNextInvoiceNumber(activeCompany) : `20260001`;
    setInvoiceNumber(nextNum);
    setVariableSymbol(nextNum.replace(/\D/g, ''));
    setIssueDate(today);
    setTaxDate(today);
    setDueDate(addDaysIso(today, 14));
    setPaymentMethod('BANK_TRANSFER');
    setInvoiceTemplate(activeCompany?.invoiceTemplate || 'CLASSIC');
    setDeductFromStock(true);
    setNote('');

    if (client) {
      setClientId(client.id);
      setClientName(client.name);
      setClientIco(client.ico);
      setClientDic(client.dic);
      setClientStreet(client.street);
      setClientCity(client.city);
      setClientZip(client.zip);
    } else {
      setClientId('');
      setClientName('');
      setClientIco('');
      setClientDic('');
      setClientStreet('');
      setClientCity('');
      setClientZip('');
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
    setMode('CREATE');
  };

  const startDuplicateInvoice = (source: Invoice) => {
    const today = toIsoDate();
    const nextNum = activeCompany ? previewNextInvoiceNumber(activeCompany) : `20260001`;
    setInvoiceNumber(nextNum);
    setVariableSymbol(nextNum.replace(/\D/g, ''));
    setIssueDate(today);
    setTaxDate(today);
    setDueDate(addDaysIso(today, 14));
    setPaymentMethod(source.paymentMethod || 'BANK_TRANSFER');
    setInvoiceTemplate(source.invoiceTemplate || activeCompany?.invoiceTemplate || 'CLASSIC');
    setDeductFromStock(source.deductedFromStock);
    setNote(source.note || '');
    setClientId(source.clientId || '');
    setClientName(source.clientName || '');
    setClientIco(source.clientIco || '');
    setClientDic(source.clientDic || '');
    setClientStreet(source.clientStreet || '');
    setClientCity(source.clientCity || '');
    setClientZip(source.clientZip || '');
    setItems(source.items.map((l) => ({ ...l })));
    setEditingInvoice(null);
    setMode('CREATE');
  };

  const startEditInvoice = (source: Invoice) => {
    setInvoiceNumber(source.invoiceNumber);
    setVariableSymbol(source.variableSymbol);
    setIssueDate(source.issueDate);
    setTaxDate(source.taxDate || source.issueDate);
    setDueDate(source.dueDate);
    setPaymentMethod(source.paymentMethod || 'BANK_TRANSFER');
    setInvoiceTemplate(source.invoiceTemplate || activeCompany?.invoiceTemplate || 'CLASSIC');
    setDeductFromStock(source.deductedFromStock);
    setNote(source.note || '');
    setClientId(source.clientId || '');
    setClientName(source.clientName || '');
    setClientIco(source.clientIco || '');
    setClientDic(source.clientDic || '');
    setClientStreet(source.clientStreet || '');
    setClientCity(source.clientCity || '');
    setClientZip(source.clientZip || '');
    setItems(source.items.map((l) => ({ ...l })));
    setEditingInvoice(source);
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
        statusFilter !== 'ALL' &&
        statusFilter !== 'OVERDUE' &&
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

  const draftTotals = useMemo(
    () => calculateInvoiceTotals(items, activeCompany?.vatPayer ?? true),
    [items, activeCompany]
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
    setSaving(true);
    try {
      const payload = {
        company: activeCompany,
        invoiceNumber,
        variableSymbol,
        issueDate,
        taxDate,
        dueDate,
        paymentMethod,
        clientId,
        clientName,
        clientIco,
        clientDic,
        clientStreet,
        clientCity,
        clientZip,
        note,
        deductFromStock,
        invoiceTemplate,
        items,
      };

      if (mode === 'EDIT' && editingInvoice) {
        const updatedId = await editInvoice({
          workspace,
          originalInvoice: editingInvoice,
          inventory,
          isAdmin: isCurrentUserAdmin,
          payload,
        });
        notify(`Změny na faktuře ${invoiceNumber} byly uloženy.`);
        setEditingInvoice(null);
        setSelectedInvoiceId(updatedId);
        setMode('DETAIL');
      } else {
        const newId = await issueInvoice({
          workspace,
          inventory,
          payload,
        });
        notify(`Faktura ${invoiceNumber} byla vystavena.`);
        setSelectedInvoiceId(newId);
        setMode('DETAIL');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Uložení faktury selhalo.', 'error');
    } finally {
      setSaving(false);
    }
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

    return (
      <div className="space-y-5">
        <div className="no-print flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMode('LIST')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <ArrowLeft className="w-4 h-4" />
              Zpět na seznam
            </button>
            <div>
              <h1 className="text-lg font-bold text-slate-900 font-mono">
                Faktura {selectedInvoice.invoiceNumber}
              </h1>
              <p className="text-xs text-slate-500">
                {selectedInvoice.clientName} ·{' '}
                {selectedInvoice.exportedToPohoda ? 'Exportováno do POHODY' : 'Zatím neexportováno'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
                  Označit uhrazeno
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
            <button
              type="button"
              onClick={() => window.print()}
              style={{ backgroundColor: palette.primary }}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95"
            >
              <Printer className="w-4 h-4" />
              Tisk / PDF A4
            </button>
          </div>
        </div>

        {/* Live template switcher */}
        {selectedInvoice.status !== 'CANCELLED' && (
          <div className="no-print bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs font-medium text-slate-600">Šablona dokladu:</span>
            <div className="flex flex-wrap items-center gap-1.5">
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
          </div>
        )}

        <InvoiceDocumentPreview
          invoice={selectedInvoice}
          company={activeCompany}
          palette={palette}
          vatPayer={isVatPayer}
        />
      </div>
    );
  }

  // CREATE / EDIT VIEW
  if (mode === 'CREATE' || mode === 'EDIT') {
    const isEditing = mode === 'EDIT' && editingInvoice !== null;
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
                {isEditing ? `Úprava faktury ${editingInvoice.invoiceNumber}` : 'Nová faktura'}
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
            {isEditing ? 'Uložit změny' : 'Vystavit fakturu'} · {formatCzk(draftTotals.totalWithVat)}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Document metadata */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">Údaje dokladu</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Číslo faktury *</label>
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
                <label className="block text-xs font-medium text-slate-700 mb-1">Datum splatnosti</label>
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
              <div className="flex items-end">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 pb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deductFromStock}
                    onChange={(e) => setDeductFromStock(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Automaticky odepsat ze skladu
                </label>
              </div>
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
                  {activeCompany?.vatPayer && <th className="py-2 px-2 w-20">DPH</th>}
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
                    {activeCompany?.vatPayer && (
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
                        activeCompany?.vatPayer
                          ? lineTotalWithVat(line, true)
                          : lineTotalWithoutVat(line)
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
              <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka na faktuře</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Volitelná poznámka pro odběratele"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>

            <div className="sm:w-64 space-y-1 text-sm tabular-nums">
              <div className="flex justify-between text-slate-600">
                <span>Celkem bez DPH</span>
                <span>{formatCzk(draftTotals.totalWithoutVat)}</span>
              </div>
              {activeCompany?.vatPayer && (
                <div className="flex justify-between text-slate-600">
                  <span>DPH</span>
                  <span>{formatCzk(draftTotals.totalVat)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold text-slate-900 pt-1.5 border-t border-slate-200">
                <span>Celkem k úhradě</span>
                <span>{formatCzk(draftTotals.totalWithVat)}</span>
              </div>
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

        <button
          type="button"
          onClick={() => startNewInvoice()}
          style={{ backgroundColor: palette.primary }}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 self-start md:self-auto whitespace-nowrap"
        >
          <FilePlus2 className="w-4 h-4" />
          Nová faktura
        </button>
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
            <p className="mt-3 text-sm font-medium text-slate-900">Žádné faktury</p>
            <p className="mt-1 text-xs text-slate-500">
              Vystavte první fakturu s QR platbou a automatickým odpisem ze skladu.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Číslo / VS</th>
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
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => {
                        setSelectedInvoiceId(inv.id);
                        setMode('DETAIL');
                      }}
                      className="hover:bg-slate-50/80 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 font-mono tabular-nums whitespace-nowrap">
                        <p className="font-semibold text-slate-900">{inv.invoiceNumber}</p>
                        <p className="text-xs text-slate-500">VS {inv.variableSymbol}</p>
                      </td>
                      <td className="py-3 px-4">
                        <p className="font-medium text-slate-900">{inv.clientName}</p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          {inv.clientIco ? `IČO ${inv.clientIco}` : '—'}
                          {inv.exportedToPohoda && ' · POHODA ✓'}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                        <p>{formatDateCz(inv.issueDate)}</p>
                        <p className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>
                          Splatnost {formatDateCz(inv.dueDate)}
                          {overdue && diff !== null && ` (${Math.abs(diff)} d)`}
                        </p>
                      </td>
                      <td className="py-3 px-4 text-right font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {formatCzk(inv.totalWithVat, inv.currency)}
                      </td>
                      <td className="py-3 px-4 text-xs font-medium whitespace-nowrap">
                        {inv.status === 'PAID' ? (
                          <span className="text-emerald-700">Uhrazeno</span>
                        ) : inv.status === 'CANCELLED' ? (
                          <span className="text-slate-400">Stornováno</span>
                        ) : overdue ? (
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
                          {inv.status !== 'CANCELLED' && (
                            <button
                              type="button"
                              onClick={() => startEditInvoice(inv)}
                              title="Upravit fakturu"
                              className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => startDuplicateInvoice(inv)}
                            title="Duplikovat fakturu"
                            className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
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
    </div>
  );
}
