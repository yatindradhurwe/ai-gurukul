import { useState, type FormEvent } from "react";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, StatCard, fmtDate } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const KIND: Record<string, { label: string; tone: "sky" | "red" | "brand" }> = { boys: { label: "Boys", tone: "sky" }, girls: { label: "Girls", tone: "red" }, coed: { label: "Co-ed", tone: "brand" } };

export function HostelPage() {
  const { can } = useAuth();
  return can("hostel.manage") ? <HostelOffice /> : <MyRoom />;
}

function HostelOffice() {
  const data = useApi<any>("/hostels");
  const [adding, setAdding] = useState(false);
  const [roomFor, setRoomFor] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);
  const hostels: any[] = data.data?.hostels ?? [];
  const beds = hostels.reduce((t, h) => t + h.beds, 0);
  const occupied = hostels.reduce((t, h) => t + h.occupied, 0);

  return (
    <div className="space-y-5">
      <PageTitle
        title="Hostel"
        icon="home"
        subtitle="Rooms, beds and who lives where."
        action={
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> New hostel
          </button>
        }
      />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Hostels" value={hostels.length} icon="home" />
        <StatCard label="Beds" value={beds} icon="layers" tone="sky" />
        <StatCard label="Occupied" value={occupied} icon="users" tone="amber" hint={beds ? `${Math.round((occupied / beds) * 100)}% full` : undefined} />
        <StatCard label="Free beds" value={beds - occupied} icon="check" tone="green" />
      </div>
      <ErrorNote message={data.error} />
      {data.loading && !data.data ? (
        <Spinner />
      ) : hostels.length === 0 ? (
        <Empty title="No hostels yet" icon="home">Add a hostel, then its rooms, to start allocating beds.</Empty>
      ) : (
        hostels.map((h) => {
          const floors = [...new Set<number>(h.roomList.map((r: any) => r.floor))].sort((a, b) => a - b);
          return (
            <SectionCard
              key={h.id}
              title={h.name}
              icon="home"
              action={
                <div className="flex items-center gap-2">
                  <Badge tone={KIND[h.kind].tone}>{KIND[h.kind].label}</Badge>
                  <button className="btn-ghost btn-sm" onClick={() => setRoomFor(h)}>
                    <Icon name="plus" size={14} /> Add room
                  </button>
                </div>
              }
            >
              <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
                <span>
                  Warden: <b className="text-slate-900">{h.warden ?? "Not set"}</b>
                </span>
                {h.phone && (
                  <a href={`tel:${h.phone}`} className="inline-flex items-center gap-1 text-brand">
                    <Icon name="phone" size={14} /> {h.phone}
                  </a>
                )}
                <span className="flex min-w-[12rem] flex-1 items-center gap-2">
                  <Progress value={h.beds ? (h.occupied / h.beds) * 100 : 0} tone="amber" />
                  <span className="whitespace-nowrap text-xs">
                    {h.occupied}/{h.beds} beds
                  </span>
                </span>
              </div>
              {h.roomList.length === 0 ? (
                <p className="text-sm text-slate-500">No rooms yet.</p>
              ) : (
                floors.map((f) => (
                  <div key={f} className="mb-4 last:mb-0">
                    <p className="label">{f === 0 ? "Ground floor" : `Floor ${f}`}</p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                      {h.roomList
                        .filter((r: any) => r.floor === f)
                        .map((r: any) => {
                          const full = r.residents.length >= r.capacity;
                          return (
                            <button
                              key={r.id}
                              onClick={() => setOpen({ ...r, hostel: h.name })}
                              className={`rounded-2xl p-3 text-left ring-1 transition hover:-translate-y-0.5 hover:shadow-md ${full ? "bg-amber-50 ring-amber-200" : "bg-emerald-50 ring-emerald-200"}`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-base font-bold text-slate-900">{r.room_no}</span>
                                <span className="text-[10px] font-semibold uppercase text-slate-500">{r.room_type}</span>
                              </div>
                              <div className="mt-2 flex gap-1">
                                {Array.from({ length: r.capacity }, (_, i) => (
                                  <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < r.residents.length ? "bg-amber-500" : "bg-emerald-300"}`} />
                                ))}
                              </div>
                              <p className="mt-2 truncate text-xs text-slate-600">{r.residents.length ? r.residents.map((x: any) => x.name.split(" ")[0]).join(", ") : "Empty"}</p>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                ))
              )}
            </SectionCard>
          );
        })
      )}
      {adding && <NewHostel onClose={() => setAdding(false)} onSaved={data.reload} />}
      {roomFor && <NewRoom hostel={roomFor} onClose={() => setRoomFor(null)} onSaved={data.reload} />}
      {open && <RoomModal room={open} onClose={() => setOpen(null)} onChanged={() => (data.reload(), setOpen(null))} />}
    </div>
  );
}

function NewHostel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const wardens = useApi<any>("/hostels/wardens");
  const [form, setForm] = useState({ name: "", kind: "coed", wardenId: "", phone: "", address: "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/hostels", { body: { ...form, wardenId: form.wardenId || null, phone: form.phone || null, address: form.address || null } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New hostel">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Ganga House" />
          </Field>
          <Field label="For">
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="boys">Boys</option>
              <option value="girls">Girls</option>
              <option value="coed">Co-ed</option>
            </select>
          </Field>
          <Field label="Warden">
            <select className="input" value={form.wardenId} onChange={(e) => setForm({ ...form, wardenId: e.target.value })}>
              <option value="">Choose later</option>
              {(wardens.data?.wardens ?? []).map((w: any) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Phone">
            <input className="input" type="tel" maxLength={20} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
        </div>
        <Field label="Address (optional)">
          <input className="input" maxLength={300} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create hostel</button>
        </div>
      </form>
    </Modal>
  );
}

function NewRoom({ hostel, onClose, onSaved }: { hostel: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ roomNo: "", floor: 1, capacity: 3, roomType: "standard" });
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/hostels/${hostel.id}/rooms`, { body: { ...form, floor: Number(form.floor), capacity: Number(form.capacity) } });
      setAdded([...added, form.roomNo]);
      // Suggest the next room number.
      const n = Number(form.roomNo);
      setForm({ ...form, roomNo: Number.isFinite(n) ? String(n + 1) : "" });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Add rooms — ${hostel.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Room number">
            <input className="input" required maxLength={20} value={form.roomNo} onChange={(e) => setForm({ ...form, roomNo: e.target.value })} placeholder="101" />
          </Field>
          <Field label="Floor">
            <input className="input" type="number" min={0} max={50} value={form.floor} onChange={(e) => setForm({ ...form, floor: Number(e.target.value) })} />
          </Field>
          <Field label="Beds">
            <input className="input" type="number" min={1} max={20} required value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} />
          </Field>
          <Field label="Type">
            <input className="input" list="room-types" maxLength={40} value={form.roomType} onChange={(e) => setForm({ ...form, roomType: e.target.value })} />
            <datalist id="room-types">
              <option value="standard" />
              <option value="ac" />
              <option value="dormitory" />
            </datalist>
          </Field>
        </div>
        {added.length > 0 && <p className="text-sm text-emerald-700">Added rooms {added.join(", ")}.</p>}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Done
          </button>
          <button className="btn">Add room</button>
        </div>
      </form>
    </Modal>
  );
}

function RoomModal({ room, onClose, onChanged }: { room: any; onClose: () => void; onChanged: () => void }) {
  const students = useApi<any>("/hostels/students");
  const [studentId, setStudentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const full = room.residents.length >= room.capacity;
  const choices: any[] = (students.data?.students ?? []).filter((s: any) => !room.residents.some((r: any) => r.student_id === s.student_id));

  async function allocate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/hostels/rooms/${room.id}/allocations`, { body: { studentId } });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function vacate(r: any) {
    if (!confirm(`${r.name} is leaving room ${room.room_no}?`)) return;
    await api(`/hostels/allocations/${r.allocation_id}/vacate`, { body: {} });
    onChanged();
  }
  return (
    <Modal open onClose={onClose} title={`${room.hostel} · Room ${room.room_no}`}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {room.floor === 0 ? "Ground floor" : `Floor ${room.floor}`} · {room.room_type} · {room.residents.length}/{room.capacity} beds used
        </p>
        <ul className="space-y-2">
          {room.residents.map((r: any) => (
            <li key={r.allocation_id} className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2">
              <div className="flex items-center gap-2.5">
                <Avatar name={r.name} size={32} />
                <div>
                  <p className="text-sm font-semibold text-slate-900">{r.name}</p>
                  <p className="text-xs text-slate-500">Since {fmtDate(r.since, { day: "numeric", month: "short", year: "numeric" })}</p>
                </div>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => vacate(r)}>
                Vacate
              </button>
            </li>
          ))}
          {room.residents.length === 0 && <li className="text-sm text-slate-500">Nobody lives here yet.</li>}
        </ul>
        {!full ? (
          <form onSubmit={allocate} className="flex gap-2 border-t border-slate-100 pt-4">
            <select className="input" required value={studentId} onChange={(e) => setStudentId(e.target.value)}>
              <option value="">Add a student…</option>
              {choices.map((s) => (
                <option key={s.student_id} value={s.student_id}>
                  {s.name}
                  {s.room_no ? ` (moving from ${s.hostel} ${s.room_no})` : ""}
                </option>
              ))}
            </select>
            <button className="btn shrink-0">Allocate</button>
          </form>
        ) : (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">This room is full.</p>
        )}
        <ErrorNote message={error} />
      </div>
    </Modal>
  );
}

function MyRoom() {
  const { can } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [studentId, setStudentId] = useState<string | null>(null);
  const mine = useApi<any>(parent ? (studentId ? `/hostels/my?studentId=${studentId}` : null) : "/hostels/my");
  const d = mine.data;
  return (
    <div className="space-y-5">
      <PageTitle title={parent ? "Hostel" : "My hostel room"} icon="home" subtitle="Room, roommates and who to contact." action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />} />
      <ErrorNote message={mine.error} />
      {mine.loading && !d ? (
        <Spinner />
      ) : (
        d &&
        (!d.resident ? (
          <Empty title="Not staying in the hostel" icon="home">
            Day scholar — no hostel room allocated.
          </Empty>
        ) : (
          <div className="grid gap-5 lg:grid-cols-5">
            <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-emerald-400 via-teal-500 to-sky-500 p-6 text-white shadow-lift animate-fade-up lg:col-span-3">
              <div className="absolute -right-8 -top-8 h-36 w-36 rounded-full bg-white/20 blur-xl" />
              <Icon name="home" size={44} className="relative animate-float" />
              <p className="relative mt-3 text-xs font-bold uppercase tracking-[0.2em] text-white/80">
                {d.room.hostel} · {KIND[d.room.kind].label}
              </p>
              <p className="relative font-display text-4xl font-semibold">Room {d.room.room_no}</p>
              <p className="relative mt-1 text-white/90">
                {d.room.floor === 0 ? "Ground floor" : `Floor ${d.room.floor}`} · {d.room.room_type} · {d.room.capacity}-bed room
              </p>
              <p className="relative mt-4 text-sm text-white/85">Living here since {fmtDate(d.room.start_date, { day: "numeric", month: "long", year: "numeric" })}</p>
            </section>
            <div className="space-y-5 lg:col-span-2">
              <SectionCard title="Roommates" icon="users">
                {d.room.roommates.length ? (
                  <ul className="space-y-2">
                    {d.room.roommates.map((n: string) => (
                      <li key={n} className="flex items-center gap-3">
                        <Avatar name={n} size={34} />
                        <span className="text-sm font-semibold text-slate-900">{n}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">You have the room to yourself for now.</p>
                )}
              </SectionCard>
              <SectionCard title="Warden" icon="shield">
                <p className="text-sm font-semibold text-slate-900">{d.room.warden ?? "To be assigned"}</p>
                {d.room.phone && (
                  <a href={`tel:${d.room.phone}`} className="btn btn-sm mt-3">
                    <Icon name="phone" size={14} /> {d.room.phone}
                  </a>
                )}
                {d.room.address && <p className="mt-2 text-xs text-slate-500">{d.room.address}</p>}
              </SectionCard>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
