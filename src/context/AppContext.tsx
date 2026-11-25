import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import { ensureSharedWorkspace } from '../lib/firestoreService';
import {
  hasAdminRights,
  isAccountantMember,
  isInvoiceOverdue,
  needsRestockAlert,
  timestampToMs,
} from '../lib/format';
import type {
  AresSubject,
  BankTransaction,
  Client,
  Company,
  ExtractedDeliveryNote,
  InventoryItem,
  Invoice,
  InvoiceLineItem,
  ParsedBankTx,
  StockMovement,
  TeamMember,
  TeamRole,
  Warehouse,
  Workspace,
} from '../types';

export interface ToastNotice {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface AppContextValue {
  authReady: boolean;
  user: User | null;
  emailVerified: boolean;
  userEmail: string;
  workspace: Workspace | null;
  workspaceLoading: boolean;
  workspaceInitError: string | null;
  retryWorkspaceInit: () => void;
  isCurrentUserAdmin: boolean;
  currentUserRole: TeamRole;
  isReadOnlyAccountant: boolean;
  teamMembers: TeamMember[];
  companies: Company[];
  activeCompanyId: string;
  activeCompany: Company | null;
  switchCompany: (companyId: string) => void;
  warehouses: Warehouse[];
  accessibleWarehouses: Warehouse[];
  inventory: InventoryItem[];
  movements: StockMovement[];
  clients: Client[];
  invoices: Invoice[];
  bankTransactions: BankTransaction[];
  lowStockItems: InventoryItem[];
  overdueInvoices: Invoice[];
  totalAlertCount: number;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string, displayName?: string) => Promise<void>;
  sendResetPassword: (email: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  refreshEmailVerification: () => Promise<boolean>;
  signOutUser: () => Promise<void>;
  lookupAres: (ico: string) => Promise<AresSubject>;
  fetchFioTransactions: (apiToken: string, daysBack?: number) => Promise<ParsedBankTx[]>;
  extractAiDeliveryNote: (params: {
    rawText?: string;
    base64Data?: string;
    mimeType?: string;
    fileName?: string;
  }) => Promise<ExtractedDeliveryNote>;
  notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
  toasts: ToastNotice[];
  dismissToast: (id: number) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

const ACTIVE_COMPANY_STORAGE_KEY = 'skladfaktura_active_company';

function normalizeInvoiceLineItem(raw: Record<string, unknown>): InvoiceLineItem {
  return {
    inventoryItemId: String(raw.inventoryItemId || ''),
    warehouseId: String(raw.warehouseId || ''),
    sku: String(raw.sku || ''),
    name: String(raw.name || ''),
    quantity: Number(raw.quantity ?? 1),
    unit: String(raw.unit || 'ks'),
    unitPrice: Number(raw.unitPrice ?? 0),
    vatRate: Number(raw.vatRate ?? 21),
    discountPercent: Number(raw.discountPercent ?? 0),
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [emailVerified, setEmailVerified] = useState(false);

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceInitError, setWorkspaceInitError] = useState<string | null>(null);
  const [initTick, setInitTick] = useState(0);

  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [activeCompanyId, setActiveCompanyId] = useState<string>(
    () => window.localStorage.getItem(ACTIVE_COMPANY_STORAGE_KEY) || 'company_1'
  );
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [bankTransactions, setBankTransactions] = useState<BankTransaction[]>([]);

  const [fatalError, setFatalError] = useState<Error | null>(null);
  const [toasts, setToasts] = useState<ToastNotice[]>([]);

  const notify = useCallback((message: string, tone: 'success' | 'error' | 'info' = 'success') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const captureSnapshotError = useCallback(
    (error: unknown, operationType: OperationType, path: string) => {
      try {
        handleFirestoreError(error, operationType, path);
      } catch (wrapped) {
        setFatalError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
    []
  );

  // 1. Auth state listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setEmailVerified(Boolean(firebaseUser?.emailVerified));
      setAuthReady(true);
      if (!firebaseUser) {
        setWorkspace(null);
        setTeamMembers([]);
        setCompanies([]);
        setWarehouses([]);
        setInventory([]);
        setMovements([]);
        setClients([]);
        setInvoices([]);
        setBankTransactions([]);
        setWorkspaceInitError(null);
      }
    });
    return () => unsub();
  }, []);

  const userEmail = (user?.email || '').trim().toLowerCase();

  // 2. Discover or create shared Android/Web workspace (requires verified email per Firestore rules)
  useEffect(() => {
    if (!authReady || !user || !userEmail || !emailVerified) return;
    let active = true;
    setWorkspaceLoading(true);
    setWorkspaceInitError(null);

    ensureSharedWorkspace(user)
      .then((ws) => {
        if (!active) return;
        setWorkspace(ws);
        setWorkspaceLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setWorkspaceLoading(false);
        setWorkspaceInitError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      active = false;
    };
  }, [authReady, user, userEmail, emailVerified, initTick]);

  // 3. Real-time Firestore listeners synced 1:1 with Android app
  const workspaceId = workspace?.id || '';

  useEffect(() => {
    if (!authReady || !user || !userEmail || !emailVerified || !workspaceId) return;

    const root = doc(db, 'workspaces', workspaceId);

    const unsubWs = onSnapshot(
      root,
      (snap) => {
        if (snap.exists()) {
          setWorkspace({ id: snap.id, ...(snap.data() as Omit<Workspace, 'id'>) });
        }
      },
      (err) => captureSnapshotError(err, OperationType.GET, `workspaces/${workspaceId}`)
    );

    const unsubTeam = onSnapshot(
      query(collection(root, 'teamMembers'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<TeamMember, 'id'>) }))
          .sort((a, b) => {
            const rank = (r: string) => (r === 'OWNER' ? 0 : r === 'ADMIN' ? 1 : 2);
            return rank(a.role) - rank(b.role) || a.displayName.localeCompare(b.displayName, 'cs');
          });
        setTeamMembers(list);
      },
      (err) => captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/teamMembers`)
    );

    const unsubCompanies = onSnapshot(
      query(collection(root, 'companies'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Company, 'id'>) }))
          .sort((a, b) => a.id.localeCompare(b.id));
        setCompanies(list);
        if (list.length > 0) {
          setActiveCompanyId((prev) => (list.some((c) => c.id === prev) ? prev : list[0].id));
        }
      },
      (err) => captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/companies`)
    );

