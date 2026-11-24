import React, { useEffect, useState } from 'react';
import { Check, ExternalLink, Globe, Loader2, Tag, X } from 'lucide-react';
import { bulkAssignItemCategories } from '../lib/firestoreService';
import { categorizeItemsViaNerx, type NerxCategorizeMatch } from '../lib/nerxCategorizer';
import type { InventoryItem, Workspace } from '../types';

interface NerxCategorizeModalProps {
  items: InventoryItem[];
  existingCategories: string[];
  workspace: Workspace;
  accentColor: string;
  onClose: () => void;
  onCompleted: (message: string) => void;
  onError: (message: string) => void;
}

interface ReviewRow {
  item: InventoryItem;
  category: string;
  source: NerxCategorizeMatch['source'];
  matchedTitle: string;
  matchedUrl: string;
  selected: boolean;
}

export function NerxCategorizeModal({
  items,
  existingCategories,
  workspace,
  accentColor,
  onClose,
  onCompleted,
  onError,
}: NerxCategorizeModalProps) {
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState({ done: 0, total: items.length });
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [saving, setSaving] = useState(false);

  const onCloseRef = React.useRef(onClose);
  const onErrorRef = React.useRef(onError);
  onCloseRef.current = onClose;
  onErrorRef.current = onError;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setProgress({ done: 0, total: items.length });

    categorizeItemsViaNerx(
      items.map((i) => ({ id: i.id, name: i.name, sku: i.sku, ean: i.ean })),
      (done, total) => {
        if (active) setProgress({ done, total });
      }
    )
      .then((matches) => {
        if (!active) return;
        const matchMap = new Map(matches.map((m) => [m.id, m]));
        setRows(
          items.map((item) => {
            const m = matchMap.get(item.id);
            const cat = m?.category || item.category || '';
            return {
              item,
              category: cat,
              source: m?.source || 'NONE',
              matchedTitle: m?.matchedTitle || '',
              matchedUrl: m?.matchedUrl || '',
              selected: Boolean(m?.category && m.category !== item.category),
            };
          })
        );
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        onErrorRef.current(err instanceof Error ? err.message : 'Porovnání s Nerx.cz selhalo.');
        onCloseRef.current();
      });

    return () => {
      active = false;
    };
  }, [items]);

  const selectedCount = rows.filter((r) => r.selected && r.category.trim().length > 0).length;
  const nerxCount = rows.filter((r) => r.source === 'NERX').length;
  const ruleCount = rows.filter((r) => r.source === 'RULE').length;

  const updateRow = (itemId: string, patch: Partial<ReviewRow>) => {
    setRows((prev) => prev.map((r) => (r.item.id === itemId ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    const assignments = rows
      .filter((r) => r.selected && r.category.trim().length > 0)
      .map((r) => ({ itemId: r.item.id, category: r.category.trim() }));
    if (assignments.length === 0) {
      onError('Vyberte alespoň jednu položku s vyplněnou kategorií.');
      return;
    }
    setSaving(true);
    try {
      const count = await bulkAssignItemCategories({ workspace, assignments });
      onCompleted(`Kategorie byly aktualizovány u ${count} skladových karet (synchronizováno s Androidem).`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Uložení kategorií selhalo.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-xl overflow-hidden my-8 flex flex-col max-h-[88vh]">
        <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-4">
          <div className="flex items-start gap-2.5">
            <Globe className="w-5 h-5 text-emerald-700 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Automatické zařazení kategorií podle Nerx.cz
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Živé porovnání {items.length} položek s katalogem e-shopu Nerx.cz (bez AI limitů).
                Navržené kategorie můžete před uložením upravit.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-12 flex flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="w-7 h-7 text-slate-700 animate-spin" />
            <p className="text-sm font-medium text-slate-900">
              Porovnávám položky s katalogem Nerx.cz… ({progress.done} / {progress.total})
            </p>
            <p className="text-xs text-slate-500">
              Hledám shodu podle EAN a přesného názvu modelu (včetně variant).
            </p>
          </div>
        ) : (
          <>
            <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 tabular-nums">
              <div className="flex flex-wrap items-center gap-4">
                <span>
                  Nalezeno na Nerx.cz: <strong className="text-emerald-700">{nerxCount}</strong>
                </span>
                <span>
                  Určeno pravidlem: <strong className="text-slate-900">{ruleCount}</strong>
                </span>
                <span>
                  Vybráno k uložení: <strong className="text-slate-900">{selectedCount}</strong>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setRows((prev) =>
                      prev.map((r) => ({ ...r, selected: r.category.trim().length > 0 }))
                    )
                  }
                  className="text-xs font-medium text-slate-700 hover:text-slate-900 underline underline-offset-2"
                >
                  Vybrat vše s kategorií
                </button>
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.map((r) => ({ ...r, selected: false })))}
                  className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2"
                >
                  Zrušit výběr
                </button>
              </div>
            </div>

            <div className="overflow-auto flex-1">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="py-2.5 pl-4 pr-2 w-10"></th>
                    <th className="py-2.5 px-3">Položka na skladě</th>
                    <th className="py-2.5 px-3">Shoda (Nerx.cz)</th>
                    <th className="py-2.5 px-3 w-64">Navržená kategorie</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {rows.map((row) => (
                    <tr key={row.item.id} className={row.selected ? '' : 'opacity-60'}>
                      <td className="py-2.5 pl-4 pr-2">
                        <input
                          type="checkbox"
                          checked={row.selected}
                          onChange={(e) => updateRow(row.item.id, { selected: e.target.checked })}
                          className="rounded border-slate-300 cursor-pointer"
                        />
                      </td>
                      <td className="py-2.5 px-3">
                        <p className="font-medium text-slate-900">{row.item.name}</p>
                        <p className="text-xs text-slate-500">
                          <span className="font-mono">{row.item.sku}</span>
                          {row.item.category ? ` · Aktuálně: ${row.item.category}` : ' · Bez kategorie'}
                        </p>
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        {row.source === 'NERX' ? (
                          <div>
                            <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                              <Globe className="w-3 h-3" />
                              Nerx.cz
                            </span>
                            {row.matchedTitle && (
                              <p className="text-slate-500 mt-0.5 line-clamp-1">
                                {row.matchedUrl ? (
                                  <a
                                    href={row.matchedUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 hover:text-slate-800 underline underline-offset-2"
                                  >
                                    {row.matchedTitle}
                                    <ExternalLink className="w-3 h-3 shrink-0" />
                                  </a>
                                ) : (
                                  row.matchedTitle
                                )}
                              </p>
                            )}
                          </div>
                        ) : row.source === 'RULE' ? (
                          <span className="inline-flex items-center gap-1 text-slate-600 font-medium">
                            <Tag className="w-3 h-3" />
                            Chytré pravidlo
                          </span>
                        ) : (
                          <span className="text-slate-400">Nenalezeno</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        <input
                          type="text"
                          list="nerx-modal-categories"
                          value={row.category}
                          onChange={(e) =>
                            updateRow(row.item.id, {
                              category: e.target.value,
                              selected: e.target.value.trim().length > 0,
                            })
                          }
                          placeholder="Zadejte kategorii…"
                          className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-md bg-white"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="nerx-modal-categories">
                {existingCategories.map((cat) => (
                  <option key={cat} value={cat} />
                ))}
              </datalist>
            </div>

            <div className="p-4 border-t border-slate-100 flex items-center justify-end gap-2 bg-white">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Zrušit
              </button>
              <button
                type="button"
                disabled={saving || selectedCount === 0}
                onClick={handleSave}
                style={{ backgroundColor: accentColor }}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Uložit kategorie ({selectedCount})
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
