import type { Timestamp } from 'firebase/firestore';

export type TeamRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type MovementType = 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT';
export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CARD';
export type InvoiceStatus = 'ISSUED' | 'PAID' | 'CANCELLED';
export type BankMatchStatus = 'UNMATCHED' | 'MATCHED' | 'IGNORED';
export type BankTxSource = 'FIO_API' | 'GPC_IMPORT' | 'CSV_IMPORT' | 'MANUAL';
export type InvoiceTemplateId = 'CLASSIC' | 'MODERN_BANNER' | 'MINIMAL' | 'EXECUTIVE_SIDEBAR';
export type PohodaExportScope = 'INVOICES' | 'STOCK' | 'BOTH';

export interface Workspace {
  id: string;
  ownerUid: string;
  ownerEmail: string;
  name: string;
  memberEmails: string[];
  adminEmails: string[];
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface TeamMember {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: TeamRole;
  memberEmails: string[];
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface Company {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  name: string;
  ico: string;
  dic: string;
  street: string;
  city: string;
  zip: string;
  bankName: string;
  bankAccount: string;
  iban: string;
  bic: string;
  fioApiToken: string;
  lastBankSyncAt: string;
  email: string;
  phone: string;
  invoicePrefix: string;
  nextInvoiceNumber: number;
  vatPayer: boolean;
  accentIndex: number;
  invoiceTemplate: InvoiceTemplateId;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface Warehouse {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  name: string;
  code: string;
  shared: boolean;
  ownerCompanyId: string;
  location: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface InventoryItem {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  sku: string;
  name: string;
  ean: string;
  category: string;
  unit: string;
  quantity: number;
  minQuantity: number;
  purchasePrice: number;
  salePrice: number;
  vatRate: number;
  warehouseId: string;
  supplierName: string;
  notes: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface StockMovement {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  itemId: string;
  itemName: string;
  itemSku: string;
  warehouseId: string;
  companyId: string;
  movementType: MovementType;
  quantityDelta: number;
  unit: string;
  unitPrice: number;
  documentRef: string;
  note: string;
  createdAt?: Timestamp | null;
}

export interface Client {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  name: string;
  ico: string;
  dic: string;
  street: string;
  city: string;
  zip: string;
  country: string;
  email: string;
  phone: string;
  bankAccount: string;
  notes: string;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface InvoiceLineItem {
  inventoryItemId: string;
  warehouseId: string;
  sku: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  vatRate: number;
  discountPercent: number;
}

export type InvoiceDocumentType = 'INVOICE' | 'PROFORMA' | 'QUOTE' | 'CREDIT_NOTE';
export type RecurringInterval = 'NONE' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export interface Invoice {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  companyId: string;
  companyName: string;
  companyIco: string;
  companyDic: string;
  companyAddress: string;
  companyBankAccount: string;
  companyIban: string;
  invoiceNumber: string;
  variableSymbol: string;
  documentType?: InvoiceDocumentType;
  reverseCharge?: boolean;
  relatedInvoiceNumber?: string;
  recurringInterval?: RecurringInterval;
  reminderCount?: number;
  lastReminderDate?: string;
  clientEmail?: string;
  issueDate: string;
  taxDate: string;
  dueDate: string;
  paymentMethod: PaymentMethod;
  status: InvoiceStatus;
  clientId: string;
  clientName: string;
  clientIco: string;
  clientDic: string;
  clientStreet: string;
  clientCity: string;
  clientZip: string;
  currency: string;
  exchangeRate?: number;
  legalNotice?: string;
  sentAt?: string;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
  paidAmount: number;
  paidDate: string;
  matchedTransactionId: string;
  note: string;
  deductedFromStock: boolean;
  exportedToPohoda: boolean;
  invoiceTemplate?: InvoiceTemplateId;
  items: InvoiceLineItem[];
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface BankTransaction {
  id: string;
  workspaceId: string;
  memberEmails: string[];
  companyId: string;
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  variableSymbol: string;
  counterpartyName: string;
  counterpartyAccount: string;
  message: string;
  matchedInvoiceId: string;
  matchedInvoiceNumber: string;
  matchStatus: BankMatchStatus;
  source: BankTxSource;
  createdAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
}

export interface ParsedBankTx {
  externalId: string;
  date: string;
  amount: number;
  currency: string;
  variableSymbol: string;
  counterpartyName: string;
  counterpartyAccount: string;
  message: string;
  source: BankTxSource;
}

export interface ExtractedLineItem {
  id: string;
  sku: string;
  name: string;
  ean: string;
  category?: string;
  quantity: number;
  unit: string;
  originalPurchasePrice?: number;
  purchasePrice: number;
  suggestedSalePrice: number;
  vatRate: number;
  selected: boolean;
  matchedInventoryId?: string | null;
  matchedItemName?: string | null;
  matchedOtherWarehouseId?: string | null;
  manualMatchLock?: boolean;
}

export interface ExtractedDeliveryNote {
  supplierName: string;
  supplierIco: string;
  documentNumber: string;
  documentType: string;
  currency?: string;
  exchangeRate?: number;
  exchangeRateSource?: 'CZK' | 'CNB' | 'DOKLAD' | 'MANUAL';
  exchangeRateDate?: string;
  cnbRate?: number;
  items: ExtractedLineItem[];
}

export interface AresSubject {
  ico: string;
  dic: string;
  name: string;
  street: string;
  city: string;
  zip: string;
  legalForm: string;
}

export interface CompanyBrandPalette {
  index: number;
  nameCz: string;
  primary: string;
  dark: string;
  soft: string;
  border: string;
}

export const COMPANY_BRAND_PALETTES: CompanyBrandPalette[] = [
  { index: 0, nameCz: 'Smaragdová', primary: '#047857', dark: '#064E3B', soft: '#ECFDF5', border: '#A7F3D0' },
  { index: 1, nameCz: 'Kobaltová', primary: '#1D4ED8', dark: '#1E3A8A', soft: '#EFF6FF', border: '#BFDBFE' },
  { index: 2, nameCz: 'Jantarová', primary: '#B45309', dark: '#78350F', soft: '#FFFBEB', border: '#FDE68A' },
  { index: 3, nameCz: 'Fialová', primary: '#7C3AED', dark: '#4C1D95', soft: '#F5F3FF', border: '#DDD6FE' },
  { index: 4, nameCz: 'Petrolejová', primary: '#0F766E', dark: '#134E4A', soft: '#F0FDFA', border: '#99F6E4' },
  { index: 5, nameCz: 'Námořnická', primary: '#1E3F5E', dark: '#0F2942', soft: '#F1F5F9', border: '#CBD5E1' },
];

export const INVOICE_TEMPLATES: {
  id: InvoiceTemplateId;
  labelCz: string;
  subtitleCz: string;
}[] = [
  { id: 'CLASSIC', labelCz: 'Klasická', subtitleCz: 'Tradiční čistá česká faktura s výraznou linkou' },
  { id: 'MODERN_BANNER', labelCz: 'Moderní pruh', subtitleCz: 'Barevná horní lišta podle firemního odstínu' },
  { id: 'MINIMAL', labelCz: 'Minimalistická', subtitleCz: 'Vzdušné typografické rozvržení bez rámů' },
  { id: 'EXECUTIVE_SIDEBAR', labelCz: 'Manažerský sloupec', subtitleCz: 'Vertikální akcent a zvýrazněné shrnutí úhrady' },
];

export type AppSection =
  | 'dashboard'
  | 'inventory'
  | 'smart-stock-in'
  | 'invoices'
  | 'bank-matching'
  | 'clients'
  | 'reports'
  | 'alerts'
  | 'settings';
