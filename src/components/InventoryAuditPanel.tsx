import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ClipboardCheck,
  Download,
  FileText,
  Loader2,
  RotateCcw,
  ScanBarcode,
  X,
} from 'lucide-react';
import { QtyInput, parseQtyNumber } from './QtyInput';
import { commitInventoryAudit } from '../lib/firestoreService';
import { downloadTextFile, formatCzk, formatQty, round2, toIsoDate } from '../lib/format';
import type { Company, InventoryItem, Warehouse, Workspace } from '../types';

interface InventoryAuditPanelProps {
  items: InventoryItem[];
  warehouses: Warehouse[];
  workspace: Workspace;
  company?: Company | null;
  auditorEmail?: string;
  activeCompanyId: string;
  accentColor: string;
  readOnly?: boolean;
  onNotify: (msg: string, tone?: 'success' | 'error' | 'info') => void;
}

interface DetectedBarcodeLike {
  rawValue?: string;
}

interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement) => Promise<DetectedBarcodeLike[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

function playScanBeep() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1120;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
    window.setTimeout(() => ctx.close().catch(() => {}), 200);
  } catch {
    // Audio feedback is optional
  }
}

export function InventoryAuditPanel({
  items,
  warehouses,
  workspace,
  company = null,
  auditorEmail = '',
  activeCompanyId,
  accentColor,
  readOnly = false,
  onNotify,
}: InventoryAuditPanelProps) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [scanInput, setScanInput] = useState('');
  const [lastScannedId, setLastScannedId] = useState<string | null>(null);
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [docRef, setDocRef] = useState(`Inventura ${toIsoDate()}`);
  const [committing, setCommitting] = useState(false);
  const scanRef = useRef<HTMLInputElement | null>(null);

  // Live mobile/webcam EAN barcode scanner state
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState<string>('Připravuji kameru…');
  const [cameraScanCount, setCameraScanCount] = useState(0);
  const [lastCameraCode, setLastCameraCode] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScanCooldownRef = useRef<{ code: string; ts: number }>({ code: '', ts: 0 });

  const whMap = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);

  const getCounted = (item: InventoryItem): number => {
    return counts[item.id] !== undefined ? counts[item.id] : item.quantity;
  };

  const applyScannedCode = useCallback(
    (rawCode: string, fromCamera = false): boolean => {
      const code = rawCode.trim().toLowerCase();
      if (!code) return false;

      const match = items.find(
        (i) =>
          (i.ean && i.ean.trim().toLowerCase() === code) ||
          i.sku.trim().toLowerCase() === code ||
          i.name.trim().toLowerCase() === code
      );

      if (!match) {
        onNotify(
          `Kód „${rawCode.trim()}“ nebyl nalezen v zobrazených skladových kartách.`,
          'error'
        );
        return false;
      }

      setCounts((prev) => {
        const current = prev[match.id] !== undefined ? prev[match.id] : 0;
        return { ...prev, [match.id]: round2(current + 1) };
      });
      setLastScannedId(match.id);
      if (fromCamera) {
        setCameraScanCount((c) => c + 1);
        setLastCameraCode(`${match.name} (${rawCode.trim()})`);
        playScanBeep();
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
          navigator.vibrate(55);
        }
      }
      onNotify(`Naskenováno +1 ${match.unit}: ${match.name}`, 'info');
      return true;
    },
    [items, onNotify]
  );

  const handleScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!scanInput.trim()) return;
    applyScannedCode(scanInput, false);
    setScanInput('');
    scanRef.current?.focus();
  };

  // Start/stop mobile camera + native BarcodeDetector loop
  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!cameraOpen) {
      stopCamera();
      return;
    }

    let cancelled = false;
    let rafId = 0;
    setCameraError(null);
    setCameraStatus('Spouštím zadní kameru…');

    const start = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError(
          'Tento prohlížeč nepodporuje přístup ke kameře (vyžaduje HTTPS). Použijte ruční zadání EAN nebo Bluetooth/USB čtečku.'
        );
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        const DetectorCtor = window.BarcodeDetector;
        if (!DetectorCtor) {
          setCameraStatus(
            'Kamera běží, ale tento prohlížeč nemá nativní čtečku čárových kódů (použijte Chrome na Androidu/PC nebo zadejte EAN ručně).'
          );
          return;
        }

        const detector = new DetectorCtor({
          formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'],
        });
        setCameraStatus('Namiřte kameru na čárový kód EAN nebo QR — automaticky započítá +1 ks');

        const loop = async () => {
          if (cancelled) return;
          const video = videoRef.current;
          if (video && video.readyState >= 2) {
            try {
              const found = await detector.detect(video);
              if (found && found.length > 0) {
                const raw = (found[0].rawValue || '').trim();
                const now = Date.now();
                const prev = lastScanCooldownRef.current;
                // 1.5s debounce per same code to prevent rapid accidental duplicates
                if (raw && (raw !== prev.code || now - prev.ts > 1500)) {
                  lastScanCooldownRef.current = { code: raw, ts: now };
                  applyScannedCode(raw, true);
                }
              }
            } catch {
              // Ignore single-frame detection errors
            }
          }
          rafId = window.setTimeout(() => {
            if (!cancelled) loop();
          }, 220);
        };

        loop();
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err instanceof Error
              ? `Přístup ke kameře byl zamítnut nebo není dostupný: ${err.message}`
              : 'Nelze otevřít kameru zařízení.'
          );
        }
      }
    };

    start();

    return () => {
      cancelled = true;
      if (rafId) window.clearTimeout(rafId);
      stopCamera();
    };
  }, [cameraOpen, applyScannedCode, stopCamera]);

  const rows = useMemo(() => {
    return items
      .map((item) => {
        const counted = getCounted(item);
        const delta = round2(counted - item.quantity);
        const diffValue = round2(delta * Math.max(0, item.purchasePrice));
        return { item, counted, delta, diffValue };
      })
      .filter((r) => !onlyDiffs || r.delta !== 0);
  }, [items, counts, onlyDiffs]);

  const summary = useMemo(() => {
    let diffCount = 0;
    let surplusValue = 0;
    let shortageValue = 0;
    for (const item of items) {
      const counted = getCounted(item);
      const delta = round2(counted - item.quantity);
      if (delta !== 0) {
        diffCount++;
        const val = round2(delta * Math.max(0, item.purchasePrice));
        if (val >= 0) surplusValue = round2(surplusValue + val);
        else shortageValue = round2(shortageValue + val);
      }
    }
    return {
      diffCount,
      surplusValue,
      shortageValue,
      netValue: round2(surplusValue + shortageValue),
    };
  }, [items, counts]);

  const handleZeroAllForFullScan = () => {
    const zeroed: Record<string, number> = {};
    for (const item of items) zeroed[item.id] = 0;
    setCounts(zeroed);
    onNotify('Všechny napočítané stavy nastaveny na 0 – můžete skenovat od nuly.', 'info');
    scanRef.current?.focus();
  };

  const handleReset = () => {
    setCounts({});
    setLastScannedId(null);
    setCameraScanCount(0);
    setLastCameraCode(null);
  };

  const handleExportAuditCsv = () => {
    const header = 'SKU;EAN;Nazev;Sklad;Evidovany stav;Skutecny stav;Rozdil;MJ;Hodnota rozdilu CZK';
    const lines = items.map((item) => {
      const counted = getCounted(item);
      const delta = round2(counted - item.quantity);
      const val = round2(delta * Math.max(0, item.purchasePrice));
      const esc = (s: string) => `"${String(s || '').replace(/"/g, '""')}"`;
      return [
        esc(item.sku),
        esc(item.ean),
        esc(item.name),
        esc(whMap.get(item.warehouseId) || item.warehouseId),
        item.quantity,
        counted,
        delta,
        esc(item.unit),
        val,
      ].join(';');
    });
    downloadTextFile(
      `\uFEFF${header}\n${lines.join('\n')}`,
      `inventurni_protokol_${toIsoDate()}.csv`,
      'text/csv;charset=utf-8'
    );
    onNotify('Inventurní protokol (CSV) byl stažen.');
  };

  const handleExportAuditPdf = async () => {
    const exportRows = (onlyDiffs ? rows : items.map((item) => {
      const counted = getCounted(item);
      const delta = round2(counted - item.quantity);
      return {
        item,
        counted,
        delta,
        diffValue: round2(delta * Math.max(0, item.purchasePrice)),
      };
    })).map((r) => ({
      sku: r.item.sku,
      ean: r.item.ean,
      name: r.item.name,
      warehouseName: whMap.get(r.item.warehouseId) || r.item.warehouseId,
      unit: r.item.unit || 'ks',
      systemQty: r.item.quantity,
      actualQty: r.counted,
      delta: r.delta,
      purchasePrice: r.item.purchasePrice,
      valueDelta: r.diffValue,
    }));

    const { downloadPdfBytes, generateInventoryAuditPdfBytes } = await import('../lib/pdfExport');
    const uniqueWhNames = Array.from(new Set(exportRows.map((r) => r.warehouseName)));
    const pdfBytes = generateInventoryAuditPdfBytes({
      company,
      docRef: docRef.trim() || `Inventura ${toIsoDate()}`,
      auditDate: toIsoDate(),
      warehouseLabel:
        uniqueWhNames.length === 1 ? uniqueWhNames[0] : `Všechny sklady (${uniqueWhNames.length})`,
      auditorEmail,
      rows: exportRows,
      totalCounted: items.length,
      shortageValue: summary.shortageValue,
      surplusValue: summary.surplusValue,
      netValue: summary.netValue,
    });
    downloadPdfBytes(pdfBytes, `inventurni_protokol_${toIsoDate()}.pdf`);
    onNotify('Inventurní protokol v PDF (A4) byl vygenerován a stažen.');
  };

  const handleCommitAudit = async () => {
    if (readOnly) return;
    const adjustments = items
      .map((item) => ({ item, countedQty: getCounted(item) }))
      .filter((a) => round2(a.countedQty - a.item.quantity) !== 0);
    if (adjustments.length === 0) {
      onNotify('Nejsou zadány žádné rozdíly k zaúčtování.', 'info');
      return;
    }
    setCommitting(true);
    try {
      const count = await commitInventoryAudit({
        workspace,
        activeCompanyId,
        adjustments,
        documentRef: docRef.trim() || `Inventura ${toIsoDate()}`,
      });
      setCounts({});
      setLastScannedId(null);
      onNotify(`Inventura uzavřena: srovnáno ${count} položek a zapsáno do deníku pohybů.`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Uzavření inventury selhalo.', 'error');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Live Camera EAN Barcode Scanner Panel */}
      {cameraOpen && (
        <div className="bg-slate-950 text-white rounded-xl overflow-hidden border border-slate-800 shadow-lg">
          <div className="px-4 py-3 bg-slate-900 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs">
              <Camera className="w-4 h-4 text-emerald-400" />
              <span className="font-semibold">Fyzická inventura — skener EAN kamerou</span>
              {cameraScanCount > 0 && (
                <span className="px-2 py-0.5 bg-emerald-600/30 text-emerald-300 border border-emerald-500/40 rounded font-mono">
                  Naskenováno: {cameraScanCount}×
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setCameraOpen(false)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 rounded-md"
            >
              <X className="w-3.5 h-3.5" />
              Zavřít kameru
            </button>
          </div>

          {cameraError ? (
            <div className="p-6 text-center text-xs text-red-300 space-y-2">
              <p>{cameraError}</p>
            </div>
          ) : (
            <div className="relative bg-black flex items-center justify-center max-h-72 overflow-hidden">
              <video
                ref={videoRef}
                playsInline
                muted
                className="w-full max-h-72 object-cover"
              />
              {/* Scan viewfinder frame */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="w-64 h-28 border-2 border-emerald-400/90 rounded-lg relative shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
                  <div className="absolute inset-x-2 top-1/2 h-0.5 bg-red-500/80 animate-pulse" />
                </div>
              </div>
            </div>
          )}

          <div className="px-4 py-2.5 bg-slate-900/90 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-slate-300">{cameraStatus}</span>
            {lastCameraCode && (
              <span className="text-emerald-300 font-medium truncate max-w-sm">
                Poslední sken: {lastCameraCode}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Scanner & Audit Control Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <form onSubmit={handleScanSubmit} className="flex-1 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[220px]">
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Skenování čárového kódu (kamerou mobilu, EAN/SKU čtečkou nebo ručně + Enter)
              </label>
              <div className="relative">
                <ScanBarcode className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={scanRef}
                  type="text"
                  disabled={readOnly}
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="Naskenujte EAN nebo zadejte SKU a stiskněte Enter (+1 ks)…"
                  className="w-full pl-9 pr-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:border-slate-400 disabled:bg-slate-50"
                />
              </div>
            </div>
            {!readOnly && (
              <>
                <button
                  type="submit"
                  className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg whitespace-nowrap"
                >
                  +1 započítat
                </button>
                <button
                  type="button"
                  onClick={() => setCameraOpen((v) => !v)}
                  style={!cameraOpen ? { backgroundColor: accentColor } : undefined}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg whitespace-nowrap ${
                    cameraOpen
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'text-white hover:opacity-95'
                  }`}
                >
                  <Camera className="w-3.5 h-3.5" />
                  {cameraOpen ? 'Vypnout kameru' : 'Skenovat kamerou (EAN)'}
                </button>
              </>
            )}
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={docRef}
              onChange={(e) => setDocRef(e.target.value)}
              placeholder="Název inventury"
              className="px-3 py-2 text-xs border border-slate-200 rounded-lg w-44"
            />
            {!readOnly && (
              <>
                <button
                  type="button"
                  onClick={handleZeroAllForFullScan}
                  className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg whitespace-nowrap"
                  title="Nastaví všechny skutečné stavy na 0 pro kompletní fyzické přepočítání čtečkou nebo kamerou"
                >
                  Vynulovat pro plný sken
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset
                </button>
              </>
            )}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4 text-xs tabular-nums">
            <label className="inline-flex items-center gap-1.5 text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyDiffs}
                onChange={(e) => setOnlyDiffs(e.target.checked)}
                className="rounded border-slate-300"
              />
              Jen položky s rozdílem ({summary.diffCount})
            </label>
            <span className="text-emerald-700 font-medium">
              Přebytky: +{formatCzk(summary.surplusValue)}
            </span>
            <span className="text-red-700 font-medium">
              Manka: {formatCzk(summary.shortageValue)}
            </span>
            <span className="font-semibold text-slate-900">
              Čistý rozdíl: {summary.netValue >= 0 ? '+' : ''}
              {formatCzk(summary.netValue)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportAuditPdf}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-lg"
            >
              <FileText className="w-3.5 h-3.5" />
              Inventurní protokol PDF
            </button>
            <button
              type="button"
              onClick={handleExportAuditCsv}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg"
            >
              <Download className="w-3.5 h-3.5" />
              Protokol CSV
            </button>
            {!readOnly && (
              <button
                type="button"
                disabled={committing || summary.diffCount === 0}
                onClick={handleCommitAudit}
                style={{ backgroundColor: accentColor }}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white rounded-lg hover:opacity-95 disabled:opacity-50"
              >
                {committing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Zaúčtovat manko/přebytek ({summary.diffCount})
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Audit Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-12 text-center">
            <ClipboardCheck className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-slate-900">
              {onlyDiffs ? 'Žádné inventurní rozdíly' : 'Žádné položky pro inventuru'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="py-3 px-4">Položka / SKU / EAN</th>
                  <th className="py-3 px-4">Sklad</th>
                  <th className="py-3 px-4 text-right">Evidovaný stav</th>
                  <th className="py-3 px-4 text-right w-36">Skutečný stav</th>
                  <th className="py-3 px-4 text-right">Rozdíl</th>
                  <th className="py-3 px-4 text-right">Hodnota rozdílu</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {rows.map(({ item, counted, delta, diffValue }) => (
                  <tr
                    key={item.id}
                    className={
                      lastScannedId === item.id
                        ? 'bg-emerald-50/60'
                        : delta !== 0
                          ? 'bg-amber-50/40'
                          : 'hover:bg-slate-50/50'
                    }
                  >
                    <td className="py-2.5 px-4">
                      <p className="font-medium text-slate-900">{item.name}</p>
                      <p className="text-xs text-slate-500 font-mono">
                        {item.sku}
                        {item.ean ? ` · EAN ${item.ean}` : ''}
                      </p>
                    </td>
                    <td className="py-2.5 px-4 text-xs text-slate-600">
                      {whMap.get(item.warehouseId) || item.warehouseId}
                    </td>
                    <td className="py-2.5 px-4 text-right tabular-nums text-slate-600">
                      {formatQty(item.quantity)} {item.unit}
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <QtyInput
                          disabled={readOnly}
                          value={counted}
                          onValueChange={(cleaned) =>
                            setCounts((prev) => ({
                              ...prev,
                              [item.id]: parseQtyNumber(cleaned),
                            }))
                          }
                          className="w-24 px-2 py-1 text-sm text-right border border-slate-200 rounded-md tabular-nums bg-white disabled:bg-slate-50"
                        />
                        <span className="text-xs text-slate-500">{item.unit}</span>
                      </div>
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-semibold tabular-nums whitespace-nowrap ${
                        delta > 0
                          ? 'text-emerald-700'
                          : delta < 0
                            ? 'text-red-700'
                            : 'text-slate-400'
                      }`}
                    >
                      {delta > 0 ? `+${formatQty(delta)}` : formatQty(delta)} {item.unit}
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right text-xs font-medium tabular-nums whitespace-nowrap ${
                        diffValue > 0
                          ? 'text-emerald-700'
                          : diffValue < 0
                            ? 'text-red-700'
                            : 'text-slate-400'
                      }`}
                    >
                      {diffValue > 0 ? `+${formatCzk(diffValue)}` : formatCzk(diffValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