    const unsubWarehouses = onSnapshot(
      query(collection(root, 'warehouses'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Warehouse, 'id'>) }))
          .sort((a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name, 'cs'));
        setWarehouses(list);
      },
      (err) => captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/warehouses`)
    );

    const unsubInventory = onSnapshot(
      query(collection(root, 'inventory'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<InventoryItem, 'id'>) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'cs'));
        setInventory(list);
      },
      (err) => captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/inventory`)
    );

    const unsubMovements = onSnapshot(
      query(collection(root, 'stockMovements'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<StockMovement, 'id'>) }))
          .sort((a, b) => timestampToMs(b.createdAt) - timestampToMs(a.createdAt));
        setMovements(list);
      },
      (err) =>
        captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/stockMovements`)
    );

    const unsubClients = onSnapshot(
      query(collection(root, 'clients'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<Client, 'id'>) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'cs'));
        setClients(list);
      },
      (err) => captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/clients`)
    );

    const unsubInvoices = onSnapshot(
      query(collection(root, 'invoices'), where('memberEmails', 'array-contains', userEmail)),
      (snap) => {
        const list = snap.docs
          .map((d) => {
            const raw = d.data() as Omit<Invoice, 'id' | 'items'> & {
              items?: Array<Record<string, unknown>>;
            };
            return {
              id: d.id,
              ...raw,
              items: (raw.items || []).map(normalizeInvoiceLineItem),
            } as Invoice;
          })
          .sort((a, b) => {
            if (b.issueDate !== a.issueDate) return b.issueDate.localeCompare(a.issueDate);
            return b.invoiceNumber.localeCompare(a.invoiceNumber);
          });
        setInvoices(list);
      },
      (err) => captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/invoices`)
    );

    const unsubBank = onSnapshot(
      query(
        collection(root, 'bankTransactions'),
        where('memberEmails', 'array-contains', userEmail)
      ),
      (snap) => {
        const list = snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<BankTransaction, 'id'>) }))
          .sort((a, b) => {
            if (b.date !== a.date) return b.date.localeCompare(a.date);
            return timestampToMs(b.createdAt) - timestampToMs(a.createdAt);
          });
        setBankTransactions(list);
      },
      (err) =>
        captureSnapshotError(err, OperationType.LIST, `workspaces/${workspaceId}/bankTransactions`)
    );

    return () => {
      unsubWs();
      unsubTeam();
      unsubCompanies();
      unsubWarehouses();
      unsubInventory();
      unsubMovements();
      unsubClients();
      unsubInvoices();
      unsubBank();
    };
  }, [authReady, user, userEmail, emailVerified, workspaceId, captureSnapshotError]);

  const switchCompany = useCallback((companyId: string) => {
    setActiveCompanyId(companyId);
    window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, companyId);
  }, []);

  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) || companies[0] || null,
    [companies, activeCompanyId]
  );

  const accessibleWarehouses = useMemo(() => {
    if (!activeCompany) return warehouses;
    return warehouses.filter((w) => w.shared || w.ownerCompanyId === activeCompany.id);
  }, [warehouses, activeCompany]);

  const isCurrentUserAdmin = useMemo(
    () => hasAdminRights(workspace, userEmail),
    [workspace, userEmail]
  );

  const currentTeamMember = useMemo(
    () => teamMembers.find((m) => m.email.trim().toLowerCase() === userEmail) || null,
    [teamMembers, userEmail]
  );

  const currentUserRole: TeamRole = useMemo(() => {
    if (workspace && workspace.ownerEmail.toLowerCase() === userEmail) return 'OWNER';
    if (isCurrentUserAdmin) return 'ADMIN';
    if (isAccountantMember(currentTeamMember)) return 'ACCOUNTANT';
    return 'MEMBER';
  }, [workspace, userEmail, isCurrentUserAdmin, currentTeamMember]);

  const isReadOnlyAccountant = currentUserRole === 'ACCOUNTANT';

  const lowStockItems = useMemo(() => {
    const whIds = new Set(accessibleWarehouses.map((w) => w.id));
    return inventory.filter((i) => whIds.has(i.warehouseId) && needsRestockAlert(i));
  }, [inventory, accessibleWarehouses]);

  const overdueInvoices = useMemo(() => {
    return invoices.filter(
      (i) => (!activeCompany || i.companyId === activeCompany.id) && isInvoiceOverdue(i)
    );
  }, [invoices, activeCompany]);

  const totalAlertCount = lowStockItems.length + overdueInvoices.length;

  const signInWithGoogle = useCallback(async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      if (!msg.includes('popup-closed-by-user')) {
        notify('Přihlášení přes Google se nezdařilo.', 'error');
      }
    }
  }, [notify]);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    setEmailVerified(Boolean(cred.user.emailVerified));
  }, []);

  const registerWithEmail = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (displayName?.trim()) {
        await updateProfile(cred.user, { displayName: displayName.trim().slice(0, 120) });
      }
      await sendEmailVerification(cred.user);
      setEmailVerified(Boolean(cred.user.emailVerified));
    },
    []
  );

  const sendResetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  const resendVerificationEmail = useCallback(async () => {
    if (!auth.currentUser) return;
    await sendEmailVerification(auth.currentUser);
  }, []);

  const refreshEmailVerification = useCallback(async (): Promise<boolean> => {
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
    const verified = Boolean(auth.currentUser.emailVerified);
    setEmailVerified(verified);
    return verified;
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  const lookupAres = useCallback(async (ico: string): Promise<AresSubject> => {
    const clean = ico.replace(/\D/g, '');
    const res = await fetch(`/api/ares/${encodeURIComponent(clean)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Dotaz na ARES selhal.');
    return data as AresSubject;
  }, []);

  const fetchFioTransactions = useCallback(
    async (apiToken: string, daysBack = 30): Promise<ParsedBankTx[]> => {
      const res = await fetch('/api/fio-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken, daysBack }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Synchronizace s Fio bankou selhala.');
      return (data.transactions || []) as ParsedBankTx[];
    },
    []
  );

  const extractAiDeliveryNote = useCallback(
    async (params: {
      rawText?: string;
      base64Data?: string;
      mimeType?: string;
      fileName?: string;
    }): Promise<ExtractedDeliveryNote> => {
      const res = await fetch('/api/ai-stock-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'AI zpracování dokladu selhalo.');
      return data as ExtractedDeliveryNote;
    },
    []
  );

  const retryWorkspaceInit = useCallback(() => {
    setInitTick((t) => t + 1);
  }, []);

  if (fatalError) {
    throw fatalError;
  }

  const value = useMemo<AppContextValue>(
    () => ({
      authReady,
      user,
      emailVerified,
      userEmail,
      workspace,
      workspaceLoading,
      workspaceInitError,
      retryWorkspaceInit,
      isCurrentUserAdmin,
      currentUserRole,
      isReadOnlyAccountant,
      teamMembers,
      companies,
      activeCompanyId,
      activeCompany,
      switchCompany,
      warehouses,
      accessibleWarehouses,
      inventory,
      movements,
      clients,
      invoices,
      bankTransactions,
      lowStockItems,
      overdueInvoices,
      totalAlertCount,
      signInWithGoogle,
      signInWithEmail,
      registerWithEmail,
      sendResetPassword,
      resendVerificationEmail,
      refreshEmailVerification,
      signOutUser,
      lookupAres,
      fetchFioTransactions,
      extractAiDeliveryNote,
      notify,
      toasts,
      dismissToast,
    }),
    [
      authReady,
      user,
      emailVerified,
      userEmail,
      workspace,
      workspaceLoading,
      workspaceInitError,
      retryWorkspaceInit,
      isCurrentUserAdmin,
      currentUserRole,
      isReadOnlyAccountant,
      teamMembers,
      companies,
      activeCompanyId,
      activeCompany,
      switchCompany,
      warehouses,
      accessibleWarehouses,
      inventory,
      movements,
      clients,
      invoices,
      bankTransactions,
      lowStockItems,
      overdueInvoices,
      totalAlertCount,
      signInWithGoogle,
      signInWithEmail,
      registerWithEmail,
      sendResetPassword,
      resendVerificationEmail,
      refreshEmailVerification,
      signOutUser,
      lookupAres,
      fetchFioTransactions,
      extractAiDeliveryNote,
      notify,
      toasts,
      dismissToast,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
