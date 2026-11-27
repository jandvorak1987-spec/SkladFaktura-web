import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isNonStockRecyclingFee } from './ttlCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shared live Firestore database ID used by both SkladFaktura Web and Android
const SHARED_ANDROID_DATABASE_ID =
  'ai-studio-android-skladfak-22914057-061f-49e4-b795-36f08ccd24cb';

let cachedFirebaseConfig = null;
function loadFirebaseWebConfig() {
  if (cachedFirebaseConfig) return cachedFirebaseConfig;
  const cfgPath = path.resolve(__dirname, '../firebase-applet-config.json');
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cachedFirebaseConfig = {
    projectId: String(process.env.FIREBASE_PROJECT_ID || raw.projectId || '').trim(),
    apiKey: String(process.env.FIREBASE_WEB_API_KEY || raw.apiKey || '').trim(),
    databaseId: String(process.env.FIREBASE_DATABASE_ID || SHARED_ANDROID_DATABASE_ID).trim(),
  };
  return cachedFirebaseConfig;
}

// In-memory cached Firebase Auth ID token for the sync service user (50-minute TTL)
let cachedAuthToken = { idToken: '', email: '', expiresAt: 0 };

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function round4(n) {
  return Math.round(Number(n || 0) * 10000) / 10000;
}

function toIsoDate(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysIso(isoDate, days) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const base = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
  base.setDate(base.getDate() + Math.max(0, Math.min(365, Number(days || 14))));
  return toIsoDate(base);
}

function normalizeMatchKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeSkuKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_./]+/g, '');
}

function isSyntheticSku(sku) {
  const s = String(sku || '').trim();
  if (!s) return true;
  return /^(sku|ai|imp|isdoc|poh|loc|item|pol)[-_ ]?\d{1,6}$/i.test(s);
}

function canonicalTokenKey(normalized) {
  const tokens = normalized.split(' ').filter((w) => w.length >= 1);
  if (tokens.length < 2) return '';
  return [...tokens].sort().join('\0');
}

function areNamesCompatible(nameA, nameB) {
  const a = normalizeMatchKey(nameA);
  const b = normalizeMatchKey(nameB);
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = canonicalTokenKey(a);
  return Boolean(ka && ka === canonicalTokenKey(b));
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

function getHeader(req, name) {
  const headers = req.headers || {};
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

function getQueryParam(req, name) {
  if (req.query && req.query[name] !== undefined) {
    const v = req.query[name];
    return Array.isArray(v) ? String(v[0] || '') : String(v || '');
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return url.searchParams.get(name) || '';
  } catch {
    return '';
  }
}

/**
 * Constant-time comparison of Bearer token (or X-Api-Key) against server-side B2B_WEBHOOK_TOKEN.
 * Fails closed when B2B_WEBHOOK_TOKEN is not configured.
 */
function verifyWebhookAuth(req) {
  const expected = String(process.env.B2B_WEBHOOK_TOKEN || '').trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error:
        'Webhook není nakonfigurován: na serveru chybí proměnná prostředí B2B_WEBHOOK_TOKEN.',
    };
  }

  const authHeader = getHeader(req, 'authorization').trim();
  const apiKeyHeader = getHeader(req, 'x-api-key').trim();
  let provided = '';
  if (/^bearer\s+/i.test(authHeader)) {
    provided = authHeader.replace(/^bearer\s+/i, '').trim();
  } else if (apiKeyHeader) {
    provided = apiKeyHeader;
  }

  if (!provided) {
    return {
      ok: false,
      status: 401,
      error: 'Chybí autorizační hlavička Authorization: Bearer <token>.',
    };
  }

  const hashA = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(expected, 'utf8').digest();
  if (!crypto.timingSafeEqual(hashA, hashB)) {
    return {
      ok: false,
      status: 401,
      error: 'Neplatný Bearer token / API klíč.',
    };
  }

  return { ok: true };
}

// =============================================================================
// Firebase Auth + Cloud Firestore REST API (No firebase-admin / No IAM needed)
// =============================================================================

async function getFirebaseIdToken() {
  const email = String(process.env.FIREBASE_SYNC_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.FIREBASE_SYNC_PASSWORD || '').trim();
  if (!email || !password) {
    throw new Error(
      'Na serveru chybí FIREBASE_SYNC_EMAIL nebo FIREBASE_SYNC_PASSWORD pro zápis do sdílené databáze SkladFaktura.'
    );
  }

  const now = Date.now();
  if (cachedAuthToken.idToken && cachedAuthToken.email === email && now < cachedAuthToken.expiresAt) {
    return { idToken: cachedAuthToken.idToken, email };
  }

  const { apiKey } = loadFirebaseWebConfig();
  if (!apiKey) {
    throw new Error('Chybí Firebase Web API key v konfiguraci.');
  }

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
      signal: AbortSignal.timeout(10000),
    }
  );
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.idToken) {
    const code = data?.error?.message || `HTTP ${resp.status}`;
    throw new Error(
      `Přihlášení synchronizačního účtu (${email}) k Firebase selhalo (${code}). Zkontrolujte FIREBASE_SYNC_EMAIL a FIREBASE_SYNC_PASSWORD.`
    );
  }

  const expiresInSec = Math.max(300, Number(data.expiresIn || 3600) - 600);
  cachedAuthToken = {
    idToken: data.idToken,
    email,
    expiresAt: now + expiresInSec * 1000,
  };
  return { idToken: data.idToken, email };
}

function getFirestoreBase() {
  const { projectId, databaseId } = loadFirebaseWebConfig();
  return {
    docRootPath: `projects/${projectId}/databases/${databaseId}/documents`,
    restBaseUrl: `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`,
  };
}

