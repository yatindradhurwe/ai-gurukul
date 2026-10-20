import { useState, type FormEvent } from "react";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, Tabs, fmtDate, todayISO, type Tone } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const STATUS: Record<string, { tone: Tone; label: string }> = {
  pending: { tone: "amber", label: "Waiting" },
  approved: { tone: "green", label: "Approved" },
  rejected: { tone: "red", label: "Not approved" },
  cancelled: { tone: "slate", label: "Cancelled" },
};
const KIND: Record<string, string> = { student: "Student leave", staff: "Staff leave", outpass: "Hostel out-pass" };
const STAFF_ROLES = ["tenant_owner", "tenant_admin", "teacher", "staff", "accountant", "librarian", "transport_manager", "warden", "content_reviewer"];

const range = (l: any) => (l.start_date === l.end_date ? fmtDate(l.start_date, { weekday: "short", day: "numeric", month: "short" }) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date)}`);

export function LeavePage() {
  const { info } = useAuth();
  const review = useApi<any>("/leave/review?status=pending");
  const canReview = !!review.data?.canReview;
  const [tab, setTab] = useState<"mine" | "review">("mine");
  const isStaff = (info?.roles ?? []).some((r) => STAFF_ROLES.includes(r));
  const pending = review.data?.requests?.length ?? 0;

  return (
    <div className="space-y-5">
      <PageTitle
        title="Leave"
        icon="calendar"
        subtitle={isStaff ? "Apply for leave and review requests from students and staff." : "Apply for leave or a hostel out-pass."}
        action={canReview && <Tabs value={tab} onChange={setTab} options={[{ value: "mine", label: "My requests" }, { value: "review", label: `To review${pending ? ` (${pending})` : ""}` }]} />}
      />
      {tab === "review" && canReview ? <Review onChanged={review.reload} /> : <Mine isStaff={isStaff} />}
    </div>
  );
}

function Mine({ isStaff }: { isStaff: boolean }) {
  const mine = useApi<any>("/leave/mine");
  const balance = useApi<any>(isStaff ? "/leave/balance" : null);
  const [open, setOpen] = useState(false);
  const rows: any[] = mine.data?.requests ?? [];
  const cancel = async (l: any) => {
    await api(`/leave/${l.id}/cancel`, { body: {} });
    mine.reload();
  };
  return (
    <div className="space-y-5">
      {balance.data && (
        <div className="grid gap-4 sm:grid-cols-3">
          {balance.data.balances.map((b: any) => (
            <div key={b.type} className="card animate-fade-up">
              <p className="text-xs font-semibold capitalize text-slate-500">{b.type} leave</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {b.left} <span className="text-sm font-medium text-slate-400">of {b.allowed} days left</span>
              </p>
              <div className="mt-2">
                <Progress value={(b.used / b.allowed) * 100} tone={b.left <= 2 ? "red" : "brand"} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <button className="btn" onClick={() => setOpen(true)}>
          <Icon name="plus" size={16} /> New request
        </button>
      </div>
      <ErrorNote message={mine.error} />
      {mine.loading && !mine.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty title="No leave requests" icon="calendar">Requests you make, or that concern you, appear here.</Empty>
      ) : (
        <div className="space-y-3">
          {rows.map((l) => (
            <div key={l.id} className="card flex flex-wrap items-center justify-between gap-3 animate-fade-up">
              <div className="flex items-center gap-3">
                <span className={`flex h-11 w-11 items-center justify-center rounded-2xl ${l.kind === "outpass" ? "bg-emerald-100 text-emerald-600" : "bg-indigo-100 text-indigo-600"}`}>
                  <Icon name={l.kind === "outpass" ? "home" : "calendar"} size={20} />
                </span>
                <div>
                  <p className="font-semibold text-slate-900">
                    {KIND[l.kind]}
                    {l.kind === "staff" && <span className="ml-1 text-sm font-normal capitalize text-slate-500">· {l.leave_type}</span>}
                    {l.student && l.kind !== "staff" && <span className="ml-1 text-sm font-normal text-slate-500">· {l.student}</span>}
                  </p>
                  <p className="text-sm text-slate-600">
                    {range(l)} · {l.days} day(s)
                    {l.out_time && ` · out ${l.out_time}, back ${l.return_time}`}
                  </p>
                  <p className="text-xs text-slate-500">{l.reason}</p>
                  {l.review_note && (
                    <p className="mt-1 text-xs text-slate-600">
                      <b>{l.reviewer}:</b> {l.review_note}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
                {l.status === "pending" && (
                  <button className="btn-ghost btn-sm" onClick={() => cancel(l)}>
                    Withdraw
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <NewRequest isStaff={isStaff} onClose={() => setOpen(false)} onSaved={() => (mine.reload(), balance.reload())} />}
    </div>
  );
}

function NewRequest({ isStaff, onClose, onSaved }: { isStaff: boolean; onClose: () => void; onSaved: () => void }) {
  const { info, can } = useAuth();
  const students = useStudentOptions();
  const forStudent = !!info?.studentProfileId || can("reports.children");
  const [form, setForm] = useState({
    kind: isStaff ? "staff" : "student",
    leaveType: "casual",
    startDate: todayISO(),
    endDate: todayISO(),
    outTime: "10:00",
    returnTime: "18:00",
    reason: "",
  });
  const [studentId, setStudentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/leave", {
        body: {
          ...form,
          studentId: form.kind === "staff" ? undefined : (studentId ?? undefined),
          outTime: form.kind === "outpass" ? form.outTime : null,
          returnTime: form.kind === "outpass" ? form.returnTime : null,
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const kinds = [...(isStaff ? [["staff", "Staff leave"]] : []), ...(forStudent ? [["student", "Student leave"], ["outpass", "Hostel out-pass"]] : [])];
  return (
    <Modal open onClose={onClose} title="New leave request">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {kinds.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          {form.kind === "staff" ? (
            <Field label="Leave">
              <select className="input" value={form.leaveType} onChange={(e) => setForm({ ...form, leaveType: e.target.value })}>
                {["casual", "sick", "earned", "unpaid", "other"].map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            students.options.length > 0 && (
              <Field label="For">
                <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />
              </Field>
            )
          )}
          <Field label="From">
            <input className="input" type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} />
          </Field>
          <Field label="To">
            <input className="input" type="date" required min={form.startDate} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
          {form.kind === "outpass" && (
            <>
              <Field label="Going out at">
                <input className="input" type="time" required value={form.outTime} onChange={(e) => setForm({ ...form, outTime: e.target.value })} />
              </Field>
              <Field label="Back by">
                <input className="input" type="time" required value={form.returnTime} onChange={(e) => setForm({ ...form, returnTime: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <Field label="Reason">
          <textarea className="input min-h-[5rem]" required minLength={3} maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Send request</button>
        </div>
      </form>
    </Modal>
  );
}

function Review({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState("pending");
  const list = useApi<any>(`/leave/review${status ? `?status=${status}` : ""}`);
  const [acting, setActing] = useState<{ l: any; decision: "approved" | "rejected" } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rows: any[] = list.data?.requests ?? [];
  async function decide(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/leave/${acting!.l.id}/review`, { body: { decision: acting!.decision, note: note || null } });
      setActing(null);
      setNote("");
      list.reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <SectionCard
      title="Requests"
      icon="checkSquare"
      action={
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="pending">Waiting</option>
          <option value="approved">Approved</option>
          <option value="rejected">Not approved</option>
          <option value="">All</option>
        </select>
      }
    >
      {list.loading && !list.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing to review. 🎉</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="flex items-center gap-3">
                <Avatar name={l.staff ?? l.student ?? l.requester} size={40} />
                <div>
                  <p className="font-semibold text-slate-900">
                    {l.staff ?? l.student} <span className="text-sm font-normal text-slate-500">· {KIND[l.kind]}{l.kind === "staff" && `, ${l.leave_type}`}</span>
                  </p>
                  <p className="text-sm text-slate-600">
                    {range(l)} · {l.days} day(s)
                    {l.out_time && ` · ${l.out_time}–${l.return_time}`}
                    {l.classes && ` · ${l.classes}`}
                  </p>
                  <p className="text-xs text-slate-500">
                    “{l.reason}” — {l.requester}
                  </p>
                </div>
              </div>
              {l.status === "pending" ? (
                <div className="flex gap-2">
                  <button className="btn btn-sm" onClick={() => setActing({ l, decision: "approved" })}>
                    <Icon name="check" size={14} /> Approve
                  </button>
                  <button className="btn-ghost btn-sm" onClick={() => setActing({ l, decision: "rejected" })}>
                    Decline
                  </button>
                </div>
              ) : (
                <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {acting && (
        <Modal open onClose={() => setActing(null)} title={acting.decision === "approved" ? "Approve leave" : "Decline leave"}>
          <form onSubmit={decide} className="space-y-4">
            <p className="text-sm text-slate-600">
              {acting.l.staff ?? acting.l.student} · {range(acting.l)}
              {acting.decision === "approved" && acting.l.kind === "student" && " — absences on these days will be marked excused."}
            </p>
            <Field label="Note (optional)">
              <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <ErrorNote message={error} />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setActing(null)}>
                Cancel
              </button>
              <button className="btn">{acting.decision === "approved" ? "Approve" : "Decline"}</button>
            </div>
          </form>
        </Modal>
      )}
    </SectionCard>
  );
}
