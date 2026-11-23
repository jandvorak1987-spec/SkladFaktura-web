import { GoogleGenAI, Type } from '@google/genai';
import { fetchCnbRates } from './cnb-rates.js';

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

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const FALLBACK_MODEL = 'gemini-2.5-flash';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function generateWithFallback(
  ai,
  requestParams,
  {
    primaryModel = PRIMARY_MODEL,
    fallbackModel = FALLBACK_MODEL,
    maxRetries = 2,
    retryDelayMs = 2000,
  } = {}
) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent({
        ...requestParams,
        model: primaryModel,
      });
    } catch (err) {
      lastError = err;
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
    `[ai-stock-import] Model ${primaryModel} selhal i po ${maxRetries} opakováních (503/high demand), přepínám na ${fallbackModel}.`
  );
  try {
    return await ai.models.generateContent({
      ...requestParams,
      model: fallbackModel,
    });
  } catch (fallbackErr) {
    throw fallbackErr || lastError;
  }
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

    const parsed = JSON.parse((response.text || '{}').trim());
    const currency = normalizeCurrency(parsed.currency);
    const docRate = Number(parsed.documentExchangeRate || 0);

    let exchangeRate = 1;
    let exchangeRateSource = 'CZK';
    let exchangeRateDate = '';
    let cnbRate = 1;

    if (currency !== 'CZK') {
      const cnbData = await fetchCnbRates();
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
          unit: (String(it.unit || '').trim() || 'ks').slice(0, 20),
          originalPurchasePrice,
          purchasePrice,
          suggestedSalePrice: purchasePrice > 0 ? round2(purchasePrice * 1.25) : 0,
          vatRate,
          selected: true,
        };
      });

    res.status(200).json({
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
    const message = err instanceof Error ? err.message : 'neznámá chyba';
    res.status(500).json({ error: `AI zpracování dokladu selhalo: ${message}` });
  }
}
