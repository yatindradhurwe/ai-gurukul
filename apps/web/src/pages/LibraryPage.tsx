import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, SectionCard, Spinner, StatCard, SuccessNote, Tabs, fmtDate, inr, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const LOAN: Record<string, { tone: Tone; label: string }> = { active: { tone: "sky", label: "On loan" }, overdue: { tone: "red", label: "Overdue" }, returned: { tone: "green", label: "Returned" } };

export function LibraryPage() {
  const { can } = useAuth();
  const manage = can("library.manage");
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "catalogue" | "loans" | "mine") ?? (manage ? "catalogue" : "mine");
  const parent = can("reports.children");
  const tabs = manage
    ? [{ value: "catalogue" as const, label: "Catalogue" }, { value: "loans" as const, label: "Loans" }]
    : [{ value: "mine" as const, label: parent ? "My child's books" : "My books" }, { value: "catalogue" as const, label: "Catalogue" }];

  return (
    <div className="space-y-5">
      <PageTitle title="Library" icon="book" subtitle={manage ? "Catalogue books, issue them and track returns." : "Find a book and keep track of what you've borrowed."} action={<Tabs value={tab} onChange={(t) => setParams({ tab: t })} options={tabs} />} />
      {manage && <LibraryStats />}
      {tab === "catalogue" && <Catalogue manage={manage} />}
      {tab === "loans" && manage && <Loans />}
      {tab === "mine" && !manage && <MyBooks />}
    </div>
  );
}

function LibraryStats() {
  const s = useApi<any>("/library/summary");
  const d = s.data?.summary;
  if (!d) return null;
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatCard label="Titles" value={d.titles} icon="book" hint={`${d.copies} copies`} />
      <StatCard label="On loan" value={d.on_loan} icon="layers" tone="sky" />
      <StatCard label="Overdue" value={d.overdue} icon="alert" tone={d.overdue ? "red" : "green"} />
      <StatCard label="Unpaid fines" value={inr(d.fines_unpaid_paise)} icon="card" tone={Number(d.fines_unpaid_paise) ? "amber" : "green"} hint={`${inr(s.data.rules.finePerDayPaise)} per day late`} />
    </div>
  );
}

