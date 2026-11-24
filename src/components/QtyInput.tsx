import React from 'react';

interface QtyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> {
  value: string | number;
  onValueChange: (cleaned: string) => void;
  allowNegative?: boolean;
  /** When true (default), numeric 0 displays as empty so user can type immediately without deleting "0". */
  hideZero?: boolean;
}

function formatDisplayValue(val: string | number, hideZero: boolean): string {
  if (val === '' || val === null || val === undefined) return '';
  if (hideZero) {
    if (typeof val === 'number' && val === 0) return '';
    const trimmed = String(val).trim();
    if (
      trimmed === '' ||
      trimmed === '0' ||
      trimmed === '-0' ||
      /^[-]?0[.,]0+$/.test(trimmed)
    ) {
      return '';
    }
  }
  return String(val);
}

/**
 * Clean numeric quantity input that ONLY accepts typed digits or copy-pasted numbers.
 * Never displays browser +/- spinners and never changes value on mouse wheel or arrow keys.
 */
export function sanitizeQtyInput(raw: string, allowNegative = false): string {
  // Strip whitespace (including thousands spaces from copy-paste)
  const stripped = raw.replace(/[\s\u00A0]+/g, '');
  let out = '';
  let hasDecimal = false;
  let hasMinus = false;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch >= '0' && ch <= '9') {
      out += ch;
    } else if ((ch === ',' || ch === '.') && !hasDecimal) {
      hasDecimal = true;
      out += ch;
    } else if (allowNegative && ch === '-' && i === 0 && !hasMinus) {
      hasMinus = true;
      out += ch;
    }
  }
  return out;
}

export function parseQtyNumber(raw: string | number): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  const n = Number(String(raw).replace(/[\s\u00A0]+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

export function QtyInput({
  value,
  onValueChange,
  allowNegative = false,
  hideZero = true,
  onKeyDown,
  onWheel,
  onPaste,
  onFocus,
  onBlur,
  ...rest
}: QtyInputProps) {
  const [focused, setFocused] = React.useState(false);
  const [draft, setDraft] = React.useState(() => formatDisplayValue(value, hideZero));

  React.useEffect(() => {
    if (!focused) {
      setDraft(formatDisplayValue(value, hideZero));
    }
  }, [value, focused, hideZero]);

  const applyValue = (cleaned: string) => {
    setDraft(cleaned);
    onValueChange(cleaned);
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={focused ? draft : formatDisplayValue(value, hideZero)}
      onFocus={(e) => {
        setFocused(true);
        setDraft(formatDisplayValue(value, hideZero));
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      onChange={(e) => applyValue(sanitizeQtyInput(e.target.value, allowNegative))}
      onPaste={(e) => {
        if (onPaste) onPaste(e);
        if (e.defaultPrevented) return;
        const pasted = e.clipboardData?.getData('text') || '';
        const cleaned = sanitizeQtyInput(pasted, allowNegative);
        e.preventDefault();
        const el = e.currentTarget;
        const start = el.selectionStart ?? draft.length;
        const end = el.selectionEnd ?? draft.length;
        const currentStr = focused ? draft : formatDisplayValue(value, hideZero);
        const merged = sanitizeQtyInput(
          currentStr.slice(0, start) + cleaned + currentStr.slice(end),
          allowNegative
        );
        applyValue(merged);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          return;
        }
        onKeyDown?.(e);
      }}
      onWheel={(e) => {
        onWheel?.(e);
        // Never let wheel scroll alter value
        if (document.activeElement === e.currentTarget) {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
