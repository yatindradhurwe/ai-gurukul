import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Empty, ErrorNote, PageTitle, Spinner, Tabs, fmtDate } from "../components/ui";
import { useAuth } from "../lib/auth";
import { ClassPicker, useClasses } from "../lib/lms";
import { useApi } from "../lib/useApi";

function IdCard({ org, card, type }: { org: any; card: any; type: "students" | "staff" }) {
  const student = type === "students";
  return (
    <div className="relative aspect-[54/86] w-full max-w-[15rem] break-inside-avoid overflow-hidden rounded-[1.4rem] bg-white shadow-lift ring-1 ring-slate-200 print:shadow-none">
      <div className={`relative h-[38%] bg-gradient-to-br ${student ? "from-brand via-violet-500 to-fuchsia-500" : "from-emerald-500 via-teal-500 to-sky-500"} px-3 pt-3 text-white`}>
        <div className="flex items-center gap-1.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-white/25">
            <Icon name="graduation" size={14} />
          </span>
          <p className="truncate text-[11px] font-bold leading-tight">{org.name}</p>
        </div>
        <p className="mt-1 text-[9px] font-bold uppercase tracking-[0.2em] text-white/80">{student ? "Student identity card" : "Staff identity card"}</p>
        <div className="absolute -bottom-9 left-1/2 -translate-x-1/2 rounded-full bg-white p-1 shadow-md">
          <Avatar name={card.name} size={68} />
        </div>
      </div>
      <div className="flex h-[62%] flex-col items-center px-3 pb-3 pt-11 text-center">
        <p className="text-sm font-bold leading-tight text-slate-900">{card.name}</p>
        <p className="text-[11px] font-semibold text-brand">{student ? card.classes || "—" : card.designation || "Staff"}</p>
        <dl className="mt-2 w-full space-y-0.5 text-left text-[10px]">
          {(student
            ? [
                ["Adm. no.", card.admission_no],
                ["Born", card.date_of_birth && fmtDate(card.date_of_birth, { day: "numeric", month: "short", year: "numeric" })],
                ["Blood", card.blood_group],
                ["Guardian", card.guardian_phone],
              ]
            : [
                ["Emp. code", card.employee_code],
                ["Dept.", card.department],
                ["Blood", card.blood_group],
                ["Phone", card.phone],
              ]
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-dashed border-slate-100 pb-0.5">
              <dt className="text-slate-400">{k}</dt>
              <dd className="truncate font-semibold text-slate-700">{v || "—"}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-auto pt-2 text-[9px] text-slate-400">{org.phone ?? org.email ?? "If found, please return to the school office."}</p>
      </div>
    </div>
  );
}

export function IdCardsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const type = (params.get("type") as "students" | "staff") ?? "students";
  const classId = params.get("classId") ?? "";
  const { classes } = useClasses();
  const data = useApi<any>(`/id-cards?type=${type}${classId && type === "students" ? `&classId=${classId}` : ""}`);
  const cards: any[] = data.data?.cards ?? [];
  return (
    <div className="space-y-5">
      <div className="no-print">
        <PageTitle
          title="ID cards & certificates"
          icon="file"
          subtitle="Print identity cards and issue certificates."
          action={
            <>
              <Tabs value={type} onChange={(t) => setParams({ type: t })} options={[{ value: "students", label: "Students" }, { value: "staff", label: "Staff" }]} />
              {type === "students" && classes.length > 0 && <ClassPicker allowAll value={classId} onChange={(id) => setParams(id ? { type, classId: id } : { type })} classes={classes} />}
              <button className="btn" onClick={() => window.print()} disabled={!cards.length}>
                <Icon name="printer" size={16} /> Print cards
              </button>
            </>
          }
        />
      </div>
      <ErrorNote message={data.error} />
      {data.loading && !data.data ? (
        <Spinner />
      ) : cards.length === 0 ? (
        <Empty title="No one to show" icon="users" />
      ) : (
        <div className="grid grid-cols-2 justify-items-center gap-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 print:grid-cols-4">
          {cards.map((c) => (
            <div key={c.id} className="w-full">
              <IdCard org={data.data.org} card={c} type={type} />
              {type === "students" && can("admissions.manage") && (
                <div className="no-print mt-2 flex justify-center gap-2 text-xs">
                  <Link className="font-semibold text-brand" to={`/certificates/${c.id}?type=bonafide`}>
                    Bonafide
                  </Link>
                  <span className="text-slate-300">·</span>
                  <Link className="font-semibold text-brand" to={`/certificates/${c.id}?type=character`}>
                    Character
                  </Link>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A student's or staff member's own card. */
export function MyIdCardPage() {
  const data = useApi<any>("/id-cards/me");
  return (
    <div className="space-y-5">
      <div className="no-print">
        <PageTitle
          title="My ID card"
          icon="file"
          action={
            data.data && (
              <button className="btn" onClick={() => window.print()}>
                <Icon name="printer" size={16} /> Print
              </button>
            )
          }
        />
      </div>
      <ErrorNote message={data.error} />
      {data.loading && !data.data ? <Spinner /> : data.data && <div className="flex justify-center">{<IdCard org={data.data.org} card={data.data.cards[0]} type={data.data.type} />}</div>}
    </div>
  );
}

export function CertificatePage() {
  const { studentId } = useParams();
  const [params, setParams] = useSearchParams();
  const type = params.get("type") ?? "bonafide";
  const [purpose, setPurpose] = useState(params.get("purpose") ?? "");
  const data = useApi<any>(`/id-cards/certificates/${studentId}?type=${type}${params.get("purpose") ? `&purpose=${encodeURIComponent(params.get("purpose")!)}` : ""}`);
  const d = data.data;
  const s = d?.student;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <Link to="/id-cards" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <Icon name="chevronLeft" size={16} /> ID cards
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={type} onChange={(t) => setParams({ type: t, ...(purpose ? { purpose } : {}) })} options={[{ value: "bonafide", label: "Bonafide" }, { value: "character", label: "Character" }]} />
          <input className="input w-56" placeholder="Purpose (e.g. passport)" value={purpose} onChange={(e) => setPurpose(e.target.value)} onBlur={() => setParams({ type, ...(purpose ? { purpose } : {}) })} />
          <button className="btn" onClick={() => window.print()} disabled={!d}>
            <Icon name="printer" size={16} /> Print
          </button>
        </div>
      </div>
      <ErrorNote message={data.error} />
      {data.loading && !d ? (
        <Spinner />
      ) : (
        d && (
          <article className="relative overflow-hidden rounded-[1.5rem] bg-white p-10 shadow-lift ring-1 ring-slate-200 print:shadow-none sm:p-14">
            <div className="pointer-events-none absolute inset-3 rounded-[1.1rem] border-2 border-double border-amber-300/80" />
            <div className="relative text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-brand to-violet-500 text-white">
                <Icon name="graduation" size={30} />
              </div>
              <p className="mt-3 font-display text-3xl font-semibold text-slate-900">{d.org.name}</p>
              {(d.org.phone || d.org.email) && <p className="text-xs text-slate-500">{[d.org.phone, d.org.email].filter(Boolean).join(" · ")}</p>}
              <p className="mt-8 inline-block border-b-2 border-amber-400 pb-1 text-sm font-bold uppercase tracking-[0.3em] text-slate-700">
                {type === "bonafide" ? "Bonafide certificate" : "Character certificate"}
              </p>
            </div>
            <div className="relative mt-4 flex justify-between text-xs text-slate-500">
              <span>No. {d.serial}</span>
              <span>Date: {fmtDate(d.issuedOn, { day: "numeric", month: "long", year: "numeric" })}</span>
            </div>
            <p className="relative mt-8 text-[1.05rem] leading-[2] text-slate-800">
              This is to certify that <b>{s.name}</b>
              {s.guardian_name && (
                <>
                  , ward of <b>{s.guardian_name}</b>
                </>
              )}
              {s.admission_no && <>, admission number <b>{s.admission_no}</b></>}
              {s.date_of_birth && <>, born on <b>{fmtDate(s.date_of_birth, { day: "numeric", month: "long", year: "numeric" })}</b></>}, is a bonafide student of this institution
              {s.classes && (
                <>
                  , studying in <b>{s.classes}</b>
                </>
              )}
              {s.admitted_on && <> since {fmtDate(s.admitted_on, { month: "long", year: "numeric" })}</>}.{" "}
              {type === "character"
                ? "To the best of our knowledge, the student bears a good moral character and has shown good conduct and discipline during their time with us."
                : "This certificate is issued on request of the student/guardian."}
              {d.purpose && <> It is issued for the purpose of <b>{d.purpose}</b>.</>}
            </p>
            <div className="relative mt-16 flex items-end justify-between text-sm">
              <div className="text-slate-500">
                <p className="h-10" />
                <p>School seal</p>
              </div>
              <div className="text-right">
                <p className="mb-1 h-10 border-b border-slate-400" />
                <p className="font-semibold text-slate-800">{d.issuedBy}</p>
                <p className="text-xs text-slate-500">For {d.org.name}</p>
              </div>
            </div>
          </article>
        )
      )}
    </div>
  );
}
