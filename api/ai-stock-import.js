import { GoogleGenAI, Type } from '@google/genai';
import { fetchCnbRates } from './cnb-rates.js';
import { lookupAresCompany } from './ares/[ico].js';
import { extractCandidateSupplierIco } from '../server-lib/ttlCache.js';

// Strictly free-tier Gemini models only (zero paid models, no Google Search grounding)
const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-3.1-flash-lite';
const PRIMARY_TIMEOUT_MS = 8000;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function parseBody(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function normalizeCurrency(raw) {
  const c = String(raw || 'CZK')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (!c || c === 'KC' || c === 'CZ') return 'CZK';
  if (c === 'EURO' || c === 'E') return 'EUR';
  return c.slice(0, 3) || 'CZK';
}

function normalizeStockInUnit(rawUnit) {
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

function findGeminiApiKey() {
  const exactCandidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.VITE_GEMINI_API_KEY,
    process.env.GEMINI_KEY,
    process.env.API_KEY,
  ];
  for (const val of exactCandidates) {
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }

  const acceptedNormalized = new Set([
    'GEMINIAPIKEY',
    'GEMINIKEY',
    'GOOGLEGENERATIVEAIAPIKEY',
    'GOOGLEAIAPIKEY',
    'GOOGLEAPIKEY',
    'VITEGEMINIAPIKEY',
    'APIKEY',
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const norm = k.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (acceptedNormalized.has(norm) || (norm.includes('GEMINI') && !norm.includes('FIREBASE'))) {
      return v.trim();
    }
  }
  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutOrAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '').toLowerCase();
  const msg = String(err.message || err).toLowerCase();
  return (
    name === 'timeouterror' ||
    name === 'aborterror' ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

function isHighDemandError(err) {
  if (!err) return false;
  const status = Number(err.status ?? err.code ?? err.error?.code ?? err.response?.status ?? 0);
  if (status === 503) return true;
  const statusText = String(err.status ?? err.error?.status ?? '').toUpperCase();
  if (statusText === 'UNAVAILABLE') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('503') || msg.includes('high demand') || msg.includes('unavailable');
}

function isModelNotFoundError(err) {
  if (!err) return false;
  const status = Number(err.status ?? err.code ?? err.error?.code ?? err.response?.status ?? 0);
  if (status === 404) return true;
  const statusText = String(err.status ?? err.error?.status ?? '').toUpperCase();
  if (statusText === 'NOT_FOUND') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('404') || msg.includes('not_found') || msg.includes('no longer available');
}

function isQuotaExceededError(err) {
  if (!err) return false;
  const status = Number(err.status ?? err.code ?? err.error?.code ?? err.response?.status ?? 0);
  if (status === 429) return true;
  const statusText = String(err.status ?? err.error?.status ?? '').toUpperCase();
  if (statusText === 'RESOURCE_EXHAUSTED') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota exceeded');
}

async function generateWithFallback(
  ai,
  requestParams,
  { primaryModel = PRIMARY_MODEL, fallbackModel = FALLBACK_MODEL } = {}
) {
  let lastError;

  // Fast-fail primary call with 8s AbortSignal timeout -> immediate failover to lite model
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
      `[ai-stock-import] Primary ${primaryModel} failed/timed out (${err?.name || err?.status || 'error'}), failing over immediately to ${fallbackModel}.`
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
          `[ai-stock-import] Fallback ${fallbackModel} 503/high demand (attempt ${fbAttempt + 1}), retrying in ${waitMs} ms…`
        );
        await sleep(waitMs);
        continue;
      }
      throw fallbackErr || lastError;
    }
  }

  throw lastError;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metoda není povolena.' });
    return;
  }

  try {
    const apiKey = findGeminiApiKey();
    if (!apiKey) {
      const envName = process.env.VERCEL_ENV || process.env.NODE_ENV || 'production';
      const swappedKeyValue = Object.keys(process.env).some((k) => k.trim().startsWith('AIza'));
      if (swappedKeyValue) {
        res.status(500).json({
          error:
            'Na Vercelu máš pravděpodobně prohozený Key a Value: do pole Key napiš GEMINI_API_KEY a samotný klíč (AIza...) vlož do pole Value. Poté dej Save a Deployments → Redeploy.',
        });
        return;
      }

      const candidateNames = Object.keys(process.env).filter(
        (k) =>
          /gemini|google|api|key/i.test(k) &&
          !k.startsWith('VERCEL_') &&
          !k.startsWith('AWS_') &&
          !k.startsWith('NODE_') &&
          !k.startsWith('NPM_') &&
          !k.trim().startsWith('AIza')
      );
      const diag =
        candidateNames.length > 0
          ? ` (Nalezené podobné názvy proměnných: ${candidateNames.join(', ')})`
          : ' (Na serveru zatím není uložena žádná proměnná s GEMINI / API_KEY.)';

      res.status(500).json({
        error: `GEMINI_API_KEY není nastaven v prostředí "${envName}" na Vercelu.${diag} Přidej jej v projektu SkladFaktura-web → Settings → Environment Variables (zaškrtnout Production i Preview → Save) a poté udělej Deployments → Redeploy.`,
      });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const body = parseBody(req.body);
    const rawText = String(body.rawText || '').trim();
    const base64Data = String(body.base64Data || '').trim();
    const mimeType = String(body.mimeType || '').trim();
    const fileName = String(body.fileName || 'doklad').trim();
    const candidateIco = extractCandidateSupplierIco(rawText, body.supplierIco);

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
      'DŮLEŽITÉ PRO MĚNU: Pole currency uveď jako 3písmenný ISO kód měny z dokladu (např. CZK, EUR, USD, PLN, GBP). ' +
      'Pole unitPurchasePrice uveď jako jednotkovou cenu bez DPH za 1 kus (MJ) v PŮVODNÍ MĚNĚ DOKLADU — sám ji nepřepočítávej odhadem na CZK (přepočet proběhne přesným kurzem ČNB na serveru). ' +
      'Pokud je na faktuře jen cena s DPH, přepočítej ji bez DPH ve stejné měně. ' +
      'Pokud je na dokladu výslovně vytištěn směnný kurz vůči CZK (např. 1 EUR = 25,20 Kč), uveď ho v documentExchangeRate, jinak 0. ' +
      'Sazba DPH musí být 0, 12 nebo 21 (u zahraničních faktur s reverse charge / bez DPH uveď 0 nebo 21 dle povahy zboží). Odpovídej striktně dle JSON schématu.';

    const parts = [];
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

    // Eliminate waterfall: parse document with Gemini, warm 24h CNB rates, and validate candidate ICO via 7d ARES in parallel
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
      fetchCnbRates(),
      candidateIco ? lookupAresCompany(candidateIco).catch(() => null) : Promise.resolve(null),
    ]);

    const parsed = JSON.parse((response.text || '{}').trim());
    const currency = normalizeCurrency(parsed.currency);
    const docRate = Number(parsed.documentExchangeRate || 0);
    const parsedIco = String(parsed.supplierIco || '').replace(/\D/g, '');

    // Use already-fetched ARES result when ICO matches, otherwise validate extracted 8-digit ICO (7d cached)
    let aresCompany = null;
    if (preAresResult?.ok && (!parsedIco || parsedIco.padStart(8, '0') === candidateIco)) {
      aresCompany = preAresResult.data;
    } else if (parsedIco.length === 8) {
      const aresRes = await lookupAresCompany(parsedIco).catch(() => null);
      if (aresRes?.ok) aresCompany = aresRes.data;
    }

    let exchangeRate = 1;
    let exchangeRateSource = 'CZK';
    let exchangeRateDate = '';
    let cnbRate = 1;

    if (currency !== 'CZK') {
      const rateFromCnb = Number(cnbData.rates?.[currency] || 0);
      cnbRate = rateFromCnb > 0 ? round4(rateFromCnb) : 1;
      exchangeRateDate = cnbData.date || '';

      if (docRate > 0 && docRate < 10000) {
        exchangeRate = round4(docRate);
        exchangeRateSource = 'DOKLAD';
      } else if (rateFromCnb > 0) {
        exchangeRate = round4(rateFromCnb);
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
          unit: normalizeStockInUnit(it.unit),
          originalPurchasePrice,
          purchasePrice,
          suggestedSalePrice: purchasePrice > 0 ? round2(purchasePrice * 1.25) : 0,
          vatRate,
          selected: true,
        };
      });

    const resolvedSupplierName =
      String(parsed.supplierName || '').trim() || aresCompany?.name || '';
    const resolvedSupplierIco = parsedIco || aresCompany?.ico || '';

    res.status(200).json({
      supplierName: resolvedSupplierName,
      supplierIco: resolvedSupplierIco,
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
}
