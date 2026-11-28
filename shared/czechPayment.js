/**
 * Czech payment helpers shared by the SkladFaktura UI PDF and the B2B webhook.
 * czechAccountToIban / buildCzechSpdQr match src/lib/format.ts.
 */

export function czechAccountToIban(bankAccount) {
  const trimmed = String(bankAccount || '').replace(/\s+/g, '').trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase().startsWith('CZ') && trimmed.length === 24) {
    return trimmed.toUpperCase();
  }
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const bankCode = parts[1].replace(/\D/g, '');
  if (bankCode.length !== 4) return null;

  const numParts = parts[0].split('-');
  let prefix = '';
  let accNum = '';
  if (numParts.length === 1) {
    accNum = numParts[0].replace(/\D/g, '');
  } else if (numParts.length === 2) {
    prefix = numParts[0].replace(/\D/g, '');
    accNum = numParts[1].replace(/\D/g, '');
  } else {
    return null;
  }

  if (!accNum || accNum.length > 10 || prefix.length > 6) return null;
  const bban = bankCode.padStart(4, '0') + prefix.padStart(6, '0') + accNum.padStart(10, '0');
  const rearranged = `${bban}123500`;
  const remainder = Number(BigInt(rearranged) % 97n);
  const checkDigits = String(98 - remainder).padStart(2, '0');
  return `CZ${checkDigits}${bban}`;
}

/**
 * Czech Short Payment Descriptor (QR Platba / SPAYD 1.0).
 * Same field order and normalisation as the on-screen invoice.
 */
export function buildCzechSpdQr(params) {
  const converted = czechAccountToIban(params.iban) || params.iban;
  const cleanIban = String(converted || '').replace(/\s+/g, '').toUpperCase();
  if (cleanIban.length < 15) return null;

  const amount = Math.max(0, Number(params.amount) || 0).toFixed(2);
  const vs = String(params.variableSymbol || '').replace(/\D/g, '').slice(0, 10);
  const currency = String(params.currency || 'CZK').trim().toUpperCase().slice(0, 3) || 'CZK';
  const msg = String(params.message || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\*/g, ' ')
    .slice(0, 60);

  const parts = ['SPD*1.0', `ACC:${cleanIban}`, `AM:${amount}`, `CC:${currency}`];
  if (vs) parts.push(`X-VS:${vs}`);
  if (params.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(params.dueDate)) {
    parts.push(`DT:${params.dueDate.replace(/-/g, '')}`);
  }
  if (msg) parts.push(`MSG:${msg}`);
  return parts.join('*');
}

/**
 * Supplier account + IBAN shown on the invoice and returned to the B2B portal.
 * Prefers the snapshot stored on the invoice, then the company card, then
 * a Czech account→IBAN conversion (same order as the on-screen document).
 */
export function resolveSupplierPayment(invoice, company) {
  const supplierAccount = String(
    (invoice && invoice.companyBankAccount) || (company && company.bankAccount) || ''
  ).trim();
  const explicit = String((invoice && invoice.companyIban) || (company && company.iban) || '')
    .replace(/\s+/g, '')
    .toUpperCase();
  const supplierIban = explicit || czechAccountToIban(supplierAccount) || '';
  return {
    supplierAccount: supplierAccount.slice(0, 40),
    supplierIban: supplierIban.slice(0, 64),
  };
}