function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return { doubleValue: 0 };
    if (Number.isInteger(val) && Math.abs(val) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(val) };
    }
    return { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map((item) => toFsValue(item)) } };
  }
  if (typeof val === 'object') {
    return { mapValue: { fields: toFsFields(val) } };
  }
  return { stringValue: String(val) };
}

function toFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    fields[k] = toFsValue(v);
  }
  return fields;
}

function fromFsValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return Boolean(v.booleanValue);
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) {
    return Array.isArray(v.arrayValue?.values) ? v.arrayValue.values.map(fromFsValue) : [];
  }
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue?.fields || {};
    for (const [k, fv] of Object.entries(fields)) {
      out[k] = fromFsValue(fv);
    }
    return out;
  }
  return null;
}

function fromFsDoc(doc) {
  if (!doc || !doc.name) return null;
  const id = doc.name.split('/').pop() || '';
  const out = { id };
  for (const [k, v] of Object.entries(doc.fields || {})) {
    out[k] = fromFsValue(v);
  }
  return out;
}

async function fsRequest(idToken, urlPath, { method = 'GET', body } = {}) {
  const { restBaseUrl } = getFirestoreBase();
  const fullUrl = urlPath.startsWith('http') ? urlPath : `${restBaseUrl}${urlPath}`;
  const resp = await fetch(fullUrl, {
    method,
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.error?.message || json?.[0]?.error?.message || `HTTP ${resp.status}`;
    throw new Error(`Firestore REST chyba (${resp.status}): ${msg}`);
  }
  return json;
}

async function fsRunQuery(idToken, parentRelPath, structuredQuery) {
  const prefix = parentRelPath ? `/${parentRelPath}` : '';
  const rows = await fsRequest(idToken, `${prefix}:runQuery`, {
    method: 'POST',
    body: { structuredQuery },
  });
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && r.document).map((r) => fromFsDoc(r.document));
}

async function fsCommitWrites(idToken, writes) {
  if (!writes || writes.length === 0) return;
  for (let i = 0; i < writes.length; i += 200) {
    const chunk = writes.slice(i, i + 200);
    await fsRequest(idToken, ':commit', {
      method: 'POST',
      body: { writes: chunk },
    });
  }
}

function makeSetWrite(relDocPath, fieldsObj, timestampFields = ['createdAt', 'updatedAt']) {
  const { docRootPath } = getFirestoreBase();
  const fullName = `${docRootPath}/${relDocPath}`;
  const write = {
    update: {
      name: fullName,
      fields: toFsFields(fieldsObj),
    },
  };
  if (timestampFields.length > 0) {
    write.updateTransforms = timestampFields.map((fieldPath) => ({
      fieldPath,
      setToServerValue: 'REQUEST_TIME',
    }));
  }
  return write;
}

function makePatchWrite(relDocPath, fieldsObj, timestampFields = ['updatedAt']) {
  const { docRootPath } = getFirestoreBase();
  const fullName = `${docRootPath}/${relDocPath}`;
  const fieldPaths = Object.keys(fieldsObj).filter((k) => fieldsObj[k] !== undefined);
  const write = {
    update: {
      name: fullName,
      fields: toFsFields(fieldsObj),
    },
    updateMask: { fieldPaths },
  };
  if (timestampFields.length > 0) {
    write.updateTransforms = timestampFields.map((fieldPath) => ({
      fieldPath,
      setToServerValue: 'REQUEST_TIME',
    }));
  }
  return write;
}

function generateFirestoreId(prefix = 'b2b') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// =============================================================================
// Workspace & Inventory Resolution Helpers
// =============================================================================

async function resolveWorkspaceContext(idToken, email, overrides = {}) {
  const explicitWsId = String(overrides.workspaceId || process.env.B2B_WORKSPACE_ID || '').trim();
  let workspace = null;

  if (explicitWsId) {
    const doc = await fsRequest(idToken, `/workspaces/${encodeURIComponent(explicitWsId)}`);
    workspace = fromFsDoc(doc);
  } else {
    const found = await fsRunQuery(idToken, '', {
      from: [{ collectionId: 'workspaces' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'memberEmails' },
          op: 'ARRAY_CONTAINS',
          value: { stringValue: email },
        },
      },
      limit: 5,
    });
    workspace = found[0] || null;
  }

  if (!workspace) {
    throw new Error(
      `Pracovní prostor pro účet ${email} nebyl nalezen. Přidejte tento e-mail do týmu ve SkladFaktuře nebo nastavte B2B_WORKSPACE_ID.`
    );
  }

  const wsRel = `workspaces/${workspace.id}`;
  const memberFilter = {
    fieldFilter: {
      field: { fieldPath: 'memberEmails' },
      op: 'ARRAY_CONTAINS',
      value: { stringValue: email },
    },
  };

  const [companies, warehouses, inventory, clients, invoices] = await Promise.all([
    fsRunQuery(idToken, wsRel, { from: [{ collectionId: 'companies' }], where: memberFilter }),
    fsRunQuery(idToken, wsRel, { from: [{ collectionId: 'warehouses' }], where: memberFilter }),
    fsRunQuery(idToken, wsRel, { from: [{ collectionId: 'inventory' }], where: memberFilter }),
    fsRunQuery(idToken, wsRel, { from: [{ collectionId: 'clients' }], where: memberFilter }),
    fsRunQuery(idToken, wsRel, { from: [{ collectionId: 'invoices' }], where: memberFilter }),
  ]);

  const wantedCompanyId = String(overrides.companyId || process.env.B2B_COMPANY_ID || '').trim();
  const company =
    (wantedCompanyId ? companies.find((c) => c.id === wantedCompanyId) : null) ||
    companies.find((c) => c.id === 'company_1') ||
    companies[0] ||
    null;

  if (!company) {
    throw new Error('V pracovním prostoru nebyla nalezena žádná firma pro fakturaci.');
  }

  const wantedWarehouseId = String(overrides.warehouseId || process.env.B2B_WAREHOUSE_ID || '').trim();
  const warehouse =
    (wantedWarehouseId ? warehouses.find((w) => w.id === wantedWarehouseId) : null) ||
    warehouses.find((w) => w.id === 'shared_main') ||
    warehouses[0] ||
    { id: 'shared_main', name: 'Hlavní sklad' };

  const memberEmails =
    Array.isArray(workspace.memberEmails) && workspace.memberEmails.length > 0
      ? workspace.memberEmails
      : [email];

  return {
    workspace: { ...workspace, memberEmails },
    company,
    warehouse,
    warehouses,
    inventory,
    clients,
    invoices,
  };
}

