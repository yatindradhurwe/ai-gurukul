import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  show: (can: (p: string) => boolean) => boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Home", icon: "🏠", show: (can) => can("planner.self") },
  { to: "/learn", label: "Learn", icon: "📚", show: (can) => can("curriculum.read") },
  { to: "/tutor", label: "AI Teacher", icon: "🧑‍🏫", show: (can) => can("tutor.use") },
  { to: "/plan", label: "Study Plan", icon: "🗓️", show: (can) => can("planner.self") },
  { to: "/results", label: "Results", icon: "📈", show: (can) => can("reports.self") },
  { to: "/children", label: "Children", icon: "👨‍👩‍👧", show: (can) => can("reports.children") },
  { to: "/content", label: "Content", icon: "🗂️", show: (can) => can("content.manage") || can("content.review") },
  { to: "/billing", label: "Billing", icon: "💳", show: (can) => can("tenant.billing") },
];

export function Layout() {
  const { user, tenant, memberships, can, logout, switchTenant } = useAuth();
  const items = NAV.filter((n) => n.show(can));
  return (
    <div className="min-h-screen md:flex">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          {tenant?.settings?.logoUrl ? (
            <img src={tenant.settings.logoUrl} alt="" className="h-8 w-8 rounded-lg" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">G</div>
          )}
          <span className="font-semibold">AI Gurukul</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${isActive ? "bg-brand-soft font-medium text-brand" : "text-slate-600 hover:bg-slate-100"}`}
            >
              <span aria-hidden>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-4 border-t border-slate-200 pt-4 text-sm">
          {memberships.length > 1 && (
            <select className="input mb-3" value={tenant?.tenant_id} onChange={(e) => switchTenant(e.target.value)} aria-label="Switch organization">
              {memberships.map((m) => (
                <option key={m.tenant_id} value={m.tenant_id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <p className="truncate font-medium">{user?.name}</p>
          <p className="truncate text-xs text-slate-500">{tenant?.name}</p>
          <button className="mt-2 text-xs text-slate-500 hover:text-slate-800" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:pb-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex justify-around border-t border-slate-200 bg-white py-2 md:hidden">
        {items.slice(0, 5).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `flex flex-col items-center px-2 text-[11px] ${isActive ? "text-brand" : "text-slate-500"}`}>
            <span className="text-lg" aria-hidden>
              {n.icon}
            </span>
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
