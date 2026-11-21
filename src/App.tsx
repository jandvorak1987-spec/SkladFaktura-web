import React, { useState } from 'react';
import {
  BarChart3,
  Bell,
  FilePlus2,
  FileText,
  Landmark,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Package,
  RotateCcw,
  Settings,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthScreen, EmailVerificationScreen } from './components/AuthScreen';
import { DashboardView } from './components/DashboardView';
import { InventoryView } from './components/InventoryView';
import { SmartStockInView } from './components/SmartStockInView';
import { InvoicesView } from './components/InvoicesView';
import { BankMatchingView } from './components/BankMatchingView';
import { ClientsView } from './components/ClientsView';
import { AlertsCenterView } from './components/AlertsCenterView';
import { ReportsVatView } from './components/ReportsVatView';
import { SettingsExportView } from './components/SettingsExportView';
import { getCompanyPalette } from './lib/format';
import type { AppSection, Client } from './types';

interface NavItem {
  id: AppSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Přehled', icon: LayoutDashboard },
  { id: 'inventory', label: 'Sklad a pohyby', icon: Package },
  { id: 'smart-stock-in', label: 'AI Příjemka', icon: Sparkles },
  { id: 'invoices', label: 'Faktury', icon: FileText },
  { id: 'reports', label: 'Přehledy a DPH', icon: BarChart3 },
  { id: 'bank-matching', label: 'Párování banky', icon: Landmark },
  { id: 'clients', label: 'Klienti (ARES)', icon: Users },
  { id: 'alerts', label: 'Upozornění', icon: Bell },
  { id: 'settings', label: 'Nastavení & POHODA', icon: Settings },
];

