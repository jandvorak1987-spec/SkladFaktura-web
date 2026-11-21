import React, { useState } from 'react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  FileSpreadsheet,
  Landmark,
  Layers,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useApp } from '../context/AppContext';

type EmailAuthMode = 'LOGIN' | 'REGISTER' | 'RESET';

function mapFirebaseAuthError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : '';
  if (code === 'auth/operation-not-allowed') {
    return 'Přihlášení e-mailem a heslem zatím není zapnuté ve Firebase Console (Authentication → Sign-in method → E-mail/heslo).';
  }
  if (
    code === 'auth/invalid-credential' ||
    code === 'auth/wrong-password' ||
    code === 'auth/user-not-found'
  ) {
    return 'Nesprávný e-mail nebo heslo. Pokud účet ještě nemáte, přepněte na Registraci.';
  }
  if (code === 'auth/email-already-in-use') {
    return 'Tento e-mail je už zaregistrovaný. Přihlaste se nebo použijte obnovení hesla.';
  }
  if (code === 'auth/weak-password') {
    return 'Heslo musí mít alespoň 6 znaků.';
  }
  if (code === 'auth/invalid-email') {
    return 'Zadejte platnou e-mailovou adresu.';
  }
  if (code === 'auth/too-many-requests') {
    return 'Příliš mnoho pokusů. Počkejte prosím chvíli a zkuste to znovu.';
  }
  return error instanceof Error ? error.message : 'Přihlášení se nezdařilo.';
}