function buildInventoryIndex(items) {
  const byId = new Map();
  const byEan = new Map();
  const bySku = new Map();
  const byExactName = new Map();
  const bySortedTokens = new Map();

  for (const item of items) {
    byId.set(item.id, item);
    const eanClean = String(item.ean || '').replace(/\D/g, '');
    if (eanClean.length >= 8 && !byEan.has(eanClean)) {
      byEan.set(eanClean, item);
    }
    if (!isSyntheticSku(item.sku)) {
      const skuKey = normalizeSkuKey(item.sku);
      if (skuKey.length >= 2) {
        const list = bySku.get(skuKey);
        if (list) list.push(item);
        else bySku.set(skuKey, [item]);
      }
    }
    const nameKey = normalizeMatchKey(item.name);
    if (nameKey.length >= 2) {
      if (!byExactName.has(nameKey)) byExactName.set(nameKey, item);
      const tokenSig = canonicalTokenKey(nameKey);
      if (tokenSig && !bySortedTokens.has(tokenSig)) bySortedTokens.set(tokenSig, item);
    }
  }

  return { byId, byEan, bySku, byExactName, bySortedTokens };
}

function matchInventoryItem(line, preferredIndex, fallbackIndex) {
  const lookupIn = (idx) => {
    const explicitId = String(line.inventoryItemId || line.itemId || '').trim();
    if (explicitId && idx.byId.has(explicitId)) return idx.byId.get(explicitId);

    const eanClean = String(line.ean || '').replace(/\D/g, '');
    if (eanClean.length >= 8 && idx.byEan.has(eanClean)) return idx.byEan.get(eanClean);

    const nameKey = normalizeMatchKey(line.name);
    if (!isSyntheticSku(line.sku)) {
      const skuKey = normalizeSkuKey(line.sku);
      const bucket = skuKey.length >= 2 ? idx.bySku.get(skuKey) : undefined;
      if (bucket) {
        for (const cand of bucket) {
          if (nameKey.length < 2 || areNamesCompatible(cand.name, line.name)) return cand;
        }
        if (bucket.length === 1) return bucket[0];
      }
    }

    if (nameKey.length >= 2) {
      const exact = idx.byExactName.get(nameKey);
      if (exact) return exact;
      const tokenSig = canonicalTokenKey(nameKey);
      if (tokenSig && idx.bySortedTokens.has(tokenSig)) {
        return idx.bySortedTokens.get(tokenSig);
      }
    }
    return null;
  };

  return lookupIn(preferredIndex) || (fallbackIndex ? lookupIn(fallbackIndex) : null);
}

// =============================================================================
// Czech VAT & Invoice Helpers (Exact match with src/lib/format.ts)
// =============================================================================

function calculateInvoiceTotals(items, vatPayer) {
  const baseByRate = new Map();
  for (const item of items) {
    const rate = vatPayer ? Number(item.vatRate || 0) : 0;
    const discountMult = 1 - Math.min(100, Math.max(0, Number(item.discountPercent || 0))) / 100;
    const base = round2(Number(item.quantity || 0) * Number(item.unitPrice || 0) * discountMult);
    baseByRate.set(rate, round2((baseByRate.get(rate) || 0) + base));
  }
  let totalWithoutVat = 0;
  let totalVat = 0;
  for (const [rate, base] of baseByRate.entries()) {
    const vat = vatPayer && rate > 0 ? round2(base * (rate / 100)) : 0;
    totalWithoutVat = round2(totalWithoutVat + base);
    totalVat = round2(totalVat + vat);
  }
  return {
    totalWithoutVat,
    totalVat,
    totalWithVat: round2(totalWithoutVat + totalVat),
  };
}

function formatCompanyAddress(company) {
  const line2 = [company.zip, company.city].filter(Boolean).join(' ').trim();
  return [company.street, line2].filter(Boolean).join(', ').trim();
}

function mapPaymentMethod(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (v === 'CASH' || v === 'HOTOVOST' || v === 'HOTOVE') return 'CASH';
  if (v === 'CARD' || v === 'KARTA' || v === 'ONLINE' || v === 'GATEWAY') return 'CARD';
  if (v === 'COD' || v === 'DOBIRKA' || v === 'DOBÍRKA') return 'COD';
  return 'BANK_TRANSFER';
}

function mapDocumentType(raw) {
  const v = String(raw || '').trim().toUpperCase();
  if (v === 'PROFORMA' || v === 'ZALOHA' || v === 'ZÁLOHA') return 'PROFORMA';
  if (v === 'CREDIT_NOTE' || v === 'DOBROPIS' || v === 'REFUND') return 'CREDIT_NOTE';
  if (v === 'SIMPLIFIED' || v === 'PRODEJKA') return 'SIMPLIFIED';
  if (v === 'QUOTE' || v === 'NABIDKA') return 'QUOTE';
  return 'INVOICE';
}

function normalizeVatRate(raw, fallback = 21) {
  const n = Number(raw);
  if (n === 0 || n === 12 || n === 21) return n;
  return fallback;
}

