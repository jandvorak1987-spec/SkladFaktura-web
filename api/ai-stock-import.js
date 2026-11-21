import { GoogleGenAI, Type } from '@google/genai';

function round2(n) {
  return Math.round(n * 100) / 100;
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

  // Case-insensitive & typo-tolerant lookup (Linux env var names are case-sensitive)
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
      'Z dodacího listu, nákupní faktury nebo ceníku vyextrahuj hlavičku dodavatele a všechny zbožové položky k naskladnění. ' +
      'Nákupní cenu uveď jako jednotkovou cenu bez DPH v CZK (pokud je na dokladu jen cena s DPH, přepočítej ji bez DPH). ' +
      'Sazba DPH musí být 0, 12 nebo 21. Odpovídej striktně dle JSON schématu.';

    const parts = [];
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

    const parsed = JSON.parse((response.text || '{}').trim());

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

    res.status(200).json({
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
}
