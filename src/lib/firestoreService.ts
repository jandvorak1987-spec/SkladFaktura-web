import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentReference,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import type {
  BankTransaction,
  Client,
  Company,
  ExtractedLineItem,
  InventoryItem,
  Invoice,
  InvoiceLineItem,
  InvoiceTemplateId,
  ParsedBankTx,
  PaymentMethod,
  TeamMember,
  Workspace,
} from '../types';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  calculateInvoiceTotals,
  czechAccountToIban,
  formatCompanyAddress,
  hasAdminRights,
  nowSyncLabel,
  round2,
  toIsoDate,
} from './format';
import { findBestMatchingInvoice } from './bankParser';

function normalizeEmail(user: User): string {
  return (user.email || '').trim().toLowerCase();
}

function wsRoot(workspaceId: string) {
  return doc(db, 'workspaces', workspaceId);
}

/**
 * Discovers the user's shared Android/Web workspace (by `memberEmails` array-contains)
 * or initializes a new workspace matching ErpRepository.ensureWorkspaceInitialized().
 */
export async function ensureSharedWorkspace(user: User): Promise<Workspace> {
  const email = normalizeEmail(user);
  const uid = user.uid;
  const displayName = (user.displayName || email.split('@')[0] || 'Vlastník').trim().slice(0, 120);
  const path = 'workspaces';

  try {
    const snap = await getDocs(
      query(collection(db, 'workspaces'), where('memberEmails', 'array-contains', email))
    );
    const list = snap.docs.map(
      (d) => ({ id: d.id, ...(d.data() as Omit<Workspace, 'id'>) }) as Workspace
    );

    const chosen =
      list.find((w) => w.ownerUid !== uid) || list.find((w) => w.ownerUid === uid) || null;

    if (chosen) {
      await ensureDefaultEntitiesExist(chosen, email, displayName);
      return chosen;
    }

    const wsId = `ws_${uid}`;
    const members = [email];
    const admins = [email];

    await setDoc(wsRoot(wsId), {
      ownerUid: uid,
      ownerEmail: email,
      name: 'Společný sklad & fakturace',
      memberEmails: members,
      adminEmails: admins,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const created: Workspace = {
      id: wsId,
      ownerUid: uid,
      ownerEmail: email,
      name: 'Společný sklad & fakturace',
      memberEmails: members,
      adminEmails: admins,
    };
    await ensureDefaultEntitiesExist(created, email, displayName);
    return created;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

async function ensureDefaultEntitiesExist(
  workspace: Workspace,
  email: string,
  ownerDisplayName: string
): Promise<void> {
  if (!hasAdminRights(workspace, email)) return;

  const root = wsRoot(workspace.id);
  const members = workspace.memberEmails.length > 0 ? workspace.memberEmails : [email];

  const [existingCompanies, existingWarehouses, existingTeam] = await Promise.all([
    getDocs(query(collection(root, 'companies'), where('memberEmails', 'array-contains', email))),
    getDocs(query(collection(root, 'warehouses'), where('memberEmails', 'array-contains', email))),
    getDocs(query(collection(root, 'teamMembers'), where('memberEmails', 'array-contains', email))),
  ]);

  const batch = writeBatch(db);
  let hasWrites = false;

  if (existingTeam.empty) {
    hasWrites = true;
    batch.set(doc(root, 'teamMembers', 'owner'), {
      workspaceId: workspace.id,
      email: workspace.ownerEmail.toLowerCase(),
      displayName: ownerDisplayName || 'Vlastník',
      role: 'OWNER',
      memberEmails: members,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  if (existingCompanies.empty) {
    hasWrites = true;
    batch.set(doc(root, 'companies', 'company_1'), {
      workspaceId: workspace.id,
      memberEmails: members,
      name: 'Firma A s.r.o.',
      ico: '',
      dic: '',
      street: '',
      city: '',
      zip: '',
      bankName: 'Fio banka',
      bankAccount: '',
      iban: '',
      bic: '',
      fioApiToken: '',
      lastBankSyncAt: '',
      email,
      phone: '',
      invoicePrefix: String(new Date().getFullYear()),
      nextInvoiceNumber: 1,
      vatPayer: true,
      accentIndex: 0,
      invoiceTemplate: 'CLASSIC',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    batch.set(doc(root, 'companies', 'company_2'), {
      workspaceId: workspace.id,
      memberEmails: members,
      name: 'Firma B s.r.o.',
      ico: '',
      dic: '',
      street: '',
      city: '',
      zip: '',
      bankName: 'Fio banka',
      bankAccount: '',
      iban: '',
      bic: '',
      fioApiToken: '',
      lastBankSyncAt: '',
      email,
      phone: '',
      invoicePrefix: `B${new Date().getFullYear()}`,
      nextInvoiceNumber: 1,
      vatPayer: true,
      accentIndex: 1,
      invoiceTemplate: 'MODERN_BANNER',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  if (existingWarehouses.empty) {
    hasWrites = true;
    batch.set(doc(root, 'warehouses', 'shared_main'), {
      workspaceId: workspace.id,
      memberEmails: members,
      name: 'Společný hlavní sklad',
      code: 'SKLAD-SPOL',
      shared: true,
      ownerCompanyId: '',
      location: 'Sdílený sklad pro obě firmy',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(root, 'warehouses', 'wh_company_1'), {
      workspaceId: workspace.id,
      memberEmails: members,
      name: 'Oddělený sklad – Firma A',
      code: 'SKLAD-FA',
      shared: false,
      ownerCompanyId: 'company_1',
      location: 'Vyhrazeno pro Firma A',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(root, 'warehouses', 'wh_company_2'), {
      workspaceId: workspace.id,
      memberEmails: members,
      name: 'Oddělený sklad – Firma B',
      code: 'SKLAD-FB',
      shared: false,
      ownerCompanyId: 'company_2',
      location: 'Vyhrazeno pro Firma B',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  if (hasWrites) {
    await batch.commit();
  }
}

// =============================================================================
// TEAM & ROLE MANAGEMENT (Matches ErpRepository.kt verbatim)
// =============================================================================
async function syncMemberEmailsAcrossWorkspace(
  workspaceId: string,
  callerEmail: string,
  newMemberEmails: string[]
): Promise<void> {
  const root = wsRoot(workspaceId);
  const collsWithUpdatedAt = [
    'teamMembers',
    'companies',
    'warehouses',
    'inventory',
    'clients',
    'invoices',
    'bankTransactions',
  ];

  const refsWithTs: DocumentReference[] = [];
  for (const name of collsWithUpdatedAt) {
    const snap = await getDocs(
      query(collection(root, name), where('memberEmails', 'array-contains', callerEmail))
    );
    snap.docs.forEach((d) => refsWithTs.push(d.ref));
  }

  for (let i = 0; i < refsWithTs.length; i += 400) {
    const batch = writeBatch(db);
    refsWithTs.slice(i, i + 400).forEach((ref) => {
      batch.update(ref, {
        memberEmails: newMemberEmails,
        updatedAt: serverTimestamp(),
      });
    });
    await batch.commit();
  }

  // stockMovements has no updatedAt field (matches firestore.rules)
  const movSnap = await getDocs(
    query(collection(root, 'stockMovements'), where('memberEmails', 'array-contains', callerEmail))
  );
  const movRefs = movSnap.docs.map((d) => d.ref);
  for (let i = 0; i < movRefs.length; i += 400) {
    const batch = writeBatch(db);
    movRefs.slice(i, i + 400).forEach((ref) => {
      batch.update(ref, { memberEmails: newMemberEmails });
    });
    await batch.commit();
  }
}

export async function addColleague(params: {
  workspace: Workspace;
  currentMembers: TeamMember[];
  callerEmail: string;
  displayName: string;
  emailInput: string;
  grantAdmin: boolean;
}): Promise<void> {
  const { workspace, currentMembers, callerEmail, displayName, emailInput, grantAdmin } = params;
  const myEmail = callerEmail.trim().toLowerCase();
  if (!hasAdminRights(workspace, myEmail)) {
    throw new Error('Pouze administrátor může přidávat kolegy.');
  }

  const cleanEmail = emailInput.trim().toLowerCase();
  if (!cleanEmail.includes('@') || !cleanEmail.includes('.')) {
    throw new Error('Zadejte platný e-mail kolegy.');
  }
  const nonOwnerCount = currentMembers.filter((m) => m.role !== 'OWNER').length;
  if (nonOwnerCount >= 3) {
    throw new Error('Maximální počet přidaných kolegů je 3 (celkem 4 uživatelé včetně vlastníka).');
  }
  if (workspace.memberEmails.some((e) => e.toLowerCase() === cleanEmail)) {
    throw new Error(`Kolega s e-mailem ${cleanEmail} už v týmu je.`);
  }

  const cleanName = (displayName.trim() || cleanEmail.split('@')[0]).slice(0, 120);
  const updatedMembers = Array.from(
    new Set([...workspace.memberEmails.map((e) => e.toLowerCase()), cleanEmail])
  );
  const updatedAdmins = grantAdmin
    ? Array.from(new Set([...workspace.adminEmails.map((e) => e.toLowerCase()), cleanEmail]))
    : Array.from(new Set(workspace.adminEmails.map((e) => e.toLowerCase())));

  const root = wsRoot(workspace.id);
  try {
    await updateDoc(root, {
      memberEmails: updatedMembers,
      adminEmails: updatedAdmins,
      updatedAt: serverTimestamp(),
    });

    const memberRef = doc(collection(root, 'teamMembers'));
    await setDoc(memberRef, {
      workspaceId: workspace.id,
      email: cleanEmail,
      displayName: cleanName,
      role: grantAdmin ? 'ADMIN' : 'MEMBER',
      memberEmails: updatedMembers,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await syncMemberEmailsAcrossWorkspace(workspace.id, myEmail, updatedMembers);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${workspace.id}/teamMembers`);
  }
}

export async function setColleagueAdminRole(params: {
  workspace: Workspace;
  callerEmail: string;
  member: TeamMember;
  makeAdmin: boolean;
}): Promise<void> {
  const { workspace, callerEmail, member, makeAdmin } = params;
  const myEmail = callerEmail.trim().toLowerCase();
  if (!hasAdminRights(workspace, myEmail)) {
    throw new Error('Pouze administrátor může měnit oprávnění kolegů.');
  }
  if (member.role === 'OWNER') {
    throw new Error('Oprávnění vlastníka účtu nelze odebrat.');
  }

  const targetEmail = member.email.trim().toLowerCase();
  const updatedAdmins = makeAdmin
    ? Array.from(new Set([...workspace.adminEmails.map((e) => e.toLowerCase()), targetEmail]))
    : Array.from(
        new Set(
          workspace.adminEmails
            .map((e) => e.toLowerCase())
            .filter((e) => e !== targetEmail || e === workspace.ownerEmail.toLowerCase())
        )
      );

  const root = wsRoot(workspace.id);
  const batch = writeBatch(db);
  batch.update(root, { adminEmails: updatedAdmins, updatedAt: serverTimestamp() });
  batch.update(doc(root, 'teamMembers', member.id), {
    role: makeAdmin ? 'ADMIN' : 'MEMBER',
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.UPDATE,
      `workspaces/${workspace.id}/teamMembers/${member.id}`
    );
  }
}

export async function removeColleague(params: {
  workspace: Workspace;
  callerEmail: string;
  member: TeamMember;
}): Promise<void> {
  const { workspace, callerEmail, member } = params;
  const myEmail = callerEmail.trim().toLowerCase();
  if (!hasAdminRights(workspace, myEmail)) {
    throw new Error('Pouze administrátor může odebírat kolegy.');
  }
  if (member.role === 'OWNER') {
    throw new Error('Vlastníka účtu nelze odebrat.');
  }

  const targetEmail = member.email.trim().toLowerCase();
  const ownerLow = workspace.ownerEmail.toLowerCase();
  const updatedMembers = Array.from(
    new Set(
      workspace.memberEmails
        .map((e) => e.toLowerCase())
        .filter((e) => e !== targetEmail || e === ownerLow)
    )
  );
  const updatedAdmins = Array.from(
    new Set(
      workspace.adminEmails
        .map((e) => e.toLowerCase())
        .filter((e) => e !== targetEmail || e === ownerLow)
    )
  );

  const root = wsRoot(workspace.id);
  const batch = writeBatch(db);
  batch.update(root, {
    memberEmails: updatedMembers,
    adminEmails: updatedAdmins,
    updatedAt: serverTimestamp(),
  });
  batch.delete(doc(root, 'teamMembers', member.id));

  try {
    await batch.commit();
    await syncMemberEmailsAcrossWorkspace(workspace.id, myEmail, updatedMembers);
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.DELETE,
      `workspaces/${workspace.id}/teamMembers/${member.id}`
    );
  }
}

// =============================================================================
// COMPANIES & WAREHOUSES
// =============================================================================
export async function saveCompany(workspace: Workspace, company: Company): Promise<void> {
  const path = `workspaces/${workspace.id}/companies/${company.id}`;
  try {
    await updateDoc(doc(wsRoot(workspace.id), 'companies', company.id), {
      name: (company.name.trim() || 'Firma').slice(0, 160),
      ico: company.ico.trim().slice(0, 20),
      dic: company.dic.trim().slice(0, 25),
      street: company.street.trim().slice(0, 160),
      city: company.city.trim().slice(0, 120),
      zip: company.zip.trim().slice(0, 20),
      bankName: company.bankName.trim().slice(0, 80),
      bankAccount: company.bankAccount.trim().slice(0, 40),
      iban: (company.iban.trim() || czechAccountToIban(company.bankAccount) || '')
        .replace(/\s+/g, '')
        .toUpperCase()
        .slice(0, 40),
      bic: company.bic.trim().toUpperCase().slice(0, 20),
      fioApiToken: company.fioApiToken.trim().slice(0, 160),
      lastBankSyncAt: company.lastBankSyncAt.trim().slice(0, 40),
      email: company.email.trim().slice(0, 160),
      phone: company.phone.trim().slice(0, 40),
      invoicePrefix: company.invoicePrefix.trim().slice(0, 20),
      nextInvoiceNumber: Math.max(1, Math.min(99999999, Math.floor(company.nextInvoiceNumber || 1))),
      vatPayer: Boolean(company.vatPayer),
      accentIndex: Math.max(0, Math.min(5, Math.floor(company.accentIndex || 0))),
      invoiceTemplate: company.invoiceTemplate || 'CLASSIC',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function createWarehouse(params: {
  workspace: Workspace;
  name: string;
  code: string;
  shared: boolean;
  ownerCompanyId: string;
  location: string;
}): Promise<void> {
  const { workspace, name, code, shared, ownerCompanyId, location } = params;
  const cleanName = name.trim().slice(0, 120);
  if (!cleanName) throw new Error('Název skladu je povinný.');
  const cleanCode = (code.trim().toUpperCase() || `SKL-${Date.now() % 1000}`).slice(0, 40);

  const ref = doc(collection(wsRoot(workspace.id), 'warehouses'));
  try {
    await setDoc(ref, {
      workspaceId: workspace.id,
      memberEmails: workspace.memberEmails,
      name: cleanName,
      code: cleanCode,
      shared: Boolean(shared),
      ownerCompanyId: shared ? '' : ownerCompanyId.slice(0, 64),
      location: location.trim().slice(0, 160),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, ref.path);
  }
}

// =============================================================================
// INVENTORY & STOCK MOVEMENTS
// =============================================================================
export async function saveInventoryItem(params: {
  workspace: Workspace;
  item: Partial<InventoryItem> & { id?: string };
  activeCompanyId: string;
  documentRef?: string;
}): Promise<void> {
  const { workspace, item, activeCompanyId, documentRef = 'Ruční úprava' } = params;
  const cleanName = (item.name || '').trim().slice(0, 200);
  if (!cleanName) throw new Error('Název zboží je povinný.');
  const cleanSku = (item.sku || '').trim().slice(0, 64) || `SKU-${Date.now() % 100000}`;
  const safeVat = item.vatRate === 0 || item.vatRate === 12 || item.vatRate === 21 ? item.vatRate : 21;
  const safeUnit = (item.unit || 'ks').trim().slice(0, 20) || 'ks';
  const safeWarehouse = (item.warehouseId || 'shared_main').trim().slice(0, 64);

  const root = wsRoot(workspace.id);
  const coll = collection(root, 'inventory');

  try {
    if (!item.id) {
      const ref = doc(coll);
      const qty = round2(Number(item.quantity ?? 0));
      const purchasePrice = Math.max(0, round2(Number(item.purchasePrice ?? 0)));
      const batch = writeBatch(db);

      batch.set(ref, {
        workspaceId: workspace.id,
        memberEmails: workspace.memberEmails,
        sku: cleanSku,
        name: cleanName,
        ean: (item.ean || '').trim().slice(0, 40),
        category: (item.category || '').trim().slice(0, 80),
        unit: safeUnit,
        quantity: qty,
        minQuantity: Math.max(0, round2(Number(item.minQuantity ?? 0))),
        purchasePrice,
        salePrice: Math.max(0, round2(Number(item.salePrice ?? 0))),
        vatRate: safeVat,
        warehouseId: safeWarehouse,
        supplierName: (item.supplierName || '').trim().slice(0, 160),
        notes: (item.notes || '').trim().slice(0, 500),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (qty !== 0) {
        batch.set(doc(collection(root, 'stockMovements')), {
          workspaceId: workspace.id,
          memberEmails: workspace.memberEmails,
          itemId: ref.id,
          itemName: cleanName,
          itemSku: cleanSku,
          warehouseId: safeWarehouse,
          companyId: activeCompanyId || 'company_1',
          movementType: 'RECEIPT',
          quantityDelta: qty,
          unit: safeUnit,
          unitPrice: purchasePrice,
          documentRef: documentRef.slice(0, 100),
          note: 'Založení skladové karty',
          createdAt: serverTimestamp(),
        });
      }

      await batch.commit();
    } else {
      await updateDoc(doc(coll, item.id), {
        sku: cleanSku,
        name: cleanName,
        ean: (item.ean || '').trim().slice(0, 40),
        category: (item.category || '').trim().slice(0, 80),
        unit: safeUnit,
        quantity: round2(Number(item.quantity ?? 0)),
        minQuantity: Math.max(0, round2(Number(item.minQuantity ?? 0))),
        purchasePrice: Math.max(0, round2(Number(item.purchasePrice ?? 0))),
        salePrice: Math.max(0, round2(Number(item.salePrice ?? 0))),
        vatRate: safeVat,
        warehouseId: safeWarehouse,
        supplierName: (item.supplierName || '').trim().slice(0, 160),
        notes: (item.notes || '').trim().slice(0, 500),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${workspace.id}/inventory`);
  }
}

export async function adjustInventoryStock(params: {
  workspace: Workspace;
  item: InventoryItem;
  delta: number;
  activeCompanyId: string;
  documentRef?: string;
  note?: string;
}): Promise<void> {
  const { workspace, item, delta, activeCompanyId, documentRef = 'Ruční úprava', note = '' } = params;
  const roundedDelta = round2(delta);
  if (roundedDelta === 0) return;

  const root = wsRoot(workspace.id);
  const newQty = round2(item.quantity + roundedDelta);
  const batch = writeBatch(db);

  batch.update(doc(root, 'inventory', item.id), {
    quantity: newQty,
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(collection(root, 'stockMovements')), {
    workspaceId: workspace.id,
    memberEmails: workspace.memberEmails,
    itemId: item.id,
    itemName: item.name.slice(0, 200),
    itemSku: item.sku.slice(0, 64),
    warehouseId: item.warehouseId || 'shared_main',
    companyId: activeCompanyId || 'company_1',
    movementType: roundedDelta > 0 ? 'RECEIPT' : 'ISSUE',
    quantityDelta: roundedDelta,
    unit: (item.unit || 'ks').slice(0, 20),
    unitPrice: Math.max(0, round2(roundedDelta > 0 ? item.purchasePrice : item.salePrice)),
    documentRef: documentRef.slice(0, 100),
    note: (note || (roundedDelta > 0 ? 'Příjem na sklad' : 'Výdej ze skladu')).slice(0, 300),
    createdAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.UPDATE,
      `workspaces/${workspace.id}/inventory/${item.id}`
    );
  }
}

export async function updateMinQuantity(
  workspaceId: string,
  itemId: string,
  newMinQuantity: number
): Promise<void> {
  const path = `workspaces/${workspaceId}/inventory/${itemId}`;
  try {
    await updateDoc(doc(wsRoot(workspaceId), 'inventory', itemId), {
      minQuantity: Math.max(0, round2(newMinQuantity)),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteInventoryItem(workspaceId: string, itemId: string): Promise<void> {
  const path = `workspaces/${workspaceId}/inventory/${itemId}`;
  try {
    await deleteDoc(doc(wsRoot(workspaceId), 'inventory', itemId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

/**
 * Bulk stock-in commit for Smart Stock In (AI Příjemka / CSV Import).
 */
export async function commitBulkStockIn(params: {
  workspace: Workspace;
  warehouseId: string;
  companyId: string;
  supplierName: string;
  documentNumber: string;
  items: ExtractedLineItem[];
  existingInventory: InventoryItem[];
}): Promise<number> {
  const { workspace, warehouseId, companyId, supplierName, documentNumber, items, existingInventory } =
    params;
  const selected = items.filter((i) => i.selected && i.name.trim() && i.quantity > 0);
  if (selected.length === 0) return 0;

  const invMap = new Map(existingInventory.map((i) => [i.id, i]));
  const root = wsRoot(workspace.id);
  const safeWh = warehouseId || 'shared_main';
  const safeCompany = companyId || 'company_1';
  const docRefLabel = (documentNumber || 'AI Příjemka').slice(0, 100);

  for (let i = 0; i < selected.length; i += 180) {
    const chunk = selected.slice(i, i + 180);
    const batch = writeBatch(db);

    for (const line of chunk) {
      const existing = line.matchedInventoryId ? invMap.get(line.matchedInventoryId) : undefined;
      const qty = Math.max(0.01, round2(line.quantity));
      const purchasePrice = Math.max(0, round2(line.purchasePrice));
      const salePrice = Math.max(0, round2(line.suggestedSalePrice));
      const vatRate = line.vatRate === 0 || line.vatRate === 12 || line.vatRate === 21 ? line.vatRate : 21;
      const unit = (line.unit || 'ks').trim().slice(0, 20) || 'ks';
      const sku = (line.sku || `AI-${Date.now() % 10000}`).trim().slice(0, 64);
      const name = line.name.trim().slice(0, 200);

      let itemId: string;
      if (existing) {
        itemId = existing.id;
        batch.update(doc(root, 'inventory', existing.id), {
          quantity: round2(existing.quantity + qty),
          purchasePrice: purchasePrice > 0 ? purchasePrice : existing.purchasePrice,
          salePrice: salePrice > 0 ? salePrice : existing.salePrice,
          supplierName: (supplierName || existing.supplierName).slice(0, 160),
          updatedAt: serverTimestamp(),
        });
      } else {
        const newRef = doc(collection(root, 'inventory'));
        itemId = newRef.id;
        batch.set(newRef, {
          workspaceId: workspace.id,
          memberEmails: workspace.memberEmails,
          sku,
          name,
          ean: (line.ean || '').trim().slice(0, 40),
          category: 'Naskladněno AI',
          unit,
          quantity: qty,
          minQuantity: 0,
          purchasePrice,
          salePrice,
          vatRate,
          warehouseId: safeWh,
          supplierName: supplierName.trim().slice(0, 160),
          notes: `Naskladněno z dokladu ${docRefLabel}`.slice(0, 500),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      batch.set(doc(collection(root, 'stockMovements')), {
        workspaceId: workspace.id,
        memberEmails: workspace.memberEmails,
        itemId,
        itemName: name,
        itemSku: sku,
        warehouseId: safeWh,
        companyId: safeCompany,
        movementType: 'RECEIPT',
        quantityDelta: qty,
        unit,
        unitPrice: purchasePrice,
        documentRef: docRefLabel,
        note: `AI Příjemka${supplierName ? ` – ${supplierName}` : ''}`.slice(0, 300),
        createdAt: serverTimestamp(),
      });
    }

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `workspaces/${workspace.id}/inventory`);
    }
  }

  return selected.length;
}

// =============================================================================
// CLIENTS
// =============================================================================
export async function saveClient(
  workspace: Workspace,
  client: Partial<Client> & { id?: string }
): Promise<void> {
  const cleanName = (client.name || '').trim().slice(0, 200);
  if (!cleanName) throw new Error('Název klienta je povinný.');

  const root = wsRoot(workspace.id);
  const coll = collection(root, 'clients');

  try {
    if (!client.id) {
      const ref = doc(coll);
      await setDoc(ref, {
        workspaceId: workspace.id,
        memberEmails: workspace.memberEmails,
        name: cleanName,
        ico: (client.ico || '').trim().slice(0, 20),
        dic: (client.dic || '').trim().slice(0, 25),
        street: (client.street || '').trim().slice(0, 200),
        city: (client.city || '').trim().slice(0, 120),
        zip: (client.zip || '').trim().slice(0, 20),
        country: (client.country || 'Česká republika').trim().slice(0, 80),
        email: (client.email || '').trim().slice(0, 160),
        phone: (client.phone || '').trim().slice(0, 40),
        bankAccount: (client.bankAccount || '').trim().slice(0, 40),
        notes: (client.notes || '').trim().slice(0, 500),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(doc(coll, client.id), {
        name: cleanName,
        ico: (client.ico || '').trim().slice(0, 20),
        dic: (client.dic || '').trim().slice(0, 25),
        street: (client.street || '').trim().slice(0, 200),
        city: (client.city || '').trim().slice(0, 120),
        zip: (client.zip || '').trim().slice(0, 20),
        country: (client.country || 'Česká republika').trim().slice(0, 80),
        email: (client.email || '').trim().slice(0, 160),
        phone: (client.phone || '').trim().slice(0, 40),
        bankAccount: (client.bankAccount || '').trim().slice(0, 40),
        notes: (client.notes || '').trim().slice(0, 500),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${workspace.id}/clients`);
  }
}

export async function deleteClient(workspaceId: string, clientId: string): Promise<void> {
  const path = `workspaces/${workspaceId}/clients/${clientId}`;
  try {
    await deleteDoc(doc(wsRoot(workspaceId), 'clients', clientId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

// =============================================================================
// INVOICES
// =============================================================================
export interface CreateInvoicePayload {
  company: Company;
  invoiceNumber: string;
  variableSymbol: string;
  issueDate: string;
  taxDate: string;
  dueDate: string;
  paymentMethod: PaymentMethod;
  clientId: string;
  clientName: string;
  clientIco: string;
  clientDic: string;
  clientStreet: string;
  clientCity: string;
  clientZip: string;
  note: string;
  deductFromStock: boolean;
  invoiceTemplate: InvoiceTemplateId;
  items: InvoiceLineItem[];
}

export async function issueInvoice(params: {
  workspace: Workspace;
  inventory: InventoryItem[];
  payload: CreateInvoicePayload;
}): Promise<string> {
  const { workspace, inventory, payload } = params;
  const { company } = payload;
  const cleanItems = payload.items
    .filter((i) => i.name.trim().length > 0 && i.quantity > 0)
    .slice(0, 100)
    .map((i) => ({
      inventoryItemId: (i.inventoryItemId || '').slice(0, 64),
      warehouseId: (i.warehouseId || '').slice(0, 64),
      sku: (i.sku || '').slice(0, 64),
      name: i.name.trim().slice(0, 200),
      quantity: round2(i.quantity),
      unit: (i.unit || 'ks').trim().slice(0, 20),
      unitPrice: Math.max(0, round2(i.unitPrice)),
      vatRate: i.vatRate === 0 || i.vatRate === 12 || i.vatRate === 21 ? i.vatRate : 21,
      discountPercent: Math.min(100, Math.max(0, round2(i.discountPercent || 0))),
    }));

  if (cleanItems.length === 0) {
    throw new Error('Faktura musí obsahovat alespoň jednu položku.');
  }

  const totals = calculateInvoiceTotals(cleanItems, company.vatPayer);
  const root = wsRoot(workspace.id);
  const invRef = doc(collection(root, 'invoices'));
  const invNum = payload.invoiceNumber.trim().slice(0, 40);
  const vs = (payload.variableSymbol.trim() || invNum.replace(/\D/g, '')).slice(0, 20);

  const batch = writeBatch(db);
  batch.set(invRef, {
    workspaceId: workspace.id,
    memberEmails: workspace.memberEmails,
    companyId: company.id,
    companyName: (company.name || 'Firma').slice(0, 160),
    companyIco: company.ico.slice(0, 20),
    companyDic: company.dic.slice(0, 25),
    companyAddress: formatCompanyAddress(company).slice(0, 260),
    companyBankAccount: company.bankAccount.slice(0, 40),
    companyIban: (company.iban.trim() || czechAccountToIban(company.bankAccount) || '')
      .replace(/\s+/g, '')
      .toUpperCase()
      .slice(0, 40),
    invoiceNumber: invNum,
    variableSymbol: vs,
    issueDate: payload.issueDate.slice(0, 20),
    taxDate: payload.taxDate.slice(0, 20),
    dueDate: payload.dueDate.slice(0, 20),
    paymentMethod: payload.paymentMethod,
    status: 'ISSUED',
    clientId: payload.clientId.slice(0, 64),
    clientName: payload.clientName.trim().slice(0, 200),
    clientIco: payload.clientIco.trim().slice(0, 20),
    clientDic: payload.clientDic.trim().slice(0, 25),
    clientStreet: payload.clientStreet.trim().slice(0, 200),
    clientCity: payload.clientCity.trim().slice(0, 120),
    clientZip: payload.clientZip.trim().slice(0, 20),
    currency: 'CZK',
    totalWithoutVat: totals.totalWithoutVat,
    totalVat: totals.totalVat,
    totalWithVat: totals.totalWithVat,
    paidAmount: 0,
    paidDate: '',
    matchedTransactionId: '',
    note: payload.note.trim().slice(0, 500),
    deductedFromStock: Boolean(payload.deductFromStock),
    exportedToPohoda: false,
    invoiceTemplate: payload.invoiceTemplate || company.invoiceTemplate || 'CLASSIC',
    items: cleanItems,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Increment company nextInvoiceNumber atomically
  batch.update(doc(root, 'companies', company.id), {
    nextInvoiceNumber: Math.max(1, Math.floor((company.nextInvoiceNumber || 1) + 1)),
    updatedAt: serverTimestamp(),
  });

  // Deduct stock atomically
  if (payload.deductFromStock) {
    const invMap = new Map(inventory.map((i) => [i.id, i]));
    const deductions = new Map<string, number>();
    for (const line of cleanItems) {
      if (line.inventoryItemId && invMap.has(line.inventoryItemId)) {
        deductions.set(
          line.inventoryItemId,
          (deductions.get(line.inventoryItemId) || 0) + line.quantity
        );
      }
    }

    for (const [itemId, qty] of deductions.entries()) {
      const stockItem = invMap.get(itemId);
      if (!stockItem) continue;
      batch.update(doc(root, 'inventory', itemId), {
        quantity: round2(stockItem.quantity - qty),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(collection(root, 'stockMovements')), {
        workspaceId: workspace.id,
        memberEmails: workspace.memberEmails,
        itemId,
        itemName: stockItem.name.slice(0, 200),
        itemSku: stockItem.sku.slice(0, 64),
        warehouseId: stockItem.warehouseId || 'shared_main',
        companyId: company.id,
        movementType: 'ISSUE',
        quantityDelta: -round2(qty),
        unit: stockItem.unit.slice(0, 20),
        unitPrice: stockItem.salePrice,
        documentRef: `FA ${invNum}`.slice(0, 100),
        note: `Výdej k faktuře pro ${payload.clientName}`.slice(0, 300),
        createdAt: serverTimestamp(),
      });
    }
  }

  try {
    await batch.commit();
    return invRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, invRef.path);
  }
}

export async function editInvoice(params: {
  workspace: Workspace;
  originalInvoice: Invoice;
  inventory: InventoryItem[];
  isAdmin: boolean;
  payload: CreateInvoicePayload;
}): Promise<string> {
  const { workspace, originalInvoice, inventory, isAdmin, payload } = params;
  if (originalInvoice.status === 'CANCELLED') {
    throw new Error('Stornovanou fakturu nelze upravovat. Použijte funkci Duplikovat.');
  }

  const { company } = payload;
  const cleanItems = payload.items
    .filter((i) => i.name.trim().length > 0 && i.quantity > 0)
    .slice(0, 100)
    .map((i) => ({
      inventoryItemId: (i.inventoryItemId || '').slice(0, 64),
      warehouseId: (i.warehouseId || '').slice(0, 64),
      sku: (i.sku || '').slice(0, 64),
      name: i.name.trim().slice(0, 200),
      quantity: round2(i.quantity),
      unit: (i.unit || 'ks').trim().slice(0, 20),
      unitPrice: Math.max(0, round2(i.unitPrice)),
      vatRate: i.vatRate === 0 || i.vatRate === 12 || i.vatRate === 21 ? i.vatRate : 21,
      discountPercent: Math.min(100, Math.max(0, round2(i.discountPercent || 0))),
    }));

  if (cleanItems.length === 0) {
    throw new Error('Faktura musí obsahovat alespoň jednu položku.');
  }

  const totals = calculateInvoiceTotals(cleanItems, company.vatPayer);
  const root = wsRoot(workspace.id);
  const invNum = payload.invoiceNumber.trim().slice(0, 40);
  const vs = (payload.variableSymbol.trim() || invNum.replace(/\D/g, '')).slice(0, 20);

  // Compute inventory delta (oldDeducted - newDeducted): positive = return to stock, negative = additional issue
  const invMap = new Map(inventory.map((i) => [i.id, i]));
  const oldDeducted = new Map<string, number>();
  if (originalInvoice.deductedFromStock) {
    for (const line of originalInvoice.items) {
      if (line.inventoryItemId && invMap.has(line.inventoryItemId)) {
        oldDeducted.set(
          line.inventoryItemId,
          (oldDeducted.get(line.inventoryItemId) || 0) + line.quantity
        );
      }
    }
  }
  const newDeducted = new Map<string, number>();
  if (payload.deductFromStock) {
    for (const line of cleanItems) {
      if (line.inventoryItemId && invMap.has(line.inventoryItemId)) {
        newDeducted.set(
          line.inventoryItemId,
          (newDeducted.get(line.inventoryItemId) || 0) + line.quantity
        );
      }
    }
  }

  const allItemIds = new Set([...oldDeducted.keys(), ...newDeducted.keys()]);
  const stockAdjustments: Array<{ item: InventoryItem; delta: number }> = [];
  for (const itemId of allItemIds) {
    const stockItem = invMap.get(itemId);
    if (!stockItem) continue;
    const delta = round2((oldDeducted.get(itemId) || 0) - (newDeducted.get(itemId) || 0));
    if (delta !== 0) {
      stockAdjustments.push({ item: stockItem, delta });
    }
  }

  const applyStockDeltas = (batch: ReturnType<typeof writeBatch>) => {
    for (const { item: stockItem, delta } of stockAdjustments) {
      batch.update(doc(root, 'inventory', stockItem.id), {
        quantity: round2(stockItem.quantity + delta),
        updatedAt: serverTimestamp(),
      });
      batch.set(doc(collection(root, 'stockMovements')), {
        workspaceId: workspace.id,
        memberEmails: workspace.memberEmails,
        itemId: stockItem.id,
        itemName: stockItem.name.slice(0, 200),
        itemSku: stockItem.sku.slice(0, 64),
        warehouseId: stockItem.warehouseId || 'shared_main',
        companyId: company.id,
        movementType: delta > 0 ? 'RECEIPT' : 'ISSUE',
        quantityDelta: delta,
        unit: stockItem.unit.slice(0, 20),
        unitPrice: stockItem.salePrice,
        documentRef: `Oprava FA ${invNum}`.slice(0, 100),
        note: `Úprava položek faktury pro ${payload.clientName}`.slice(0, 300),
        createdAt: serverTimestamp(),
      });
    }
  };

  const editableFields = {
    invoiceNumber: invNum,
    variableSymbol: vs,
    issueDate: payload.issueDate.slice(0, 20),
    taxDate: payload.taxDate.slice(0, 20),
    dueDate: payload.dueDate.slice(0, 20),
    paymentMethod: payload.paymentMethod,
    clientId: payload.clientId.slice(0, 64),
    clientName: payload.clientName.trim().slice(0, 200),
    clientIco: payload.clientIco.trim().slice(0, 20),
    clientDic: payload.clientDic.trim().slice(0, 25),
    clientStreet: payload.clientStreet.trim().slice(0, 200),
    clientCity: payload.clientCity.trim().slice(0, 120),
    clientZip: payload.clientZip.trim().slice(0, 20),
    totalWithoutVat: totals.totalWithoutVat,
    totalVat: totals.totalVat,
    totalWithVat: totals.totalWithVat,
    note: payload.note.trim().slice(0, 500),
    deductedFromStock: Boolean(payload.deductFromStock),
    invoiceTemplate: payload.invoiceTemplate || company.invoiceTemplate || 'CLASSIC',
    items: cleanItems,
    updatedAt: serverTimestamp(),
  };

  // Attempt 1: Direct update (works for ALL team members once Firestore rules allow direct invoice editing)
  const oldRef = doc(root, 'invoices', originalInvoice.id);
  try {
    const directBatch = writeBatch(db);
    directBatch.update(oldRef, editableFields);
    applyStockDeltas(directBatch);
    await directBatch.commit();
    return originalInvoice.id;
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    const isPerm = msg.includes('permission') || msg.includes('insufficient');
    if (!isPerm) {
      handleFirestoreError(error, OperationType.UPDATE, oldRef.path);
    }

    if (!isAdmin) {
      throw new Error(
        'Přímá editace vystavené faktury vyžaduje aktualizaci pravidel Firestore pro běžné členy, nebo práva administrátora. Můžete použít tlačítko Duplikovat.'
      );
    }
  }

  // Attempt 2: Admin atomic delete + recreate fallback (preserves all newer Android fields)
  const newRef = doc(collection(root, 'invoices'));
  const replaceBatch = writeBatch(db);
  replaceBatch.delete(oldRef);
  const { id: _ignoredId, ...originalFields } = originalInvoice as Invoice & Record<string, unknown>;
  replaceBatch.set(newRef, {
    ...originalFields,
    workspaceId: workspace.id,
    memberEmails: workspace.memberEmails,
    companyId: originalInvoice.companyId || company.id,
    companyName: (originalInvoice.companyName || company.name || 'Firma').slice(0, 160),
    companyIco: (originalInvoice.companyIco || company.ico).slice(0, 20),
    companyDic: (originalInvoice.companyDic || company.dic).slice(0, 25),
    companyAddress: (originalInvoice.companyAddress || formatCompanyAddress(company)).slice(0, 260),
    companyBankAccount: (originalInvoice.companyBankAccount || company.bankAccount).slice(0, 40),
    companyIban: (originalInvoice.companyIban || company.iban).slice(0, 40),
    ...editableFields,
    status: originalInvoice.status,
    currency: originalInvoice.currency || 'CZK',
    paidAmount: originalInvoice.paidAmount || 0,
    paidDate: originalInvoice.paidDate || '',
    matchedTransactionId: originalInvoice.matchedTransactionId || '',
    exportedToPohoda: Boolean(originalInvoice.exportedToPohoda),
    createdAt: originalInvoice.createdAt || serverTimestamp(),
  });

  if (originalInvoice.matchedTransactionId) {
    replaceBatch.update(doc(root, 'bankTransactions', originalInvoice.matchedTransactionId), {
      matchedInvoiceId: newRef.id,
      matchedInvoiceNumber: invNum,
      matchStatus: 'MATCHED',
      updatedAt: serverTimestamp(),
    });
  }

  applyStockDeltas(replaceBatch);

  try {
    await replaceBatch.commit();
    return newRef.id;
  } catch (error) {
    console.error('editInvoice fallback error:', error);
    const errText = error instanceof Error ? error.message : String(error);
    throw new Error(`Nepodařilo se uložit úpravu faktury: ${errText}`);
  }
}

export async function markInvoicePaid(workspaceId: string, invoice: Invoice): Promise<void> {
  const path = `workspaces/${workspaceId}/invoices/${invoice.id}`;
  try {
    await updateDoc(doc(wsRoot(workspaceId), 'invoices', invoice.id), {
      status: 'PAID',
      paidAmount: invoice.totalWithVat,
      paidDate: toIsoDate(),
      matchedTransactionId: invoice.matchedTransactionId || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function cancelInvoice(workspaceId: string, invoice: Invoice): Promise<void> {
  const path = `workspaces/${workspaceId}/invoices/${invoice.id}`;
  try {
    await updateDoc(doc(wsRoot(workspaceId), 'invoices', invoice.id), {
      status: 'CANCELLED',
      paidAmount: invoice.paidAmount,
      paidDate: invoice.paidDate,
      matchedTransactionId: invoice.matchedTransactionId || '',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateInvoiceTemplate(
  workspaceId: string,
  invoiceId: string,
  template: InvoiceTemplateId
): Promise<void> {
  const path = `workspaces/${workspaceId}/invoices/${invoiceId}`;
  try {
    await updateDoc(doc(wsRoot(workspaceId), 'invoices', invoiceId), {
      invoiceTemplate: template,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function markInvoicesExportedToPohoda(
  workspaceId: string,
  invoiceIds: string[]
): Promise<void> {
  if (invoiceIds.length === 0) return;
  const root = wsRoot(workspaceId);
  try {
    for (let i = 0; i < invoiceIds.length; i += 400) {
      const batch = writeBatch(db);
      invoiceIds.slice(i, i + 400).forEach((id) => {
        batch.update(doc(root, 'invoices', id), {
          exportedToPohoda: true,
          updatedAt: serverTimestamp(),
        });
      });
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workspaces/${workspaceId}/invoices`);
  }
}

// =============================================================================
// BANK TRANSACTIONS & AUTOMATIC VS MATCHING
// =============================================================================
export async function importAndMatchBankTransactions(params: {
  workspace: Workspace;
  companyId: string;
  newTransactions: ParsedBankTx[];
  unpaidCompanyInvoices: Invoice[];
}): Promise<{ importedCount: number; matchedCount: number }> {
  const { workspace, companyId, newTransactions, unpaidCompanyInvoices } = params;
  const root = wsRoot(workspace.id);
  const remainingUnpaid = [...unpaidCompanyInvoices];
  let importedCount = 0;
  let matchedCount = 0;

  try {
    for (let i = 0; i < newTransactions.length; i += 180) {
      const chunk = newTransactions.slice(i, i + 180);
      const batch = writeBatch(db);

      for (const tx of chunk) {
        const txRef = doc(collection(root, 'bankTransactions'));
        const matched = findBestMatchingInvoice(tx, remainingUnpaid);
        const isMatched = matched !== null;

        if (matched) {
          matchedCount++;
          const idx = remainingUnpaid.findIndex((inv) => inv.id === matched.id);
          if (idx >= 0) remainingUnpaid.splice(idx, 1);

          const newPaid = round2(Math.max(0, matched.paidAmount + Math.max(0, tx.amount)));
          const fullyPaid = newPaid + 1.0 >= matched.totalWithVat;

          batch.update(doc(root, 'invoices', matched.id), {
            status: fullyPaid ? 'PAID' : 'ISSUED',
            paidAmount: newPaid,
            paidDate: tx.date.slice(0, 20),
            matchedTransactionId: txRef.id,
            updatedAt: serverTimestamp(),
          });
        }

        batch.set(txRef, {
          workspaceId: workspace.id,
          memberEmails: workspace.memberEmails,
          companyId,
          externalId: tx.externalId.slice(0, 100),
          date: tx.date.slice(0, 20),
          amount: round2(tx.amount),
          currency: (tx.currency || 'CZK').slice(0, 10),
          variableSymbol: tx.variableSymbol.slice(0, 30),
          counterpartyName: tx.counterpartyName.slice(0, 200),
          counterpartyAccount: tx.counterpartyAccount.slice(0, 60),
          message: tx.message.slice(0, 300),
          matchedInvoiceId: matched?.id || '',
          matchedInvoiceNumber: matched?.invoiceNumber || '',
          matchStatus: isMatched ? 'MATCHED' : 'UNMATCHED',
          source: tx.source,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        importedCount++;
      }

      await batch.commit();
    }

    if (companyId) {
      await updateDoc(doc(root, 'companies', companyId), {
        lastBankSyncAt: nowSyncLabel(),
        updatedAt: serverTimestamp(),
      });
    }

    return { importedCount, matchedCount };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `workspaces/${workspace.id}/bankTransactions`);
  }
}

export async function pairTransactionToInvoice(params: {
  workspaceId: string;
  tx: BankTransaction;
  invoice: Invoice;
}): Promise<void> {
  const { workspaceId, tx, invoice } = params;
  const root = wsRoot(workspaceId);
  const newPaid = round2(Math.max(0, invoice.paidAmount + Math.max(0, tx.amount)));
  const fullyPaid = newPaid + 1.0 >= invoice.totalWithVat;

  const batch = writeBatch(db);
  batch.update(doc(root, 'bankTransactions', tx.id), {
    matchedInvoiceId: invoice.id,
    matchedInvoiceNumber: invoice.invoiceNumber.slice(0, 40),
    matchStatus: 'MATCHED',
    updatedAt: serverTimestamp(),
  });
  batch.update(doc(root, 'invoices', invoice.id), {
    status: fullyPaid ? 'PAID' : 'ISSUED',
    paidAmount: newPaid,
    paidDate: (tx.date || toIsoDate()).slice(0, 20),
    matchedTransactionId: tx.id,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(
      error,
      OperationType.UPDATE,
      `workspaces/${workspaceId}/bankTransactions/${tx.id}`
    );
  }
}

export async function ignoreBankTransaction(workspaceId: string, txId: string): Promise<void> {
  const path = `workspaces/${workspaceId}/bankTransactions/${txId}`;
  try {
    await updateDoc(doc(wsRoot(workspaceId), 'bankTransactions', txId), {
      matchedInvoiceId: '',
      matchedInvoiceNumber: '',
      matchStatus: 'IGNORED',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function autoMatchUnmatchedTransactionsByVs(params: {
  workspaceId: string;
  unmatchedTransactions: BankTransaction[];
  unpaidCompanyInvoices: Invoice[];
}): Promise<number> {
  const { workspaceId, unmatchedTransactions, unpaidCompanyInvoices } = params;
  const remainingUnpaid = [...unpaidCompanyInvoices];
  const pairs: Array<{ tx: BankTransaction; inv: Invoice }> = [];

  for (const tx of unmatchedTransactions) {
    if (tx.matchStatus !== 'UNMATCHED' || tx.amount <= 0) continue;
    const match = findBestMatchingInvoice(
      {
        externalId: tx.externalId,
        date: tx.date,
        amount: tx.amount,
        currency: tx.currency,
        variableSymbol: tx.variableSymbol,
        counterpartyName: tx.counterpartyName,
        counterpartyAccount: tx.counterpartyAccount,
        message: tx.message,
        source: tx.source,
      },
      remainingUnpaid
    );
    if (match) {
      const idx = remainingUnpaid.findIndex((i) => i.id === match.id);
      if (idx >= 0) remainingUnpaid.splice(idx, 1);
      pairs.push({ tx, inv: match });
    }
  }

  if (pairs.length === 0) return 0;

  const root = wsRoot(workspaceId);
  try {
    for (let i = 0; i < pairs.length; i += 180) {
      const batch = writeBatch(db);
      for (const { tx, inv } of pairs.slice(i, i + 180)) {
        const newPaid = round2(Math.max(0, inv.paidAmount + tx.amount));
        const fullyPaid = newPaid + 1.0 >= inv.totalWithVat;
        batch.update(doc(root, 'bankTransactions', tx.id), {
          matchedInvoiceId: inv.id,
          matchedInvoiceNumber: inv.invoiceNumber.slice(0, 40),
          matchStatus: 'MATCHED',
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(root, 'invoices', inv.id), {
          status: fullyPaid ? 'PAID' : 'ISSUED',
          paidAmount: newPaid,
          paidDate: (tx.date || toIsoDate()).slice(0, 20),
          matchedTransactionId: tx.id,
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
    return pairs.length;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `workspaces/${workspaceId}/bankTransactions`);
  }
}
