import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  GoogleGenAI,
  Type,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import {
  TTL_ARES_COMPANY_MS,
  TTL_CNB_RATES_MS,
  TtlCache,
  extractCandidateSupplierIco,
  isNonStockRecyclingFee,
} from './server-lib/ttlCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
// Strictly free-tier Gemini models only (zero paid models, no Google Search grounding)
const PRIMARY_GEMINI_MODEL = 'gemini-4-hydrogen';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';
const PRIMARY_TIMEOUT_MS = 8000;

interface AresSubjectPayload {
  ico: string;
  dic: string;
  name: string;
  street: string;
  city: string;
  zip: string;
  legalForm: string;
}

interface CnbRatesPayload {
  date: string;
  rates: Record<string, number>;
  source: 'CNB' | 'FALLBACK';
}

const aresCache = new TtlCache({ defaultTtlMs: TTL_ARES_COMPANY_MS, maxEntries: 2000 });
const cnbCache = new TtlCache({ defaultTtlMs: TTL_CNB_RATES_MS, maxEntries: 4 });
const inFlightAres = new Map<
  string,
  Promise<{ ok: true; status: number; data: AresSubjectPayload } | { ok: false; status: number; error: string }>
>();
let inFlightCnb: Promise<CnbRatesPayload> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutOrAbortError(err: unknown): boolean {
  if (!err) return false;
  const obj = err as { name?: string; message?: string };
  const name = String(obj.name || '').toLowerCase();
  const msg = String(obj.message || err).toLowerCase();
  return (
    name === 'timeouterror' ||
    name === 'aborterror' ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

function isHighDemandError(err: unknown): boolean {
  if (!err) return false;
  const obj = err as {
    status?: number | string;
    code?: number | string;
    message?: string;
    error?: { code?: number | string; status?: string };
    response?: { status?: number | string };
  };
  const status = Number(obj.status ?? obj.code ?? obj.error?.code ?? obj.response?.status ?? 0);
  if (status === 503) return true;
  const statusText = String(obj.status ?? obj.error?.status ?? '').toUpperCase();
  if (statusText === 'UNAVAILABLE') return true;
  const msg = String(obj.message || err).toLowerCase();
  return msg.includes('503') || msg.includes('high demand') || msg.includes('unavailable');
}

function isModelNotFoundError(err: unknown): boolean {
  if (!err) return false;
  const obj = err as {
    status?: number | string;
    code?: number | string;
    message?: string;
    error?: { code?: number | string; status?: string };
    response?: { status?: number | string };
  };
  const status = Number(obj.status ?? obj.code ?? obj.error?.code ?? obj.response?.status ?? 0);
  if (status === 404) return true;
  const statusText = String(obj.status ?? obj.error?.status ?? '').toUpperCase();
  if (statusText === 'NOT_FOUND') return true;
  const msg = String(obj.message || err).toLowerCase();
  return msg.includes('404') || msg.includes('not_found') || msg.includes('no longer available');
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err) return false;
  const obj = err as {
    status?: number | string;
    code?: number | string;
    message?: string;
    error?: { code?: number | string; status?: string };
    response?: { status?: number | string };
  };
  const status = Number(obj.status ?? obj.code ?? obj.error?.code ?? obj.response?.status ?? 0);
  if (status === 429) return true;
  const statusText = String(obj.status ?? obj.error?.status ?? '').toUpperCase();
  if (statusText === 'RESOURCE_EXHAUSTED') return true;
  const msg = String(obj.message || err).toLowerCase();
  return msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota exceeded');
}

async function generateWithFallback(
  ai: GoogleGenAI,
  requestParams: Omit<GenerateContentParameters, 'model'>,
  options?: {
    primaryModel?: string;
    fallbackModel?: string;
  }
): Promise<GenerateContentResponse> {
  const primaryModel = options?.primaryModel || PRIMARY_GEMINI_MODEL;
  const fallbackModel = options?.fallbackModel || FALLBACK_GEMINI_MODEL;

  let lastError: unknown;

  // Fast 8s AbortSignal timeout on primary model -> instant failover to fallback lite model
  try {
    return await ai.models.generateContent({
      ...requestParams,
      model: primaryModel,
      config: {
        ...requestParams.config,
        abortSignal: AbortSignal.timeout(PRIMARY_TIMEOUT_MS),
      },
    });
  } catch (err) {
    lastError = err;
    const shouldFailover =
      isTimeoutOrAbortError(err) ||
      isHighDemandError(err) ||
      isModelNotFoundError(err) ||
      isQuotaExceededError(err);
    if (!shouldFailover) {
      throw err;
    }
    console.warn(
      `[ai-stock-import] Primární model ${primaryModel} selhal nebo překročil 8s timeout, okamžitě přepínám na ${fallbackModel}.`
    );
  }

  const fallbackDelays = [1500, 3000];
  for (let fbAttempt = 0; fbAttempt <= fallbackDelays.length; fbAttempt++) {
    try {
      return await ai.models.generateContent({
        ...requestParams,
        model: fallbackModel,
      });
    } catch (fallbackErr) {
      lastError = fallbackErr;
      if (isHighDemandError(fallbackErr) && fbAttempt < fallbackDelays.length) {
        const waitMs = fallbackDelays[fbAttempt];
        console.warn(
          `[ai-stock-import] Záložní model ${fallbackModel} vrátil 503/high demand (pokus ${fbAttempt + 1}/${fallbackDelays.length + 1}), opakuji za ${waitMs} ms…`
        );
        await sleep(waitMs);
        continue;
      }
      throw fallbackErr || lastError;
    }
  }

  throw lastError;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY není nakonfigurován na serveru.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function extractVsFromMessage(message: string): string {
  if (!message) return '';
  const vsMatch = message.match(/(?:VS|VAR\.?\s*SYM\.?|FA(?:KTURA)?)\s*[:#-]?\s*(\d{4,10})/i);
  if (vsMatch) return vsMatch[1];
  return '';
}

async function lookupAresServer(
  rawIco: string
): Promise<{ ok: true; status: number; data: AresSubjectPayload } | { ok: false; status: number; error: string }> {
  const cleaned = String(rawIco || '').replace(/\D/g, '');
  if (!cleaned || cleaned.length > 8) {
    return { ok: false, status: 400, error: 'Zadejte platné 8místné IČO.' };
  }
  const normalizedIco = cleaned.padStart(8, '0');
  const cached = aresCache.get(normalizedIco) as AresSubjectPayload | undefined;
  if (cached) {
    return { ok: true, status: 200, data: cached };
  }

  const existingFlight = inFlightAres.get(normalizedIco);
  if (existingFlight) return existingFlight;

  const task = (async () => {
    const url = `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${normalizedIco}`;
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SkladFaktura-Web/1.0',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        return {
          ok: false as const,
          status: 404,
          error: `Subjekt s IČO ${normalizedIco} nebyl v databázi ARES nalezen.`,
        };
      }
      if (!response.ok) {
        return {
          ok: false as const,
          status: response.status,
          error: `ARES vrátil chybu (${response.status}). Zkuste to prosím znovu.`,
        };
      }

      const json = (await response.json()) as Record<string, unknown>;
      const sidlo = (json.sidlo || {}) as Record<string, unknown>;
      const streetName = String(sidlo.nazevUlice || '').trim();
      const houseNum = Number(sidlo.cisloDomovni || 0);
      const orientNum = Number(sidlo.cisloOrientacni || 0);
      const orientLetter = String(sidlo.cisloOrientacniPismeno || '').trim();
      const partOfCity = String(sidlo.nazevCastiObce || '').trim();
      const city = String(sidlo.nazevObce || '').trim();
      const pscInt = Number(sidlo.psc || 0);
      const zip =
        pscInt > 0
          ? String(pscInt).padStart(5, '0')
          : String(sidlo.pscTxt || '').trim();

      let numberPart = '';
      if (houseNum > 0) numberPart += String(houseNum);
      if (orientNum > 0) {
        if (numberPart) numberPart += '/';
        numberPart += `${orientNum}${orientLetter}`;
      }
      const baseStreet = streetName || partOfCity || city;
      const formattedStreet =
        [baseStreet, numberPart].filter(Boolean).join(' ') ||
        String(sidlo.textovaAdresa || '')
          .split(',')[0]
          .trim();

      const data: AresSubjectPayload = {
        ico: String(json.ico || normalizedIco).trim(),
        dic: String(json.dic || '').trim(),
        name: String(json.obchodniJmeno || '').trim() || `Neznámý subjekt (${normalizedIco})`,
        street: formattedStreet,
        city,
        zip,
        legalForm: String(json.pravniForma || ''),
      };
      aresCache.set(normalizedIco, data, TTL_ARES_COMPANY_MS);
      return { ok: true as const, status: 200, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'chyba sítě';
      return {
        ok: false as const,
        status: 502,
        error: `Nepodařilo se spojit s databází ARES: ${message}`,
      };
    } finally {
      inFlightAres.delete(normalizedIco);
    }
  })();

  inFlightAres.set(normalizedIco, task);
  return task;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // =========================================================================
  // 1. Official Czech Ministry of Finance ARES REST API Proxy (7-day TTL cache)
  // =========================================================================
  app.get('/api/ares/:ico', async (req, res) => {
    const result = await lookupAresServer(String(req.params.ico || ''));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.json(result.data);
  });

  // =========================================================================
  // 2. Official Fio Banka REST API Proxy
  // =========================================================================
  app.post('/api/fio-sync', async (req, res) => {
    const token = String(req.body?.apiToken || '').trim();
    const daysBack = Math.min(365, Math.max(1, Number(req.body?.daysBack || 30)));
    if (token.length < 10) {
      res.status(400).json({ error: 'Zadejte platný API token z Fio Internetbankingu.' });
      return;
    }

    const now = new Date();
    const from = new Date(now.getTime() - daysBack * 86400000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`;
    const fromStr = fmt(from);
    const toStr = fmt(now);

    const url = `https://fioapi.fio.cz/v1/rest/periods/${encodeURIComponent(
      token
    )}/${fromStr}/${toStr}/transactions.json`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });

      if (response.status === 409) {
        res.status(409).json({
          error: 'Fio API limit: vyčkejte prosím 30 sekund mezi synchronizacemi.',
        });
        return;
      }
      if ([401, 403, 404].includes(response.status)) {
        res.status(response.status).json({
          error: `Neplatný nebo expirovaný Fio API token (HTTP ${response.status}).`,
        });
        return;
      }
      if (!response.ok) {
        res.status(response.status).json({
          error: `Fio banka vrátila chybu HTTP ${response.status}.`,
        });
        return;
      }

      const root = (await response.json()) as {
        accountStatement?: {
          transactionList?: {
            transaction?: Array<Record<string, { value?: string | number | null } | null>>;
          };
        };
      };

      const txList = root.accountStatement?.transactionList?.transaction || [];
      const transactions = txList.map((tx, i) => {
        const strCol = (k: string) => String(tx[k]?.value ?? '').trim();
        const numCol = (k: string) => Number(tx[k]?.value ?? 0);

        const extId = strCol('column22') || `FIO-${i}-${Date.now()}`;
        const rawDate = strCol('column0').slice(0, 10) || toStr;
        const amount = round2(numCol('column1'));
        const currency = (strCol('column14') || 'CZK').slice(0, 10);
        const rawVs = strCol('column5').replace(/\D/g, '');
        const counterAcc = strCol('column2');
        const counterBank = strCol('column3');
        const fullAcc = counterAcc && counterBank ? `${counterAcc}/${counterBank}` : counterAcc;
        const counterName = strCol('column10') || strCol('column7');
        const message = strCol('column16') || strCol('column25');

        return {
          externalId: extId.slice(0, 100),
          date: rawDate,
          amount,
          currency,
          variableSymbol: (rawVs || extractVsFromMessage(message)).slice(0, 30),
          counterpartyName: counterName.slice(0, 200),
          counterpartyAccount: fullAcc.slice(0, 60),
          message: message.slice(0, 300),
          source: 'FIO_API' as const,
        };
      });

      res.json({ transactions });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'síťová chyba';
      res.status(502).json({ error: `Chyba spojení s Fio bankou: ${msg}` });
    }
  });

  // =========================================================================
  // 2b. ČNB Daily Exchange Rates Proxy (24-hour TTL cache)
  // =========================================================================
  const FALLBACK_CNB_RATES: Record<string, number> = {
    CZK: 1,
    EUR: 25.2,
    USD: 23.5,
    PLN: 5.9,
    GBP: 29.8,
    CHF: 26.8,
    HUF: 0.062,
    SEK: 2.2,
    DKK: 3.38,
    NOK: 2.15,
    CAD: 16.8,
    JPY: 0.155,
  };

  async function fetchCnbRatesServer(): Promise<CnbRatesPayload> {
    const cached = cnbCache.get('daily') as CnbRatesPayload | undefined;
    if (cached) return cached;
    if (inFlightCnb) return inFlightCnb;

    inFlightCnb = (async (): Promise<CnbRatesPayload> => {
      try {
        const response = await fetch(
          'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt',
          {
            headers: { 'User-Agent': 'SkladFaktura-Web/1.0' },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const dateMatch = (lines[0] || '').match(/(\d{2}\.\d{2}\.\d{4})/);
        const date = dateMatch ? dateMatch[1] : '';
        const rates: Record<string, number> = { CZK: 1 };
        for (let i = 2; i < lines.length; i++) {
          const parts = lines[i].split('|');
          if (parts.length < 5) continue;
          const amount = Number(parts[2].replace(',', '.'));
          const code = parts[3].trim().toUpperCase();
          const rateVal = Number(parts[4].replace(',', '.'));
          if (code && amount > 0 && rateVal > 0) {
            rates[code] = Math.round((rateVal / amount) * 10000) / 10000;
          }
        }
        if (Object.keys(rates).length > 3) {
          const payload: CnbRatesPayload = { date, rates, source: 'CNB' };
          cnbCache.set('daily', payload, TTL_CNB_RATES_MS);
          return payload;
        }
        throw new Error('Neplatná odpověď ČNB');
      } catch {
        return { date: '', rates: { ...FALLBACK_CNB_RATES }, source: 'FALLBACK' };
      } finally {
        inFlightCnb = null;
      }
    })();

    return inFlightCnb;
  }

  function normalizeCurrencyCode(raw: unknown): string {
    const c = String(raw || 'CZK')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    if (!c || c === 'KC' || c === 'CZ') return 'CZK';
    if (c === 'EURO' || c === 'E') return 'EUR';
    return c.slice(0, 3) || 'CZK';
  }

  function normalizeStockInUnit(rawUnit: unknown): string {
    const trimmed = String(rawUnit || '').trim();
    const clean = trimmed.toLowerCase().replace(/[.,;:()]/g, '');
    if (!clean) return 'ks';
    if (
      clean === 'ml' ||
      clean === 'mlt' ||
      clean === 'cl' ||
      clean === 'dl' ||
      clean === 'mililitr' ||
      clean === 'mililitru' ||
      clean === 'mililitrů' ||
      clean === 'mililitry'
    ) {
      return 'ks';
    }
    if (
      clean === 'ks' ||
      clean === 'kus' ||
      clean === 'kusy' ||
      clean === 'kusu' ||
      clean === 'kusů' ||
      clean === 'pcs' ||
      clean === 'pc' ||
      clean === 'ea' ||
      clean === 'st' ||
      clean === 'stk' ||
      clean === 'unit' ||
      clean === 'units' ||
      clean === 'pce' ||
      clean === 'h87'
    ) {
      return 'ks';
    }
    if (clean === 'balení' || clean === 'baleni' || clean === 'pack' || clean === 'pkt') return 'bal';
    if (clean === 'karton') return 'kart';
    if (clean === 'krabice') return 'krab';
    if (clean === 'paleta') return 'pal';
    return trimmed.slice(0, 20);
  }

  app.get('/api/cnb-rates', async (_req, res) => {
    const data = await fetchCnbRatesServer();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.json(data);
  });

  // =========================================================================
  // 3. AI Smart Stock-In (Free-tier Gemini + Parallel ARES & CNB via Promise.all)
  // =========================================================================
  app.post('/api/ai-stock-import', async (req, res) => {
    try {
      const ai = getGeminiClient();
      const rawText = String(req.body?.rawText || '').trim();
      const base64Data = String(req.body?.base64Data || '').trim();
      const mimeType = String(req.body?.mimeType || '').trim();
      const fileName = String(req.body?.fileName || 'doklad').trim();
      const candidateIco = extractCandidateSupplierIco(rawText, req.body?.supplierIco);

      if (!rawText && (!base64Data || !mimeType)) {
        res.status(400).json({ error: 'Nahrajte soubor (foto/PDF) nebo vložte text dokladu.' });
        return;
      }

      const systemInstruction =
        'Jsi přesný český účetní a skladový extraktor pro aplikaci SkladFaktura. ' +
        'Z dodacího listu, nákupní faktury nebo ceníku vyextrahuj hlavičku dodavatele, měnu dokladu a všechny zbožové položky k naskladnění. ' +
        'DŮLEŽITÉ PRO MĚRNOU JEDNOTKU (unit) A MNOŽSTVÍ (quantity): ' +
        'Zboží v lahvičkách, kapslích, cartridgích, podech, e-liquidech, aromatech, příchutích či jiných baleních (např. „10ml“, „20ml“, „2ml“, „60ml“, „10 ml“) se VŽDY naskladňuje po kusech ("ks") — NIKDY jako "ml"! ' +
        'Údaj v ml (např. 10ml, 20 ml) nebo mg v názvu produktu či ve sloupci objemu/spotřební daně je pouze objem/síla jednoho kusu (ponech jej v názvu produktu), nikoli měrná jednotka ani počet kusů. ' +
        'Do pole quantity uveď skutečný počet kusů/lahviček/balení ze sloupce množství (nikdy ne objem v ml) a do pole unit nastav "ks" (případně "bal", "kart", "sada" jen pokud je to výslovná jednotka počtu balení). ' +
        'DŮLEŽITÉ – CO NEEXTRAHOVAT NA SKLAD: NIKDY neextrahuj jako položku recyklační poplatek / recyklační příspěvek (PHE, příspěvek na historická elektrozařízení, zpětný odběr elektrozařízení nebo baterií, elektroodpad, EKO poplatek, ASEKOL, REMA, ELEKTROWIN, ECOBAT, RETELA, recycling/WEEE fee) — recyklační poplatek se na sklad nepřidává! ' +
        'DŮLEŽITÉ PRO MĚNU: Pole currency uveď jako 3písmenný ISO kód měny z dokladu (např. CZK, EUR, USD, PLN, GBP). ' +
        'Pole unitPurchasePrice uveď jako jednotkovou cenu bez DPH za 1 kus (MJ) v PŮVODNÍ MĚNĚ DOKLADU — sám ji nepřepočítávej odhadem na CZK (přepočet proběhne přesným kurzem ČNB na serveru). ' +
        'Pokud je na faktuře jen cena s DPH, přepočítej ji bez DPH ve stejné měně. ' +
        'Pokud je na dokladu výslovně vytištěn směnný kurz vůči CZK (např. 1 EUR = 25,20 Kč), uveď ho v documentExchangeRate, jinak 0. ' +
        'Sazba DPH musí být 0, 12 nebo 21 (u zahraničních faktur s reverse charge / bez DPH uveď 0 nebo 21 dle povahy zboží). Odpovídej striktně dle JSON schématu.';

      const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];
      if (base64Data && mimeType) {
        parts.push({ inlineData: { data: base64Data, mimeType } });
        parts.push({
          text: `Vyextrahuj všechny skladové položky a měnu ze souboru '${fileName}' do strukturovaného JSON.`,
        });
      } else {
        parts.push({
          text: `Text dokladu k hromadnému naskladnění:\n\n${rawText}`,
        });
      }

      // Run Gemini parsing, 24h-cached CNB rates, and 7d-cached ARES validation concurrently (zero waterfall)
      const [response, cnbData, preAresResult] = await Promise.all([
        generateWithFallback(ai, {
          contents: { parts },
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                supplierName: { type: Type.STRING },
                supplierIco: { type: Type.STRING },
                documentNumber: { type: Type.STRING },
                documentType: { type: Type.STRING },
                currency: { type: Type.STRING },
                documentExchangeRate: { type: Type.NUMBER },
                items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      sku: { type: Type.STRING },
                      name: { type: Type.STRING },
                      ean: { type: Type.STRING },
                      quantity: { type: Type.NUMBER },
                      unit: { type: Type.STRING },
                      unitPurchasePrice: { type: Type.NUMBER },
                      vatRate: { type: Type.INTEGER },
                    },
                    required: ['name', 'quantity'],
                  },
                },
              },
              required: ['items'],
            },
          },
        }),
        fetchCnbRatesServer(),
        candidateIco ? lookupAresServer(candidateIco).catch(() => null) : Promise.resolve(null),
      ]);

      const parsed = JSON.parse((response.text || '{}').trim()) as {
        supplierName?: string;
        supplierIco?: string;
        documentNumber?: string;
        documentType?: string;
        currency?: string;
        documentExchangeRate?: number;
        items?: Array<{
          sku?: string;
          name?: string;
          ean?: string;
          quantity?: number;
          unit?: string;
          unitPurchasePrice?: number;
          vatRate?: number;
        }>;
      };

      const currency = normalizeCurrencyCode(parsed.currency);
      const docRate = Number(parsed.documentExchangeRate || 0);
      const parsedIco = String(parsed.supplierIco || '').replace(/\D/g, '');

      let aresCompany: AresSubjectPayload | null = null;
      if (preAresResult?.ok && (!parsedIco || parsedIco.padStart(8, '0') === candidateIco)) {
        aresCompany = preAresResult.data;
      } else if (parsedIco.length === 8) {
        const aresRes = await lookupAresServer(parsedIco).catch(() => null);
        if (aresRes?.ok) aresCompany = aresRes.data;
      }

      let exchangeRate = 1;
      let exchangeRateSource: 'CZK' | 'CNB' | 'DOKLAD' | 'MANUAL' = 'CZK';
      let exchangeRateDate = '';
      let cnbRate = 1;

      if (currency !== 'CZK') {
        const rateFromCnb = Number(cnbData.rates[currency] || 0);
        cnbRate = rateFromCnb > 0 ? Math.round(rateFromCnb * 10000) / 10000 : 1;
        exchangeRateDate = cnbData.date || '';

        if (docRate > 0 && docRate < 10000) {
          exchangeRate = Math.round(docRate * 10000) / 10000;
          exchangeRateSource = 'DOKLAD';
        } else if (rateFromCnb > 0) {
          exchangeRate = Math.round(rateFromCnb * 10000) / 10000;
          exchangeRateSource = cnbData.source === 'CNB' ? 'CNB' : 'MANUAL';
        } else {
          exchangeRate = 1;
          exchangeRateSource = 'MANUAL';
        }
      }

      const items = (parsed.items || [])
        .filter(
          (it) =>
            String(it.name || '').trim().length > 0 &&
            !isNonStockRecyclingFee(it.name, it.sku)
        )
        .map((it, idx) => {
          const originalPurchasePrice = Math.max(0, round2(Number(it.unitPurchasePrice || 0)));
          const purchasePrice =
            currency === 'CZK'
              ? originalPurchasePrice
              : Math.max(0, round2(originalPurchasePrice * exchangeRate));
          const vatRaw = Number(it.vatRate ?? 21);
          const vatRate = vatRaw === 0 || vatRaw === 12 || vatRaw === 21 ? vatRaw : 21;
          const quantity = Math.max(0.01, round2(Number(it.quantity || 1)));
          return {
            id: `ai_${Date.now()}_${idx}`,
            sku: (String(it.sku || '').trim() || `AI-${String(idx + 1).padStart(3, '0')}`).slice(0, 64),
            name: String(it.name || '').trim().slice(0, 200),
            ean: String(it.ean || '').trim().slice(0, 40),
            quantity,
            unit: normalizeStockInUnit(it.unit),
            originalPurchasePrice,
            purchasePrice,
            suggestedSalePrice: purchasePrice > 0 ? round2(purchasePrice * 1.25) : 0,
            vatRate,
            selected: true,
          };
        });

      res.json({
        supplierName: String(parsed.supplierName || '').trim() || aresCompany?.name || '',
        supplierIco: parsedIco || aresCompany?.ico || '',
        supplierAresValidated: Boolean(aresCompany),
        documentNumber: String(parsed.documentNumber || '').trim(),
        documentType: String(parsed.documentType || 'Dodací list').trim() || 'Dodací list',
        currency,
        exchangeRate,
        exchangeRateSource,
        exchangeRateDate,
        cnbRate,
        items,
      });
    } catch (err) {
      if (isQuotaExceededError(err)) {
        res.status(429).json({
          error:
            'Denní bezplatný limit požadavků Gemini API (Free Tier) byl vyčerpán pro oba modely. Pro vyšší limity aktivuj placený tarif (Billing) u svého Gemini API klíče v Google AI Studio, případně počkej na denní obnovení kvóty.',
        });
        return;
      }
      if (isHighDemandError(err) || isTimeoutOrAbortError(err)) {
        res.status(503).json({
          error:
            'Servery Google Gemini jsou momentálně dočasně přetížené (chyba 503 – high demand) i po přepnutí na záložní model. Klikni prosím na „Zkusit znovu“ za 15–30 sekund.',
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'neznámá chyba';
      res.status(500).json({ error: `AI zpracování dokladu selhalo: ${message}` });
    }
  });

  // =========================================================================
  // 4. Live Product Categorization via Nerx.cz (30d TTL cache + Promise.allSettled concurrency 5)
  // =========================================================================
  app.post('/api/nerx-categorize', async (req, res) => {
    try {
      const mod = await import('./api/nerx-categorize.js');
      await mod.default(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'neznámá chyba';
      res.status(500).json({ error: `Kategorizace přes Nerx.cz selhala: ${message}` });
    }
  });

  // =========================================================================
  // 5. Nerx B2B Webhook API (Orders, Invoices, Payments, Cancellations & Stock Movements)
  // =========================================================================
  app.all('/api/b2b-webhook', async (req, res) => {
    try {
      const mod = await import('./server-lib/b2bWebhook.js');
      await mod.handleB2bWebhookRequest(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'neznámá chyba';
      res.status(500).json({ error: `B2B webhook selhal: ${message}` });
    }
  });

  // =========================================================================
  // Static / Vite Dev Middleware
  // =========================================================================
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SkladFaktura Web server běží na http://0.0.0.0:${PORT}`);
  });
}

startServer();
