import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, fmtDateTime, inr, todayISO, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";

const ROLE: Record<string, string> = { tenant_owner: "Principal", tenant_admin: "Admin", teacher: "Teacher", staff: "Office / HR", accountant: "Accounts", librarian: "Librarian", transport_manager: "Transport", warden: "Warden", content_reviewer: "Reviewer" };
const ATT: { value: string; label: string; active: string }[] = [
  { value: "present", label: "Present", active: "bg-emerald-500 text-white ring-emerald-500" },
  { value: "absent", label: "Absent", active: "bg-rose-500 text-white ring-rose-500" },
  { value: "half_day", label: "Half day", active: "bg-amber-500 text-white ring-amber-500" },
  { value: "leave", label: "On leave", active: "bg-sky-500 text-white ring-sky-500" },
];
const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

export function StaffPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "staff" | "attendance" | "payroll") ?? "staff";
  return (
    <div className="space-y-5">
      <PageTitle
        title="Staff & payroll"
        icon="users"
        subtitle="Employee records, staff attendance and monthly payslips."
        action={<Tabs value={tab} onChange={(t) => setParams({ tab: t })} options={[{ value: "staff", label: "Staff" }, { value: "attendance", label: "Attendance" }, { value: "payroll", label: "Payroll" }]} />}
      />
      {tab === "staff" && <StaffList />}
      {tab === "attendance" && <StaffAttendance />}
      {tab === "payroll" && <Payroll />}
    </div>
  );
}

function StaffList() {
  const list = useApi<any>("/hr/staff");
  const [editing, setEditing] = useState<any>(null);
  const rows: any[] = list.data?.staff ?? [];
  const monthly = (s: any) => Number(s.basic_paise ?? 0) + Number(s.hra_paise ?? 0) + Number(s.da_paise ?? 0) + Number(s.other_paise ?? 0);
  const payroll = rows.reduce((t, s) => t + (s.status !== "left" ? monthly(s) : 0), 0);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Staff" value={rows.length} icon="users" />
        <StatCard label="Profiles complete" value={rows.filter((s) => s.profile_id).length} icon="check" tone="green" hint={`${rows.filter((s) => !s.profile_id).length} to set up`} />
        <StatCard label="Monthly payroll" value={inr(payroll)} icon="card" tone="amber" hint="Gross, before deductions" />
        <StatCard label="Absences this month" value={rows.reduce((t, s) => t + (s.absent_this_month ?? 0), 0)} icon="alert" tone="red" />
      </div>
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-5">Name</th>
                  <th>Code</th>
                  <th>Designation</th>
                  <th className="text-right">Monthly gross</th>
                  <th>This month</th>
                  <th className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.user_id}>
                    <td className="pl-5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={s.name} size={32} />
                        <div>
                          <p className="font-semibold text-slate-900">{s.name}</p>
                          <p className="text-xs text-slate-500">{s.roles.map((r: string) => ROLE[r] ?? r).join(", ")}</p>
                        </div>
                      </div>
                    </td>
                    <td className="font-mono text-xs">{s.employee_code ?? "—"}</td>
                    <td>
                      {s.designation || "—"}
                      {s.department && <span className="block text-xs text-slate-500">{s.department}</span>}
                    </td>
                    <td className="text-right font-semibold">{s.profile_id ? inr(monthly(s)) : "—"}</td>
                    <td className="text-xs text-slate-600">
                      {s.present_this_month} present{s.absent_this_month ? ` · ${s.absent_this_month} absent` : ""}
                      {s.status && s.status !== "active" && <Badge tone="amber">{s.status.replace("_", " ")}</Badge>}
                    </td>
                    <td className="pr-5 text-right">
                      <button className={s.profile_id ? "btn-ghost btn-sm" : "btn btn-sm"} onClick={() => setEditing(s)}>
                        {s.profile_id ? "Edit" : "Set up"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editing && <ProfileModal s={editing} onClose={() => setEditing(null)} onSaved={list.reload} />}
    </div>
  );
}