export function EmailVerificationScreen() {
  const { user, resendVerificationEmail, refreshEmailVerification, signOutUser } = useApp();
  const [checking, setChecking] = useState(false);
  const [resending, setResending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleCheck = async () => {
    setChecking(true);
    setErrorMsg(null);
    setMessage(null);
    try {
      const verified = await refreshEmailVerification();
      if (!verified) {
        setErrorMsg(
          'E-mail zatím není ověřený. Otevřete prosím svou schránku (i složku Spam) a klikněte na ověřovací odkaz.'
        );
      }
    } catch (err) {
      setErrorMsg(mapFirebaseAuthError(err));
    } finally {
      setChecking(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    setErrorMsg(null);
    setMessage(null);
    try {
      await resendVerificationEmail();
      setMessage('Ověřovací e-mail byl odeslán znovu.');
    } catch (err) {
      setErrorMsg(mapFirebaseAuthError(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8 space-y-5">
        <div className="w-11 h-11 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center">
          <Mail className="w-5 h-5" />
        </div>

        <div>
          <h1 className="text-xl font-bold text-slate-900">Ověřte svou e-mailovou adresu</h1>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            Na adresu <strong className="text-slate-900">{user?.email}</strong> jsme odeslali
            ověřovací odkaz. Kvůli zabezpečení sdílené databáze je nutné e-mail jednou potvrdit.
          </p>
        </div>

        {message && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900">
            {message}
          </div>
        )}
        {errorMsg && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
            {errorMsg}
          </div>
        )}

        <div className="space-y-2.5 pt-1">
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg"
          >
            {checking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            E-mail jsem ověřil(a) – vstoupit
          </button>

          <button
            type="button"
            onClick={handleResend}
            disabled={resending}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-60 rounded-lg"
          >
            <RefreshCw className={`w-4 h-4 ${resending ? 'animate-spin' : ''}`} />
            Poslat ověřovací e-mail znovu
          </button>

          <button
            type="button"
            onClick={signOutUser}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-500 hover:text-slate-800"
          >
            <LogOut className="w-3.5 h-3.5" />
            Odhlásit se a použít jiný účet
          </button>
        </div>
      </div>
    </div>
  );
}

export function AuthScreen() {
  const { signInWithGoogle, signInWithEmail, registerWithEmail, sendResetPassword } = useApp();
  const [signingInGoogle, setSigningInGoogle] = useState(false);

  const [emailMode, setEmailMode] = useState<EmailAuthMode>('LOGIN');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busyEmail, setBusyEmail] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setErrorMsg(null);
    setInfoMsg(null);
    setSigningInGoogle(true);
    try {
      await signInWithGoogle();
    } finally {
      setSigningInGoogle(false);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setInfoMsg(null);
    setBusyEmail(true);
    try {
      if (emailMode === 'LOGIN') {
        await signInWithEmail(email, password);
      } else if (emailMode === 'REGISTER') {
        await registerWithEmail(email, password, displayName);
      } else {
        await sendResetPassword(email);
        setInfoMsg('Odkaz pro nastavení nového hesla jsme odeslali na váš e-mail.');
        setEmailMode('LOGIN');
      }
    } catch (err) {
      setErrorMsg(mapFirebaseAuthError(err));
    } finally {
      setBusyEmail(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left column: Value proposition */}
      <div className="lg:w-7/12 bg-slate-900 text-white p-8 sm:p-12 lg:p-16 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-semibold text-lg">
              SF
            </div>
            <div>
              <p className="text-lg font-semibold tracking-tight leading-none">SkladFaktura</p>
              <p className="text-xs text-slate-400 mt-1">Webová kancelář · synchronizace s Android</p>
            </div>
          </div>

          <h1 className="mt-12 text-3xl sm:text-4xl font-bold tracking-tight text-white max-w-xl leading-tight">
            Sklad, fakturace a párování banky pro obě firmy v reálném čase.
          </h1>
          <p className="mt-4 text-base text-slate-300 max-w-lg leading-relaxed">
            Okamžitě propojeno se stejnou databází jako vaše Android aplikace SkladFaktura.
            Každý příjem zboží, vystavená faktura i spárovaná platba se projeví v telefonu i na webu bez prodlevy.
          </p>

          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl">
            <div className="border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                <Building2 className="w-4 h-4 shrink-0" />
                Dvě firmy, sdílené i oddělené sklady
              </div>
              <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
                Přepínání mezi Firmou A a Firmou B s vlastní číselnou řadou, barvou dokladů i DPH.
              </p>
            </div>

            <div className="border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                <Sparkles className="w-4 h-4 shrink-0" />
                AI Příjemka & ARES
              </div>
              <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
                Hromadné naskladnění z fotky, PDF nebo CSV a načtení údajů odběratele z ARES podle IČO.
              </p>
            </div>

            <div className="border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                <Landmark className="w-4 h-4 shrink-0" />
                Fio API, GPC/CSV a QR Platba
              </div>
              <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
                Automatické párování plateb podle variabilního symbolu a 4 vizuální šablony faktur.
              </p>
            </div>

            <div className="border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                <FileSpreadsheet className="w-4 h-4 shrink-0" />
                Stormware POHODA XML v2.0
              </div>
              <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">
                Export vydaných faktur i skladových karet jedním klikem pro účetní a daňové zpracování.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-slate-800 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            Sdílený tým až 4 uživatelů
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-slate-500" />
            Google účet nebo libovolný e-mail s heslem
          </span>
        </div>
      </div>

      {/* Right column: Sign-in card */}
      <div className="lg:w-5/12 flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-7 sm:p-8">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
            Přihlášení do sdíleného prostoru
          </p>
          <h2 className="mt-1.5 text-2xl font-bold text-slate-900">Vstup do SkladFaktura</h2>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
            Přihlaste se přes Google (stejně jako v Android aplikaci) nebo libovolným pozvaným
            e-mailem a heslem.
          </p>

          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={signingInGoogle || busyEmail}
            className="mt-6 w-full inline-flex items-center justify-center gap-3 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17z"
              />
              <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14z"
              />
              <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96z"
              />
            </svg>
            <span>{signingInGoogle ? 'Přihlašuji…' : 'Pokračovat přes Google účet'}</span>
            <ArrowRight className="w-4 h-4 ml-auto opacity-80" />
          </button>

          <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
            <div className="h-px bg-slate-200 flex-1" />
            <span>nebo libovolný e-mail a heslo</span>
            <div className="h-px bg-slate-200 flex-1" />
          </div>

          <div className="inline-flex w-full bg-slate-100 p-0.5 rounded-lg border border-slate-200 mb-4">
            <button
              type="button"
              onClick={() => {
                setEmailMode('LOGIN');
                setErrorMsg(null);
                setInfoMsg(null);
              }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                emailMode === 'LOGIN'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Přihlášení
            </button>
            <button
              type="button"
              onClick={() => {
                setEmailMode('REGISTER');
                setErrorMsg(null);
                setInfoMsg(null);
              }}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${
                emailMode === 'REGISTER'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              První registrace
            </button>
          </div>

          {errorMsg && (
            <div className="mb-3 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 leading-relaxed">
              {errorMsg}
            </div>
          )}
          {infoMsg && (
            <div className="mb-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 leading-relaxed">
              {infoMsg}
            </div>
          )}

          <form onSubmit={handleEmailSubmit} className="space-y-3">
            {emailMode === 'REGISTER' && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Jméno a příjmení
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Např. Petr Novák"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                E-mail (Seznam, firemní, Gmail…)
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="kolega@firma.cz"
                className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
              />
            </div>

            {emailMode !== 'RESET' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">Heslo</label>
                  {emailMode === 'LOGIN' && (
                    <button
                      type="button"
                      onClick={() => {
                        setEmailMode('RESET');
                        setErrorMsg(null);
                        setInfoMsg(null);
                      }}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      Zapomenuté heslo?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimálně 6 znaků"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={busyEmail || signingInGoogle}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 disabled:opacity-60 rounded-lg transition-colors"
            >
              {busyEmail ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
              {emailMode === 'LOGIN'
                ? 'Přihlásit se e-mailem'
                : emailMode === 'REGISTER'
                  ? 'Vytvořit účet a ověřit e-mail'
                  : 'Odeslat odkaz pro obnovení hesla'}
            </button>

            {emailMode === 'RESET' && (
              <button
                type="button"
                onClick={() => setEmailMode('LOGIN')}
                className="w-full text-xs text-slate-500 hover:text-slate-900 py-1"
              >
                Zpět na přihlášení
              </button>
            )}
          </form>

          <div className="mt-5 pt-4 border-t border-slate-100 text-xs text-slate-500 space-y-1">
            <p>
              <strong className="text-slate-700 font-medium">Jste pozvaný kolega?</strong> Použijte
              přesně ten e-mail, který administrátor přidal v Nastavení → Tým.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
