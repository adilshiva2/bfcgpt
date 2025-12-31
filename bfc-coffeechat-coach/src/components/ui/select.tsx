import type React from "react";

type SelectOption = {
  label: string;
  value: string;
};

type SelectProps = {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
};

export function Select({ label, value, options, onChange, disabled, className = "" }: SelectProps) {
  return (
    <label className={`flex flex-col gap-2 text-sm ${className}`}>
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
      <select
        className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
