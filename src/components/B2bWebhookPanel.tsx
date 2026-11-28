import React, { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-react';
import type { Company, Warehouse, Workspace } from '../types';

interface B2bWebhookPanelProps {
  workspace: Workspace | null;
  activeCompany: Company | null;
  warehouses: Warehouse[];
  accentColor: string;
  onNotify: (msg: string, tone?: 'success' | 'error' | 'info') => void;
}

interface ConfigStatus {
  tokenConfigured: boolean;
  firebaseSyncConfigured: boolean;
}

interface PingResult {
  ok: boolean;
  workspaceName?: string;
  companyName?: string;
  warehouseName?: string;
  inventoryCount?: number;
  invoiceCount?: number;
  clientCount?: number;
  error?: string;
}

const ORDER_EXAMPLE = `{
  "event": "order.created",
  "orderId": "B2B-2026-0042",
  "orderNumber": "20260042",
  "paymentMethod": "BANK_TRANSFER",
  "paid": false,
  "currency": "CZK",
  "customer": {
    "name": "Vape Shop s.r.o.",
    "ico": "12345678",
    "dic": "CZ12345678",
    "street": "Hlavní 12",
    "city": "Praha",
    "zip": "11000",
    "email": "objednavky@vapeshop.cz"
  },
  "items": [
    {
      "sku": "OXV-GL-MW",
      "ean": "6972531691234",
      "name": "Oxva Xlim Go Lite Mist White",
      "quantity": 10,
      "unit": "ks",
      "unitPrice": 280,
      "vatRate": 21
    }
  ]
}`;

const MOVEMENT_EXAMPLE = `{
  "event": "stock.movement",
  "documentRef": "B2B-EXP-042",
  "note": "Expedice ze skladu Nerx B2B",
  "movements": [
    {
      "sku": "OXV-GL-MW",
      "name": "Oxva Xlim Go Lite Mist White",
      "quantityDelta": -5,
      "unit": "ks"
    }
  ]
}`;

export function B2bWebhookPanel({
  workspace,
  activeCompany,
  warehouses,
  accentColor,
  onNotify,
}: B2bWebhookPanelProps) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [testToken, setTestToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [activeExample, setActiveExample] = useState<'ORDER' | 'MOVEMENT' | 'PAID'>('ORDER');

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/b2b-webhook`
      : '/api/b2b-webhook';

  const defaultWh = warehouses.find((w) => w.id === 'shared_main') || warehouses[0] || null;

  const loadConfigStatus = async () => {
    setLoadingStatus(true);
    try {
      const resp = await fetch('/api/b2b-webhook?check=config');
      if (resp.ok) {
        const data = (await resp.json()) as ConfigStatus;
        setStatus(data);
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    loadConfigStatus();
  }, []);

  const copyText = async (key: string, text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      onNotify(`${label} zkopírováno do schránky.`);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      onNotify('Nepodařilo se zkopírovat text do schránky.', 'error');
    }
  };

  const generateSuggestedToken = () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token =
      'skf_b2b_' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    copyText('genToken', token, 'Vygenerovaný Bearer token');
  };

  const handleTestConnection = async () => {
    const cleanToken = testToken.trim();
    if (!cleanToken) {
      onNotify('Vložte svůj B2B_WEBHOOK_TOKEN pro otestování spojení.', 'error');
      return;
    }
    setTesting(true);
    setPingResult(null);
    try {
      const resp = await fetch('/api/b2b-webhook', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${cleanToken}`,
        },
      });
      const data = (await resp.json().catch(() => ({}))) as PingResult;
      if (resp.ok && data.ok) {
        setPingResult(data);
        onNotify('Spojení s B2B webhookem a sdílenou databází funguje.');
      } else {
        setPingResult({ ok: false, error: data.error || `HTTP ${resp.status}` });
        onNotify(data.error || `Test selhal (HTTP ${resp.status}).`, 'error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chyba sítě';
      setPingResult({ ok: false, error: msg });
      onNotify(msg, 'error');
    } finally {
      setTesting(false);
    }
  };

  const paidExample = `{
  "event": "order.paid",
  "orderId": "B2B-2026-0042",
  "paidDate": "${new Date().toISOString().slice(0, 10)}"
}`;

  const shownJson =
    activeExample === 'ORDER'
      ? ORDER_EXAMPLE
      : activeExample === 'MOVEMENT'
        ? MOVEMENT_EXAMPLE
        : paidExample;

  return (
    <div className="space-y-5">
      {/* Main Webhook URL card */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-slate-600" />
              Propojení s Nerx B2B (Webhook & API)
            </h2>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
              Objednávky, faktury, úhrady, storna i skladové pohyby odeslané z vašeho Nerx B2B na
              tuto adresu se automaticky zapíší do SkladFaktury (Faktury, Sklad, Deník pohybů,
              Odběratelé, DPH i statistiky) a ihned se synchronizují s Android aplikací.
            </p>
          </div>
          <button
            type="button"
            onClick={loadConfigStatus}
            disabled={loadingStatus}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? 'animate-spin' : ''}`} />
            Obnovit stav
          </button>
        </div>

        {/* Webhook URL copy box */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-700">
            URL Webhook / API endpointu (vložte do Nerx B2B)
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              readOnly
              value={webhookUrl}
              className="flex-1 px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-800 select-all"
            />
            <button
              type="button"
              onClick={() => copyText('url', webhookUrl, 'URL Webhooku')}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white rounded-lg shrink-0"
              style={{ backgroundColor: accentColor }}
            >
              {copiedKey === 'url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedKey === 'url' ? 'Zkopírováno' : 'Kopírovat URL'}
            </button>
          </div>
        </div>

        {/* Server configuration status */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-slate-800 font-mono">B2B_WEBHOOK_TOKEN</p>
              <p className="text-[11px] text-slate-500">Tajný Bearer token pro ověření Nerx B2B</p>
            </div>
            {status ? (
              status.tokenConfigured ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 shrink-0">
                  <CheckCircle2 className="w-4 h-4" /> Nastaveno
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 shrink-0">
                  <XCircle className="w-4 h-4" /> Chybí na serveru
                </span>
              )
            ) : (
              <span className="text-xs text-slate-400">…</span>
            )}
          </div>

          <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-slate-800 font-mono">
                FIREBASE_SYNC_EMAIL / PASSWORD
              </p>
              <p className="text-[11px] text-slate-500">Účet člena týmu pro automatický zápis</p>
            </div>
            {status ? (
              status.firebaseSyncConfigured ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 shrink-0">
                  <CheckCircle2 className="w-4 h-4" /> Nastaveno
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 shrink-0">
                  <XCircle className="w-4 h-4" /> Chybí na serveru
                </span>
              )
            ) : (
              <span className="text-xs text-slate-400">…</span>
            )}
          </div>
        </div>
      </div>

      {/* Step-by-step setup on Vercel */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-slate-600" />
            Nastavení na Vercelu (Environment Variables)
          </h3>
          <button
            type="button"
            onClick={generateSuggestedToken}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg"
          >
            {copiedKey === 'genToken' ? (
              <Check className="w-3.5 h-3.5 text-emerald-700" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            Vygenerovat a zkopírovat nový Bearer token
          </button>
        </div>

        <ol className="text-xs text-slate-600 space-y-2 list-decimal pl-5 leading-relaxed">
          <li>
            Klikněte na <strong>Vygenerovat a zkopírovat nový Bearer token</strong> výše (tajný klíč
            se nikde neukládá v prohlížeči).
          </li>
          <li>
            V projektu na Vercelu (<strong>Settings → Environment Variables</strong>) přidejte:
            <ul className="mt-1.5 space-y-1 list-disc pl-4 font-mono text-[11px] text-slate-800">
              <li>
                <strong>B2B_WEBHOOK_TOKEN</strong> = váš vygenerovaný Bearer token (stejný vložte i
                do Nerx B2B)
              </li>
              <li>
                <strong>FIREBASE_SYNC_EMAIL</strong> = e-mail účtu přihlášeného do SkladFaktury (s
                e-mail/heslo přihlášením)
              </li>
              <li>
                <strong>FIREBASE_SYNC_PASSWORD</strong> = heslo tohoto účtu
              </li>
            </ul>
          </li>
          <li>
            Volitelně (pokud máte více firem nebo skladů) přidejte přesné ID cílového pracovního
            prostoru, firmy a skladu a udělejte <strong>Redeploy</strong>:
          </li>
        </ol>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          {[
            { key: 'B2B_WORKSPACE_ID', value: workspace?.id || '' },
            { key: 'B2B_COMPANY_ID', value: activeCompany?.id || 'company_1' },
            { key: 'B2B_WAREHOUSE_ID', value: defaultWh?.id || 'shared_main' },
          ].map((row) => (
            <div
              key={row.key}
              className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <p className="text-[11px] font-mono font-semibold text-slate-700">{row.key}</p>
                <p className="text-[11px] font-mono text-slate-500 truncate">{row.value || '—'}</p>
              </div>
              {row.value && (
                <button
                  type="button"
                  onClick={() => copyText(row.key, row.value, row.key)}
                  className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-white rounded border border-transparent hover:border-slate-200 shrink-0"
                  title={`Kopírovat ${row.key}`}
                >
                  {copiedKey === row.key ? (
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Live Connection Test */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Ověření spojení (Test)</h3>
        <p className="text-xs text-slate-500">
          Vložte svůj <span className="font-mono">B2B_WEBHOOK_TOKEN</span> (zůstává jen v paměti
          pro test) a ověřte, že endpoint správně čte a zapisuje do vaší sdílené databáze.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="password"
            value={testToken}
            onChange={(e) => setTestToken(e.target.value)}
            placeholder="Vložte B2B_WEBHOOK_TOKEN pro test…"
            autoComplete="off"
            className="flex-1 px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/15"
          />
          <button
            type="button"
            disabled={testing}
            onClick={handleTestConnection}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-60 shrink-0"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            {testing ? 'Testuji…' : 'Otestovat spojení'}
          </button>
        </div>

        {pingResult && (
          <div
            className={`p-3 rounded-lg text-xs border ${
              pingResult.ok
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-900'
            }`}
          >
            {pingResult.ok ? (
              <p>
                <strong>Připojeno!</strong> Firma: <strong>{pingResult.companyName}</strong> ·
                Sklad: <strong>{pingResult.warehouseName}</strong> · Karet:{' '}
                <strong>{pingResult.inventoryCount}</strong> · Faktur:{' '}
                <strong>{pingResult.invoiceCount}</strong> · Klientů:{' '}
                <strong>{pingResult.clientCount}</strong>
              </p>
            ) : (
              <p>{pingResult.error}</p>
            )}
          </div>
        )}
      </div>

      {/* Payload reference */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Podporované formáty zpráv z Nerx B2B (POST JSON)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Hlavička: <span className="font-mono">Authorization: Bearer &lt;B2B_WEBHOOK_TOKEN&gt;</span> ·
              Sklad: <span className="font-mono">GET /api/b2b-webhook?action=inventory</span> ·
              Originál PDF faktury:{' '}
              <span className="font-mono">GET /api/b2b-webhook?action=invoice-pdf&amp;invoiceId=…</span>{' '}
              (také <span className="font-mono">orderId</span> nebo <span className="font-mono">invoiceNumber</span>).
              Odpověď <span className="font-mono">order.created</span> obsahuje{' '}
              <span className="font-mono">invoicePdfUrl</span>, <span className="font-mono">supplierIban</span> a{' '}
              <span className="font-mono">supplierAccount</span>.
            </p>
          </div>
          <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
            {(
              [
                ['ORDER', 'Objednávka / Faktura'],
                ['PAID', 'Úhrada'],
                ['MOVEMENT', 'Skladový pohyb'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveExample(id)}
                className={`px-2.5 py-1 rounded-md font-medium ${
                  activeExample === id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <pre className="p-3.5 bg-slate-950 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto leading-relaxed">
          {shownJson}
        </pre>
      </div>
    </div>
  );
}
