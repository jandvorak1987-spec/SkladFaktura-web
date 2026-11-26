import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Building2,
  Check,
  Download,
  Eye,
  FileCode2,
  Loader2,
  Plus,
  Shield,
  Smartphone,
  Trash2,
  UserPlus,
  Users,
  Warehouse as WarehouseIcon,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  addColleague,
  createCompany,
  createWarehouse,
  markInvoicesExportedToPohoda,
  removeColleague,
  saveCompany,
  setColleagueRole,
} from '../lib/firestoreService';
import {
  czechAccountToIban,
  downloadTextFile,
  generatePohodaDataPackXml,
  getCompanyPalette,
  isAccountantMember,
  stripAccountantTag,
  toIsoDate,
} from '../lib/format';
import { getMonthlyPackPreviewCounts } from '../lib/accountantPack';
import {
  COMPANY_BRAND_PALETTES,
  INVOICE_TEMPLATES,
  type Company,
  type InvoiceTemplateId,
  type PohodaExportScope,
  type TeamRole,
} from '../types';

type SettingsTab = 'COMPANY' | 'WAREHOUSES' | 'TEAM' | 'POHODA';

export function SettingsExportView() {
  const {
    workspace,
    userEmail,
    isCurrentUserAdmin,
    isReadOnlyAccountant,
    teamMembers,
    companies,
    activeCompany,
    switchCompany,
    warehouses,
    accessibleWarehouses,
    inventory,
    movements,
    invoices,
    lookupAres,
    notify,
  } = useApp();

  const [tab, setTab] = useState<SettingsTab>(isReadOnlyAccountant ? 'POHODA' : 'COMPANY');
  const [draftCompany, setDraftCompany] = useState<Company | null>(activeCompany);
  const [aresBusy, setAresBusy] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);

  // Add new company modal
  const [newCompOpen, setNewCompOpen] = useState(false);
  const [newCompBusy, setNewCompBusy] = useState(false);
  const [newCompAresBusy, setNewCompAresBusy] = useState(false);
  const [newCompCreateWh, setNewCompCreateWh] = useState(true);
  const [newCompDraft, setNewCompDraft] = useState({
    name: '',
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
    email: userEmail || '',
    phone: '',
    invoicePrefix: '',
    nextInvoiceNumber: 1,
    vatPayer: true,
    accentIndex: 2,
    invoiceTemplate: 'CLASSIC' as InvoiceTemplateId,
  });

  // Warehouse form
  const [whName, setWhName] = useState('');
  const [whCode, setWhCode] = useState('');
  const [whShared, setWhShared] = useState(true);
  const [whOwnerCompanyId, setWhOwnerCompanyId] = useState(activeCompany?.id || 'company_1');
  const [whLocation, setWhLocation] = useState('');
  const [creatingWh, setCreatingWh] = useState(false);

  // Team form
  const [colleagueName, setColleagueName] = useState('');
  const [colleagueEmail, setColleagueEmail] = useState('');
  const [colleagueRole, setColleagueRoleDraft] = useState<Exclude<TeamRole, 'OWNER'>>('MEMBER');
  const [teamBusy, setTeamBusy] = useState(false);

  // Monthly accountant ZIP pack
  const [packMonthKey, setPackMonthKey] = useState<string>(() => toIsoDate().slice(0, 7));
  const [buildingPack, setBuildingPack] = useState(false);

  // Pohoda export
  const [pohodaScope, setPohodaScope] = useState<PohodaExportScope>('BOTH');
  const [onlyUnexported, setOnlyUnexported] = useState(false);
  const [exportingPohoda, setExportingPohoda] = useState(false);

  useEffect(() => {
    setDraftCompany(activeCompany);
    if (activeCompany) setWhOwnerCompanyId(activeCompany.id);
  }, [activeCompany]);

  const palette = getCompanyPalette(draftCompany?.accentIndex ?? activeCompany?.accentIndex);

  const companyInvoices = useMemo(
    () => invoices.filter((i) => !activeCompany || i.companyId === activeCompany.id),
    [invoices, activeCompany]
  );

  const companyInventory = useMemo(() => {
    const whIds = new Set(accessibleWarehouses.map((w) => w.id));
    return inventory.filter((i) => whIds.has(i.warehouseId));
  }, [inventory, accessibleWarehouses]);

  const invoicesForPohoda = useMemo(() => {
    return companyInvoices.filter(
      (i) => i.status !== 'CANCELLED' && (!onlyUnexported || !i.exportedToPohoda)
    );
  }, [companyInvoices, onlyUnexported]);

  const handleCompanyAres = async () => {
    if (!draftCompany) return;
    const ico = draftCompany.ico.replace(/\D/g, '');
    if (ico.length !== 8) {
      notify('Zadejte 8místné IČO pro načtení z ARES.', 'error');
      return;
    }
    setAresBusy(true);
    try {
      const s = await lookupAres(ico);
      setDraftCompany({
        ...draftCompany,
        ico: s.ico,
        dic: s.dic || draftCompany.dic,
        name: s.name || draftCompany.name,
        street: s.street || draftCompany.street,
        city: s.city || draftCompany.city,
        zip: s.zip || draftCompany.zip,
      });
      notify(`Načteno z ARES: ${s.name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Dotaz na ARES selhal.', 'error');
    } finally {
      setAresBusy(false);
    }
  };

  const handleComputeIban = () => {
    if (!draftCompany) return;
    const iban = czechAccountToIban(draftCompany.bankAccount);
    if (!iban) {
      notify('Zadejte platné české číslo účtu ve tvaru např. 123456789/2010.', 'error');
      return;
    }
    setDraftCompany({ ...draftCompany, iban });
    notify(`IBAN vypočítán: ${iban}`);
  };

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || !draftCompany) return;
    setSavingCompany(true);
    try {
      await saveCompany(workspace, draftCompany);
      notify(`Údaje firmy ${draftCompany.name} byly uloženy a synchronizovány.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Uložení firmy selhalo.', 'error');
    } finally {
      setSavingCompany(false);
    }
  };

  const openNewCompanyModal = () => {
    const usedAccents = new Set(companies.map((c) => c.accentIndex));
    const nextAccent =
      COMPANY_BRAND_PALETTES.find((p) => !usedAccents.has(p.index))?.index ??
      companies.length % COMPANY_BRAND_PALETTES.length;
    const nextLetter = String.fromCharCode(65 + Math.min(25, companies.length));
    setNewCompDraft({
      name: '',
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
      email: userEmail || '',
      phone: '',
      invoicePrefix: `${nextLetter}${new Date().getFullYear()}`,
      nextInvoiceNumber: 1,
      vatPayer: true,
      accentIndex: nextAccent,
      invoiceTemplate: 'CLASSIC',
    });
    setNewCompCreateWh(true);
    setNewCompOpen(true);
  };

  const handleNewCompAres = async () => {
    const ico = newCompDraft.ico.replace(/\D/g, '');
    if (ico.length !== 8) {
      notify('Zadejte 8místné IČO pro načtení z ARES.', 'error');
      return;
    }
    setNewCompAresBusy(true);
    try {
      const s = await lookupAres(ico);
      setNewCompDraft((prev) => ({
        ...prev,
        ico: s.ico,
        dic: s.dic || prev.dic,
        name: s.name || prev.name,
        street: s.street || prev.street,
        city: s.city || prev.city,
        zip: s.zip || prev.zip,
      }));
      notify(`Načteno z ARES: ${s.name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Dotaz na ARES selhal.', 'error');
    } finally {
      setNewCompAresBusy(false);
    }
  };

  const handleCreateCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setNewCompBusy(true);
    try {
      const newId = await createCompany({
        workspace,
        existingCompanies: companies,
        draft: newCompDraft,
        createDedicatedWarehouse: newCompCreateWh,
      });
      switchCompany(newId);
      setNewCompOpen(false);
      notify(
        `Firma ${newCompDraft.name.trim()} byla přidána${newCompCreateWh ? ' včetně odděleného skladu' : ''}.`
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Přidání firmy selhalo.', 'error');
    } finally {
      setNewCompBusy(false);
    }
  };

  const handleCreateWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setCreatingWh(true);
    try {
      await createWarehouse({
        workspace,
        name: whName,
        code: whCode,
        shared: whShared,
        ownerCompanyId: whShared ? '' : whOwnerCompanyId,
        location: whLocation,
      });
      notify(`Sklad ${whName} byl založen.`);
      setWhName('');
      setWhCode('');
      setWhLocation('');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Založení skladu selhalo.', 'error');
    } finally {
      setCreatingWh(false);
    }
  };

  const handleAddColleague = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace) return;
    setTeamBusy(true);
    try {
      await addColleague({
        workspace,
        currentMembers: teamMembers,
        callerEmail: userEmail,
        displayName: colleagueName,
        emailInput: colleagueEmail,
        role: colleagueRole,
      });
      const roleLabel =
        colleagueRole === 'ACCOUNTANT'
          ? 'Účetní (jen pro čtení)'
          : colleagueRole === 'ADMIN'
            ? 'Administrátor'
            : 'Kolega';
      notify(
        `${colleagueEmail.trim().toLowerCase()} byl přidán s rolí ${roleLabel}.`
      );
      setColleagueName('');
      setColleagueEmail('');
      setColleagueRoleDraft('MEMBER');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Přidání uživatele selhalo.', 'error');
    } finally {
      setTeamBusy(false);
    }
  };

  const handleDownloadMonthlyPack = async () => {
    if (!workspace || !activeCompany) return;
    setBuildingPack(true);
    try {
      const { generateAndDownloadMonthlyAccountantPack } = await import('../lib/accountantPack');
      const result = await generateAndDownloadMonthlyAccountantPack({
        workspaceId: workspace.id,
        company: activeCompany,
        monthKey: packMonthKey,
        invoices,
        movements,
        inventory: companyInventory,
        warehouses,
      });
      notify(
        `Balíček ${result.zipFileName} (${result.zipSizeKb} kB) stažen: ${result.issuedInvoicesCount} vydaných PDF, ${result.receivedArchiveFilesCount} přijatých souborů, ${result.cashEntriesCount} pokladních dokladů + POHODA XML.`
      );
    } catch (err) {
      notify(
        err instanceof Error ? err.message : 'Generování měsíčního balíčku selhalo.',
        'error'
      );
    } finally {
      setBuildingPack(false);
    }
  };

  const handleExportPohoda = async () => {
    if (!workspace || !activeCompany) return;
    setExportingPohoda(true);
    try {
      const xml = generatePohodaDataPackXml({
        company: activeCompany,
        invoices: invoicesForPohoda,
        inventory: companyInventory,
        warehouses,
        scope: pohodaScope,
      });
      const safeName =
        activeCompany.name.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase() || 'firma';
      downloadTextFile(
        xml,
        `pohoda_${safeName}_${pohodaScope.toLowerCase()}_${toIsoDate()}.xml`,
        'application/xml;charset=utf-8'
      );

      if (
        !isReadOnlyAccountant &&
        (pohodaScope === 'INVOICES' || pohodaScope === 'BOTH') &&
        invoicesForPohoda.length > 0
      ) {
        const unexportedIds = invoicesForPohoda
          .filter((i) => !i.exportedToPohoda)
          .map((i) => i.id);
        if (unexportedIds.length > 0) {
          await markInvoicesExportedToPohoda(workspace.id, unexportedIds);
        }
      }
      notify('Soubor POHODA XML DataPack v2.0 byl vygenerován a stažen.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Export do POHODY selhal.', 'error');
    } finally {
      setExportingPohoda(false);
    }
  };

  const packCounts = useMemo(
    () =>
      getMonthlyPackPreviewCounts({
        company: activeCompany,
        monthKey: packMonthKey,
        invoices,
        movements,
      }),
    [activeCompany, packMonthKey, invoices, movements]
  );

  const nonOwnerCount = teamMembers.filter((m) => m.role !== 'OWNER').length;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          Správa pracovního prostoru · Synchronizováno s Android
        </p>
        <h1 className="text-2xl font-bold text-slate-900 mt-1">Nastavení, tým a export POHODA</h1>
      </div>

      {/* Tabs */}
      <div className="inline-flex flex-wrap items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200">
        {(
          [
            ['COMPANY', 'Firemní údaje', Building2],
            ['WAREHOUSES', `Sklady (${warehouses.length})`, WarehouseIcon],
            ['TEAM', `Tým (${teamMembers.length}/6)`, Users],
            ['POHODA', 'Balíček pro účetní & POHODA', Archive],
          ] as [SettingsTab, string, React.ComponentType<{ className?: string }>][]
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* TAB 1: COMPANY */}
      {tab === 'COMPANY' && draftCompany && (
        <form onSubmit={handleSaveCompany} className="space-y-6">
          {/* Switch between Company A & B */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {companies.map((c) => {
                const pal = getCompanyPalette(c.accentIndex);
                const active = c.id === draftCompany.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => switchCompany(c.id)}
                    className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg border transition-colors ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: pal.primary }}
                    />
                    {c.name}
                  </button>
                );
              })}

              {isCurrentUserAdmin && (
                <button
                  type="button"
                  onClick={openNewCompanyModal}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-dashed border-slate-300 rounded-lg transition-colors whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  Přidat další firmu
                </button>
              )}
            </div>
            {!isCurrentUserAdmin && (
              <p className="text-xs text-amber-700">
                Úpravy a přidávání firem jsou vyhrazeny administrátorům týmu.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* Identity & Address */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-slate-900">Identifikace a adresa</h2>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-700 mb-1">IČO</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.ico}
                    onChange={(e) => setDraftCompany({ ...draftCompany, ico: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <button
                  type="button"
                  disabled={!isCurrentUserAdmin || aresBusy}
                  onClick={handleCompanyAres}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg whitespace-nowrap"
                >
                  {aresBusy ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Building2 className="w-3.5 h-3.5" />
                  )}
                  Načíst z ARES
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Název firmy</label>
                  <input
                    type="text"
                    required
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.name}
                    onChange={(e) => setDraftCompany({ ...draftCompany, name: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">DIČ</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.dic}
                    onChange={(e) => setDraftCompany({ ...draftCompany, dic: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={!isCurrentUserAdmin}
                      checked={draftCompany.vatPayer}
                      onChange={(e) =>
                        setDraftCompany({ ...draftCompany, vatPayer: e.target.checked })
                      }
                      className="rounded border-slate-300"
                    />
                    Plátce DPH
                  </label>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Ulice a č.p.</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.street}
                    onChange={(e) => setDraftCompany({ ...draftCompany, street: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Město</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.city}
                    onChange={(e) => setDraftCompany({ ...draftCompany, city: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">PSČ</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.zip}
                    onChange={(e) => setDraftCompany({ ...draftCompany, zip: e.target.value })}
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">E-mail</label>
                  <input
                    type="email"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.email}
                    onChange={(e) => setDraftCompany({ ...draftCompany, email: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Telefon</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.phone}
                    onChange={(e) => setDraftCompany({ ...draftCompany, phone: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
              </div>
            </div>

            {/* Banking, Numbering & Visual Brand */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-slate-900">
                Banka, Fio API, číslování a vzhled faktur
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Název banky</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.bankName}
                    onChange={(e) => setDraftCompany({ ...draftCompany, bankName: e.target.value })}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Číslo účtu</label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.bankAccount}
                    onChange={(e) =>
                      setDraftCompany({ ...draftCompany, bankAccount: e.target.value })
                    }
                    placeholder="123456789/2010"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>

                <div className="sm:col-span-2 flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      IBAN (pro QR Platbu)
                    </label>
                    <input
                      type="text"
                      disabled={!isCurrentUserAdmin}
                      value={draftCompany.iban}
                      onChange={(e) => setDraftCompany({ ...draftCompany, iban: e.target.value })}
                      className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={!isCurrentUserAdmin}
                    onClick={handleComputeIban}
                    className="px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg whitespace-nowrap"
                  >
                    Vypočítat IBAN
                  </button>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Fio banka API token (pouze čtení výpisů)
                  </label>
                  <input
                    type="password"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.fioApiToken}
                    onChange={(e) =>
                      setDraftCompany({ ...draftCompany, fioApiToken: e.target.value })
                    }
                    placeholder="Vložte token z Fio Internetbankingu"
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Prefix číselné řady
                  </label>
                  <input
                    type="text"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.invoicePrefix}
                    onChange={(e) =>
                      setDraftCompany({ ...draftCompany, invoicePrefix: e.target.value })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Další pořadové číslo
                  </label>
                  <input
                    type="number"
                    min="1"
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.nextInvoiceNumber}
                    onChange={(e) =>
                      setDraftCompany({
                        ...draftCompany,
                        nextInvoiceNumber: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                    className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg disabled:bg-slate-50 tabular-nums"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Firemní barevný akcent
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    {COMPANY_BRAND_PALETTES.map((pal) => {
                      const active = draftCompany.accentIndex === pal.index;
                      return (
                        <button
                          key={pal.index}
                          type="button"
                          disabled={!isCurrentUserAdmin}
                          onClick={() =>
                            setDraftCompany({ ...draftCompany, accentIndex: pal.index })
                          }
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                            active
                              ? 'border-slate-900 bg-slate-50 text-slate-900'
                              : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          <span
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: pal.primary }}
                          />
                          {pal.nameCz}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Výchozí šablona faktury
                  </label>
                  <select
                    disabled={!isCurrentUserAdmin}
                    value={draftCompany.invoiceTemplate || 'CLASSIC'}
                    onChange={(e) =>
                      setDraftCompany({
                        ...draftCompany,
                        invoiceTemplate: e.target.value as InvoiceTemplateId,
                      })
                    }
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white disabled:bg-slate-50"
                  >
                    {INVOICE_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.labelCz} — {t.subtitleCz}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {isCurrentUserAdmin && (
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingCompany}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-60"
              >
                {savingCompany ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Uložit firemní údaje
              </button>
            </div>
          )}
        </form>
      )}

      {/* TAB 2: WAREHOUSES */}
      {tab === 'WAREHOUSES' && (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
          <div className="xl:col-span-3 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100">
              <h2 className="text-sm font-semibold text-slate-900">Existující sklady</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {warehouses.map((wh) => {
                const ownerComp = companies.find((c) => c.id === wh.ownerCompanyId);
                const count = inventory.filter((i) => i.warehouseId === wh.id).length;
                return (
                  <div key={wh.id} className="px-5 py-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{wh.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                        <span className="font-mono text-slate-700">{wh.code}</span> ·{' '}
                        {wh.shared
                          ? 'Sdílený sklad pro všechny firmy'
                          : `Oddělený sklad (${ownerComp?.name || wh.ownerCompanyId})`}
                        {wh.location ? ` · ${wh.location}` : ''}
                      </p>
                    </div>
                    <span className="text-xs font-medium text-slate-600 tabular-nums whitespace-nowrap">
                      {count} položek
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <form
            onSubmit={handleCreateWarehouse}
            className="xl:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4 self-start"
          >
            <h2 className="text-sm font-semibold text-slate-900">Založit nový sklad</h2>
            {!isCurrentUserAdmin && (
              <p className="text-xs text-amber-700">Nové sklady může zakládat pouze administrátor.</p>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Název skladu *</label>
              <input
                type="text"
                required
                disabled={!isCurrentUserAdmin}
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                placeholder="Např. Výdejna Brno"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Kód skladu (pro POHODU)
              </label>
              <input
                type="text"
                disabled={!isCurrentUserAdmin}
                value={whCode}
                onChange={(e) => setWhCode(e.target.value)}
                placeholder="SKLAD-BRNO"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Režim skladu</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={!isCurrentUserAdmin}
                  onClick={() => setWhShared(true)}
                  className={`py-2 text-xs font-medium rounded-lg border ${
                    whShared
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Sdílený
                </button>
                <button
                  type="button"
                  disabled={!isCurrentUserAdmin}
                  onClick={() => setWhShared(false)}
                  className={`py-2 text-xs font-medium rounded-lg border ${
                    !whShared
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}
                >
                  Oddělený pro firmu
                </button>
              </div>
            </div>
            {!whShared && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Patří firmě
                </label>
                <select
                  disabled={!isCurrentUserAdmin}
                  value={whOwnerCompanyId}
                  onChange={(e) => setWhOwnerCompanyId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Umístění / popis</label>
              <input
                type="text"
                disabled={!isCurrentUserAdmin}
                value={whLocation}
                onChange={(e) => setWhLocation(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
              />
            </div>
            <button
              type="submit"
              disabled={!isCurrentUserAdmin || creatingWh}
              style={{ backgroundColor: palette.primary }}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              Přidat sklad
            </button>
          </form>
        </div>
      )}

      {/* TAB 3: TEAM & ANDROID SYNC */}
      {tab === 'TEAM' && (
        <div className="space-y-6">
          <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
            <Smartphone className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
            <div className="text-sm text-emerald-950">
              <p className="font-semibold">Okamžité propojení Web ↔ Android aplikace SkladFaktura</p>
              <p className="text-xs text-emerald-900 mt-1 leading-relaxed">
                Tato webová aplikace pracuje přímo nad stejnou cloudovou databází jako vaše Android
                aplikace. Stačí, aby se kolega na mobilu i na webu přihlásil svým Google účtem
                přidaným níže — veškeré změny ve skladu, fakturách i platbách se projeví okamžitě na
                obou zařízeních.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
            <div className="xl:col-span-3 bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">
                  Členové sdíleného prostoru ({teamMembers.length} / 6)
                </h2>
                <span className="text-xs text-slate-500">Vlastník + až 5 kolegů / účetní</span>
              </div>
              <div className="divide-y divide-slate-100">
                {teamMembers.map((member) => {
                  const isOwner = member.role === 'OWNER';
                  const isAcct = isAccountantMember(member);
                  const effectiveRole: TeamRole = isOwner
                    ? 'OWNER'
                    : member.role === 'ADMIN'
                      ? 'ADMIN'
                      : isAcct
                        ? 'ACCOUNTANT'
                        : 'MEMBER';
                  const displayNameClean = stripAccountantTag(member.displayName) || member.email;
                  return (
                    <div
                      key={member.id}
                      className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-slate-900 flex items-center gap-2 flex-wrap">
                          <span>{displayNameClean}</span>
                          {member.email.toLowerCase() === userEmail && (
                            <span className="text-xs font-normal text-slate-500">(vy)</span>
                          )}
                          {effectiveRole === 'ACCOUNTANT' && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold bg-indigo-50 text-indigo-800 border border-indigo-200 rounded">
                              <Eye className="w-3 h-3" />
                              Účetní (jen pro čtení)
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {member.email} ·{' '}
                          <span className="font-medium text-slate-700">
                            {effectiveRole === 'OWNER'
                              ? 'Vlastník'
                              : effectiveRole === 'ADMIN'
                                ? 'Administrátor'
                                : effectiveRole === 'ACCOUNTANT'
                                  ? 'Účetní (jen čtení + exporty)'
                                  : 'Kolega (úpravy skladu a faktur)'}
                          </span>
                        </p>
                      </div>

                      {!isOwner && isCurrentUserAdmin && workspace && (
                        <div className="flex items-center gap-2">
                          <select
                            aria-label="Role člena týmu"
                            value={effectiveRole}
                            onChange={async (e) => {
                              const nextRole = e.target.value as Exclude<TeamRole, 'OWNER'>;
                              try {
                                await setColleagueRole({
                                  workspace,
                                  callerEmail: userEmail,
                                  member,
                                  newRole: nextRole,
                                });
                                const lbl =
                                  nextRole === 'ACCOUNTANT'
                                    ? 'Účetní (jen pro čtení)'
                                    : nextRole === 'ADMIN'
                                      ? 'Administrátor'
                                      : 'Kolega';
                                notify(`Role pro ${displayNameClean} byla změněna na ${lbl}.`);
                              } catch (err) {
                                notify(
                                  err instanceof Error ? err.message : 'Změna role selhala.',
                                  'error'
                                );
                              }
                            }}
                            className="px-2.5 py-1.5 text-xs font-medium text-slate-800 bg-slate-50 border border-slate-200 rounded-md"
                          >
                            <option value="MEMBER">Kolega (úpravy)</option>
                            <option value="ACCOUNTANT">Účetní (jen čtení)</option>
                            <option value="ADMIN">Administrátor</option>
                          </select>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await removeColleague({
                                  workspace,
                                  callerEmail: userEmail,
                                  member,
                                });
                                notify(`${displayNameClean} byl odebrán z týmu.`, 'info');
                              } catch (err) {
                                notify(
                                  err instanceof Error ? err.message : 'Odebrání selhalo.',
                                  'error'
                                );
                              }
                            }}
                            className="p-1.5 text-slate-400 hover:text-red-600 rounded-md"
                            title="Odebrat z týmu"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <form
              onSubmit={handleAddColleague}
              className="xl:col-span-2 bg-white border border-slate-200 rounded-xl p-5 space-y-4 self-start"
            >
              <h2 className="text-sm font-semibold text-slate-900">
                Pozvat kolegu nebo účetní
              </h2>
              <p className="text-xs text-slate-500">
                Účetní s rolí <strong>Účetní (jen pro čtení)</strong> vidí všechny faktury, DPH
                přehledy a může si 1 kliknutím stáhnout měsíční ZIP balíček i POHODA XML, ale nemůže
                nic smazat ani upravit.
              </p>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Jméno</label>
                <input
                  type="text"
                  disabled={!isCurrentUserAdmin || nonOwnerCount >= 5}
                  value={colleagueName}
                  onChange={(e) => setColleagueName(e.target.value)}
                  placeholder="Např. Ing. Jana Nováková (účetní)"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  E-mail *
                </label>
                <input
                  type="email"
                  required
                  disabled={!isCurrentUserAdmin || nonOwnerCount >= 5}
                  value={colleagueEmail}
                  onChange={(e) => setColleagueEmail(e.target.value)}
                  placeholder="ucetni@firma.cz"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Role a oprávnění
                </label>
                <select
                  disabled={!isCurrentUserAdmin || nonOwnerCount >= 5}
                  value={colleagueRole}
                  onChange={(e) =>
                    setColleagueRoleDraft(e.target.value as Exclude<TeamRole, 'OWNER'>)
                  }
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="ACCOUNTANT">Účetní — jen pro čtení + exporty ZIP & POHODA</option>
                  <option value="MEMBER">Kolega — fakturace a správa skladu</option>
                  <option value="ADMIN">Administrátor — plný přístup včetně firem a týmu</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={!isCurrentUserAdmin || nonOwnerCount >= 5 || teamBusy}
                style={{ backgroundColor: palette.primary }}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50"
              >
                {teamBusy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                {nonOwnerCount >= 5 ? 'Dosažen limit 5 členů' : 'Přidat do sdíleného prostoru'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB 4: MONTHLY ACCOUNTANT PACK & POHODA XML EXPORT */}
      {tab === 'POHODA' && activeCompany && (
        <div className="space-y-6 max-w-3xl">
          {/* 1-CLICK MONTHLY ACCOUNTANT ZIP PACK */}
          <div className="bg-white border-2 border-emerald-200 rounded-xl p-6 space-y-5 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <div
                  style={{ backgroundColor: palette.soft, color: palette.primary }}
                  className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
                >
                  <Archive className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Měsíční balíček pro účetní (1 klik — ZIP)
                  </h2>
                  <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                    Jedním kliknutím stáhnete kompletní archiv za vybraný měsíc pro firmu{' '}
                    <strong>{activeCompany.name}</strong>: všechna PDF vydaných faktur a prodejek,
                    archivované přijaté doklady + přehled příjemek, pokladní knihu (PDF + CSV),
                    POHODA XML DataPack v2.0 a podklad pro DPH.
                  </p>
                </div>
              </div>
              <div className="shrink-0">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  Vybraný měsíc
                </label>
                <input
                  type="month"
                  value={packMonthKey}
                  onChange={(e) => setPackMonthKey(e.target.value)}
                  className="px-3 py-2 text-sm font-medium border border-slate-200 rounded-lg bg-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-slate-500">Vydané doklady (PDF)</p>
                <p className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">
                  {packCounts.issuedCount}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-slate-500">Příjemky na sklad</p>
                <p className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">
                  {packCounts.receiptsCount}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-slate-500">Pokladna (hotovost)</p>
                <p className="text-lg font-bold text-slate-900 tabular-nums mt-0.5">
                  {packCounts.cashCount}
                </p>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-slate-500">POHODA XML + DPH</p>
                <p className="text-lg font-bold text-emerald-700 mt-0.5">V ceně ZIP</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-xs text-slate-500">
                Obsahuje složky: <span className="font-mono">01_Vydane_faktury_PDF</span>,{' '}
                <span className="font-mono">02_Prijate_doklady</span>,{' '}
                <span className="font-mono">03_Pokladna</span>,{' '}
                <span className="font-mono">04_POHODA</span>,{' '}
                <span className="font-mono">05_DPH_Prehled</span>
              </p>
              <button
                type="button"
                disabled={buildingPack || !packMonthKey}
                onClick={handleDownloadMonthlyPack}
                style={{ backgroundColor: palette.primary }}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white rounded-lg hover:opacity-95 disabled:opacity-60"
              >
                {buildingPack ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                {buildingPack
                  ? 'Sestavuji PDF a ZIP balíček…'
                  : `Stáhnout balíček pro účetní (${packMonthKey}.zip)`}
              </button>
            </div>
          </div>

          {/* INDIVIDUAL POHODA XML EXPORT */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Samostatný export pro Stormware POHODA (XML DataPack v2.0)
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                Vygenerovaný XML balíček pro firmu <strong>{activeCompany.name}</strong> (IČO{' '}
                {activeCompany.ico || 'nevyplněno'}) můžete přímo naimportovat přes Soubor → Datová
                komunikace → XML import/export.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">Rozsah exportu</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(
                  [
                    ['INVOICES', 'Pouze faktury'],
                    ['STOCK', 'Pouze skladové karty'],
                    ['BOTH', 'Faktury i sklad'],
                  ] as [PohodaExportScope, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setPohodaScope(id)}
                    className={`py-2.5 px-3 text-xs font-medium rounded-lg border transition-colors ${
                      pohodaScope === id
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {(pohodaScope === 'INVOICES' || pohodaScope === 'BOTH') && (
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyUnexported}
                  onChange={(e) => setOnlyUnexported(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Exportovat pouze dosud neexportované faktury
              </label>
            )}

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-700 space-y-1 tabular-nums">
              {(pohodaScope === 'INVOICES' || pohodaScope === 'BOTH') && (
                <p>
                  Faktur k exportu: <strong>{invoicesForPohoda.length}</strong> (stornované se
                  vynechávají)
                </p>
              )}
              {(pohodaScope === 'STOCK' || pohodaScope === 'BOTH') && (
                <p>
                  Skladových karet k exportu: <strong>{companyInventory.length}</strong>
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={exportingPohoda}
              onClick={handleExportPohoda}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-60"
            >
              {exportingPohoda ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileCode2 className="w-4 h-4" />
              )}
              Stáhnout POHODA XML balíček
            </button>
          </div>
        </div>
      )}

      {/* MODAL: ADD NEW COMPANY */}
      {newCompOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleCreateCompany}
            className="w-full max-w-2xl bg-white border border-slate-200 rounded-xl p-6 space-y-5 my-8"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Přidat novou firmu</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Firma se ihned objeví v horním přepínači firem i v synchronizované mobilní aplikaci.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setNewCompOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  IČO (pro automatické vyplnění z ARES)
                </label>
                <input
                  type="text"
                  value={newCompDraft.ico}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, ico: e.target.value })}
                  placeholder="Např. 12345678"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>
              <button
                type="button"
                disabled={newCompAresBusy}
                onClick={handleNewCompAres}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg whitespace-nowrap"
              >
                {newCompAresBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Building2 className="w-3.5 h-3.5" />
                )}
                Načíst z ARES
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Název firmy *
                </label>
                <input
                  type="text"
                  required
                  value={newCompDraft.name}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, name: e.target.value })}
                  placeholder="Např. Nová Firma s.r.o."
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">DIČ</label>
                <input
                  type="text"
                  value={newCompDraft.dic}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, dic: e.target.value })}
                  placeholder="CZ12345678"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div className="flex items-end pb-2">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newCompDraft.vatPayer}
                    onChange={(e) =>
                      setNewCompDraft({ ...newCompDraft, vatPayer: e.target.checked })
                    }
                    className="rounded border-slate-300"
                  />
                  Plátce DPH
                </label>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Ulice a č.p.</label>
                <input
                  type="text"
                  value={newCompDraft.street}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, street: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Město</label>
                <input
                  type="text"
                  value={newCompDraft.city}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, city: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">PSČ</label>
                <input
                  type="text"
                  value={newCompDraft.zip}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, zip: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Číslo bankovního účtu
                </label>
                <input
                  type="text"
                  value={newCompDraft.bankAccount}
                  onChange={(e) =>
                    setNewCompDraft({
                      ...newCompDraft,
                      bankAccount: e.target.value,
                      iban: czechAccountToIban(e.target.value) || newCompDraft.iban,
                    })
                  }
                  placeholder="123456789/2010"
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Prefix číselné řady faktur
                </label>
                <input
                  type="text"
                  value={newCompDraft.invoicePrefix}
                  onChange={(e) =>
                    setNewCompDraft({ ...newCompDraft, invoicePrefix: e.target.value })
                  }
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">E-mail</label>
                <input
                  type="email"
                  value={newCompDraft.email}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Telefon</label>
                <input
                  type="text"
                  value={newCompDraft.phone}
                  onChange={(e) => setNewCompDraft({ ...newCompDraft, phone: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Barevný akcent firmy
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {COMPANY_BRAND_PALETTES.map((pal) => {
                    const active = newCompDraft.accentIndex === pal.index;
                    return (
                      <button
                        key={pal.index}
                        type="button"
                        onClick={() => setNewCompDraft({ ...newCompDraft, accentIndex: pal.index })}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                          active
                            ? 'border-slate-900 bg-slate-50 text-slate-900'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: pal.primary }}
                        />
                        {pal.nameCz}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="sm:col-span-2 pt-1">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newCompCreateWh}
                    onChange={(e) => setNewCompCreateWh(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  Automaticky založit pro tuto firmu vlastní oddělený sklad (sdílené sklady bude mít dostupné vždy)
                </label>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewCompOpen(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Zrušit
              </button>
              <button
                type="submit"
                disabled={newCompBusy}
                style={{ backgroundColor: getCompanyPalette(newCompDraft.accentIndex).primary }}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-60"
              >
                {newCompBusy ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Založit firmu
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