function ProfileModal({ s, onClose, onSaved }: { s: any; onClose: () => void; onSaved: () => void }) {
  const r = (p: any) => (p == null ? 0 : Number(p) / 100);
  const [form, setForm] = useState({
    employeeCode: s.employee_code ?? "",
    designation: s.designation ?? "",
    department: s.department ?? "",
    dateJoined: s.date_joined ?? "",
    phone: s.phone ?? "",
    bloodGroup: s.blood_group ?? "",
    bankAccountLast4: s.bank_account_last4 ?? "",
    basic: r(s.basic_paise),
    hra: r(s.hra_paise),
    da: r(s.da_paise),
    other: r(s.other_paise),
    pfPercent: s.pf_percent != null ? Number(s.pf_percent) : 12,
    professionalTax: s.professional_tax_paise != null ? r(s.professional_tax_paise) : 200,
    tds: r(s.tds_paise),
    status: s.status ?? "active",
  });
  const [error, setError] = useState<string | null>(null);
  const num = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: Number(e.target.value) });
  const txt = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const gross = form.basic + form.hra + form.da + form.other;
  const net = gross - (form.basic * form.pfPercent) / 100 - form.professionalTax - form.tds;
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/hr/staff/${s.user_id}`, {
        method: "PUT",
        body: { ...form, dateJoined: form.dateJoined || null, phone: form.phone || null, bloodGroup: form.bloodGroup || null, bankAccountLast4: form.bankAccountLast4 || null },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`${s.name} — HR profile`} wide>
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Employee code">
            <input className="input font-mono" required maxLength={30} value={form.employeeCode} onChange={txt("employeeCode")} placeholder="EMP-001" />
          </Field>
          <Field label="Designation">
            <input className="input" maxLength={80} value={form.designation} onChange={txt("designation")} placeholder="TGT Science" />
          </Field>
          <Field label="Department">
            <input className="input" maxLength={80} value={form.department} onChange={txt("department")} placeholder="Science" />
          </Field>
          <Field label="Joined">
            <input className="input" type="date" value={form.dateJoined} onChange={txt("dateJoined")} />
          </Field>
          <Field label="Phone">
            <input className="input" type="tel" maxLength={20} value={form.phone} onChange={txt("phone")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Blood group">
              <input className="input" maxLength={5} value={form.bloodGroup} onChange={txt("bloodGroup")} />
            </Field>
            <Field label="Bank a/c (last 4)">
              <input className="input font-mono" maxLength={4} pattern="\d{4}" value={form.bankAccountLast4} onChange={txt("bankAccountLast4")} />
            </Field>
          </div>
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="label">Monthly salary (₹)</p>
          <div className="grid gap-3 sm:grid-cols-4">
            {(["basic", "hra", "da", "other"] as const).map((k) => (
              <Field key={k} label={{ basic: "Basic", hra: "HRA", da: "DA", other: "Other allowances" }[k]}>
                <input className="input" type="number" min={0} step="1" required={k === "basic"} value={form[k]} onChange={num(k)} />
              </Field>
            ))}
            <Field label="PF % of basic">
              <input className="input" type="number" min={0} max={100} step="0.1" value={form.pfPercent} onChange={num("pfPercent")} />
            </Field>
            <Field label="Professional tax">
              <input className="input" type="number" min={0} value={form.professionalTax} onChange={num("professionalTax")} />
            </Field>
            <Field label="TDS">
              <input className="input" type="number" min={0} value={form.tds} onChange={num("tds")} />
            </Field>
            <Field label="Status">
              <select className="input" value={form.status} onChange={txt("status")}>
                <option value="active">Working</option>
                <option value="on_leave">On long leave</option>
                <option value="left">Left</option>
              </select>
            </Field>
          </div>
          <p className="mt-3 text-sm text-slate-600">
            Gross <b>₹{gross.toLocaleString("en-IN")}</b> · Take-home about <b className="text-emerald-700">₹{Math.max(0, Math.round(net)).toLocaleString("en-IN")}</b> for a full month
          </p>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function StaffAttendance() {
  const [date, setDate] = useState(todayISO());
  const sheet = useApi<any>(`/hr/attendance?date=${date}`);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows: any[] = sheet.data?.staff ?? [];
  useEffect(() => setMarks(Object.fromEntries(rows.filter((r) => r.status).map((r) => [r.user_id, r.status]))), [sheet.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setOk(null), [date]);
  async function save() {
    setError(null);
    try {
      await api("/hr/attendance", { body: { date, records: Object.entries(marks).map(([userId, status]) => ({ userId, status })) } });
      setOk(`Saved staff attendance for ${fmtDate(date, { day: "numeric", month: "long" })}.`);
      sheet.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <SectionCard title="Staff attendance" icon="checkSquare" action={<input type="date" className="input w-auto" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}>
      {sheet.loading && !sheet.data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-3 flex justify-end">
            <button className="btn-ghost btn-sm" onClick={() => setMarks(Object.fromEntries(rows.map((r) => [r.user_id, marks[r.user_id] === "leave" ? "leave" : "present"])))}>
              <Icon name="check" size={14} /> All present
            </button>
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => (
              <li key={r.user_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-3">
                  <Avatar name={r.name} size={36} />
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{r.name}</p>
                    <p className="text-xs text-slate-500">{r.designation || "Staff"}</p>
                  </div>
                </div>
                <div className="flex gap-1.5" role="radiogroup" aria-label={`Attendance for ${r.name}`}>
                  {ATT.map((a) => (
                    <button
                      key={a.value}
                      type="button"
                      role="radio"
                      aria-checked={marks[r.user_id] === a.value}
                      onClick={() => setMarks({ ...marks, [r.user_id]: a.value })}
                      className={`h-9 rounded-xl px-3 text-xs font-semibold ring-1 transition ${marks[r.user_id] === a.value ? a.active : "text-slate-500 ring-slate-200 hover:bg-slate-100"}`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <SuccessNote message={ok} />
            <ErrorNote message={error} />
            <div className="flex justify-end">
              <button className="btn" onClick={save} disabled={!Object.keys(marks).length}>
                Save attendance
              </button>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

const STATUS_TONE: Record<string, Tone> = { draft: "amber", paid: "green" };

function Payroll() {
  const [month, setMonth] = useState(lastMonth());
  const list = useApi<any>(`/hr/payroll?month=${month}`);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slips: any[] = list.data?.payslips ?? [];
  useEffect(() => setOk(null), [month]);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api("/hr/payroll/generate", { body: { month } });
      setOk(`Generated ${r.generated} payslip(s) for ${monthName(month)} — ${r.workingDays} working days.${r.skippedPaid ? ` ${r.skippedPaid} already paid were left unchanged.` : ""}`);
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pay = async (s: any) => {
    await api(`/hr/payslips/${s.id}/pay`, { body: {} });
    list.reload();
  };
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <input type="month" className="input w-auto" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
        <button className="btn" onClick={run} disabled={busy}>
          <Icon name="sparkles" size={16} /> {busy ? "Working…" : slips.length ? "Recalculate drafts" : "Run payroll"}
        </button>
      </div>
      <SuccessNote message={ok} />
      <ErrorNote message={error ?? list.error} />
      {list.data && slips.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Gross" value={inr(list.data.totals.gross)} icon="card" />
          <StatCard label="Net pay" value={inr(list.data.totals.net)} icon="trending" tone="green" />
          <StatCard label="Paid" value={`${list.data.totals.paid}/${slips.length}`} icon="check" tone={list.data.totals.paid === slips.length ? "green" : "amber"} />
        </div>
      )}
      {list.loading && !list.data ? (
        <Spinner />
      ) : slips.length === 0 ? (
        <Empty title={`No payslips for ${monthName(month)}`} icon="card">Set up staff salaries, mark attendance, then run payroll.</Empty>
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-5">Employee</th>
                  <th>Paid days</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Deductions</th>
                  <th className="text-right">Net</th>
                  <th>Status</th>
                  <th className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {slips.map((s) => (
                  <tr key={s.id}>
                    <td className="pl-5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={s.name} size={30} />
                        <div>
                          <p className="font-semibold text-slate-900">{s.name}</p>
                          <p className="text-xs text-slate-500">{s.designation}</p>
                        </div>
                      </div>
                    </td>
                    <td className="text-sm">
                      {s.working_days - Number(s.unpaid_days)}/{s.working_days}
                    </td>
                    <td className="text-right">{inr(s.gross_paise)}</td>
                    <td className="text-right text-rose-600">− {inr(s.deductions_paise)}</td>
                    <td className="text-right font-bold">{inr(s.net_paise)}</td>
                    <td>
                      <Badge tone={STATUS_TONE[s.status]}>{s.status === "paid" ? "Paid" : "Draft"}</Badge>
                    </td>
                    <td className="pr-5">
                      <div className="flex justify-end gap-1.5">
                        <Link to={`/payslips/${s.id}`} className="btn-ghost btn-sm">
                          View
                        </Link>
                        {s.status === "draft" && (
                          <button className="btn btn-sm" onClick={() => pay(s)}>
                            Mark paid
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function PayslipPage() {
  const { id } = useParams();
  const data = useApi<any>(`/hr/payslips/${id}`);
  if (data.loading && !data.data) return <Spinner />;
  if (!data.data) return <ErrorNote message={data.error ?? "Payslip not found"} />;
  const { org, payslip: s } = data.data;
  // Stored as JSON (which doesn't keep key order), so list the lines in payslip order.
  const ORDER = ["Basic", "HRA", "DA", "Other allowances", "Provident fund", "Professional tax", "Income tax (TDS)"];
  const rows = (o: Record<string, number>) =>
    Object.entries(o)
      .filter(([, v]) => Number(v) > 0)
      .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="no-print flex justify-between">
        <Link to="/payslips" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <Icon name="chevronLeft" size={16} /> Payslips
        </Link>
        <button className="btn" onClick={() => window.print()}>
          <Icon name="printer" size={16} /> Print / PDF
        </button>
      </div>
      <article className="card overflow-hidden p-0">
        <div className="flex items-center justify-between gap-4 bg-gradient-to-r from-emerald-500 via-teal-500 to-sky-500 px-8 py-6 text-white">
          <div>
            <p className="font-display text-xl font-semibold">{org.name}</p>
            <p className="text-sm text-white/80">Payslip for {monthName(s.month)}</p>
          </div>
          <Badge tone={STATUS_TONE[s.status]}>{s.status === "paid" ? `Paid ${s.paid_at ? fmtDate(s.paid_at) : ""}` : "Draft"}</Badge>
        </div>
        <div className="grid gap-4 px-8 py-6 text-sm sm:grid-cols-2">
          {[
            ["Employee", s.name],
            ["Code", s.employee_code],
            ["Designation", [s.designation, s.department].filter(Boolean).join(", ")],
            ["Bank account", s.bank_account_last4 ? `•••• ${s.bank_account_last4}` : "—"],
            ["Working days", s.working_days],
            ["Paid days", s.working_days - Number(s.unpaid_days)],
          ].map(([k, v]) => (
            <div key={k as string}>
              <p className="label">{k}</p>
              <p className="font-semibold text-slate-900">{v || "—"}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-4 px-8 sm:grid-cols-2">
          {[
            ["Earnings", rows(s.earnings), s.gross_paise, "text-slate-900"],
            ["Deductions", rows(s.deductions), s.deductions_paise, "text-rose-600"],
          ].map(([title, list, total, tone]: any) => (
            <div key={title} className="overflow-hidden rounded-2xl ring-1 ring-slate-200">
              <p className="bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-500">{title}</p>
              <ul className="divide-y divide-slate-100 text-sm">
                {list.map(([k, v]: [string, number]) => (
                  <li key={k} className="flex justify-between px-4 py-2">
                    <span className="text-slate-600">{k}</span>
                    <span className={tone}>{inr(v)}</span>
                  </li>
                ))}
                <li className="flex justify-between bg-slate-50 px-4 py-2 font-semibold">
                  <span>Total</span>
                  <span className={tone}>{inr(total)}</span>
                </li>
              </ul>
            </div>
          ))}
        </div>
        <div className="m-8 flex items-center justify-between rounded-2xl bg-emerald-50 px-6 py-4 ring-1 ring-emerald-200">
          <span className="font-semibold text-emerald-800">Net pay</span>
          <span className="text-2xl font-black text-emerald-700">{inr(s.net_paise)}</span>
        </div>
        <p className="px-8 pb-6 text-xs text-slate-400">Generated {fmtDateTime(s.generated_at)}. This is a computer-generated payslip.</p>
      </article>
    </div>
  );
}

export function MyPayslipsPage() {
  const list = useApi<any>("/hr/payslips/mine");
  const slips: any[] = list.data?.payslips ?? [];
  return (
    <div className="space-y-5">
      <PageTitle title="My payslips" icon="card" subtitle="Your salary slips, ready to download." />
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : slips.length === 0 ? (
        <Empty title="No payslips yet" icon="card">Payslips appear here once the school pays your salary.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {slips.map((s) => (
            <Link key={s.id} to={`/payslips/${s.id}`} className="card card-hover block">
              <p className="text-xs font-semibold text-brand">{monthName(s.month)}</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{inr(s.net_paise)}</p>
              <p className="text-xs text-slate-500">
                Net pay · gross {inr(s.gross_paise)} · {s.working_days - Number(s.unpaid_days)}/{s.working_days} days
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
