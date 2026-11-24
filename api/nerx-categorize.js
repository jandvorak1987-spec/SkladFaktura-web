// Vercel Serverless Function: Live product categorization against Nerx.cz (Shoptet)
// with smart fallback rules — zero AI quota, zero 503 errors.

const COLOR_AND_NOISE_WORDS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'pink', 'purple', 'brown', 'grey', 'gray',
  'silver', 'gold', 'orange', 'yellow', 'cyan', 'violet', 'beige', 'navy', 'mint',
  'light', 'dark', 'mist', 'deep', 'sky', 'rose', 'pearl', 'matte', 'glossy', 'rainbow',
  'gunmetal', 'carbon', 'chrome', 'gradient', 'edition', 'color', 'colour',
  'cerna', 'bila', 'cervena', 'modra', 'zelena', 'ruzova', 'fialova', 'hneda', 'seda',
  'stribrna', 'zlata', 'oranzova', 'zluta', 'svetle', 'tmave', 'ks', 'pcs', 'bal',
]);

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTokens(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function buildCoreQuery(name) {
  const tokens = normalizeTokens(name).filter((t) => !COLOR_AND_NOISE_WORDS.has(t));
  return tokens.slice(0, 5).join(' ').trim();
}

function scoreTitleMatch(queryName, candidateTitle) {
  const qTokens = normalizeTokens(queryName);
  const cTokens = normalizeTokens(candidateTitle);
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  const cSet = new Set(cTokens);
  let score = 0;

  for (const qt of qTokens) {
    if (cSet.has(qt)) {
      // Variant tokens (numbers, lite, pro, go2, se, sq, max, mini, salt, cartridge) weigh extra
      const isVariant = /\d/.test(qt) || ['lite', 'pro', 'se', 'sq', 'max', 'mini', 'plus', 'ultra', 'cartridge', 'pod', 'salt', 'coil', 'hlava'].includes(qt);
      score += isVariant ? 3 : 2;
    } else if (!COLOR_AND_NOISE_WORDS.has(qt)) {
      score -= 1;
    }
  }

  // Slight penalty for extra non-color words in candidate
  const qSet = new Set(qTokens);
  for (const ct of cTokens) {
    if (!qSet.has(ct) && !COLOR_AND_NOISE_WORDS.has(ct)) {
      score -= 0.35;
    }
  }

  return score;
}

function fallbackRuleCategory(name) {
  const n = normalizeTokens(name).join(' ');
  if (/\b(cartridge|pod\s*cartridge|zhavici|hlava|hlavy|coil|mesh\s*coil|atomizer|clearomizer|tank|sklicko|naustek)\b/.test(n)) {
    return 'Cartridge & žhavicí hlavy';
  }
  if (/\b(predplnen|elfa\s*pod|prefilled|pod\s*2x2|2x2ml)\b/.test(n)) {
    return 'Předplněné pody';
  }
  if (/\b(jednorazov|disposable|puffs|potahu|venix|kurwa|elf\s*bar\s*600|lost\s*mary|crystal\s*bar|frumist)\b/.test(n)) {
    return 'Jednorázové e-cigarety';
  }
  if (/\b(salt|nicsalt|nic\s*salt|liquid|eliquid|e\s*liquid|10ml|10\s*ml)\b/.test(n) && !/\b(kit|pod\s*kit|baterie|mod)\b/.test(n)) {
    return 'Liquidy';
  }
  if (/\b(prichut|aroma|shake|vape|longfill|shortfill|baze|base|booster|nikotinovy\s*booster)\b/.test(n)) {
    return 'Příchutě & báze';
  }
  if (/\b(sacky|sacek|snus|velo|killa|pablo|siberia|zyn|garant|kurwa\s*fatality|nikotinove)\b/.test(n)) {
    return 'Nikotinové sáčky';
  }
  if (/\b(xlim|pod\s*kit|starter\s*kit|e\s*cigareta|ecigareta|vaporesso|uwell|caliburn|voopoo|argus|drag|smok|geekvape|aegis|wenax|aspire|lost\s*vape|ursa|vaper|mod\s*kit)\b/.test(n)) {
    return 'Sety e-cigaret & pody';
  }
  if (/\b(baterie|18650|21700|nabijecka|kabel|usb|pouzdro|vata|drat)\b/.test(n)) {
    return 'Příslušenství';
  }
  return '';
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SkladFaktura/1.0)',
      'Accept-Language': 'cs-CZ,cs;q=0.9',
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) return '';
  return await res.text();
}

