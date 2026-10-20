import { useEffect, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";

export const Spinner = () => (
  <div className="flex justify-center p-10">
    <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-brand/20 border-t-brand" />
  </div>
);

export const ErrorNote = ({ message }: { message: string | null }) =>
  message ? (
    <div className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
      <Icon name="alert" size={16} className="mt-0.5" />
      <span>{message}</span>
    </div>
  ) : null;

export const InfoNote = ({ children }: { children: ReactNode }) => (
  <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">{children}</div>
);

export const SuccessNote = ({ message }: { message: string | null }) =>
  message ? (
    <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 ring-1 ring-emerald-200/60">
      <Icon name="check" size={16} />
      {message}
    </div>
  ) : null;

export const Empty = ({ title, children, icon = "layers" }: { title: string; children?: ReactNode; icon?: IconName }) => (
  <div className="rounded-2xl border border-dashed border-slate-300 bg-surface/50 px-6 py-10 text-center">
    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
      <Icon name={icon} size={20} />
    </div>
    <p className="font-semibold text-slate-800">{title}</p>
    {children && <div className="mx-auto mt-1 max-w-md text-sm text-slate-500">{children}</div>}
  </div>
);

export function Progress({ value, tone = "brand" }: { value: number; tone?: "brand" | "green" | "amber" | "red" }) {
  const color = tone === "green" ? "bg-emerald-500" : tone === "amber" ? "bg-amber-500" : tone === "red" ? "bg-rose-500" : "bg-brand";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export const PageTitle = ({ title, subtitle, action, icon }: { title: string; subtitle?: string; action?: ReactNode; icon?: IconName }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3 animate-fade-up">
    <div className="flex items-center gap-3">
      {icon && (
        <div className="hidden h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand sm:flex">
          <Icon name={icon} size={22} />
        </div>
      )}
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-900 md:text-[1.7rem]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
    </div>
    {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
  </div>
);

const TONES = {
  brand: "bg-brand-soft text-brand",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  sky: "bg-sky-50 text-sky-700",
  slate: "bg-slate-100 text-slate-600",
} as const;
export type Tone = keyof typeof TONES;

export const Badge = ({ tone = "slate", children }: { tone?: Tone; children: ReactNode }) => <span className={`chip ${TONES[tone]}`}>{children}</span>;

export function StatCard({ label, value, hint, icon, tone = "brand" }: { label: string; value: ReactNode; hint?: ReactNode; icon: IconName; tone?: Tone }) {
  return (
    <div className="card flex items-start gap-4 animate-fade-up">
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${TONES[tone]}`}>
        <Icon name={icon} size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <p className="mt-0.5 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
        {hint && <p className="mt-0.5 truncate text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

export function SectionCard({ title, icon, action, children, className = "" }: { title: string; icon?: IconName; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card animate-fade-up ${className}`}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="section-title">
          {icon && <Icon name={icon} size={16} className="text-brand" />}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const AVATAR_COLORS = ["bg-indigo-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-sky-500", "bg-violet-500", "bg-teal-500"];
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  const color = AVATAR_COLORS[[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${color}`} style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials || "?"}
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="inline-flex rounded-xl bg-slate-100 p-1 text-sm">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-1.5 font-medium transition ${value === o.value ? "bg-surface text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Simple modal dialog; closes on Escape or backdrop click. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-surface p-6 shadow-lift ring-1 ring-slate-200 animate-fade-up sm:rounded-3xl ${wide ? "sm:max-w-2xl" : "sm:max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block">
    <span className="label">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
  </label>
);

export const NoAccess = ({ what = "this page" }: { what?: string }) => (
  <Empty title="You don't have access" icon="shield">
    Your role in this organization can't open {what}. Ask an administrator if you need it.
  </Empty>
);

const TASK_STYLES: Record<string, string> = {
  learn: "bg-indigo-50 text-indigo-700",
  practice: "bg-emerald-50 text-emerald-700",
  revision: "bg-sky-50 text-sky-700",
  mock_test: "bg-rose-50 text-rose-700",
};
export const TaskChip = ({ type }: { type: string }) => <span className={`chip ${TASK_STYLES[type] ?? "bg-slate-100"}`}>{type.replace("_", " ")}</span>;

export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);

/** Percentage already on a 0–100 scale. */
export const pct100 = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);

export const toneForPercent = (v: number | null | undefined): Tone => (v == null ? "slate" : v >= 75 ? "green" : v >= 50 ? "amber" : "red");

export const fmtDate = (d: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString("en-IN", opts) : "—";

export const fmtDateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
