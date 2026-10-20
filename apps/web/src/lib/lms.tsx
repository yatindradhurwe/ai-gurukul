import { useEffect } from "react";
import { useAuth } from "./auth";
import { useApi } from "./useApi";

export interface ClassRow {
  id: string;
  name: string;
  teacher: string;
  students: number;
}

/** Classes the caller teaches, administers or is enrolled in (null path when the role has no classes). */
export function useClasses() {
  const { can } = useAuth();
  const allowed = can("classes.manage") || can("classes.attend");
  const res = useApi<{ classes: ClassRow[] }>(allowed ? "/classes" : null);
  return { ...res, classes: res.data?.classes ?? [], allowed };
}

export interface StudentOption {
  id: string;
  name: string;
}

/**
 * Students the caller may pick: a parent's linked children, or (for staff) every
 * student in the organization. Students themselves get an empty list.
 */
export function useStudentOptions() {
  const { can } = useAuth();
  const parent = can("reports.children");
  const staff = can("reports.class") || can("members.manage");
  const children = useApi<{ children: { student_id: string; name: string }[] }>(parent ? "/parents/children" : null);
  const members = useApi<{ members: { name: string; student_profile_id: string | null }[] }>(!parent && staff ? "/tenants/current/members" : null);
  const options: StudentOption[] = parent
    ? (children.data?.children ?? []).map((c) => ({ id: c.student_id, name: c.name }))
    : (members.data?.members ?? []).filter((m) => m.student_profile_id).map((m) => ({ id: m.student_profile_id!, name: m.name }));
  return { options, needed: parent || staff, loading: children.loading || members.loading };
}

/** Select a student; auto-picks the first option so the page always has data to show. */
export function StudentPicker({ value, onChange, options }: { value: string | null; onChange: (id: string) => void; options: StudentOption[] }) {
  useEffect(() => {
    if (!value && options[0]) onChange(options[0].id);
  }, [value, options, onChange]);
  if (!options.length) return null;
  return (
    <select className="input w-auto min-w-[12rem]" value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label="Student">
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export function ClassPicker({ value, onChange, classes, allowAll }: { value: string; onChange: (id: string) => void; classes: { id: string; name: string }[]; allowAll?: boolean }) {
  return (
    <select className="input w-auto min-w-[12rem]" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Class">
      {allowAll && <option value="">All classes</option>}
      {!allowAll && !value && <option value="">Choose a class…</option>}
      {classes.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
