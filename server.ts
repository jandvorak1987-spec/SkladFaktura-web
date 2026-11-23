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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const PRIMARY_GEMINI_MODEL = 'gemini-4-hydrogen';
const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    maxRetries?: number;
    retryDelayMs?: number;
  }
): Promise<GenerateContentResponse> {
  const primaryModel = options?.primaryModel || PRIMARY_GEMINI_MODEL;
  const fallbackModel = options?.fallbackModel || FALLBACK_GEMINI_MODEL;
  const maxRetries = options?.maxRetries ?? 2;
  const retryDelayMs = options?.retryDelayMs ?? 2000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent({
        ...requestParams,
        model: primaryModel,
      });
    } catch (err) {
      lastError = err;
      if (isModelNotFoundError(err) || isQuotaExceededError(err)) {
        break;
      }
      if (!isHighDemandError(err)) {
        throw err;
      }
      if (attempt < maxRetries) {
        console.warn(
          `[ai-stock-import] Model ${primaryModel} vrátil 503/high demand (pokus ${attempt + 1}/${maxRetries + 1}), opakuji za ${retryDelayMs} ms…`
        );
        await sleep(retryDelayMs);
      }
    }
  }

  console.warn(
    `[ai-stock-import] Model ${primaryModel} není dostupný (503/429/404), přepínám na ${fallbackModel}.`
  );
  const fallbackDelays = [2000, 4000, 6000];
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

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  // =========================================================================
  // 1. Official Czech Ministry of Finance ARES REST API Proxy
  // =========================================================================
  app.get('/api/ares/:ico', async (req, res) => {
    const cleaned = String(req.params.ico || '').replace(/\D/g, '');
    if (!cleaned || cleaned.length > 8) {
      res.status(400).json({ error: 'Zadejte platné 8místné IČO.' });
      return;
    }
    const normalizedIco = cleaned.padStart(8, '0');
    const url = `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${normalizedIco}`;

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SkladFaktura-Web/1.0',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 404) {
        res.status(404).json({
          error: `Subjekt s IČO ${normalizedIco} nebyl v databázi ARES nalezen.`,
        });
        return;
      }
      if (!response.ok) {
        res.status(response.status).json({
          error: `ARES vrátil chybu (${response.status}). Zkuste to prosím znovu.`,
        });
        return;
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

      res.json({
        ico: String(json.ico || normalizedIco).trim(),
        dic: String(json.dic || '').trim(),
        name: String(json.obchodniJmeno || '').trim() || `Neznámý subjekt (${normalizedIco})`,
        street: formattedStreet,
        city,
        zip,
        legalForm: String(json.pravniForma || ''),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'chyba sítě';
      res.status(502).json({
        error: `Nepodařilo se spojit s databází ARES: ${message}`,
      });
    }
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
  // 3. Server-Side Gemini AI Smart Stock-In (Delivery Note / Invoice Extraction)
  // =========================================================================
  // 2b. ČNB Daily Exchange Rates Proxy
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
  let cachedCnb: { date: string; rates: Record<string, number>; source: 'CNB' | 'FALLBACK' } | null = null;
  let cachedCnbAt = 0;

  async function fetchCnbRatesServer(): Promise<{
    date: string;
    rates: Record<string, number>;
    source: 'CNB' | 'FALLBACK';
  }> {
    const now = Date.now();
    if (cachedCnb && now - cachedCnbAt < 3600_000) {
      return cachedCnb;
    }
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
        cachedCnb = { date, rates, source: 'CNB' };
        cachedCnbAt = now;
        return cachedCnb;
      }
      throw new Error('Neplatná odpověď ČNB');
    } catch {
      return { date: '', rates: { ...FALLBACK_CNB_RATES }, source: 'FALLBACK' };
    }
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

  app.get('/api/cnb-rates', async (_req, res) => {
    const data = await fetchCnbRatesServer();
    res.json(data);
  });

  // =========================================================================
  // 3. AI Smart Stock-In (Delivery Note / Invoice OCR & Extraction via Gemini)
  // =========================================================================
  app.post('/api/ai-stock-import', async (req, res) => {
    try {
      const ai = getGeminiClient();
      const rawText = String(req.body?.rawText || '').trim();
      const base64Data = String(req.body?.base64Data || '').trim();
      const mimeType = String(req.body?.mimeType || '').trim();
      const fileName = String(req.body?.fileName || 'doklad').trim();

      if (!rawText && (!base64Data || !mimeType)) {
        res.status(400).json({ error: 'Nahrajte soubor (foto/PDF) nebo vložte text dokladu.' });
        return;
      }

      const systemInstruction =
        'Jsi přesný český účetní a skladový extraktor pro aplikaci SkladFaktura. ' +
        'Z dodacího listu, nákupní faktury nebo ceníku vyextrahuj hlavičku dodavatele, měnu dokladu a všechny zbožové položky k naskladnění. ' +
        'DŮLEŽITÉ PRO MĚNU: Pole currency uveď jako 3písmenný ISO kód měny z dokladu (např. CZK, EUR, USD, PLN, GBP). ' +
        'Pole unitPurchasePrice uveď jako jednotkovou cenu bez DPH v PŮVODNÍ MĚNĚ DOKLADU — sám ji nepřepočítávej odhadem na CZK (přepočet proběhne přesným kurzem ČNB na serveru). ' +
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

      const response = await generateWithFallback(ai, {
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
      });

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
      let exchangeRate = 1;
      let exchangeRateSource: 'CZK' | 'CNB' | 'DOKLAD' | 'MANUAL' = 'CZK';
      let exchangeRateDate = '';
      let cnbRate = 1;

      if (currency !== 'CZK') {
        const cnbData = await fetchCnbRatesServer();
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
        .filter((it) => String(it.name || '').trim().length > 0)
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
            unit: (String(it.unit || '').trim() || 'ks').slice(0, 20),
            originalPurchasePrice,
            purchasePrice,
            suggestedSalePrice: purchasePrice > 0 ? round2(purchasePrice * 1.25) : 0,
            vatRate,
            selected: true,
          };
        });

      res.json({
        supplierName: String(parsed.supplierName || '').trim(),
        supplierIco: String(parsed.supplierIco || '').replace(/\D/g, ''),
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
      if (isHighDemandError(err)) {
        res.status(503).json({
          error:
            'Servery Google Gemini jsou momentálně dočasně přetížené (chyba 503 – high demand) i po automatických opakováních a přepnutí na záložní model. Klikni prosím na „Zkusit znovu“ za 15–30 sekund.',
        });
        return;
      }
      const message = err instanceof Error ? err.message : 'neznámá chyba';
      res.status(500).json({ error: `AI zpracování dokladu selhalo: ${message}` });
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