function detectEventType(body) {
  const raw = String(body.event || body.type || body.action || '')
    .trim()
    .toLowerCase();

  if (
    raw.includes('stock') ||
    raw.includes('movement') ||
    raw.includes('pohyb') ||
    (Array.isArray(body.movements) && body.movements.length > 0 && !body.items && !body.orderItems)
  ) {
    return 'STOCK_MOVEMENT';
  }
  if (raw.includes('cancel') || raw.includes('storno') || raw.includes('refund')) {
    return 'ORDER_CANCELLED';
  }
  if (raw === 'order.paid' || raw === 'invoice.paid' || raw === 'payment.received' || raw === 'paid') {
    return 'ORDER_PAID';
  }
  if (raw === 'ping' || raw === 'test' || raw === 'health') {
    return 'PING';
  }
  return 'ORDER_OR_INVOICE';
}

function extractPayloadEntity(body) {
  // Support both flat payloads and wrapped { event, data: { ... } } or { order: { ... } } or { invoice: { ... } }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return { ...body, ...body.data };
  }
  if (body.order && typeof body.order === 'object' && !Array.isArray(body.order)) {
    return { ...body, ...body.order };
  }
  if (body.invoice && typeof body.invoice === 'object' && !Array.isArray(body.invoice)) {
    return { ...body, ...body.invoice };
  }
  return body;
}

// =============================================================================
// Event Handlers
// =============================================================================

