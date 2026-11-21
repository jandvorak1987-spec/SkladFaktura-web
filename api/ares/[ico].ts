interface VercelRequest {
  method?: string;
  url?: string;
  query?: Record<string, string | string[] | undefined>;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'Metoda není povolena.' });
    return;
  }

  const rawQueryIco = req.query?.ico;
  let icoParam = Array.isArray(rawQueryIco) ? rawQueryIco[0] : rawQueryIco || '';
  if (!icoParam && req.url) {
    const cleanPath = req.url.split('?')[0];
    icoParam = cleanPath.split('/').pop() || '';
  }

  const cleaned = String(icoParam).replace(/\D/g, '');
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

    res.status(200).json({
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
}
