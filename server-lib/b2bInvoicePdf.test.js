import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { czechAccountToIban } from '../shared/czechPayment.js';
import { handleB2bWebhookRequest } from './b2bWebhook.js';

const ORIGINAL_TOKEN = process.env.B2B_WEBHOOK_TOKEN;
const TEST_TOKEN = 'unit-test-token';

before(() => {
  process.env.B2B_WEBHOOK_TOKEN = TEST_TOKEN;
});

after(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.B2B_WEBHOOK_TOKEN;
  else process.env.B2B_WEBHOOK_TOKEN = ORIGINAL_TOKEN;
});

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
  };
}

function companyFixture(overrides = {}) {
  return {
    id: 'company_1',
    name: 'Venix Trade s.r.o.',
    vatPayer: true,
    accentIndex: 0,
    bankAccount: '19-2000145399/0800',
    iban: '',
    invoicePrefix: 'FA',
    nextInvoiceNumber: 42,
    street: 'Dlouhá 12',
    city: 'Praha',
    zip: '110 00',
    ico: '12345678',
    dic: 'CZ12345678',
    ...overrides,
  };
}

function invoiceFixture(overrides = {}) {
  return {
    id: 'inv_test_1',
    workspaceId: 'ws1',
    companyId: 'company_1',
    companyName: 'Venix Trade s.r.o.',
    companyIco: '12345678',
    companyDic: 'CZ12345678',
    companyAddress: 'Dlouhá 12, 110 00 Praha',
    companyBankAccount: '19-2000145399/0800',
    companyIban: '',
    invoiceNumber: 'FA20260042',
    variableSymbol: '20260042',
    documentType: 'INVOICE',
    invoiceTemplate: 'CLASSIC',
    issueDate: '2026-11-28',
    taxDate: '2026-11-28',
    dueDate: '2026-12-12',
    paymentMethod: 'BANK_TRANSFER',
    status: 'ISSUED',
    clientName: 'Odběratel Žluťoučký s.r.o.',
    clientIco: '87654321',
    clientDic: 'CZ87654321',
    clientStreet: 'Krátká 5',
    clientCity: 'Brno',
    clientZip: '602 00',
    currency: 'CZK',
    totalWithoutVat: 100,
    totalVat: 21,
    totalWithVat: 121,
    paidAmount: 0,
    note: 'Poznámka s diakritikou: příliš žluťoučký kůň [B2B:ORD-77]',
    items: [
      {
        sku: 'ELQ-1',
        name: 'E-liquid Třešeň 10 ml',
        quantity: 2,
        unit: 'ks',
        unitPrice: 50,
        vatRate: 21,
        discountPercent: 0,
      },
    ],
    ...overrides,
  };
}

function ctxFixture(invoices, company = companyFixture()) {
  return {
    workspace: { id: 'ws1', name: 'Sklad', memberEmails: ['sync@example.com'] },
    company,
    warehouse: { id: 'shared_main', name: 'Hlavní sklad' },
    inventory: [],
    clients: [],
    invoices,
  };
}

function runtimeFor(ctx, extra = {}) {
  return {
    getFirebaseIdToken: async () => ({ idToken: 'test-id-token', email: 'sync@example.com' }),
    resolveWorkspaceContext: async () => ctx,
    commitWrites: async () => {},
    ...extra,
  };
}

function pdfRequest(query, headers = {}) {
  const params = new URLSearchParams({ action: 'invoice-pdf', ...query });
  return {
    method: 'GET',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, host: 'sklad-faktura-web.vercel.app', ...headers },
    query: { action: 'invoice-pdf', ...query },
    url: `/api/b2b-webhook?${params.toString()}`,
  };
}

test('czech account converts to the canonical IBAN', () => {
  assert.equal(czechAccountToIban('19-2000145399/0800'), 'CZ6508000000192000145399');
});

test('invoice-pdf without a token is 401 and does not touch Firebase', async () => {
  let touched = false;
  const res = mockRes();
  await handleB2bWebhookRequest(
    { method: 'GET', headers: {}, query: { action: 'invoice-pdf', invoiceId: 'inv_test_1' } },
    res,
    {
      getFirebaseIdToken: async () => {
        touched = true;
        throw new Error('should not authenticate');
      },
    }
  );
  assert.equal(res.statusCode, 401);
  assert.equal(touched, false);
  assert.match(String(res.body && res.body.error), /autoriza/i);
});

test('invoice-pdf with a wrong token is 401', async () => {
  const res = mockRes();
  await handleB2bWebhookRequest(
    {
      method: 'GET',
      headers: { authorization: 'Bearer not-the-token' },
      query: { action: 'invoice-pdf', invoiceId: 'inv_test_1' },
    },
    res
  );
  assert.equal(res.statusCode, 401);
});