function WorkspaceShell() {
  const {
    authReady,
    user,
    emailVerified,
    workspace,
    workspaceLoading,
    workspaceInitError,
    retryWorkspaceInit,
    companies,
    activeCompany,
    switchCompany,
    totalAlertCount,
    signOutUser,
    toasts,
    dismissToast,
  } = useApp();

  const [section, setSection] = useState<AppSection>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [invoiceCreateTrigger, setInvoiceCreateTrigger] = useState(0);
  const [prefillClient, setPrefillClient] = useState<Client | null>(null);

  if (!authReady) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-slate-600">
          <Loader2 className="w-5 h-5 animate-spin text-slate-700" />
          Načítám SkladFaktura…
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  if (!emailVerified) {
    return <EmailVerificationScreen />;
  }

  if (workspaceLoading && !workspace) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-md w-full text-center space-y-3">
          <Loader2 className="w-6 h-6 animate-spin text-slate-700 mx-auto" />
          <h2 className="text-base font-semibold text-slate-900">
            Připojuji sdílený prostor Android & Web…
          </h2>
          <p className="text-xs text-slate-500">
            Ověřuji přístup pro účet <strong className="text-slate-700">{user.email}</strong>
          </p>
        </div>
      </div>
    );
  }

  if (workspaceInitError && !workspace) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl p-8 max-w-md w-full space-y-4">
          <h2 className="text-base font-semibold text-slate-900">
            Nepodařilo se načíst pracovní prostor
          </h2>
          <p className="text-xs text-slate-600 leading-relaxed">{workspaceInitError}</p>
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={retryWorkspaceInit}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg"
            >
              <RotateCcw className="w-4 h-4" />
              Zkusit znovu
            </button>
            <button
              type="button"
              onClick={signOutUser}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Odhlásit se
            </button>
          </div>
        </div>
      </div>
    );
  }

  const palette = getCompanyPalette(activeCompany?.accentIndex);

  const openNewInvoice = (client?: Client) => {
    if (client) {
      setPrefillClient(client);
    } else {
      setPrefillClient(null);
    }
    setSection('invoices');
    setInvoiceCreateTrigger((n) => n + 1);
  };

  const navigate = (target: AppSection) => {
    setSection(target);
    setMobileMenuOpen(false);
  };

  const sidebarNav = (
    <div className="flex flex-col h-full">
      <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-3">
        <div
          style={{ backgroundColor: palette.primary }}
          className="w-9 h-9 rounded-lg text-white flex items-center justify-center font-bold text-sm shrink-0"
        >
          SF
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-900 truncate">SkladFaktura</p>
          <p className="text-[11px] text-slate-500 truncate">
            {workspace?.name || 'Společný prostor'}
          </p>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => navigate(item.id)}
              className={`w-full flex items-center justify-between gap-2.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                active
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
              }`}
            >
              <span className="flex items-center gap-2.5 truncate">
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </span>
              {item.id === 'alerts' && totalAlertCount > 0 && (
                <span
                  className={`text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-md ${
                    active ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-900'
                  }`}
                >
                  {totalAlertCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-slate-200">
        <div className="px-3 py-2 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-900 truncate">
              {user.displayName || 'Uživatel'}
            </p>
            <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={signOutUser}
            title="Odhlásit se"
            className="p-1.5 text-slate-400 hover:text-slate-800 hover:bg-slate-100 rounded-md shrink-0"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="no-print hidden lg:flex lg:flex-col w-60 bg-white border-r border-slate-200 fixed inset-y-0 left-0 z-30">
        {sidebarNav}
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-64 max-w-[85vw] bg-white h-full z-10 shadow-xl">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="absolute top-3 right-3 p-1.5 text-slate-400 hover:text-slate-700"
            >
              <X className="w-4 h-4" />
            </button>
            {sidebarNav}
          </div>
        </div>
      )}

      {/* Main Column */}
      <div className="flex-1 lg:pl-60 flex flex-col min-w-0">
        {/* Persistent Top Company Switcher Header */}
        <header className="no-print sticky top-0 z-20 bg-white border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-lg"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="inline-flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 overflow-x-auto max-w-full">
              {companies.map((c) => {
                const pal = getCompanyPalette(c.accentIndex);
                const isActive = c.id === activeCompany?.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => switchCompany(c.id)}
                    className={`inline-flex items-center gap-2 px-3 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: pal.primary }}
                    />
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => navigate('alerts')}
              title="Centrum upozornění"
              className="relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <Bell className="w-4 h-4" />
              {totalAlertCount > 0 && (
                <span className="text-xs font-semibold text-amber-800 tabular-nums">
                  {totalAlertCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => openNewInvoice()}
              style={{ backgroundColor: palette.primary }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-95 whitespace-nowrap"
            >
              <FilePlus2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Nová faktura</span>
            </button>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {section === 'dashboard' && (
            <DashboardView
              onNavigate={navigate}
              onQuickCreateInvoice={() => openNewInvoice()}
            />
          )}
          {section === 'inventory' && <InventoryView onNavigate={navigate} />}
          {section === 'smart-stock-in' && <SmartStockInView />}
          {section === 'invoices' && (
            <InvoicesView
              initialCreateTrigger={invoiceCreateTrigger}
              prefillClient={prefillClient}
              onClearPrefillClient={() => setPrefillClient(null)}
            />
          )}
          {section === 'reports' && <ReportsVatView />}
          {section === 'bank-matching' && <BankMatchingView />}
          {section === 'clients' && (
            <ClientsView onCreateInvoiceForClient={(c) => openNewInvoice(c)} />
          )}
          {section === 'alerts' && <AlertsCenterView onNavigate={navigate} />}
          {section === 'settings' && <SettingsExportView />}
        </main>
      </div>

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="no-print fixed bottom-4 right-4 z-50 space-y-2 max-w-sm w-full pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start justify-between gap-3 px-4 py-3 rounded-lg border shadow-md text-xs font-medium ${
                t.tone === 'error'
                  ? 'bg-red-50 border-red-200 text-red-900'
                  : t.tone === 'info'
                    ? 'bg-white border-slate-200 text-slate-800'
                    : 'bg-slate-900 border-slate-800 text-white'
              }`}
            >
              <span>{t.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="opacity-70 hover:opacity-100 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <WorkspaceShell />
      </AppProvider>
    </ErrorBoundary>
  );
}
