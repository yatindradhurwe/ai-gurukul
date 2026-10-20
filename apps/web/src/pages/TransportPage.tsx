import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Avatar, Badge, Empty, ErrorNote, Field, Modal, PageTitle, Progress, SectionCard, Spinner, StatCard, Tabs } from "../components/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { StudentPicker, useStudentOptions } from "../lib/lms";
import { useApi } from "../lib/useApi";

const DIRECTION: Record<string, string> = { both: "Pickup & drop", pickup: "Pickup only", drop: "Drop only" };

export function TransportPage() {
  const { can } = useAuth();
  return can("transport.manage") ? <TransportOffice /> : <MyBus />;
}

function StopTimeline({ stops, highlight }: { stops: any[]; highlight?: string | null }) {
  if (!stops.length) return <p className="text-sm text-slate-500">No stops yet.</p>;
  return (
    <ol className="relative space-y-3 border-l-[3px] border-dashed border-amber-300 pl-6">
      {stops.map((s, i) => {
        const mine = s.id === highlight;
        const last = i === stops.length - 1;
        return (
          <li key={s.id} className="relative">
            <span className={`absolute -left-[33px] top-1 flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-black ring-4 ring-white ${mine ? "bg-brand text-white animate-pop" : last ? "bg-emerald-500 text-white" : "bg-amber-400 text-amber-950"}`}>
              {last ? <Icon name="home" size={12} /> : s.sequence}
            </span>
            <div className={`rounded-2xl px-3 py-2 ${mine ? "bg-brand-soft ring-2 ring-brand/30" : ""}`}>
              <p className={`text-sm font-semibold ${mine ? "text-brand" : "text-slate-900"}`}>
                {s.name} {mine && <span className="chip ml-1 bg-brand text-white">Your stop</span>}
              </p>
              {s.landmark && <p className="text-xs text-slate-500">{s.landmark}</p>}
              <p className="mt-0.5 text-xs text-slate-600">
                <b>Pickup</b> {s.pickup_time} · <b>Drop</b> {s.drop_time}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Transport office
// ---------------------------------------------------------------------------
function TransportOffice() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "routes" | "riders" | "vehicles") ?? "routes";
  const routes = useApi<any>("/transport/routes");
  const s = routes.data?.summary;
  return (
    <div className="space-y-5">
      <PageTitle
        title="Transport"
        icon="bus"
        subtitle="Buses, routes, stops and who rides where."
        action={<Tabs value={tab} onChange={(t) => setParams({ tab: t })} options={[{ value: "routes", label: "Routes" }, { value: "riders", label: "Riders" }, { value: "vehicles", label: "Vehicles" }]} />}
      />
      {s && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard label="Routes" value={s.routes} icon="mapPin" />
          <StatCard label="Buses in service" value={s.vehicles} icon="bus" tone="amber" />
          <StatCard label="Stops" value={s.stops} icon="layers" tone="sky" />
          <StatCard label="Students riding" value={s.riders} icon="users" tone="green" />
        </div>
      )}
      {tab === "routes" && <Routes data={routes} />}
      {tab === "riders" && <Riders routes={routes.data?.routes ?? []} onChanged={routes.reload} />}
      {tab === "vehicles" && <Vehicles onChanged={routes.reload} />}
    </div>
  );
}

function Routes({ data }: { data: ReturnType<typeof useApi<any>> }) {
  const vehicles = useApi<any>("/transport/vehicles");
  const [adding, setAdding] = useState(false);
  const [stopFor, setStopFor] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const routes: any[] = data.data?.routes ?? [];

  const setVehicle = async (r: any, vehicleId: string) => {
    setError(null);
    try {
      await api(`/transport/routes/${r.id}`, { method: "PATCH", body: { vehicleId: vehicleId || null } });
      data.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const removeStop = async (s: any) => {
    setError(null);
    try {
      await api(`/transport/stops/${s.id}`, { method: "DELETE" });
      data.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const removeRoute = async (r: any) => {
    if (!confirm(`Delete ${r.name}?`)) return;
    setError(null);
    try {
      await api(`/transport/routes/${r.id}`, { method: "DELETE" });
      data.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> New route
        </button>
      </div>
      <ErrorNote message={error ?? data.error} />
      {data.loading && !data.data ? (
        <Spinner />
      ) : routes.length === 0 ? (
        <Empty title="No routes yet" icon="bus">Add a vehicle, then create a route and its stops.</Empty>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {routes.map((r) => {
            const pct = r.capacity ? (r.riders / r.capacity) * 100 : 0;
            return (
              <div key={r.id} className="card animate-fade-up">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-300 to-orange-500 text-white shadow-md">
                      <Icon name="bus" size={24} />
                    </span>
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">{r.name}</h3>
                      <p className="text-xs text-slate-500">
                        {r.registration_no ? `${r.vehicle_label || "Bus"} · ${r.registration_no}` : "No vehicle assigned"}
                        {r.driver_name && ` · ${r.driver_name}`}
                      </p>
                    </div>
                  </div>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => removeRoute(r)} aria-label={`Delete ${r.name}`}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                <div className="mt-4">
                  <div className="mb-1 flex justify-between text-xs text-slate-500">
                    <span>
                      {r.riders} of {r.capacity ?? "—"} seats
                    </span>
                    {r.vehicle_status && r.vehicle_status !== "active" && <Badge tone="amber">{r.vehicle_status}</Badge>}
                  </div>
                  <Progress value={pct} tone={pct >= 100 ? "red" : pct >= 85 ? "amber" : "green"} />
                </div>
                <div className="mt-4">
                  <StopTimeline stops={r.stops} />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                  <button className="btn-ghost btn-sm" onClick={() => setStopFor(r)}>
                    <Icon name="plus" size={14} /> Add stop
                  </button>
                  <select className="input w-auto py-1.5 text-xs" value={r.vehicle_id ?? ""} onChange={(e) => setVehicle(r, e.target.value)} aria-label="Vehicle">
                    <option value="">No vehicle</option>
                    {(vehicles.data?.vehicles ?? []).map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.label || v.registration_no} ({v.capacity} seats)
                      </option>
                    ))}
                  </select>
                  {r.stops.length > 0 && (
                    <select className="input ml-auto w-auto py-1.5 text-xs" value="" onChange={(e) => e.target.value && removeStop(r.stops.find((s: any) => s.id === e.target.value))} aria-label="Remove a stop">
                      <option value="">Remove a stop…</option>
                      {r.stops.map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.sequence}. {s.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {adding && <NewRoute vehicles={vehicles.data?.vehicles ?? []} onClose={() => setAdding(false)} onSaved={data.reload} />}
      {stopFor && <AddStop route={stopFor} onClose={() => setStopFor(null)} onSaved={data.reload} />}
    </div>
  );
}

function NewRoute({ vehicles, onClose, onSaved }: { vehicles: any[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/transport/routes", { body: { name, vehicleId: vehicleId || null } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title="New route">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Route name">
          <input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Route 2 — Indiranagar" />
        </Field>
        <Field label="Vehicle">
          <select className="input" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">Assign later</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label || v.registration_no} — {v.registration_no} ({v.capacity} seats)
              </option>
            ))}
          </select>
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Create route</button>
        </div>
      </form>
    </Modal>
  );
}

function AddStop({ route, onClose, onSaved }: { route: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: "", landmark: "", pickupTime: "07:30", dropTime: "15:30", sequence: route.stops.length + 1 });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/transport/routes/${route.id}/stops`, { body: { ...form, sequence: Number(form.sequence), landmark: form.landmark || null } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Add stop — ${route.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Stop name">
            <input className="input" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. 100 Feet Road" />
          </Field>
          <Field label="Landmark (optional)">
            <input className="input" maxLength={160} value={form.landmark} onChange={(e) => setForm({ ...form, landmark: e.target.value })} placeholder="Near the post office" />
          </Field>
          <Field label="Morning pickup">
            <input className="input" type="time" required value={form.pickupTime} onChange={(e) => setForm({ ...form, pickupTime: e.target.value })} />
          </Field>
          <Field label="Afternoon drop">
            <input className="input" type="time" required value={form.dropTime} onChange={(e) => setForm({ ...form, dropTime: e.target.value })} />
          </Field>
          <Field label="Position on the route" hint={`1 to ${route.stops.length + 1}`}>
            <input className="input" type="number" min={1} max={route.stops.length + 1} value={form.sequence} onChange={(e) => setForm({ ...form, sequence: Number(e.target.value) })} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">Add stop</button>
        </div>
      </form>
    </Modal>
  );
}

function Riders({ routes, onChanged }: { routes: any[]; onChanged: () => void }) {
  const [routeId, setRouteId] = useState("");
  const [search, setSearch] = useState("");
  const list = useApi<any>(`/transport/riders${routeId ? `?routeId=${routeId}` : ""}`);
  const [editing, setEditing] = useState<any>(null);
  const rows: any[] = (list.data?.students ?? []).filter((s: any) => !search || s.name.toLowerCase().includes(search.toLowerCase()));
  const remove = async (s: any) => {
    if (!confirm(`Remove ${s.name} from transport?`)) return;
    await api(`/transport/riders/${s.student_id}`, { method: "DELETE" });
    list.reload();
    onChanged();
  };
  return (
    <SectionCard
      title="Riders"
      icon="users"
      action={
        <div className="flex flex-wrap gap-2">
          <input className="input w-auto" placeholder="Search student" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="input w-auto" value={routeId} onChange={(e) => setRouteId(e.target.value)} aria-label="Route">
            <option value="">All students</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="pl-5">Student</th>
                <th>Route</th>
                <th>Stop</th>
                <th>Times</th>
                <th className="pr-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.student_id}>
                  <td className="pl-5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={s.name} size={28} />
                      <div>
                        <p className="font-medium text-slate-900">{s.name}</p>
                        <p className="text-xs text-slate-500">{s.classes ?? "No class"}</p>
                      </div>
                    </div>
                  </td>
                  <td>{s.route ?? <span className="text-slate-400">Not using transport</span>}</td>
                  <td>{s.stop ?? "—"}</td>
                  <td className="whitespace-nowrap text-slate-600">{s.stop ? `${s.pickup_time} / ${s.drop_time} · ${DIRECTION[s.direction]}` : "—"}</td>
                  <td className="pr-5">
                    <div className="flex justify-end gap-1.5">
                      <button className="btn-ghost btn-sm" onClick={() => setEditing(s)}>
                        {s.route ? "Change" : "Assign"}
                      </button>
                      {s.route && (
                        <button className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => remove(s)} aria-label={`Remove ${s.name}`}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <AssignRider
          student={editing}
          routes={routes}
          onClose={() => setEditing(null)}
          onSaved={() => {
            list.reload();
            onChanged();
          }}
        />
      )}
    </SectionCard>
  );
}

function AssignRider({ student, routes, onClose, onSaved }: { student: any; routes: any[]; onClose: () => void; onSaved: () => void }) {
  const [routeId, setRouteId] = useState(student.route_id ?? routes[0]?.id ?? "");
  const route = routes.find((r) => r.id === routeId);
  const [stopId, setStopId] = useState(student.stop_id ?? "");
  const [direction, setDirection] = useState(student.direction ?? "both");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/transport/riders/${student.student_id}`, { method: "PUT", body: { stopId: stopId || route?.stops[0]?.id, direction } });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal open onClose={onClose} title={`Transport for ${student.name}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Route">
          <select className="input" value={routeId} onChange={(e) => (setRouteId(e.target.value), setStopId(""))}>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {r.riders}/{r.capacity ?? "?"} seats
              </option>
            ))}
          </select>
        </Field>
        <Field label="Stop">
          <select className="input" required value={stopId || route?.stops[0]?.id || ""} onChange={(e) => setStopId(e.target.value)}>
            {(route?.stops ?? []).map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.sequence}. {s.name} — {s.pickup_time} / {s.drop_time}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Uses the bus for">
          <select className="input" value={direction} onChange={(e) => setDirection(e.target.value)}>
            {Object.entries(DIRECTION).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={!route?.stops.length}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Vehicles({ onChanged }: { onChanged: () => void }) {
  const list = useApi<any>("/transport/vehicles");
  const [editing, setEditing] = useState<any>(null);
  const rows: any[] = list.data?.vehicles ?? [];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button className="btn" onClick={() => setEditing({})}>
          <Icon name="plus" size={16} /> Add vehicle
        </button>
      </div>
      <ErrorNote message={list.error} />
      {rows.length === 0 ? (
        <Empty title="No vehicles yet" icon="bus">Add the school's buses and vans with their drivers.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((v) => (
            <button key={v.id} onClick={() => setEditing(v)} className="card card-hover text-left">
              <div className="flex items-start justify-between">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-100 text-amber-600">
                  <Icon name="bus" size={22} />
                </span>
                <Badge tone={v.status === "active" ? "green" : v.status === "maintenance" ? "amber" : "slate"}>{v.status}</Badge>
              </div>
              <p className="mt-3 font-semibold text-slate-900">{v.label || "Vehicle"}</p>
              <p className="font-mono text-sm text-slate-600">{v.registration_no}</p>
              <p className="mt-2 text-xs text-slate-500">
                {v.capacity} seats · {v.driver_name || "No driver"} {v.driver_phone && `· ${v.driver_phone}`}
              </p>
              {v.routes && <p className="mt-1 text-xs text-brand">{v.routes}</p>}
            </button>
          ))}
        </div>
      )}
      {editing && (
        <VehicleModal
          vehicle={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            list.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function VehicleModal({ vehicle, onClose, onSaved }: { vehicle: any; onClose: () => void; onSaved: () => void }) {
  const editing = !!vehicle.id;
  const [form, setForm] = useState({
    registrationNo: vehicle.registration_no ?? "",
    label: vehicle.label ?? "",
    capacity: vehicle.capacity ?? 40,
    driverName: vehicle.driver_name ?? "",
    driverPhone: vehicle.driver_phone ?? "",
    attendantName: vehicle.attendant_name ?? "",
    attendantPhone: vehicle.attendant_phone ?? "",
    status: vehicle.status ?? "active",
  });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const body = { ...form, capacity: Number(form.capacity), driverPhone: form.driverPhone || null, attendantName: form.attendantName || null, attendantPhone: form.attendantPhone || null };
      await api(editing ? `/transport/vehicles/${vehicle.id}` : "/transport/vehicles", { method: editing ? "PATCH" : "POST", body });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={editing ? "Edit vehicle" : "Add vehicle"} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Registration number">
            <input className="input font-mono uppercase" required maxLength={20} value={form.registrationNo} onChange={set("registrationNo")} placeholder="KA01AB1234" />
          </Field>
          <Field label="Name">
            <input className="input" maxLength={60} value={form.label} onChange={set("label")} placeholder="Bus 3" />
          </Field>
          <Field label="Seats">
            <input className="input" type="number" min={1} max={200} required value={form.capacity} onChange={set("capacity")} />
          </Field>
          <Field label="Driver">
            <input className="input" maxLength={120} value={form.driverName} onChange={set("driverName")} />
          </Field>
          <Field label="Driver phone">
            <input className="input" type="tel" maxLength={20} value={form.driverPhone} onChange={set("driverPhone")} />
          </Field>
          <Field label="Status">
            <select className="input" value={form.status} onChange={set("status")}>
              <option value="active">In service</option>
              <option value="maintenance">Under maintenance</option>
              <option value="retired">Retired</option>
            </select>
          </Field>
          <Field label="Attendant (optional)">
            <input className="input" maxLength={120} value={form.attendantName} onChange={set("attendantName")} />
          </Field>
          <Field label="Attendant phone">
            <input className="input" type="tel" maxLength={20} value={form.attendantPhone} onChange={set("attendantPhone")} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn">{editing ? "Save" : "Add vehicle"}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Students and parents
// ---------------------------------------------------------------------------
function MyBus() {
  const { can } = useAuth();
  const parent = can("reports.children");
  const students = useStudentOptions();
  const [studentId, setStudentId] = useState<string | null>(null);
  const mine = useApi<any>(parent ? (studentId ? `/transport/my?studentId=${studentId}` : null) : "/transport/my");
  const d = mine.data;
  const stop = d?.route?.stops.find((s: any) => s.id === d.stopId);
  return (
    <div className="space-y-5">
      <PageTitle title={parent ? "School bus" : "My bus"} icon="bus" subtitle="Your route, stop and timings." action={parent && <StudentPicker value={studentId} onChange={setStudentId} options={students.options} />} />
      <ErrorNote message={mine.error} />
      {mine.loading && !d ? (
        <Spinner />
      ) : (
        d &&
        (!d.assigned ? (
          <Empty title="Not using school transport" icon="bus">
            Ask the school office if you'd like a seat on the school bus.
          </Empty>
        ) : (
          <div className="grid gap-5 lg:grid-cols-5">
            <div className="space-y-5 lg:col-span-2">
              <section className="relative overflow-hidden rounded-[2rem] bg-gradient-to-br from-amber-300 via-orange-400 to-rose-400 p-6 text-white shadow-lift animate-fade-up">
                <div className="absolute -right-6 -top-6 h-32 w-32 rounded-full bg-white/20 blur-xl" />
                <Icon name="bus" size={44} className="relative animate-float" />
                <p className="relative mt-3 text-xs font-bold uppercase tracking-[0.2em] text-white/80">{d.route.name}</p>
                <p className="relative font-display text-3xl font-semibold">{d.route.vehicle_label || "School bus"}</p>
                {d.route.registration_no && <p className="relative mt-1 inline-block rounded-lg bg-white/25 px-2 py-0.5 font-mono text-sm font-bold">{d.route.registration_no}</p>}
                {stop && (
                  <div className="relative mt-5 grid grid-cols-2 gap-3">
                    {d.direction !== "drop" && (
                      <div className="rounded-2xl bg-white/20 p-3 backdrop-blur">
                        <p className="text-[11px] font-semibold text-white/80">Morning pickup</p>
                        <p className="text-2xl font-black">{stop.pickup_time}</p>
                      </div>
                    )}
                    {d.direction !== "pickup" && (
                      <div className="rounded-2xl bg-white/20 p-3 backdrop-blur">
                        <p className="text-[11px] font-semibold text-white/80">Afternoon drop</p>
                        <p className="text-2xl font-black">{stop.drop_time}</p>
                      </div>
                    )}
                  </div>
                )}
              </section>
              <SectionCard title="Who to call" icon="phone">
                <ul className="space-y-3">
                  {[
                    ["Driver", d.route.driver_name, d.route.driver_phone],
                    ["Attendant", d.route.attendant_name, d.route.attendant_phone],
                  ]
                    .filter(([, name]) => name)
                    .map(([role, name, phone]) => (
                      <li key={role} className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={name} size={36} />
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{name}</p>
                            <p className="text-xs text-slate-500">{role}</p>
                          </div>
                        </div>
                        {phone && (
                          <a href={`tel:${phone}`} className="btn btn-sm">
                            <Icon name="phone" size={14} /> {phone}
                          </a>
                        )}
                      </li>
                    ))}
                </ul>
              </SectionCard>
            </div>
            <SectionCard title="Route" icon="mapPin" className="lg:col-span-3">
              <StopTimeline stops={d.route.stops} highlight={d.stopId} />
            </SectionCard>
          </div>
        ))
      )}
    </div>
  );
}