async function handleOrderOrInvoice(ctx, idToken, rawBody) {
  const data = extractPayloadEntity(rawBody);
  const { workspace, company, warehouse, inventory, clients, invoices } = ctx;
  const wsRel = `workspaces/${workspace.id}`;

  const rawItems =
    (Array.isArray(data.items) && data.items) ||
    (Array.isArray(data.orderItems) && data.orderItems) ||
    (Array.isArray(data.lines) && data.lines) ||
    [];

  if (rawItems.length === 0) {
    return {
      status: 400,
      payload: { error: 'Chybí pole položek (items / orderItems / lines).' },
    };
  }

  const externalId = String(
    data.externalId || data.b2bOrderId || data.orderId || data.orderNumber || data.id || ''
  )
    .trim()
    .slice(0, 80);

  const incomingInvNumber = String(data.invoiceNumber || data.number || '').trim().slice(0, 40);
  const b2bTag = externalId ? `[B2B:${externalId}]` : '';

  // Idempotency check: prevent duplicate invoice creation & double stock deduction
  const existingInvoice = invoices.find(
    (inv) =>
      (b2bTag && String(inv.note || '').includes(b2bTag)) ||
      (incomingInvNumber && String(inv.invoiceNumber || '').trim() === incomingInvNumber)
  );

  const rawStatus = String(data.status || data.paymentStatus || '').trim().toUpperCase();
  const isPaidIncoming =
    Boolean(data.paid || data.isPaid) ||
    rawStatus === 'PAID' ||
    rawStatus === 'ZAPLACENO' ||
    rawStatus === 'UHRAZENO';

  if (existingInvoice) {
    // If order transitioned to PAID, update status idempotently
    if (isPaidIncoming && existingInvoice.status !== 'PAID' && existingInvoice.status !== 'CANCELLED') {
      const paidDate = String(data.paidDate || toIsoDate()).slice(0, 20);
      await fsCommitWrites(idToken, [
        makePatchWrite(`${wsRel}/invoices/${existingInvoice.id}`, {
          status: 'PAID',
          paidAmount: round2(existingInvoice.totalWithVat || 0),
          paidDate,
        }),
      ]);
      return {
        status: 200,
        payload: {
          ok: true,
          duplicate: true,
          updatedStatus: 'PAID',
          invoiceId: existingInvoice.id,
          invoiceNumber: existingInvoice.invoiceNumber,
        },
      };
    }

    return {
      status: 200,
      payload: {
        ok: true,
        duplicate: true,
        invoiceId: existingInvoice.id,
        invoiceNumber: existingInvoice.invoiceNumber,
      },
    };
  }

  // Normalize customer / client details
  const cust =
    (data.customer && typeof data.customer === 'object' ? data.customer : null) ||
    (data.client && typeof data.client === 'object' ? data.client : null) ||
    (data.buyer && typeof data.buyer === 'object' ? data.buyer : null) ||
    (data.billingAddress && typeof data.billingAddress === 'object' ? data.billingAddress : null) ||
    {};

  const clientName = String(
    cust.companyName ||
      cust.company ||
      cust.name ||
      data.clientName ||
      data.customerName ||
      'B2B Odběratel'
  )
    .trim()
    .slice(0, 200);
  const clientIco = String(cust.ico || cust.companyId || data.clientIco || data.ico || '')
    .replace(/\D/g, '')
    .slice(0, 20);
  const clientDic = String(cust.dic || cust.vatId || data.clientDic || data.dic || '')
    .trim()
    .slice(0, 25);
  const clientStreet = String(cust.street || cust.address || data.clientStreet || '')
    .trim()
    .slice(0, 200);
  const clientCity = String(cust.city || data.clientCity || '').trim().slice(0, 120);
  const clientZip = String(cust.zip || cust.postalCode || data.clientZip || '').trim().slice(0, 20);
  const clientEmail = String(cust.email || data.clientEmail || data.customerEmail || '')
    .trim()
    .slice(0, 160);
  const clientPhone = String(cust.phone || data.clientPhone || '').trim().slice(0, 40);
  const clientCountry = String(cust.country || 'Česká republika').trim().slice(0, 80);

  // Match or create client in workspace
  let matchedClient = null;
  if (clientIco.length >= 6) {
    matchedClient = clients.find((c) => String(c.ico || '').replace(/\D/g, '') === clientIco) || null;
  }
  if (!matchedClient && clientName) {
    const normClientName = normalizeMatchKey(clientName);
    matchedClient = clients.find((c) => normalizeMatchKey(c.name) === normClientName) || null;
  }

  const writes = [];
  let clientId = matchedClient ? matchedClient.id : '';
  if (!matchedClient && clientName) {
    clientId = generateFirestoreId('cli');
    writes.push(
      makeSetWrite(`${wsRel}/clients/${clientId}`, {
        workspaceId: workspace.id,
        memberEmails: workspace.memberEmails,
        name: clientName,
        ico: clientIco,
        dic: clientDic,
        street: clientStreet,
        city: clientCity,
        zip: clientZip,
        country: clientCountry,
        email: clientEmail,
        phone: clientPhone,
        bankAccount: '',
        notes: 'Automaticky vytvořeno z Nerx B2B',
      })
    );
  }

  // Build O(1) inventory indexes (target warehouse first, then all warehouses)
  const targetWhItems = inventory.filter((i) => i.warehouseId === warehouse.id);
  const otherWhItems = inventory.filter((i) => i.warehouseId !== warehouse.id);
  const preferredIdx = buildInventoryIndex(targetWhItems);
  const fallbackIdx = buildInventoryIndex(otherWhItems);

  const docType = mapDocumentType(data.documentType);
  const isReverseCharge = Boolean(data.reverseCharge);
  const currency = String(data.currency || 'CZK').trim().toUpperCase().slice(0, 3) || 'CZK';
  const exchangeRate =
    currency === 'CZK' ? 1 : Math.max(0.0001, round4(Number(data.exchangeRate || 1) || 1));
  const effectiveVatPayer = Boolean(company.vatPayer) && !isReverseCharge && docType !== 'QUOTE';
  const pricesIncludeVat = Boolean(data.pricesIncludeVat);

  const cleanItems = [];
  const stockAdjustments = new Map(); // itemId -> { stockItem, qty }
  let unmatchedItemsCount = 0;

  for (const rawItem of rawItems.slice(0, 100)) {
    const name = String(rawItem.name || rawItem.title || rawItem.productName || '')
      .trim()
      .slice(0, 200);
    const qty = round2(Number(rawItem.quantity ?? rawItem.qty ?? 0));
    if (!name || !Number.isFinite(qty) || qty <= 0) continue;

    const sku = String(rawItem.sku || rawItem.code || '').trim().slice(0, 64);
    const ean = String(rawItem.ean || rawItem.barcode || '').trim().slice(0, 40);
    const vatRate = isReverseCharge
      ? 0
      : normalizeVatRate(rawItem.vatRate ?? rawItem.vat ?? rawItem.taxRate, 21);

    const rawPrice = Number(
      rawItem.unitPrice ?? rawItem.priceWithoutVat ?? rawItem.price ?? rawItem.unitPriceWithVat ?? 0
    );
    const isLineWithVat =
      pricesIncludeVat || (rawItem.unitPrice === undefined && rawItem.priceWithoutVat === undefined && rawItem.unitPriceWithVat !== undefined);
    const unitPrice = Math.max(
      0,
      round2(
        isLineWithVat && effectiveVatPayer && vatRate > 0
          ? rawPrice / (1 + vatRate / 100)
          : rawPrice
      )
    );
    const discountPercent = Math.min(100, Math.max(0, round2(Number(rawItem.discountPercent || 0))));

    const isFeeLine = isNonStockRecyclingFee(name, sku);
    const matchedStock = isFeeLine
      ? null
      : matchInventoryItem(
          { inventoryItemId: rawItem.inventoryItemId || rawItem.itemId, ean, sku, name },
          preferredIdx,
          fallbackIdx
        );

    if (!matchedStock && !isFeeLine) {
      unmatchedItemsCount++;
    }

    cleanItems.push({
      inventoryItemId: matchedStock ? matchedStock.id : '',
      warehouseId: matchedStock ? matchedStock.warehouseId || warehouse.id : warehouse.id,
      sku: (sku || matchedStock?.sku || '').slice(0, 64),
      name,
      quantity: qty,
      unit: String(rawItem.unit || matchedStock?.unit || 'ks').trim().slice(0, 20) || 'ks',
      unitPrice,
      vatRate,
      discountPercent,
    });

    if (matchedStock) {
      const prev = stockAdjustments.get(matchedStock.id);
      if (prev) prev.qty = round2(prev.qty + qty);
      else stockAdjustments.set(matchedStock.id, { stockItem: matchedStock, qty });
    }
  }

  if (cleanItems.length === 0) {
    return {
      status: 400,
      payload: { error: 'Doklad neobsahuje žádnou platnou položku s názvem a kladným množstvím.' },
    };
  }

  const totals = calculateInvoiceTotals(cleanItems, effectiveVatPayer);
  const issueDate = String(data.issueDate || data.createdAt || toIsoDate()).slice(0, 10);
  const taxDate = String(data.taxDate || issueDate).slice(0, 10);
  const dueDate = String(
    data.dueDate || addDaysIso(issueDate, Number(company.defaultDueDays || 14))
  ).slice(0, 10);

  let invoiceNumber = incomingInvNumber;
  let autoIncremented = false;
  if (!invoiceNumber) {
    const prefix = String(company.invoicePrefix || 'FA').trim();
    const nextNum = Math.max(1, Math.floor(Number(company.nextInvoiceNumber || 1)));
    invoiceNumber = `${prefix}${new Date().getFullYear()}${String(nextNum).padStart(4, '0')}`.slice(
      0,
      40
    );
    autoIncremented = docType === 'INVOICE';
  }

  const variableSymbol = String(
    data.variableSymbol || data.vs || invoiceNumber.replace(/\D/g, '') || externalId.replace(/\D/g, '')
  )
    .replace(/\D/g, '')
    .slice(0, 20);

  const noteParts = [
    String(data.note || '').trim(),
    b2bTag,
    data.orderNumber && String(data.orderNumber) !== externalId
      ? `B2B obj. ${String(data.orderNumber).trim()}`
      : '',
  ].filter(Boolean);
  const note = noteParts.join(' · ').slice(0, 500);

  const deductFromStock =
    data.deductFromStock !== false && docType !== 'QUOTE' && docType !== 'PROFORMA';

  const invId = generateFirestoreId('inv');
  writes.push(
    makeSetWrite(`${wsRel}/invoices/${invId}`, {
      workspaceId: workspace.id,
      memberEmails: workspace.memberEmails,
      companyId: company.id,
      companyName: String(company.name || 'Firma').slice(0, 160),
      companyIco: String(company.ico || '').slice(0, 20),
      companyDic: String(company.dic || '').slice(0, 25),
      companyAddress: formatCompanyAddress(company).slice(0, 260),
      companyBankAccount: String(company.bankAccount || '').slice(0, 40),
      companyIban: String(company.iban || '').replace(/\s+/g, '').toUpperCase().slice(0, 40),
      invoiceNumber,
      variableSymbol,
      documentType: docType,
      reverseCharge: isReverseCharge,
      relatedInvoiceNumber: String(data.relatedInvoiceNumber || '').trim().slice(0, 40),
      recurringInterval: 'NONE',
      reminderCount: 0,
      lastReminderDate: '',
      clientEmail,
      issueDate,
      taxDate,
      dueDate,
      paymentMethod: mapPaymentMethod(data.paymentMethod),
      status: isPaidIncoming ? 'PAID' : 'ISSUED',
      clientId: clientId.slice(0, 64),
      clientName,
      clientIco,
      clientDic,
      clientStreet,
      clientCity,
      clientZip,
      currency,
      exchangeRate,
      legalNotice: String(data.legalNotice || '').trim().slice(0, 1500),
      sentAt: '',
      totalWithoutVat: totals.totalWithoutVat,
      totalVat: totals.totalVat,
      totalWithVat: totals.totalWithVat,
      paidAmount: isPaidIncoming ? totals.totalWithVat : 0,
      paidDate: isPaidIncoming ? String(data.paidDate || issueDate).slice(0, 10) : '',
      matchedTransactionId: '',
      note,
      deductedFromStock: deductFromStock && stockAdjustments.size > 0,
      exportedToPohoda: false,
      invoiceTemplate: String(company.invoiceTemplate || 'CLASSIC'),
      items: cleanItems,
    })
  );

  if (autoIncremented) {
    writes.push(
      makePatchWrite(`${wsRel}/companies/${company.id}`, {
        nextInvoiceNumber: Math.max(1, Math.floor(Number(company.nextInvoiceNumber || 1) + 1)),
      })
    );
  }

  let stockMovementsCreated = 0;
  if (deductFromStock) {
    const isCreditNote = docType === 'CREDIT_NOTE';
    const refPrefix = isCreditNote ? 'DOB' : docType === 'SIMPLIFIED' ? 'PRO' : 'FA';
    const notePrefix = isCreditNote ? 'B2B vratka z dobropisu' : 'B2B výdej k faktuře';

    for (const [itemId, { stockItem, qty }] of stockAdjustments.entries()) {
      const delta = isCreditNote ? round2(qty) : -round2(qty);
      const nextQty = round2(Number(stockItem.quantity || 0) + delta);
      writes.push(
        makePatchWrite(`${wsRel}/inventory/${itemId}`, {
          quantity: nextQty,
        })
      );
      const movId = generateFirestoreId('mov');
      writes.push(
        makeSetWrite(
          `${wsRel}/stockMovements/${movId}`,
          {
            workspaceId: workspace.id,
            memberEmails: workspace.memberEmails,
            itemId,
            itemName: String(stockItem.name || '').slice(0, 200),
            itemSku: String(stockItem.sku || '').slice(0, 64),
            warehouseId: stockItem.warehouseId || warehouse.id,
            companyId: company.id,
            movementType: isCreditNote ? 'RECEIPT' : 'ISSUE',
            quantityDelta: delta,
            unit: String(stockItem.unit || 'ks').slice(0, 20),
            unitPrice: Number(stockItem.salePrice || 0),
            documentRef: `${refPrefix} ${invoiceNumber}`.slice(0, 100),
            note: `${notePrefix} pro ${clientName}${b2bTag ? ` ${b2bTag}` : ''}`.slice(0, 300),
          },
          ['createdAt']
        )
      );
      stockMovementsCreated++;
    }
  }

  await fsCommitWrites(idToken, writes);

  return {
    status: 201,
    payload: {
      ok: true,
      event: 'ORDER_OR_INVOICE',
      invoiceId: invId,
      invoiceNumber,
      variableSymbol,
      clientId,
      clientCreated: !matchedClient,
      status: isPaidIncoming ? 'PAID' : 'ISSUED',
      totalWithoutVat: totals.totalWithoutVat,
      totalVat: totals.totalVat,
      totalWithVat: totals.totalWithVat,
      currency,
      stockMovementsCreated,
      unmatchedItemsCount,
    },
  };
}

