import React, { useMemo, useRef, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Landmark,
  Link2,
  Loader2,
  RefreshCw,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  buildStatementImportPreview,
  decodeBankFileBuffer,
  type StatementImportPreview,
} from '../lib/bankParser';
import {
  autoMatchUnmatchedTransactionsByVs,
  ignoreBankTransaction,
  importAndMatchBankTransactions,
  pairTransactionToInvoice,
} from '../lib/firestoreService';
import { formatCzk, formatDateCz, getCompanyPalette, round2 } from '../lib/format';
import type { BankMatchStatus, BankTransaction, Invoice } from '../types';

type FilterStatus = 'ALL' | BankMatchStatus;

export function BankMatchingView() {
  const {
    workspace,
    activeCompany,
    invoices,
    bankTransactions,
    fetchFioTransactions,
    notify,
  } = useApp();

  const palette = getCompanyPalette(activeCompany?.accentIndex);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [statusFilter, setStatusFilter] = useState<FilterStatus>('ALL');
  const [syncingFio, setSyncingFio] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [importingPreview, setImportingPreview] = useState(false);

  const [preview, setPreview] = useState<StatementImportPreview | null>(null);
  const [pairingTx, setPairingTx] = useState<BankTransaction | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);

  const companyTx = useMemo(
    () => bankTransactions.filter((t) => !activeCompany || t.companyId === activeCompany.id),
    [bankTransactions, activeCompany]
  );

  const unpaidCompanyInvoices = useMemo(
    () =>
      invoices.filter(
        (i) => (!activeCompany || i.companyId === activeCompany.id) && i.status === 'ISSUED'
      ),
    [invoices, activeCompany]
  );

  const filteredTx = useMemo(() => {
    if (statusFilter === 'ALL') return companyTx;
    return companyTx.filter((t) => t.matchStatus === statusFilter);
  }, [companyTx, statusFilter]);

  const counts = useMemo(() => {
    return {
      all: companyTx.length,
      unmatched: companyTx.filter((t) => t.matchStatus === 'UNMATCHED').length,
      matched: companyTx.filter((t) => t.matchStatus === 'MATCHED').length,
      ignored: companyTx.filter((t) => t.matchStatus === 'IGNORED').length,
    };
  }, [companyTx]);

  const handleFioSync = async () => {
    if (!workspace || !activeCompany) return;
    if (!activeCompany.fioApiToken.trim()) {
      notify(
        'V nastavení firmy chybí Fio API token. Doplňte jej v Nastavení → Firemní údaje.',
        'error'
      );
      return;
    }
    setSyncingFio(true);
    try {
      const parsed = await fetchFioTransactions(activeCompany.fioApiToken.trim(), 30);
      const existingIds = new Set(companyTx.map((t) => t.externalId));
      const fresh = parsed.filter((tx) => !existingIds.has(tx.externalId));
      if (fresh.length === 0) {
        notify('Fio banka neobsahuje žádné nové pohyby za posledních 30 dní.', 'info');
        return;
      }
      const { importedCount, matchedCount } = await importAndMatchBankTransactions({
        workspace,
        companyId: activeCompany.id,
        newTransactions: fresh,
        unpaidCompanyInvoices,
      });
      notify(
        `Načteno ${importedCount} nových pohybů z Fio banky, automaticky spárováno ${matchedCount} faktur.`
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Synchronizace s Fio selhala.', 'error');
    } finally {
      setSyncingFio(false);
    }
  };

  const handleStatementFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeCompany) return;
    e.target.value = '';

    try {
      const buffer = await file.arrayBuffer();
      const rawContent = decodeBankFileBuffer(buffer, file.name);
      const result = buildStatementImportPreview({
        rawContent,
        fileName: file.name,
        companyId: activeCompany.id,
        existingTransactions: companyTx,
        unpaidCompanyInvoices,
      });
      if (result.totalParsed === 0) {
        notify('V souboru nebyly rozpoznány žádné bankovní transakce (.gpc / .abo / .csv).', 'error');
        return;
      }
      setPreview(result);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Načtení výpisu selhalo.', 'error');
    }
  };

  const handleConfirmPreviewImport = async () => {
    if (!workspace || !activeCompany || !preview) return;
    if (preview.newTransactions.length === 0) {
      notify('Všechny pohyby v tomto výpisu už byly importovány dříve.', 'info');
      setPreview(null);
      return;
    }
    setImportingPreview(true);
    try {
      const { importedCount, matchedCount } = await importAndMatchBankTransactions({
        workspace,
        companyId: activeCompany.id,
        newTransactions: preview.newTransactions,
        unpaidCompanyInvoices,
      });
      notify(
        `Importováno ${importedCount} pohybů (${preview.format}), automaticky spárováno ${matchedCount} faktur.`
      );
      setPreview(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Import výpisu selhal.', 'error');
    } finally {
      setImportingPreview(false);
    }
  };

  const handleAutoMatchUnmatched = async () => {
    if (!workspace) return;
    setAutoMatching(true);
    try {
      const matched = await autoMatchUnmatchedTransactionsByVs({
        workspaceId: workspace.id,
        unmatchedTransactions: companyTx.filter((t) => t.matchStatus === 'UNMATCHED'),
        unpaidCompanyInvoices,
      });
      if (matched > 0) {
        notify(`Automaticky spárováno ${matched} plateb podle variabilního symbolu.`);
      } else {
        notify('Nenalezeny žádné další shody podle variabilního symbolu.', 'info');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Automatické párování selhalo.', 'error');
    } finally {
      setAutoMatching(false);
    }
  };

  const handleManualPair = async (invoice: Invoice) => {
    if (!workspace || !pairingTx) return;
    setPairingBusy(true);
    try {
      await pairTransactionToInvoice({
        workspaceId: workspace.id,
        tx: pairingTx,
        invoice,
      });
      notify(`Platba spárována s fakturou ${invoice.invoiceNumber}.`);
      setPairingTx(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Ruční spárování selhalo.', 'error');
    } finally {
      setPairingBusy(false);
    }
  };

  const handleIgnore = async (tx: BankTransaction) => {
    if (!workspace) return;
    try {
      await ignoreBankTransaction(workspace.id, tx.id);
      notify('Pohyb označen jako ignorovaný.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Akce se nezdařila.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Banka a úhrady · {activeCompany?.name}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Párování plateb</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {activeCompany?.bankAccount || 'Doplňte číslo účtu v nastavení'}
            {activeCompany?.lastBankSyncAt && ` · Poslední synchronizace ${activeCompany.lastBankSyncAt}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gpc,.abo,.csv,.txt"
            onChange={handleStatementFile}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg whitespace-nowrap"
          >
            <Upload className="w-4 h-4" />
            Nahrát výpis (.gpc / .csv)
          </button>
          <button
            type="button"
            onClick={handleAutoMatchUnmatched}
            disabled={autoMatching || counts.unmatched === 0}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 rounded-lg whitespace-nowrap"
          >
            {autoMatching ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Wand2 className="w-4 h-4" />
            )}
            Spárovat podle VS
          </button>
          <button
            type="button"
            onClick={handleFioSync}
            disabled={syncingFio}
            style={{ backgroundColor: palette.primary }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-60 whitespace-nowrap"
          >
            {syncingFio ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Stáhnout Fio API (30 dní)
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
          {(
            [
              ['ALL', `Vše (${counts.all})`],
              ['UNMATCHED', `Nespárované (${counts.unmatched})`],
              ['MATCHED', `Spárované (${counts.matched})`],
              ['IGNORED', `Ignorované (${counts.ignored})`],
            ] as [FilterStatus, string][]
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

        <p className="text-xs text-slate-500 tabular-nums">
          Otevřených neuhrazených faktur firmy: <strong className="text-slate-900">{unpaidCompanyInvoices.length}</strong>
        </p>
      </div>

      {/* Preview box for uploaded GPC/CSV statement */}
      {preview && (
        <div className="bg-white border border-slate-300 rounded-xl overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Náhled výpisu: {preview.fileName} ({preview.format})
              </h3>
              <p className="text-xs text-slate-600 mt-0.5 tabular-nums">
                Celkem {preview.totalParsed} pohybů · {preview.newTransactions.length} nových ·{' '}
                {preview.duplicateCount} duplicit · {preview.autoMatchedCount} připraveno k automatickému spárování
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
              >
                Zrušit
              </button>
              <button
                type="button"
                onClick={handleConfirmPreviewImport}
                disabled={importingPreview || preview.newTransactions.length === 0}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white rounded-lg disabled:opacity-50"
              >
                {importingPreview ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Importovat a spárovat ({preview.newTransactions.length})
              </button>
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 text-xs">
            {preview.rows.map((row, idx) => (
              <div
                key={`${row.transaction.externalId}-${idx}`}
                className={`px-4 py-2.5 flex items-center justify-between gap-4 ${
                  row.isDuplicate ? 'opacity-45 bg-slate-50' : ''
                }`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900 truncate">
                    {row.transaction.counterpartyName || row.transaction.counterpartyAccount || 'Bankovní pohyb'}
                  </p>
                  <p className="text-slate-500 tabular-nums">
                    {formatDateCz(row.transaction.date)}
                    {row.transaction.variableSymbol && ` · VS ${row.transaction.variableSymbol}`}
                    {row.transaction.message && ` · ${row.transaction.message}`}
                  </p>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <p
                    className={`font-semibold ${
                      row.transaction.amount >= 0 ? 'text-emerald-700' : 'text-slate-700'
                    }`}
                  >
                    {row.transaction.amount >= 0 ? '+' : ''}
                    {formatCzk(row.transaction.amount, row.transaction.currency)}
                  </p>
                  <p className="text-[11px]">
                    {row.isDuplicate ? (
                      <span className="text-slate-400">Již importováno</span>
                    ) : row.matchedInvoice ? (
                      <span className="text-emerald-700 font-medium">
                        Spáruje s FA {row.matchedInvoice.invoiceNumber}
                      </span>
                    ) : (
                      <span className="text-slate-500">Nový pohyb</span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transactions table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredTx.length === 0 ? (
          <div className="p-12 text-center">
            <Landmark className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-slate-900">Žádné bankovní pohyby</p>
            <p className="mt-1 text-xs text-slate-500">
              Stáhněte pohyby přes Fio API nebo nahrajte výpis ve formátu ABO/GPC či CSV.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Datum</th>
                  <th className="py-3 px-4">Protiúčet / Zpráva</th>
                  <th className="py-3 px-4">VS</th>
                  <th className="py-3 px-4 text-right">Částka</th>
                  <th className="py-3 px-4">Stav párování</th>
                  <th className="py-3 px-4 text-right">Akce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredTx.map((tx) => (
                  <tr key={tx.id} className="hover:bg-slate-50/60">
                    <td className="py-3 px-4 text-xs text-slate-600 tabular-nums whitespace-nowrap">
                      {formatDateCz(tx.date)}
                      <p className="text-[11px] text-slate-400">{tx.source}</p>
                    </td>
                    <td className="py-3 px-4 max-w-sm">
                      <p className="font-medium text-slate-900 truncate">
                        {tx.counterpartyName || tx.counterpartyAccount || 'Bez označení'}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {tx.counterpartyAccount}
                        {tx.message ? ` · ${tx.message}` : ''}
                      </p>
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums">
                      {tx.variableSymbol || '—'}
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-semibold tabular-nums whitespace-nowrap ${
                        tx.amount >= 0 ? 'text-emerald-700' : 'text-slate-700'
                      }`}
                    >
                      {tx.amount >= 0 ? '+' : ''}
                      {formatCzk(tx.amount, tx.currency)}
                    </td>
                    <td className="py-3 px-4 text-xs">
                      {tx.matchStatus === 'MATCHED' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          FA {tx.matchedInvoiceNumber}
                        </span>
                      ) : tx.matchStatus === 'IGNORED' ? (
                        <span className="text-slate-400">Ignorováno</span>
                      ) : (
                        <span className="text-amber-700 font-medium">Nespárováno</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      {tx.matchStatus === 'UNMATCHED' && (
                        <div className="inline-flex items-center gap-1">
                          {tx.amount > 0 && (
                            <button
                              type="button"
                              onClick={() => setPairingTx(tx)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md"
                            >
                              <Link2 className="w-3.5 h-3.5" />
                              Spárovat
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleIgnore(tx)}
                            title="Ignorovat pohyb"
                            className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md"
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Manual Pairing */}
      {pairingTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Ruční spárování platby</h3>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  {pairingTx.counterpartyName || pairingTx.counterpartyAccount} ·{' '}
                  <strong className="text-emerald-700">
                    +{formatCzk(pairingTx.amount, pairingTx.currency)}
                  </strong>
                  {pairingTx.variableSymbol ? ` · VS ${pairingTx.variableSymbol}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPairingTx(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
              {unpaidCompanyInvoices.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  Aktivní firma nemá žádné neuhrazené faktury ke spárování.
                </div>
              ) : (
                unpaidCompanyInvoices.map((inv) => {
                  const remaining = round2(Math.max(0, inv.totalWithVat - inv.paidAmount));
                  return (
                    <button
                      key={inv.id}
                      type="button"
                      disabled={pairingBusy}
                      onClick={() => handleManualPair(inv)}
                      className="w-full text-left px-5 py-3.5 hover:bg-slate-50 flex items-center justify-between gap-4 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {inv.clientName}
                        </p>
                        <p className="text-xs text-slate-500 tabular-nums">
                          <span className="font-mono text-slate-700">{inv.invoiceNumber}</span> · VS{' '}
                          {inv.variableSymbol} · Splatnost {formatDateCz(inv.dueDate)}
                        </p>
                      </div>
                      <div className="text-right shrink-0 tabular-nums">
                        <p className="text-sm font-semibold text-slate-900">
                          {formatCzk(remaining, inv.currency)}
                        </p>
                        <p className="text-[11px] text-slate-400">Zbývá uhradit</p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
