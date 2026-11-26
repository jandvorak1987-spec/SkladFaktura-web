import { TTL_ARES_COMPANY_MS, TtlCache } from '../../server-lib/ttlCache.js';

const aresCache = new TtlCache({ defaultTtlMs: TTL_ARES_COMPANY_MS, maxEntries: 2000 });
const inFlightAres = new Map();

export async function lookupAresCompany(rawIco) {
  const cleaned = String(rawIco || '').replace(/\D/g, '');
  if (!cleaned || cleaned.length > 8) {
    return { ok: false, status: 400, error: 'Zadejte platné 8místné IČO.' };
  }

  const normalizedIco = cleaned.padStart(8, '0');
  const cached = aresCache.get(normalizedIco);
  if (cached) {
    return { ok: true, status: 200, data: cached, cached: true };
  }

  if (inFlightAres.has(normalizedIco)) {
    return inFlightAres.get(normalizedIco);
  }

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
          ok: false,
          status: 404,
          error: `Subjekt s IČO ${normalizedIco} nebyl v databázi ARES nalezen.`,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: `ARES vrátil chybu (${response.status}). Zkuste to prosím znovu.`,
        };
      }

      const json = await response.json();
      const sidlo = json?.sidlo || {};
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

      const data = {
        ico: String(json?.ico || normalizedIco).trim(),
        dic: String(json?.dic || '').trim(),
        name: String(json?.obchodniJmeno || '').trim() || `Neznámý subjekt (${normalizedIco})`,
        street: formattedStreet,
        city,
        zip,
        legalForm: String(json?.pravniForma || ''),
      };

      aresCache.set(normalizedIco, data, TTL_ARES_COMPANY_MS);
      return { ok: true, status: 200, data, cached: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'chyba sítě';
      return {
        ok: false,
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

export default async function handler(req, res) {
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

  const result = await lookupAresCompany(icoParam);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.setHeader?.('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=86400');
  res.status(200).json(result.data);
}
