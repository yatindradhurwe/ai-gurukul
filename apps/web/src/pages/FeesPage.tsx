import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, fmtDateTime, inr, todayISO, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const STATE: Record<string, { tone: Tone; label: string }> = {
  due: { tone: "amber", label: "Due" },
  partial: { tone: "sky", label: "Part paid" },
  overdue: { tone: "red", label: "Overdue" },
  paid: { tone: "green", label: "Paid" },
  cancelled: { tone: "slate", label: "Cancelled" },
};
const METHODS: Record<string, string> = { cash: "Cash", upi: "UPI", card: "Card", cheque: "Cheque", bank_transfer: "Bank transfer", online: "Online" };
const CATEGORIES = ["tuition", "admission", "transport", "exam", "library", "activity", "hostel", "other"];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).replace("_", " ");

export function FeesPage() {
  const { can } = useAuth();
  return can("fees.manage") ? <FeesOffice /> : <MyFees />;
}

// ---------------------------------------------------------------------------
// Fees office
// ---------------------------------------------------------------------------
function FeesOffice() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "overview" | "invoices" | "structures") ?? "overview";
  return (
    <div className="space-y-5">
      <PageTitle
        title="Fees"
        icon="card"
        subtitle="Bill fees, collect payments and issue receipts."
        action={<Tabs value={tab} onChange={(t) => setParams({ tab: t })} options={[{ value: "overview", label: "Overview" }, { value: "invoices", label: "Invoices" }, { value: "structures", label: "Fee structures" }]} />}
      />
      {tab === "overview" && <Overview />}
      {tab === "invoices" && <Invoices />}
      {tab === "structures" && <Structures />}
    </div>
  );
}

