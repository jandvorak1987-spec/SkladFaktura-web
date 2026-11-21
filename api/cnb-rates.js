const FALLBACK_RATES = {
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

let cachedCnb = null;
let cachedAt = 0;

export async function fetchCnbRates() {
  const now = Date.now();
  if (cachedCnb && now - cachedAt < 3600_000) {
    return cachedCnb;
  }

  try {
    const res = await fetch(
      'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt',
      {
        headers: { 'User-Agent': 'SkladFaktura-Web/1.0' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const dateLine = lines[0] || '';
    const dateMatch = dateLine.match(/(\d{2}\.\d{2}\.\d{4})/);
    const date = dateMatch ? dateMatch[1] : '';

    const rates = { CZK: 1 };
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
      cachedAt = now;
      return cachedCnb;
    }
    throw new Error('Neplatná odpověď ČNB');
  } catch {
    return {
      date: '',
      rates: { ...FALLBACK_RATES },
      source: 'FALLBACK',
    };
  }
}

export default async function handler(req, res) {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'Metoda není povolena.' });
    return;
  }

  const data = await fetchCnbRates();
  res.status(200).json(data);
}