function Catalogue({ manage }: { manage: boolean }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const q = new URLSearchParams();
  if (search.trim()) q.set("search", search.trim());
  if (category) q.set("category", category);
  const books = useApi<any>(`/library/books?${q}`);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [issuing, setIssuing] = useState<any>(null);
  const [ok, setOk] = useState<string | null>(null);
  const rows: any[] = books.data?.books ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input min-w-[14rem] flex-1" placeholder="Search by title, author or ISBN" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {(books.data?.categories ?? []).map((c: any) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.n})
            </option>
          ))}
        </select>
        {manage && (
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add book
          </button>
        )}
      </div>
      <SuccessNote message={ok} />
      <ErrorNote message={books.error} />
      {books.loading && !books.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title={search || category ? "No books match" : "The catalogue is empty"} icon="book">
          {manage ? "Add the library's books so members can find them." : "Try a different search."}
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((b) => (
            <div key={b.id} className="card flex gap-4 animate-fade-up">
              <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-violet-500 p-1 text-center text-[10px] font-semibold leading-tight text-white shadow-md">
                {b.title.slice(0, 40)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 font-semibold text-slate-900">{b.title}</p>
                <p className="truncate text-xs text-slate-500">{b.author || "Unknown author"}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>{b.category}</Badge>
                  {b.shelf && <Badge tone="brand">Shelf {b.shelf}</Badge>}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  {b.with_me ? (
                    <Badge tone="sky">With you</Badge>
                  ) : (
                    <span className={`text-xs font-semibold ${b.available > 0 ? "text-emerald-700" : "text-rose-600"}`}>
                      {b.available > 0 ? `${b.available} of ${b.total_copies} available` : "All copies out"}
                    </span>
                  )}
                  {manage && (
                    <div className="flex gap-1">
                      <button className="btn btn-sm" disabled={b.available < 1} onClick={() => setIssuing(b)}>
                        Issue
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(b)} aria-label={`Edit ${b.title}`}>
                        <Icon name="sliders" size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <BookModal onClose={() => setAdding(false)} onSaved={books.reload} />}
      {editing && <BookModal book={editing} onClose={() => setEditing(null)} onSaved={books.reload} />}
      {issuing && <IssueModal book={issuing} onClose={() => setIssuing(null)} onIssued={(m) => (setOk(m), books.reload())} />}
    </div>
  );
}

function BookModal({ book, onClose, onSaved }: { book?: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    title: book?.title ?? "",
    author: book?.author ?? "",
    isbn: book?.isbn ?? "",
    category: book?.category ?? "General",
    publisher: book?.publisher ?? "",
    shelf: book?.shelf ?? "",
    copies: book?.total_copies ?? 1,
  });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const body = { ...form, copies: Number(form.copies), isbn: form.isbn || null, publisher: form.publisher || null, shelf: form.shelf || null };
      await api(book ? `/library/books/${book.id}` : "/library/books", { method: book ? "PATCH" : "POST", body });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function remove() {
    if (!confirm(`Remove “${book.title}” from the catalogue?`)) return;
    try {
      await api(`/library/books/${book.id}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={book ? "Edit book" : "Add a book"} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title">
            <input className="input" required maxLength={250} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Author">
            <input className="input" maxLength={200} value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
          </Field>
          <Field label="ISBN (optional)">
            <input className="input" maxLength={20} value={form.isbn} onChange={(e) => setForm({ ...form, isbn: e.target.value })} />
          </Field>
          <Field label="Category">
            <input className="input" required list="book-categories" maxLength={60} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <datalist id="book-categories">
              {["General", "Fiction", "Science", "Mathematics", "History", "Biography", "Reference", "Hindi", "Comics"].map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Publisher (optional)">
            <input className="input" maxLength={120} value={form.publisher} onChange={(e) => setForm({ ...form, publisher: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Shelf">
              <input className="input" maxLength={40} value={form.shelf} onChange={(e) => setForm({ ...form, shelf: e.target.value })} placeholder="e.g. B-3" />
            </Field>
            <Field label="Copies">
              <input className="input" type="number" min={0} max={10000} required value={form.copies} onChange={(e) => setForm({ ...form, copies: Number(e.target.value) })} />
            </Field>
          </div>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-between gap-2">
          {book ? (
            <button type="button" className="btn-danger" onClick={remove}>
              <Icon name="trash" size={14} /> Remove
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn">{book ? "Save" : "Add book"}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function IssueModal({ book, onClose, onIssued }: { book: any; onClose: () => void; onIssued: (msg: string) => void }) {
  const members = useApi<any>("/library/members");
  const [userId, setUserId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list: any[] = (members.data?.members ?? []).filter((m: any) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api("/library/loans", { body: { bookId: book.id, userId, dueDate: dueDate || null } });
      const who = members.data.members.find((m: any) => m.id === userId)?.name;
      onIssued(`Issued “${book.title}” to ${who}, due ${fmtDate(r.loan.due_date, { day: "numeric", month: "long" })}.`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Issue “${book.title}”`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Borrower">
          <input className="input mb-2" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select className="input" required size={Math.min(6, Math.max(3, list.length))} value={userId} onChange={(e) => setUserId(e.target.value)}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} — {m.roles.join(", ")}
                {m.active_loans ? ` (${m.active_loans} on loan)` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due date (optional)" hint="Defaults to 14 days from today.">
          <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!userId}>
            Issue book
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Loans() {
  const [state, setState] = useState("out");
  const loans = useApi<any>(`/library/loans${state ? `?state=${state}` : ""}`);
  const [returning, setReturning] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string) => {
    setError(null);
    try {
      await api(path, { body: {} });
      loans.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const rows: any[] = loans.data?.loans ?? [];
  return (
    <SectionCard
      title="Loans"
      icon="layers"
      action={
        <select className="input w-auto" value={state} onChange={(e) => setState(e.target.value)} aria-label="Loan status">
          <option value="out">On loan</option>
          <option value="overdue">Overdue</option>
          <option value="returned">Returned</option>
          <option value="">All</option>
        </select>
      }
    >
      <ErrorNote message={error ?? loans.error} />
      {loans.loading && !loans.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No loans here.</p>
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="pl-5">Borrower</th>
                <th>Book</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Status</th>
                <th className="text-right">Fine</th>
                <th className="pr-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="pl-5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={l.borrower} size={28} />
                      <span className="whitespace-nowrap font-medium text-slate-900">{l.borrower}</span>
                    </div>
                  </td>
                  <td className="max-w-[16rem] truncate">{l.title}</td>
                  <td className="whitespace-nowrap text-slate-500">{fmtDate(l.issued_at)}</td>
                  <td className="whitespace-nowrap text-slate-500">{fmtDate(l.due_date)}</td>
                  <td>
                    <Badge tone={LOAN[l.state].tone}>
                      {LOAN[l.state].label}
                      {l.state === "overdue" && ` · ${l.days_overdue}d`}
                    </Badge>
                  </td>
                  <td className="text-right">
                    {Number(l.fine_due_paise) > 0 ? (
                      <span className={l.state === "returned" && l.fine_paid ? "text-slate-400 line-through" : "font-semibold text-rose-600"}>{inr(l.fine_due_paise)}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="pr-5">
                    <div className="flex justify-end gap-1.5">
                      {l.state !== "returned" ? (
                        <>
                          <button className="btn btn-sm" onClick={() => setReturning(l)}>
                            Return
                          </button>
                          <button className="btn-ghost btn-sm" onClick={() => act(`/library/loans/${l.id}/renew`)}>
                            Renew
                          </button>
                        </>
                      ) : (
                        Number(l.fine_paise) > 0 &&
                        !l.fine_paid && (
                          <button className="btn-ghost btn-sm" onClick={() => act(`/library/loans/${l.id}/fine-paid`)}>
                            Fine paid
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {returning && <ReturnModal loan={returning} onClose={() => setReturning(null)} onDone={loans.reload} />}
    </SectionCard>
  );
}

function ReturnModal({ loan, onClose, onDone }: { loan: any; onClose: () => void; onDone: () => void }) {
  const fine = Number(loan.fine_due_paise);
  const [waive, setWaive] = useState(false);
  const [paid, setPaid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/library/loans/${loan.id}/return`, { body: { waiveFine: waive, finePaid: paid } });
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="Return book">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-700">
          <b>{loan.title}</b> from {loan.borrower}, due {fmtDate(loan.due_date, { day: "numeric", month: "long" })}.
        </p>
        {fine > 0 ? (
          <div className="space-y-2 rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
            <p>
              Returned {loan.days_overdue} day(s) late — fine <b>{inr(fine)}</b>.
            </p>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={paid} disabled={waive} onChange={(e) => setPaid(e.target.checked)} /> Fine collected now
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Waive the fine
            </label>
          </div>
        ) : (
          <p className="text-sm text-emerald-700">On time — no fine.</p>
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Confirm return</button>
        </div>
      </form>
    </Modal>
  );
}

function MyBooks() {
  const { can } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [studentId, setStudentId] = useState<string | null>(null);
  const mine = useApi<any>(parent ? (studentId ? `/library/my?studentId=${studentId}` : null) : "/library/my");
  const rows: any[] = mine.data?.loans ?? [];
  const out = rows.filter((l) => l.state !== "returned");
  return (
    <SectionCard title={parent ? "Borrowed books" : "My books"} icon="book" action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />}>
      <ErrorNote message={mine.error} />
      {mine.loading && !mine.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">No books borrowed yet. Browse the catalogue and ask the librarian to issue one.</p>
      ) : (
        <>
          {mine.data?.rules && (
            <p className="mb-3 text-xs text-slate-500">
              {out.length} on loan. Books are lent for {mine.data.rules.loanDays} days; the late fine is {inr(mine.data.rules.finePerDayPaise)} per day.
            </p>
          )}
          <ul className="divide-y divide-slate-100">
            {rows.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{l.title}</p>
                  <p className="text-xs text-slate-500">
                    {l.author} · issued {fmtDate(l.issued_at)} · {l.state === "returned" ? `returned ${fmtDate(l.returned_at)}` : `due ${fmtDate(l.due_date, { day: "numeric", month: "long" })}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {Number(l.fine_due_paise) > 0 && !(l.state === "returned" && l.fine_paid) && <span className="text-sm font-semibold text-rose-600">Fine {inr(l.fine_due_paise)}</span>}
                  <Badge tone={LOAN[l.state].tone}>{LOAN[l.state].label}</Badge>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
