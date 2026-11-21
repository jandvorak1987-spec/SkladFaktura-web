function round2(n) {
  return Math.round(n * 100) / 100;
}

function extractVsFromMessage(message) {
  if (!message) return '';
  const vsMatch = message.match(/(?:VS|VAR\.?\s*SYM\.?|FA(?:KTURA)?)\s*[:#-]?\s*(\d{4,10})/i);
  return vsMatch ? vsMatch[1] : '';
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Metoda není povolena.' });
    return;
  }

  const body = parseBody(req.body);
  const token = String(body.apiToken || '').trim();
  const daysBack = Math.min(365, Math.max(1, Number(body.daysBack || 30)));
  if (token.length < 10) {
    res.status(400).json({ error: 'Zadejte platný API token z Fio Internetbankingu.' });
    return;
  }

  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 86400000);
  const fmt = (d) =>
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

    const root = await response.json();
    const txList = root?.accountStatement?.transactionList?.transaction || [];
    const transactions = txList.map((tx, i) => {
      const strCol = (k) => String(tx?.[k]?.value ?? '').trim();
      const numCol = (k) => Number(tx?.[k]?.value ?? 0);

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
        source: 'FIO_API',
      };
    });

    res.status(200).json({ transactions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'síťová chyba';
    res.status(502).json({ error: `Chyba spojení s Fio bankou: ${msg}` });
  }
}
