import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useTheme, type Theme } from "../lib/theme";
import { useApi } from "../lib/useApi";
import { Icon, type IconName } from "./icons";
import { Avatar } from "./ui";

type Can = (p: string) => boolean;

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  show: (can: Can, platformAdmin: boolean) => boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const staff = (can: Can) => can("classes.manage");
const learner = (can: Can) => can("classes.attend");
const parent = (can: Can) => can("reports.children");

export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: "dashboard", show: () => true },
      { to: "/today", label: "My day", icon: "target", show: (can) => can("planner.self") },
    ],
  },
  {
    label: "Learning",
    items: [
      { to: "/learn", label: "Courses", icon: "book", show: (can) => can("curriculum.read") },
      { to: "/tutor", label: "AI Teacher", icon: "sparkles", show: (can) => can("tutor.use") },
      { to: "/plan", label: "Study plan", icon: "calendar", show: (can) => can("planner.self") },
      { to: "/results", label: "Results", icon: "trending", show: (can) => can("reports.self") },
    ],
  },
  {
    label: "Classroom",
    items: [
      { to: "/classes", label: "Live classes", icon: "video", show: (can) => staff(can) || learner(can) },
      { to: "/timetable", label: "Timetable", icon: "clock", show: (can) => staff(can) || learner(can) },
      { to: "/assignments", label: "Assignments", icon: "clipboard", show: (can) => staff(can) || learner(can) || parent(can) },
      { to: "/attendance", label: "Attendance", icon: "checkSquare", show: (can) => staff(can) || learner(can) || parent(can) },
    ],
  },
  {
    label: "Academics",
    items: [
      { to: "/exams", label: "Exams", icon: "file", show: (can) => can("exams.manage") || staff(can) || learner(can) || parent(can) },
      { to: "/gradebook", label: "Gradebook", icon: "award", show: staff },
      { to: "/report-card", label: "Report card", icon: "chart", show: (can) => learner(can) || parent(can) || staff(can) },
      { to: "/children", label: "My children", icon: "heart", show: parent },
    ],
  },
  {
    label: "Campus",
    items: [
      { to: "/fees", label: "Fees", icon: "card", show: (can) => can("fees.manage") || learner(can) || parent(can) },
      { to: "/library", label: "Library", icon: "book", show: () => true },
    ],
  },
  {
    label: "Community",
    items: [{ to: "/announcements", label: "Announcements", icon: "megaphone", show: () => true }],
  },
  {
    label: "Administration",
    items: [
      { to: "/content", label: "Content", icon: "folder", show: (can) => can("content.manage") || can("content.review") },
      { to: "/people", label: "People", icon: "users", show: (can) => can("members.manage") },
      { to: "/billing", label: "Subscription", icon: "sliders", show: (can) => can("tenant.billing") },
      { to: "/platform", label: "Platform admin", icon: "shield", show: (_can, platformAdmin) => platformAdmin },
    ],
  },
];

const ROLE_LABELS: Record<string, string> = {
  tenant_owner: "Owner",
  tenant_admin: "Admin",
  teacher: "Teacher",
  staff: "Staff / HR",
  accountant: "Accountant",
  librarian: "Librarian",
  content_reviewer: "Reviewer",
  parent: "Parent",
  student: "Student",
};

function useNav() {
  const { user, can } = useAuth();
  return NAV.map((g) => ({ ...g, items: g.items.filter((n) => n.show(can, !!user?.is_platform_admin)) })).filter((g) => g.items.length);
}