async function handleOrderPaid(ctx, idToken, rawBody) {
  const data = extractPayloadEntity(rawBody);
  const { workspace, invoices } = ctx;
  const wsRel = `workspaces/${workspace.id}`;

  const externalId = String(
    data.externalId || data.b2bOrderId || data.orderId || data.orderNumber || ''
  ).trim();
  const invNum = String(data.invoiceNumber || '').trim();
  const vs = String(data.variableSymbol || data.vs || '').replace(/\D/g, '');
  const b2bTag = externalId ? `[B2B:${externalId}]` : '';

  const target = invoices.find(
    (inv) =>
      (b2bTag && String(inv.note || '').includes(b2bTag)) ||
      (invNum && String(inv.invoiceNumber || '').trim() === invNum) ||
      (vs && String(inv.variableSymbol || '').replace(/\D/g, '') === vs)
  );

  if (!target) {
    return { status: 404, payload: { error: 'Odpovídající faktura pro označení úhrady nebyla nalezena.' } };
  }

  const paidDate = String(data.paidDate || toIsoDate()).slice(0, 10);
  const paidAmount = round2(Number(data.paidAmount || target.totalWithVat || 0));

  await fsCommitWrites(idToken, [
    makePatchWrite(`${wsRel}/invoices/${target.id}`, {
      status: 'PAID',
      paidAmount,
      paidDate,
    }),
  ]);

  return {
    status: 200,
    payload: {
      ok: true,
      event: 'ORDER_PAID',
      invoiceId: target.id,
      invoiceNumber: target.invoiceNumber,
      status: 'PAID',
      paidAmount,
      paidDate,
    },
  };
}