function Overview() {
  const sum = useApi<any>("/fees/summary");
  if (sum.loading && !sum.data) return <Spinner />;
  const t = sum.data?.totals;
  if (!t) return <ErrorNote message={sum.error} />;
  const collectedPct = Number(t.billed) ? (Number(t.collected) / Number(t.billed)) * 100 : 0;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Collected this month" value={inr(t.collectedThisMonth)} icon="trending" tone="green" />
        <StatCard label="Outstanding" value={inr(t.outstanding)} icon="card" tone="amber" hint={`of ${inr(t.billed)} billed`} />
        <StatCard label="Overdue" value={inr(t.overdue)} icon="alert" tone={t.overdue_count ? "red" : "green"} hint={`${t.overdue_students} student(s), ${t.overdue_count} invoice(s)`} />
        <StatCard label="Collected so far" value={inr(t.collected)} icon="check" hint={`${Math.round(collectedPct)}% of billed`} />
      </div>
      <SectionCard title="Collection progress" icon="chart">
        <Progress value={collectedPct} tone={collectedPct >= 75 ? "green" : "amber"} />
        <div className="mt-3 flex flex-wrap gap-2">
          {sum.data.byMethod.map((m: any) => (
            <Badge key={m.method}>
              {METHODS[m.method]}: {inr(m.amount)} · {m.payments}
            </Badge>
          ))}
        </div>
      </SectionCard>
      <SectionCard title="Recent payments" icon="file" action={<Link to="/fees?tab=invoices" className="text-xs font-semibold text-brand">All invoices →</Link>}>
        {sum.data.recent.length ? (
          <ul className="divide-y divide-slate-100">
            {sum.data.recent.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={p.student} size={32} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900">{p.student}</p>
                    <p className="truncate text-xs text-slate-500">
                      {p.title} · {METHODS[p.method]} · {fmtDateTime(p.paid_at)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-emerald-700">{inr(p.amount_paise)}</span>
                  <Link to={`/fees/receipts/${p.id}`} className="btn-ghost btn-sm">
                    {p.receipt_no}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No payments recorded yet.</p>
        )}
      </SectionCard>
    </div>
  );
}

function Invoices() {
  const [state, setState] = useState("unpaid");
  const [search, setSearch] = useState("");
  const q = new URLSearchParams();
  if (state) q.set("state", state);
  if (search.trim()) q.set("search", search.trim());
  const list = useApi<any>(`/fees/invoices?${q}`);
  const [collect, setCollect] = useState<any>(null);
  const [concession, setConcession] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const [paid, setPaid] = useState<{ id: string; receipt_no: string } | null>(null);
  const rows: any[] = list.data?.invoices ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <input className="input pl-9" placeholder="Search student name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="pointer-events-none absolute left-3 top-2.5 text-slate-400">
            <Icon name="users" size={16} />
          </span>
        </div>
        <select className="input w-auto" value={state} onChange={(e) => setState(e.target.value)} aria-label="Status">
          <option value="unpaid">Unpaid (due, part paid, overdue)</option>
          <option value="overdue">Overdue</option>
          <option value="partial">Part paid</option>
          <option value="paid">Paid</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <button className="btn" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> One-off invoice
        </button>
      </div>
      {paid && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 ring-1 ring-emerald-200/60">
          <span className="flex items-center gap-2">
            <Icon name="check" size={16} /> Payment recorded. Receipt {paid.receipt_no}.
          </span>
          <Link to={`/fees/receipts/${paid.id}`} className="btn-ghost btn-sm">
            <Icon name="printer" size={14} /> View & print receipt
          </Link>
        </div>
      )}
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No invoices here" icon="card">Create a fee structure to bill students, or change the filter.</Empty>
      ) : (
        <div className="card p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="pl-5">Student</th>
                  <th>Fee</th>
                  <th>Due</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Balance</th>
                  <th>Status</th>
                  <th className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id}>
                    <td className="pl-5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={i.student} size={28} />
                        <div>
                          <p className="whitespace-nowrap font-medium text-slate-900">{i.student}</p>
                          <p className="text-xs text-slate-500">{i.classes ?? "No class"}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <p className="text-slate-800">{i.title}</p>
                      {Number(i.discount_paise) > 0 && (
                        <p className="text-xs text-emerald-700">
                          − {inr(i.discount_paise)} {i.discount_note && `(${i.discount_note})`}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-slate-500">{fmtDate(i.due_date)}</td>
                    <td className="text-right">{inr(i.amount_paise)}</td>
                    <td className="text-right text-emerald-700">{inr(i.paid_paise)}</td>
                    <td className="text-right font-semibold">{inr(Math.max(0, Number(i.balance_paise)))}</td>
                    <td>
                      <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                    </td>
                    <td className="pr-5">
                      {["due", "partial", "overdue"].includes(i.state) && (
                        <div className="flex justify-end gap-1.5">
                          <button className="btn btn-sm" onClick={() => setCollect(i)}>
                            Collect
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => setConcession(i)} title="Concession or cancel">
                            <Icon name="sliders" size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {collect && (
        <CollectModal
          invoice={collect}
          onClose={() => setCollect(null)}
          onPaid={(p) => {
            setPaid(p);
            list.reload();
          }}
        />
      )}
      {concession && <ConcessionModal invoice={concession} onClose={() => setConcession(null)} onSaved={list.reload} />}
      {adding && <OneOffModal onClose={() => setAdding(false)} onSaved={list.reload} />}
    </div>
  );
}

function CollectModal({ invoice, onClose, onPaid }: { invoice: any; onClose: () => void; onPaid: (p: { id: string; receipt_no: string }) => void }) {
  const balance = Math.max(0, Number(invoice.balance_paise)) / 100;
  const [form, setForm] = useState({ amount: balance, method: "cash", reference: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/fees/invoices/${invoice.id}/payments`, { body: { amount: Number(form.amount), method: form.method, reference: form.reference || null } });
      onPaid(r.payment);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Collect fee — ${invoice.student}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-slate-50 p-4 text-sm">
          <p className="font-semibold text-slate-900">{invoice.title}</p>
          <p className="mt-1 text-slate-600">
            Amount {inr(invoice.amount_paise)} · Paid {inr(invoice.paid_paise)} · <b>Balance {inr(invoice.balance_paise)}</b>
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount received (₹)">
            <input className="input" type="number" min={1} step="0.01" max={balance} required value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} />
          </Field>
          <Field label="Method">
            <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {Object.entries(METHODS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Reference (optional)" hint="UPI transaction ID, cheque number or bank reference.">
          <input className="input" maxLength={120} value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? "Saving…" : `Record ₹${Number(form.amount || 0).toLocaleString("en-IN")}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConcessionModal({ invoice, onClose, onSaved }: { invoice: any; onClose: () => void; onSaved: () => void }) {
  const [discount, setDiscount] = useState(Number(invoice.discount_paise) / 100);
  const [note, setNote] = useState(invoice.discount_note ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = async (body: object) => {
    setError(null);
    try {
      await api(`/fees/invoices/${invoice.id}`, { method: "PATCH", body });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Concession — ${invoice.student}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ discount: Number(discount), discountNote: note || null });
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600">
          {invoice.title} · {inr(invoice.amount_paise)}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Concession (₹)">
            <input className="input" type="number" min={0} step="0.01" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} />
          </Field>
          <Field label="Reason">
            <input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sibling concession" />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex flex-wrap justify-between gap-2">
          {Number(invoice.paid_paise) === 0 ? (
            <button type="button" className="btn-danger" onClick={() => confirm("Cancel this invoice?") && save({ status: "cancelled" })}>
              Cancel invoice
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn">Save concession</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function OneOffModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const students = useApi<any>("/fees/students");
  const [form, setForm] = useState({ studentId: "", title: "", amount: 500, dueDate: todayISO() });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/fees/invoices", { body: { ...form, amount: Number(form.amount) } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="One-off invoice">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Student">
          <select className="input" required value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}>
            <option value="">Choose a student…</option>
            {(students.data?.students ?? []).map((s: any) => (
              <option key={s.student_id} value={s.student_id}>
                {s.name}
                {s.classes ? ` — ${s.classes}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="For">
          <input className="input" required maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. School trip to the science museum" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount (₹)">
            <input className="input" type="number" min={1} step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} />
          </Field>
          <Field label="Due date">
            <input className="input" type="date" required value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create invoice</button>
        </div>
      </form>
    </Modal>
  );
}

function Structures() {
  const list = useApi<any>("/fees/structures");
  const classes: { id: string; name: string }[] = useApi<any>("/fees/classes").data?.classes ?? [];
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows: any[] = list.data?.structures ?? [];

  async function apply(s: any) {
    const r = await api(`/fees/structures/${s.id}/apply`, { body: {} });
    setNote(r.billed ? `Billed ${r.billed} new student(s) for ${s.name}.` : `Everyone is already billed for ${s.name}.`);
    list.reload();
  }
  async function remove(s: any) {
    if (!confirm(`Delete “${s.name}” and its unpaid invoices?`)) return;
    setError(null);
    try {
      await api(`/fees/structures/${s.id}`, { method: "DELETE" });
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn" onClick={() => setOpen(true)}>
          <Icon name="plus" size={16} /> New fee
        </button>
      </div>
      <SuccessNote message={note} />
      <ErrorNote message={error ?? list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No fees set up" icon="card">Create a fee such as “Term 1 tuition” to bill a class or every student at once.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((s) => {
            const pct = Number(s.billed_paise) ? (Number(s.collected_paise) / Number(s.billed_paise)) * 100 : 0;
            return (
              <div key={s.id} className="card animate-fade-up">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Badge tone="brand">{cap(s.category)}</Badge>
                    <h3 className="mt-2 text-base font-semibold text-slate-900">{s.name}</h3>
                    <p className="text-xs text-slate-500">
                      {s.class_name ?? "All students"} · due {fmtDate(s.due_date, { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                  </div>
                  <p className="text-xl font-bold text-slate-900">{inr(s.amount_paise)}</p>
                </div>
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-slate-500">
                    <span>
                      {inr(s.collected_paise)} of {inr(s.billed_paise)} collected
                    </span>
                    <span>{s.invoices} students</span>
                  </div>
                  <Progress value={pct} tone={pct >= 100 ? "green" : "brand"} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link to={`/fees?tab=invoices`} className="btn-ghost btn-sm">
                    Invoices
                  </Link>
                  <button className="btn-ghost btn-sm" onClick={() => apply(s)}>
                    Bill new students
                  </button>
                  <button className="btn-danger btn-sm ml-auto" onClick={() => remove(s)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {open && <NewStructure classes={classes} onClose={() => setOpen(false)} onSaved={(n) => (setNote(n), list.reload())} />}
    </div>
  );
}

function NewStructure({ classes, onClose, onSaved }: { classes: { id: string; name: string }[]; onClose: () => void; onSaved: (note: string) => void }) {
  const [form, setForm] = useState({ name: "", category: "tuition", amount: 10000, dueDate: todayISO(), classId: "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api("/fees/structures", { body: { ...form, amount: Number(form.amount), classId: form.classId || null } });
      onSaved(`Created ${form.name} and billed ${r.billed} student(s).`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New fee">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <input className="input" required maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Term 1 tuition fee" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {cap(c)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount per student (₹)">
            <input className="input" type="number" min={1} step="0.01" required value={form.amount} onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })} />
          </Field>
          <Field label="Due date">
            <input className="input" type="date" required value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
          <Field label="Bill to">
            <select className="input" value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
              <option value="">Every student</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create & bill</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Students and parents
// ---------------------------------------------------------------------------
function MyFees() {
  const { can, tenant } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [params] = useSearchParams();
  const [studentId, setStudentId] = useState<string | null>(params.get("studentId"));
  const data = useApi<any>(parent ? (studentId ? `/fees/student?studentId=${studentId}` : null) : "/fees/student");
  const d = data.data;
  const receiptsFor = (invoiceId: string) => (d?.payments ?? []).filter((p: any) => p.invoice_id === invoiceId);

  return (
    <div className="space-y-5">
      <PageTitle title="Fees" icon="card" subtitle={parent ? "Your child's school fees and receipts." : "Your school fees and receipts."} action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />} />
      <ErrorNote message={data.error} />
      {parent && !students.loading && !students.options.length && <Empty title="No children linked" icon="heart">Link your child from My children to see fees.</Empty>}
      {data.loading && !d ? (
        <Spinner />
      ) : (
        d && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard label="Amount due" value={inr(d.totals.due_paise)} icon="card" tone={d.totals.due_paise ? "amber" : "green"} hint={d.totals.due_paise ? undefined : "Nothing due — thank you!"} />
              <StatCard label="Overdue" value={inr(d.totals.overdue_paise)} icon="alert" tone={d.totals.overdue_paise ? "red" : "green"} />
              <StatCard label="Paid so far" value={inr(d.totals.paid_paise)} icon="check" tone="green" />
            </div>
            {d.totals.due_paise > 0 && (
              <div className="rounded-2xl bg-sky-50 px-4 py-3 text-sm text-sky-700 ring-1 ring-sky-200/60">
                Pay at the {tenant?.name ?? "school"} fees office by cash, UPI, card or cheque. Your receipt appears here as soon as it is recorded.
              </div>
            )}
            <SectionCard title="Invoices" icon="file">
              {d.invoices.length ? (
                <ul className="divide-y divide-slate-100">
                  {d.invoices.map((i: any) => (
                    <li key={i.id} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{i.title}</p>
                          <p className="text-xs text-slate-500">
                            Due {fmtDate(i.due_date, { day: "numeric", month: "short", year: "numeric" })} · {inr(i.amount_paise)}
                            {Number(i.discount_paise) > 0 && ` · concession ${inr(i.discount_paise)}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          {i.state !== "paid" && <span className="text-sm font-semibold text-slate-900">{inr(i.balance_paise)} to pay</span>}
                          <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                        </div>
                      </div>
                      {receiptsFor(i.id).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {receiptsFor(i.id).map((p: any) => (
                            <Link key={p.id} to={`/fees/receipts/${p.id}`} className="chip bg-slate-100 text-slate-600 hover:bg-slate-200">
                              <Icon name="file" size={12} /> {p.receipt_no} · {inr(p.amount_paise)}
                            </Link>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">No fees billed yet.</p>
              )}
            </SectionCard>
          </>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Printable receipt
// ---------------------------------------------------------------------------
export function ReceiptPage() {
  const { id } = useParams();
  const r = useApi<any>(`/fees/receipts/${id}`);
  if (r.loading && !r.data) return <Spinner />;
  if (!r.data) return <ErrorNote message={r.error ?? "Receipt not found"} />;
  const { organization: org, receipt, invoice, student } = r.data;
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="no-print flex items-center justify-between">
        <Link to="/fees" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <Icon name="chevronLeft" size={16} /> Fees
        </Link>
        <button className="btn" onClick={() => window.print()}>
          <Icon name="printer" size={16} /> Print / PDF
        </button>
      </div>
      <article className="card overflow-hidden p-0">
        <div className="flex items-center justify-between gap-4 border-b border-dashed border-slate-300 px-8 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <Icon name="graduation" size={24} />
            </div>
            <div>
              <p className="font-display text-xl font-semibold text-slate-900">{org.name}</p>
              <p className="text-xs text-slate-500">{[org.supportEmail, org.supportPhone].filter(Boolean).join(" · ") || "Fee receipt"}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="label">Receipt</p>
            <p className="font-mono text-sm font-semibold text-slate-900">{receipt.receipt_no}</p>
          </div>
        </div>
        <div className="grid gap-6 px-8 py-6 sm:grid-cols-2">
          <div>
            <p className="label">Received from</p>
            <p className="font-semibold text-slate-900">{student.name}</p>
            <p className="text-sm text-slate-500">{student.classes ?? student.email}</p>
          </div>
          <div className="sm:text-right">
            <p className="label">Date</p>
            <p className="font-semibold text-slate-900">{fmtDateTime(receipt.paid_at)}</p>
            <p className="text-sm text-slate-500">
              {METHODS[receipt.method]}
              {receipt.reference && ` · ${receipt.reference}`}
            </p>
          </div>
        </div>
        <div className="mx-8 overflow-hidden rounded-xl ring-1 ring-slate-200">
          <table className="table">
            <tbody>
              <tr>
                <td className="pl-4 text-slate-600">{invoice.title}</td>
                <td className="pr-4 text-right">{inr(invoice.amount_paise)}</td>
              </tr>
              {Number(invoice.discount_paise) > 0 && (
                <tr>
                  <td className="pl-4 text-slate-600">Concession</td>
                  <td className="pr-4 text-right text-emerald-700">− {inr(invoice.discount_paise)}</td>
                </tr>
              )}
              <tr className="bg-brand-soft">
                <td className="pl-4 font-semibold text-slate-900">Amount received</td>
                <td className="pr-4 text-right text-lg font-bold text-slate-900">{inr(receipt.amount_paise)}</td>
              </tr>
              <tr>
                <td className="pl-4 text-slate-600">Balance remaining</td>
                <td className="pr-4 text-right font-semibold">{inr(Math.max(0, Number(invoice.balance_paise)))}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex items-end justify-between gap-4 px-8 py-6 text-xs text-slate-500">
          <p>This is a computer-generated receipt.</p>
          <p className="text-right">
            Received by
            <br />
            <span className="font-semibold text-slate-800">{receipt.received_by}</span>
          </p>
        </div>
      </article>
    </div>
  );
}
