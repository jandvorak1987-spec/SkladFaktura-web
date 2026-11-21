import React, { useMemo, useState } from 'react';
import {
  Building2,
  Edit3,
  FilePlus2,
  Loader2,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { deleteClient, saveClient } from '../lib/firestoreService';
import { getCompanyPalette } from '../lib/format';
import type { Client } from '../types';

interface ClientsViewProps {
  onCreateInvoiceForClient: (client: Client) => void;
}

interface ClientFormState {
  id?: string;
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
}

const EMPTY_CLIENT: ClientFormState = {
  name: '',
  ico: '',
  dic: '',
  street: '',
  city: '',
  zip: '',
  country: 'Česká republika',
  email: '',
  phone: '',
  bankAccount: '',
  notes: '',
};

export function ClientsView({ onCreateInvoiceForClient }: ClientsViewProps) {
  const { workspace, activeCompany, clients, lookupAres, notify } = useApp();
  const palette = getCompanyPalette(activeCompany?.accentIndex);

  const [search, setSearch] = useState('');
  const [form, setForm] = useState<ClientFormState | null>(null);
  const [aresLoading, setAresLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.ico.toLowerCase().includes(q) ||
        c.dic.toLowerCase().includes(q) ||
        c.city.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q)
    );
  }, [clients, search]);

  const handleAresLookup = async () => {
    if (!form) return;
    const ico = form.ico.replace(/\D/g, '');
    if (ico.length !== 8) {
      notify('Zadejte platné 8místné IČO pro dotaz do ARES.', 'error');
      return;
    }
    setAresLoading(true);
    try {
      const subject = await lookupAres(ico);
      setForm({
        ...form,
        ico: subject.ico,
        dic: subject.dic || form.dic,
        name: subject.name || form.name,
        street: subject.street || form.street,
        city: subject.city || form.city,
        zip: subject.zip || form.zip,
      });
      notify(`Údaje z ARES načteny: ${subject.name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Dotaz na ARES selhal.', 'error');
    } finally {
      setAresLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace || !form) return;
    setSaving(true);
    try {
      await saveClient(workspace, form);
      notify(form.id ? 'Klient byl upraven.' : 'Nový klient byl uložen.');
      setForm(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Uložení klienta selhalo.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (client: Client) => {
    if (!workspace) return;
    try {
      await deleteClient(workspace.id, client.id);
      notify(`Klient ${client.name} byl odstraněn.`, 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Odstranění klienta selhalo.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Sdílený adresář pro obě firmy
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">Klienti a odběratelé</h1>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {clients.length} uložených subjektů · přímé napojení na registr ARES
          </p>
        </div>

        <button
          type="button"
          onClick={() => setForm({ ...EMPTY_CLIENT })}
          style={{ backgroundColor: palette.primary }}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-95 self-start md:self-auto whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          Nový klient
        </button>
      </div>

      {/* Search */}
      <div className="bg-white border border-slate-200 rounded-xl p-4">
        <div className="relative max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Hledat podle názvu, IČO, DIČ, města nebo e-mailu…"
            className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-400"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center">
            <Users className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-slate-900">Žádní klienti</p>
            <p className="mt-1 text-xs text-slate-500">
              Zadejte IČO odběratele a načtěte fakturační údaje jedním kliknutím z ARES.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Odběratel</th>
                  <th className="py-3 px-4">IČO / DIČ</th>
                  <th className="py-3 px-4">Adresa</th>
                  <th className="py-3 px-4">Kontakt</th>
                  <th className="py-3 px-4 text-right">Akce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filtered.map((client) => (
                  <tr key={client.id} className="hover:bg-slate-50/60">
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-900">{client.name}</p>
                      {client.notes && (
                        <p className="text-xs text-slate-500 truncate max-w-xs">{client.notes}</p>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-700 tabular-nums">
                      <p>{client.ico || '—'}</p>
                      {client.dic && <p className="text-slate-500">{client.dic}</p>}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600">
                      <p>{client.street || '—'}</p>
                      <p className="text-slate-500">
                        {[client.zip, client.city].filter(Boolean).join(' ')}
                      </p>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600">
                      <p>{client.email || '—'}</p>
                      {client.phone && <p className="text-slate-500 tabular-nums">{client.phone}</p>}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onCreateInvoiceForClient(client)}
                          title="Vystavit fakturu tomuto klientovi"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md"
                        >
                          <FilePlus2 className="w-3.5 h-3.5" />
                          Fakturovat
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              id: client.id,
                              name: client.name,
                              ico: client.ico,
                              dic: client.dic,
                              street: client.street,
                              city: client.city,
                              zip: client.zip,
                              country: client.country || 'Česká republika',
                              email: client.email,
                              phone: client.phone,
                              bankAccount: client.bankAccount,
                              notes: client.notes,
                            })
                          }
                          className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(client)}
                          className="p-1.5 text-slate-400 hover:text-red-600 rounded-md"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Create/Edit Client with ARES */}
      {form && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleSave}
            className="w-full max-w-xl bg-white border border-slate-200 rounded-xl p-6 space-y-4 my-8"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-semibold text-slate-900">
                {form.id ? 'Upravit klienta' : 'Nový klient'}
              </h3>
              <button
                type="button"
                onClick={() => setForm(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ARES Lookup Bar */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-end gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  IČO (8 číslic)
                </label>
                <input
                  type="text"
                  value={form.ico}
                  onChange={(e) => setForm({ ...form, ico: e.target.value })}
                  placeholder="Např. 27082440"
                  className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-200 rounded-lg"
                />
              </div>
              <button
                type="button"
                onClick={handleAresLookup}
                disabled={aresLoading}
                className="inline-flex items-center justify-center gap-2 px-3.5 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg whitespace-nowrap"
              >
                {aresLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Building2 className="w-4 h-4" />
                )}
                Načíst z ARES
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Název firmy / jméno *
                </label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">DIČ</label>
                <input
                  type="text"
                  value={form.dic}
                  onChange={(e) => setForm({ ...form, dic: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Bankovní účet</label>
                <input
                  type="text"
                  value={form.bankAccount}
                  onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Ulice a č.p.</label>
                <input
                  type="text"
                  value={form.street}
                  onChange={(e) => setForm({ ...form, street: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Město</label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">PSČ</label>
                <input
                  type="text"
                  value={form.zip}
                  onChange={(e) => setForm({ ...form, zip: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">E-mail</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Telefon</label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Poznámka</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                />
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setForm(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Zrušit
              </button>
              <button
                type="submit"
                disabled={saving}
                style={{ backgroundColor: palette.primary }}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
              >
                {saving ? 'Ukládám…' : 'Uložit klienta'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