async function handleOrderCancelled(ctx, idToken, rawBody) {
  const data = extractPayloadEntity(rawBody);
  const { workspace, company, warehouse, inventory, invoices } = ctx;
  const wsRel = `workspaces/${workspace.id}`;

  const externalId = String(
    data.externalId || data.b2bOrderId || data.orderId || data.orderNumber || ''
  ).trim();
  const invNum = String(data.invoiceNumber || '').trim();
  const b2bTag = externalId ? `[B2B:${externalId}]` : '';

  const target = invoices.find(
    (inv) =>
      (b2bTag && String(inv.note || '').includes(b2bTag)) ||
      (invNum && String(inv.invoiceNumber || '').trim() === invNum)
  );

  if (!target) {
    return { status: 404, payload: { error: 'Odpovídající faktura ke stornování nebyla nalezena.' } };
  }

  if (target.status === 'CANCELLED') {
    return {
      status: 200,
      payload: { ok: true, duplicate: true, invoiceId: target.id, status: 'CANCELLED' },
    };
  }

  const writes = [
    makePatchWrite(`${wsRel}/invoices/${target.id}`, {
      status: 'CANCELLED',
    }),
  ];

  let returnedMovements = 0;
  if (target.deductedFromStock && Array.isArray(target.items)) {
    const invById = new Map(inventory.map((i) => [i.id, i]));
    const returnMap = new Map();
    for (const line of target.items) {
      if (line.inventoryItemId && invById.has(line.inventoryItemId) && Number(line.quantity || 0) > 0) {
        returnMap.set(
          line.inventoryItemId,
          round2((returnMap.get(line.inventoryItemId) || 0) + Number(line.quantity || 0))
        );
      }
    }
    for (const [itemId, qty] of returnMap.entries()) {
      const card = invById.get(itemId);
      if (!card) continue;
      writes.push(
        makePatchWrite(`${wsRel}/inventory/${itemId}`, {
          quantity: round2(Number(card.quantity || 0) + qty),
        })
      );
      const movId = generateFirestoreId('mov');
      writes.push(
        makeSetWrite(
          `${wsRel}/stockMovements/${movId}`,
          {
            workspaceId: workspace.id,
            memberEmails: workspace.memberEmails,
            itemId,
            itemName: String(card.name || '').slice(0, 200),
            itemSku: String(card.sku || '').slice(0, 64),
            warehouseId: card.warehouseId || warehouse.id,
            companyId: target.companyId || company.id,
            movementType: 'RECEIPT',
            quantityDelta: qty,
            unit: String(card.unit || 'ks').slice(0, 20),
            unitPrice: Number(card.purchasePrice || 0),
            documentRef: `STORNO ${target.invoiceNumber || ''}`.trim().slice(0, 100),
            note: `B2B storno objednávky${b2bTag ? ` ${b2bTag}` : ''}`.slice(0, 300),
          },
          ['createdAt']
        )
      );
      returnedMovements++;
    }
  }

  await fsCommitWrites(idToken, writes);

  return {
    status: 200,
    payload: {
      ok: true,
      event: 'ORDER_CANCELLED',
      invoiceId: target.id,
      invoiceNumber: target.invoiceNumber,
      status: 'CANCELLED',
      returnedMovements,
    },
  };
}

