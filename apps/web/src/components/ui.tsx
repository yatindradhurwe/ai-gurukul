import type { ReactNode } from "react";

export const Spinner = () => (
  <div className="flex justify-center p-8">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
  </div>
);

export const ErrorNote = ({ message }: { message: string | null }) =>
  message ? <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{message}</div> : null;

export const InfoNote = ({ children }: { children: ReactNode }) => (
  <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">{children}</div>
);

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center">
    <p className="font-medium text-slate-700">{title}</p>
    {children && <div className="mt-2 text-sm text-slate-500">{children}</div>}
  </div>
);

export function Progress({ value, tone = "brand" }: { value: number; tone?: "brand" | "green" | "amber" }) {
  const color = tone === "green" ? "bg-emerald-500" : tone === "amber" ? "bg-amber-500" : "bg-brand";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export const PageTitle = ({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
    </div>
    {action}
  </div>
);

const TASK_STYLES: Record<string, string> = {
  learn: "bg-indigo-50 text-indigo-700",
  practice: "bg-emerald-50 text-emerald-700",
  revision: "bg-sky-50 text-sky-700",
  mock_test: "bg-rose-50 text-rose-700",
};
export const TaskChip = ({ type }: { type: string }) => <span className={`chip ${TASK_STYLES[type] ?? "bg-slate-100"}`}>{type.replace("_", " ")}</span>;

export const pct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