test('invoice-pdf is 404 when the invoice is missing', async () => {
  let rendered = false;
  const res = mockRes();
  await handleB2bWebhookRequest(pdfRequest({ invoiceId: 'missing' }), res, runtimeFor(ctxFixture([]), {
    generateInvoicePdfBytes: async () => {
      rendered = true;
      return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  }));
  assert.equal(res.statusCode, 404);
  assert.equal(rendered, false);
});

test('invoice-pdf is 404 when the invoice belongs to another company', async () => {
  const res = mockRes();
  await handleB2bWebhookRequest(
    pdfRequest({ invoiceId: 'inv_other' }),
    res,
    runtimeFor(ctxFixture([invoiceFixture({ id: 'inv_other', companyId: 'other_company' })]))
  );
  assert.equal(res.statusCode, 404);
});

test('invoice-pdf returns application/pdf for an invoice in the workspace', async () => {
  const res = mockRes();
  await handleB2bWebhookRequest(
    pdfRequest({ invoiceId: 'inv_test_1' }),
    res,
    runtimeFor(ctxFixture([invoiceFixture()]))
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.match(String(res.headers['content-disposition']), /^inline; filename="FA20260042\.pdf"/);
  const buf = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  const doc = await PDFDocument.load(buf);
  assert.equal(doc.getPageCount(), 1);
  assert.ok(buf.length > 2000);
});

test('invoice-pdf accepts the external B2B orderId and invoiceNumber', async () => {
  const ctx = ctxFixture([invoiceFixture()]);
  const stub = async () => new Uint8Array(Buffer.from('%PDF-1.4\n'));
  const byOrder = mockRes();
  await handleB2bWebhookRequest(
    pdfRequest({ orderId: 'ORD-77' }, { 'x-api-key': TEST_TOKEN, authorization: '' }),
    byOrder,
    runtimeFor(ctx, { generateInvoicePdfBytes: stub })
  );
  assert.equal(byOrder.statusCode, 200);
  assert.equal(byOrder.headers['content-type'], 'application/pdf');

  const byNumber = mockRes();
  await handleB2bWebhookRequest(
    pdfRequest({ invoiceNumber: 'FA20260042' }),
    byNumber,
    runtimeFor(ctx, { generateInvoicePdfBytes: stub })
  );
  assert.equal(byNumber.statusCode, 200);
  assert.match(String(byNumber.headers['content-disposition']), /filename="FA20260042\.pdf"/);
});

test('invoice-pdf without an identifier is 400', async () => {
  const res = mockRes();
  await handleB2bWebhookRequest(pdfRequest({}), res, runtimeFor(ctxFixture([invoiceFixture()])));
  assert.equal(res.statusCode, 400);
});

test('order.created 201 and duplicate 200 include the PDF URL and supplier account', async () => {
  const company = companyFixture();
  const created = mockRes();
  await handleB2bWebhookRequest(
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        host: 'internal.local',
        'x-forwarded-host': 'sklad-faktura-web.vercel.app',
      },
      query: {},
      body: {
        event: 'order.created',
        items: [{ name: 'Zboží česnek', quantity: 1, unitPrice: 100, vatRate: 21 }],
      },
    },
    created,
    runtimeFor(ctxFixture([], company))
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.supplierAccount, '19-2000145399/0800');
  assert.equal(created.body.supplierIban, 'CZ6508000000192000145399');
  assert.equal(created.body.invoiceId.length > 0, true);
  assert.equal(
    created.body.invoicePdfUrl,
    `https://sklad-faktura-web.vercel.app/api/b2b-webhook?action=invoice-pdf&invoiceId=${encodeURIComponent(created.body.invoiceId)}`
  );
  assert.equal(created.body.invoicePdfUrl.includes(TEST_TOKEN), false);

  const duplicate = mockRes();
  await handleB2bWebhookRequest(
    {
      method: 'POST',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, host: 'sklad-faktura-web.vercel.app' },
      query: {},
      body: {
        event: 'order.created',
        externalId: 'ORD-77',
        items: [{ name: 'Zboží', quantity: 1, unitPrice: 10 }],
      },
    },
    duplicate,
    runtimeFor(ctxFixture([invoiceFixture()], company))
  );
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.invoiceId, 'inv_test_1');
  assert.equal(
    duplicate.body.invoicePdfUrl,
    'https://sklad-faktura-web.vercel.app/api/b2b-webhook?action=invoice-pdf&invoiceId=inv_test_1'
  );
  assert.equal(duplicate.body.supplierIban, 'CZ6508000000192000145399');
  assert.equal(duplicate.body.supplierAccount, '19-2000145399/0800');
});

test('a long invoice still produces a valid multi-page PDF', async () => {
  const { generateInvoicePdfBytes } = await import('../shared/invoicePdf.js');
  const { loadNodeInvoiceFonts } = await import('../shared/loadNodeFonts.js');
  const invoice = invoiceFixture({
    items: Array.from({ length: 32 }, (_, i) => ({
      sku: `SKU-${i + 1}`,
      name: `Položka ${i + 1} žluťoučká`,
      quantity: 1,
      unit: 'ks',
      unitPrice: 10,
      vatRate: 21,
      discountPercent: 0,
    })),
  });
  const bytes = await generateInvoicePdfBytes(invoice, companyFixture(), null, loadNodeInvoiceFonts());
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2);
});
