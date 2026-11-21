import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
  isQuotaError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
    isQuotaError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    const raw = error.message || 'Neočekávaná chyba aplikace.';
    let readable = raw;
    let isQuotaError = raw.toLowerCase().includes('quota exceeded');

    try {
      const parsed = JSON.parse(raw) as { error?: string; operationType?: string; path?: string };
      if (parsed && parsed.error) {
        readable = `${parsed.error} (${parsed.operationType || 'operace'} · ${parsed.path || 'databáze'})`;
        if (parsed.error.toLowerCase().includes('quota exceeded')) {
          isQuotaError = true;
        }
      }
    } catch {
      // Plain error message
    }

    return {
      hasError: true,
      errorMessage: readable,
      isQuotaError,
    };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('SkladFaktura ErrorBoundary:', error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-8">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-red-50 text-red-700 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-lg font-semibold text-slate-900">
                  {this.state.isQuotaError
                    ? 'Překročen denní limit databáze Firebase'
                    : 'Došlo k chybě při práci s daty'}
                </h1>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  {this.state.isQuotaError
                    ? 'Denní kvóta bezplatného tarifu Firestore byla vyčerpána. Limit se automaticky obnoví následující den.'
                    : 'Aplikace nemohla dokončit požadovanou operaci. Zkontrolujte své oprávnění v pracovním prostoru nebo připojení k síti.'}
                </p>
                <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg font-mono text-xs text-slate-700 break-words">
                  {this.state.errorMessage}
                </div>
                <div className="mt-6 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={this.handleReload}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Obnovit aplikaci
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