function Brand() {
  const { tenant } = useAuth();
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2">
      {tenant?.settings?.logoUrl ? (
        <img src={tenant.settings.logoUrl} alt="" className="h-9 w-9 rounded-xl" />
      ) : (
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-violet-500 text-white shadow-md shadow-brand/30">
          <Icon name="graduation" size={20} />
        </div>
      )}
      <div className="leading-tight">
        <p className="font-display text-[1.05rem] font-semibold text-slate-900">AI Gurukul</p>
        <p className="max-w-[9.5rem] truncate text-[11px] text-slate-500">{tenant?.name ?? "Learning platform"}</p>
      </div>
    </Link>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const groups = useNav();
  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="mb-1.5 px-3 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-slate-400">{g.label}</p>
          <div className="flex flex-col gap-0.5">
            {g.items.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/"}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${
                    isActive ? "bg-brand-soft font-semibold text-brand" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute inset-y-1.5 left-0 w-1 rounded-r-full bg-brand" />}
                    <Icon name={n.icon} size={18} className={isActive ? "text-brand" : "text-slate-400 group-hover:text-slate-600"} />
                    {n.label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function ThemeSwitch() {
  const { theme, setTheme, isDark } = useTheme();
  const next: Record<Theme, Theme> = { light: "dark", dark: "system", system: "light" };
  const label = theme === "system" ? "Theme: follows device" : `Theme: ${theme}`;
  return (
    <button className="relative rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800" onClick={() => setTheme(next[theme])} title={label} aria-label={label}>
      <Icon name={theme === "system" ? "monitor" : isDark ? "moon" : "sun"} />
    </button>
  );
}

function UserMenu() {
  const { user, tenant, memberships, logout, switchTenant } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  if (!user) return null;
  const role = tenant?.roles?.map((r) => ROLE_LABELS[r] ?? r).join(", ") ?? (user.is_platform_admin ? "Platform admin" : "");
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-xl py-1 pl-1 pr-2 transition hover:bg-slate-100" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar name={user.name} size={32} />
        <span className="hidden text-left leading-tight sm:block">
          <span className="block max-w-[10rem] truncate text-sm font-semibold text-slate-900">{user.name}</span>
          <span className="block text-[11px] text-slate-500">{role}</span>
        </span>
        <Icon name="chevronDown" size={16} className="hidden text-slate-400 sm:block" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 rounded-2xl bg-surface p-2 shadow-lift ring-1 ring-slate-200 animate-fade-up">
          <div className="border-b border-slate-100 px-3 pb-3 pt-2">
            <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            {user.is_platform_admin && <span className="chip mt-2 bg-brand-soft text-brand">Platform admin</span>}
          </div>
          {memberships.length > 1 && (
            <div className="border-b border-slate-100 p-2">
              <p className="label px-1">Organization</p>
              <select className="input" value={tenant?.tenant_id} onChange={(e) => switchTenant(e.target.value)} aria-label="Switch organization">
                {memberships.map((m) => (
                  <option key={m.tenant_id} value={m.tenant_id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 hover:text-red-600" onClick={logout}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Bell() {
  const { tenant } = useAuth();
  const { pathname } = useLocation();
  const feed = useApi<{ unread: number }>(tenant ? "/announcements" : null);
  const { reload } = feed;
  useEffect(() => {
    reload();
  }, [pathname, reload]);
  const unread = feed.data?.unread ?? 0;
  return (
    <Link to="/announcements" className="relative rounded-xl p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800" aria-label={`Announcements${unread ? `, ${unread} unread` : ""}`}>
      <Icon name="bell" />
      {unread > 0 && (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-surface">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}

function usePageTitle() {
  const { pathname } = useLocation();
  const all = NAV.flatMap((g) => g.items);
  const match = all.filter((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to))).sort((a, b) => b.to.length - a.to.length)[0];
  if (pathname.startsWith("/live/")) return "Live classroom";
  if (pathname.startsWith("/fees/receipts/")) return "Fee receipt";
  return match?.label ?? "AI Gurukul";
}

export function Layout() {
  const { can } = useAuth();
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  const title = usePageTitle();
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    document.title = `${title} · AI Gurukul`;
  }, [title]);

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200/80 bg-surface lg:flex">
        <div className="py-5">
          <Brand />
        </div>
        <SideNav />
        {can("tutor.use") && (
          <Link to="/tutor" className="m-3 block rounded-2xl bg-gradient-to-br from-brand to-violet-500 p-4 text-white transition hover:shadow-lift">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Icon name="sparkles" size={16} /> Ask your AI teacher
            </p>
            <p className="mt-0.5 text-xs text-white/80">Doubts answered from your own course material.</p>
          </Link>
        )}
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-950/40 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-surface shadow-lift animate-fade-up">
            <div className="flex items-center justify-between py-5 pr-3">
              <Brand />
              <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" onClick={() => setDrawer(false)} aria-label="Close menu">
                <Icon name="x" />
              </button>
            </div>
            <SideNav onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200/80 bg-surface/80 px-4 backdrop-blur-md md:px-8">
          <button className="rounded-xl p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
          <div className="ml-auto flex items-center gap-1">
            <ThemeSwitch />
            <Bell />
            <div className="mx-1 h-6 w-px bg-slate-200" />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-4 pb-16 pt-6 md:px-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
