import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

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
        'Z dodacího listu, nákupní faktury nebo ceníku vyextrahuj hlavičku dodavatele a všechny zbožové položky k naskladnění. ' +
        'Nákupní cenu uveď jako jednotkovou cenu bez DPH v CZK (pokud je na dokladu jen cena s DPH, přepočítej ji bez DPH). ' +
        'Sazba DPH musí být 0, 12 nebo 21. Odpovídej striktně dle JSON schématu.';

      const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [];
      if (base64Data && mimeType) {
        parts.push({ inlineData: { data: base64Data, mimeType } });
        parts.push({
          text: `Vyextrahuj všechny skladové položky ze souboru '${fileName}' do strukturovaného JSON.`,
        });
      } else {
        parts.push({
          text: `Text dokladu k hromadnému naskladnění:\n\n${rawText}`,
        });
      }

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
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

      const items = (parsed.items || [])
        .filter((it) => String(it.name || '').trim().length > 0)
        .map((it, idx) => {
          const purchasePrice = Math.max(0, round2(Number(it.unitPurchasePrice || 0)));
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
        items,
      });
    } catch (err) {
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