function extractSearchCandidates(html) {
  const results = [];
  const seen = new Set();
  // Match Shoptet product links (<a href="/.../" class="name" ...>Title</a>)
  const re = /<a\b[^>]*href="(\/[^"#?]+)"[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<a\b[^>]*class="[^"]*\bname\b[^"]*"[^>]*href="(\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < 16) {
    const href = m[1] || m[3] || '';
    const rawTitle = m[2] || m[4] || '';
    const title = decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, ' '));
    if (!href || !title || seen.has(href)) continue;
    seen.add(href);
    results.push({ href, title });
  }
  return results;
}

function extractCategoryFromProductHtml(html) {
  // 1. Schema.org BreadcrumbList (most reliable on Shoptet / Nerx.cz)
  const bcBlock = html.match(/itemtype="https?:\/\/schema\.org\/BreadcrumbList"[\s\S]{0,3500}<\/div>/i);
  if (bcBlock) {
    const crumbs = [...bcBlock[0].matchAll(/itemprop="name"[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((m) => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ')))
      .filter((c) => c && c.toLowerCase() !== 'domů' && c.toLowerCase() !== 'home');
    // Breadcrumbs typically are: [Category, (Subcategory...), Product Name]
    if (crumbs.length >= 2) {
      const catParts = crumbs.slice(0, -1).filter(Boolean);
      if (catParts.length > 0) {
        return catParts.join(' / ').slice(0, 80);
      }
    }
  }

  // 2. Shoptet dataLayer "category": "..."
  const dlMatch = html.match(/"category"\s*:\s*"([^"]{2,100})"/i);
  if (dlMatch) {
    const cat = decodeHtmlEntities(dlMatch[1]);
    if (cat && cat.toLowerCase() !== 'domů') return cat.slice(0, 80);
  }

  return '';
}

async function lookupOnNerx(item, queryCache, pageCache) {
  const name = String(item.name || '').trim();
  const ean = String(item.ean || '').replace(/\D/g, '');
  const coreQuery = buildCoreQuery(name);

  const queriesToTry = [];
  if (ean.length >= 8) queriesToTry.push(ean);
  if (name.length >= 2) queriesToTry.push(name);
  if (coreQuery.length >= 3 && coreQuery.toLowerCase() !== name.toLowerCase()) {
    queriesToTry.push(coreQuery);
  }

  let bestCandidate = null;
  for (const q of queriesToTry) {
    const cacheKey = q.toLowerCase();
    let candidates = queryCache.get(cacheKey);
    if (!candidates) {
      const searchUrl = `https://www.nerx.cz/vyhledavani/?string=${encodeURIComponent(q)}`;
      const html = await fetchText(searchUrl).catch(() => '');
      candidates = html ? extractSearchCandidates(html) : [];
      queryCache.set(cacheKey, candidates);
    }

    if (candidates.length > 0) {
      let best = candidates[0];
      let bestScore = scoreTitleMatch(name, best.title);
      for (let i = 1; i < candidates.length; i++) {
        const s = scoreTitleMatch(name, candidates[i].title);
        if (s > bestScore) {
          bestScore = s;
          best = candidates[i];
        }
      }
      // Require at least minimal token relevance unless searched by exact EAN
      if (q === ean || bestScore >= 1.5) {
        bestCandidate = best;
        break;
      }
    }
  }

  if (bestCandidate) {
    let category = pageCache.get(bestCandidate.href);
    if (category === undefined) {
      const prodHtml = await fetchText(`https://www.nerx.cz${bestCandidate.href}`).catch(() => '');
      category = prodHtml ? extractCategoryFromProductHtml(prodHtml) : '';
      pageCache.set(bestCandidate.href, category);
    }
    if (category) {
      return {
        id: item.id,
        category,
        source: 'NERX',
        matchedTitle: bestCandidate.title,
        matchedUrl: `https://www.nerx.cz${bestCandidate.href}`,
      };
    }
  }

  const ruleCat = fallbackRuleCategory(name);
  return {
    id: item.id,
    category: ruleCat,
    source: ruleCat ? 'RULE' : 'NONE',
    matchedTitle: '',
    matchedUrl: '',
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    const items = rawItems
      .filter((i) => i && typeof i.name === 'string' && i.name.trim().length > 0)
      .slice(0, 60);

    if (items.length === 0) {
      return res.status(400).json({ error: 'Nebyla předána žádná položka ke kategorizaci.' });
    }

    const queryCache = new Map();
    const pageCache = new Map();
    const results = new Array(items.length);

    // Polite concurrency = 4
    let cursor = 0;
    const workerCount = Math.min(4, items.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          results[idx] = await lookupOnNerx(items[idx], queryCache, pageCache);
        }
      })
    );

    return res.status(200).json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'neznámá chyba';
    return res.status(500).json({ error: `Kategorizace přes Nerx.cz selhala: ${msg}` });
  }
}
