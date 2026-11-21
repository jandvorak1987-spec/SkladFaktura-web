import { GoogleGenAI, Type } from '@google/genai';

interface VercelRequest {
  method?: string;
  body?: unknown;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseBody(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metoda není povolena.' });
    return;
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({
        error: 'GEMINI_API_KEY není nastaven v proměnných prostředí na Vercelu (Settings → Environment Variables).',
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