async function handleStockMovements(ctx, idToken, rawBody) {
  const data = extractPayloadEntity(rawBody);
  const { workspace, company, warehouse, inventory } = ctx;
  const wsRel = `workspaces/${workspace.id}`;

  const list =
    (Array.isArray(data.movements) && data.movements) ||
    (Array.isArray(data.items) && data.items) ||
    (data.sku || data.ean || data.name || data.itemId ? [data] : []);

  if (list.length === 0) {
    return { status: 400, payload: { error: 'Chybí seznam skladových pohybů (movements / items).' } };
  }

  const targetWhItems = inventory.filter((i) => i.warehouseId === warehouse.id);
  const otherWhItems = inventory.filter((i) => i.warehouseId !== warehouse.id);
  const preferredIdx = buildInventoryIndex(targetWhItems);
  const fallbackIdx = buildInventoryIndex(otherWhItems);

  const writes = [];
  const runningQty = new Map();
  let processed = 0;
  let skippedUnmatched = 0;
  let skippedFees = 0;

  for (const row of list.slice(0, 100)) {
    const name = String(row.name || row.itemName || '').trim();
    const sku = String(row.sku || row.itemSku || '').trim();
    if (isNonStockRecyclingFee(name, sku)) {
      skippedFees++;
      continue;
    }

    const card = matchInventoryItem(
      { inventoryItemId: row.itemId || row.inventoryItemId, ean: row.ean, sku, name },
      preferredIdx,
      fallbackIdx
    );
    if (!card) {
      skippedUnmatched++;
      continue;
    }

    const rawType = String(row.movementType || row.type || data.event || '')
      .trim()
      .toUpperCase();
    let delta = round2(Number(row.quantityDelta ?? row.delta ?? row.quantity ?? 0));
    if (!Number.isFinite(delta) || delta === 0) continue;

    if ((rawType.includes('OUT') || rawType.includes('ISSUE')) && delta > 0) {
      delta = -delta;
    } else if ((rawType.includes('IN') || rawType.includes('RECEIPT')) && delta < 0) {
      delta = Math.abs(delta);
    }

    const movementType =
      rawType === 'ADJUSTMENT' || rawType.includes('ADJUST')
        ? 'ADJUSTMENT'
        : delta > 0
          ? 'RECEIPT'
          : 'ISSUE';

    const currentQty = runningQty.has(card.id)
      ? runningQty.get(card.id)
      : Number(card.quantity || 0);
    const nextQty = round2(currentQty + delta);
    runningQty.set(card.id, nextQty);

    writes.push(
      makePatchWrite(`${wsRel}/inventory/${card.id}`, {
        quantity: nextQty,
      })
    );

    const movId = generateFirestoreId('mov');
    writes.push(
      makeSetWrite(
        `${wsRel}/stockMovements/${movId}`,
        {
          workspaceId: workspace.id,
          memberEmails: workspace.memberEmails,
          itemId: card.id,
          itemName: String(card.name || name).slice(0, 200),
          itemSku: String(card.sku || sku).slice(0, 64),
          warehouseId: card.warehouseId || warehouse.id,
          companyId: company.id,
          movementType,
          quantityDelta: delta,
          unit: String(row.unit || card.unit || 'ks').slice(0, 20),
          unitPrice: Math.max(
            0,
            round2(Number(row.unitPrice ?? (delta > 0 ? card.purchasePrice : card.salePrice) ?? 0))
          ),
          documentRef: String(row.documentRef || data.documentRef || 'B2B pohyb').slice(0, 100),
          note: String(row.note || data.note || 'Automatický skladový pohyb z Nerx B2B').slice(0, 300),
        },
        ['createdAt']
      )
    );
    processed++;
  }

  if (writes.length > 0) {
    await fsCommitWrites(idToken, writes);
  }

  return {
    status: 200,
    payload: {
      ok: true,
      event: 'STOCK_MOVEMENT',
      processed,
      skippedUnmatched,
      skippedFees,
    },
  };
}

// =============================================================================
// Unified Express / Vercel HTTP Handler
// =============================================================================

export async function handleB2bWebhookRequest(req, res) {
  // Never emit wildcard CORS on an authenticated webhook endpoint
  res.setHeader('Cache-Control', 'no-store');

  // Lightweight non-sensitive readiness check for the Settings UI (booleans only, no secrets)
  if (req.method === 'GET' && getQueryParam(req, 'check') === 'config') {
    res.status(200).json({
      tokenConfigured: Boolean(String(process.env.B2B_WEBHOOK_TOKEN || '').trim()),
      firebaseSyncConfigured: Boolean(
        String(process.env.FIREBASE_SYNC_EMAIL || '').trim() &&
          String(process.env.FIREBASE_SYNC_PASSWORD || '').trim()
      ),
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Metoda není povolena. Použijte GET nebo POST.' });
    return;
  }

  const authCheck = verifyWebhookAuth(req);
  if (!authCheck.ok) {
    res.status(authCheck.status).json({ error: authCheck.error });
    return;
  }

  try {
    const { idToken, email } = await getFirebaseIdToken();
    const body = req.method === 'POST' ? parseBody(req.body) : {};
    const overrides = {
      workspaceId: body.workspaceId || getQueryParam(req, 'workspaceId'),
      companyId: body.companyId || getQueryParam(req, 'companyId'),
      warehouseId: body.warehouseId || getQueryParam(req, 'warehouseId'),
    };

    const ctx = await resolveWorkspaceContext(idToken, email, overrides);

    if (req.method === 'GET') {
      const action = getQueryParam(req, 'action').toLowerCase();
      if (action === 'inventory') {
        const whFilter = getQueryParam(req, 'warehouseId').trim();
        const items = ctx.inventory
          .filter((i) => !whFilter || i.warehouseId === whFilter)
          .map((i) => ({
            id: i.id,
            sku: i.sku || '',
            ean: i.ean || '',
            name: i.name || '',
            category: i.category || '',
            quantity: Number(i.quantity || 0),
            unit: i.unit || 'ks',
            salePrice: Number(i.salePrice || 0),
            vatRate: Number(i.vatRate ?? 21),
            warehouseId: i.warehouseId || '',
          }));
        res.status(200).json({
          ok: true,
          workspaceId: ctx.workspace.id,
          count: items.length,
          items,
        });
        return;
      }

      res.status(200).json({
        ok: true,
        connected: true,
        workspaceId: ctx.workspace.id,
        workspaceName: ctx.workspace.name || '',
        companyId: ctx.company.id,
        companyName: ctx.company.name || '',
        warehouseId: ctx.warehouse.id,
        warehouseName: ctx.warehouse.name || '',
        inventoryCount: ctx.inventory.length,
        invoiceCount: ctx.invoices.length,
        clientCount: ctx.clients.length,
      });
      return;
    }

    const eventType = detectEventType(body);
    if (eventType === 'PING') {
      res.status(200).json({
        ok: true,
        event: 'PING',
        workspaceId: ctx.workspace.id,
        companyId: ctx.company.id,
        warehouseId: ctx.warehouse.id,
      });
      return;
    }

    let result;
    if (eventType === 'STOCK_MOVEMENT') {
      result = await handleStockMovements(ctx, idToken, body);
    } else if (eventType === 'ORDER_PAID') {
      result = await handleOrderPaid(ctx, idToken, body);
    } else if (eventType === 'ORDER_CANCELLED') {
      result = await handleOrderCancelled(ctx, idToken, body);
    } else {
      result = await handleOrderOrInvoice(ctx, idToken, body);
    }

    res.status(result.status).json(result.payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'neznámá chyba';
    res.status(500).json({ error: `B2B webhook selhal: ${message}` });
  }
}
