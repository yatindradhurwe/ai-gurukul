import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useRealtime } from "../lib/realtime";
import { useApi } from "../lib/useApi";
import { Icon, type IconName } from "./icons";
import { Avatar } from "./ui";

type Can = (p: string) => boolean;

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  hint: string;
  show: (can: Can, platformAdmin: boolean) => boolean;
}

interface NavGroup {
  label: string;
  icon: IconName;
  items: NavItem[];
}

const staff = (can: Can) => can("classes.manage");
const learner = (can: Can) => can("classes.attend");
const parent = (can: Can) => can("reports.children");

export const NAV: NavGroup[] = [
  {
    label: "Learning",
    icon: "book",
    items: [
      { to: "/today", label: "My day", icon: "target", hint: "Today's study plan", show: (can) => can("planner.self") },
      { to: "/rewards", label: "Rewards", icon: "award", hint: "XP, streaks and badges", show: (can) => learner(can) || parent(can) },
      { to: "/learn", label: "Courses", icon: "book", hint: "Chapters and lessons", show: (can) => can("curriculum.read") },
      { to: "/tutor", label: "AI Teacher", icon: "sparkles", hint: "Ask any doubt", show: (can) => can("tutor.use") },
      { to: "/plan", label: "Study plan", icon: "calendar", hint: "Your exam plan", show: (can) => can("planner.self") },
      { to: "/results", label: "Results", icon: "trending", hint: "Mastery and quizzes", show: (can) => can("reports.self") },
    ],
  },
  {
    label: "Classroom",
    icon: "video",
    items: [
      { to: "/my-classes", label: "My classes", icon: "graduation", hint: "Subjects, students and activities you teach", show: (can) => staff(can) && !can("directory.manage") },
      { to: "/classes", label: "Live classes", icon: "video", hint: "AI avatar lessons", show: (can) => staff(can) || learner(can) },
      { to: "/timetable", label: "Timetable", icon: "clock", hint: "The weekly schedule", show: (can) => staff(can) || learner(can) },
      { to: "/assignments", label: "Assignments", icon: "clipboard", hint: "Homework and projects", show: (can) => staff(can) || learner(can) || parent(can) },
      { to: "/attendance", label: "Attendance", icon: "checkSquare", hint: "Daily register", show: (can) => staff(can) || learner(can) || parent(can) },
    ],
  },
  {
    label: "Academics",
    icon: "graduation",
    items: [
      { to: "/syllabus", label: "Syllabus", icon: "book", hint: "Chapters now and next", show: (can) => staff(can) || learner(can) || parent(can) },
      { to: "/academics", label: "Syllabus tracker", icon: "chart", hint: "Every class and subject", show: (can) => can("academics.manage") || can("reports.tenant") },
      { to: "/exams", label: "Exams", icon: "file", hint: "Date sheets and results", show: (can) => can("exams.manage") || staff(can) || learner(can) || parent(can) },
      { to: "/gradebook", label: "Gradebook", icon: "award", hint: "Enter marks", show: staff },
      { to: "/report-card", label: "Report card", icon: "chart", hint: "Grades and progress", show: (can) => learner(can) || parent(can) || staff(can) },
      { to: "/children", label: "My children", icon: "heart", hint: "Weekly reports", show: parent },
    ],
  },
  {
    label: "Campus",
    icon: "layers",
    items: [
      { to: "/fees", label: "Fees", icon: "card", hint: "Dues and receipts", show: (can) => can("fees.manage") || learner(can) || parent(can) },
      { to: "/library", label: "Library", icon: "book", hint: "Find and borrow books", show: () => true },
      { to: "/transport", label: "Transport", icon: "bus", hint: "Buses, routes and stops", show: (can) => can("transport.manage") || learner(can) || parent(can) },
      { to: "/hostel", label: "Hostel", icon: "home", hint: "Rooms and residents", show: (can) => can("hostel.manage") || learner(can) || parent(can) },
    ],
  },
  {
    label: "Connect",
    icon: "send",
    items: [
      { to: "/messages", label: "Messages", icon: "send", hint: "Chat with teachers and the office", show: () => true },
      { to: "/announcements", label: "Announcements", icon: "megaphone", hint: "School and class notices", show: () => true },
      { to: "/meetings", label: "Parent-teacher meetings", icon: "users", hint: "Book or publish PTM slots", show: (can) => staff(can) || parent(can) },
      { to: "/leave", label: "Leave", icon: "calendar", hint: "Apply and approve leave", show: () => true },
      { to: "/calendar", label: "School calendar", icon: "star", hint: "Holidays, exams and events", show: () => true },
    ],
  },
  {
    label: "Admin",
    icon: "shield",
    items: [
      { to: "/directory", label: "School directory", icon: "users", hint: "Staff, classes 1–12, students, documents", show: (can) => can("directory.manage") },
      { to: "/academics/setup", label: "Academic setup", icon: "sliders", hint: "Year, holidays, syllabi, subjects", show: (can) => can("academics.manage") },
      { to: "/admissions", label: "Admissions", icon: "graduation", hint: "Enquiries to admitted students", show: (can) => can("admissions.manage") },
      { to: "/id-cards", label: "ID cards", icon: "file", hint: "Cards and certificates", show: (can) => can("admissions.manage") || can("members.manage") },
      { to: "/staff", label: "Staff & payroll", icon: "card", hint: "HR records and payslips", show: (can) => can("payroll.manage") },
      { to: "/content", label: "Content", icon: "folder", hint: "Course material", show: (can) => can("content.manage") || can("content.review") },
      { to: "/access", label: "Access & roles", icon: "shield", hint: "What each role can use", show: (can) => can("tenant.manage") },
      { to: "/people", label: "People", icon: "users", hint: "Members and invitations", show: (can) => can("members.manage") },
      { to: "/billing", label: "Subscription", icon: "sliders", hint: "Plan and billing", show: (can) => can("tenant.billing") },
      { to: "/platform", label: "Platform admin", icon: "shield", hint: "All organisations", show: (_can, platformAdmin) => platformAdmin },
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
  transport_manager: "Transport",
  warden: "Warden",
  content_reviewer: "Reviewer",
  parent: "Parent",
  student: "Student",
};

function useNav() {
  const { user, can } = useAuth();
  return NAV.map((g) => ({ ...g, items: g.items.filter((n) => n.show(can, !!user?.is_platform_admin)) })).filter((g) => g.items.length);
}

const isActive = (pathname: string, to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));

function Brand() {
  const { tenant } = useAuth();
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5">
      {tenant?.settings?.logoUrl ? (
        <img src={tenant.settings.logoUrl} alt="" className="h-9 w-9 rounded-xl" />
      ) : (
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand via-violet-500 to-fuchsia-500 text-white shadow-md shadow-brand/30">
          <Icon name="graduation" size={20} />
        </div>
      )}
      <div className="hidden leading-tight sm:block">
        <p className="font-display text-[1.05rem] font-semibold text-slate-900">AI Gurukul</p>
        <p className="max-w-[9rem] truncate text-[11px] text-slate-500">{tenant?.name ?? "Learning platform"}</p>
      </div>
    </Link>
  );
}

const pill = (active: boolean) =>
  `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-2 text-sm font-semibold transition 2xl:px-3 [&>svg:first-child]:hidden 2xl:[&>svg:first-child]:inline ${
    active ? "bg-brand text-white shadow-md shadow-brand/30" : "text-slate-600 hover:bg-white hover:text-slate-900 hover:shadow-sm"
  }`;

function GroupMenu({ group, open, onOpen, onClose }: { group: NavGroup; open: boolean; onOpen: () => void; onClose: () => void }) {
  const { pathname } = useLocation();
  const active = group.items.some((i) => isActive(pathname, i.to));
  if (group.items.length === 1) {
    const only = group.items[0];
    return (
      <NavLink to={only.to} className={pill(active)}>
        <Icon name={only.icon} size={16} /> {only.label}
      </NavLink>
    );
  }
  return (
    <div className="relative">
      <button className={pill(active || open)} onClick={() => (open ? onClose() : onOpen())} aria-expanded={open} aria-haspopup="menu">
        <Icon name={group.icon} size={16} /> {group.label}
        <Icon name="chevronDown" size={14} className={`transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 z-40 mt-2 w-72 rounded-3xl bg-white p-2 shadow-lift ring-1 ring-slate-200 animate-pop">
          {group.items.map((n) => {
            const on = isActive(pathname, n.to);
            return (
              <Link key={n.to} to={n.to} role="menuitem" onClick={onClose} className={`flex items-center gap-3 rounded-2xl px-3 py-2.5 transition ${on ? "bg-brand-soft" : "hover:bg-slate-50"}`}>
                <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${on ? "bg-brand text-white" : "bg-slate-100 text-slate-600"}`}>
                  <Icon name={n.icon} size={17} />
                </span>
                <span>
                  <span className={`block text-sm font-semibold ${on ? "text-brand" : "text-slate-900"}`}>{n.label}</span>
                  <span className="block text-xs text-slate-500">{n.hint}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DesktopNav() {
  const groups = useNav();
  const { pathname } = useLocation();
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => setOpen(null), [pathname]);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  return (
    <nav ref={ref} className="hidden items-center gap-0.5 rounded-full bg-slate-100/80 p-1 xl:flex" aria-label="Main">
      <NavLink to="/" end className={({ isActive: a }) => pill(a)}>
        <Icon name="dashboard" size={16} /> Dashboard
      </NavLink>
      {groups.map((g) => (
        <GroupMenu key={g.label} group={g} open={open === g.label} onOpen={() => setOpen(g.label)} onClose={() => setOpen(null)} />
      ))}
    </nav>
  );
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  const groups = useNav();
  const { pathname } = useLocation();
  const item = (n: { to: string; label: string; icon: IconName }) => {
    const on = isActive(pathname, n.to);
    return (
      <Link key={n.to} to={n.to} onClick={onClose} className={`flex flex-col items-center gap-1.5 rounded-2xl p-3 text-center text-xs font-semibold transition ${on ? "bg-brand text-white" : "bg-slate-50 text-slate-700 hover:bg-slate-100"}`}>
        <Icon name={n.icon} size={20} />
        {n.label}
      </Link>
    );
  };
  return (
    <div className="fixed inset-0 z-50 xl:hidden">
      <div className="absolute inset-0 bg-slate-950/30 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute inset-x-0 top-0 max-h-[90vh] overflow-y-auto rounded-b-[2rem] bg-white p-5 shadow-lift animate-fade-up">
        <div className="mb-4 flex items-center justify-between">
          <Brand />
          <button className="rounded-xl p-2 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="Close menu">
            <Icon name="x" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {item({ to: "/", label: "Dashboard", icon: "dashboard" })}
        </div>
        {groups.map((g) => (
          <div key={g.label} className="mt-5">
            <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">{g.label}</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{g.items.map(item)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPLOYEE_ROLES = ["tenant_owner", "tenant_admin", "teacher", "staff", "accountant", "librarian", "transport_manager", "warden", "content_reviewer"];

function UserMenu() {
  const { user, tenant, memberships, logout, switchTenant, info } = useAuth();
  const isStaff = (info?.roles ?? []).some((r) => EMPLOYEE_ROLES.includes(r));
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
      <button className="flex items-center gap-2 rounded-full bg-white py-1 pl-1 pr-2 shadow-sm ring-1 ring-slate-200 transition hover:shadow-md" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Avatar name={user.name} size={32} />
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[9rem] truncate text-sm font-semibold text-slate-900">{user.name.split(" ")[0]}</span>
          <span className="block text-[11px] text-slate-500">{role}</span>
        </span>
        <Icon name="chevronDown" size={16} className="hidden text-slate-400 md:block" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 rounded-3xl bg-white p-2 shadow-lift ring-1 ring-slate-200 animate-pop">
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
          <div className="border-b border-slate-100 py-1">
            {(isStaff || info?.studentProfileId) && (
              <Link to="/id-cards/me" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">
                <Icon name="file" size={16} /> My ID card
              </Link>
            )}
            {isStaff && (
              <Link to="/payslips" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-2xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100">
                <Icon name="card" size={16} /> My payslips
              </Link>
            )}
          </div>
          <button className="mt-1 flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 hover:text-red-600" onClick={logout}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** The browser tab shows the page name, prefixed with unread messages like "(3) Messages · AI Gurukul". */
const tabTitle = { page: "AI Gurukul", unread: 0 };
const renderTitle = () => {
  document.title = tabTitle.unread ? `(${tabTitle.unread > 99 ? "99+" : tabTitle.unread}) ${tabTitle.page}` : tabTitle.page;
};

function MessagesIcon() {
  const { tenant } = useAuth();
  const { pathname } = useLocation();
  const inbox = useApi<{ unread: number }>(tenant ? "/messages/conversations" : null);
  const { reload } = inbox;
  useEffect(() => {
    reload();
  }, [pathname, reload]);
  // New messages and read receipts arrive over the live connection.
  useRealtime("message", reload);
  useRealtime("receipt", reload);
  useRealtime("ready", reload);
  const unread = inbox.data?.unread ?? 0;
  useEffect(() => {
    tabTitle.unread = unread;
    renderTitle();
  }, [unread]);
  return (
    <Link to="/messages" className="relative rounded-full bg-white p-2.5 text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:text-slate-900 hover:shadow-md" aria-label={`Messages${unread ? `, ${unread} unread` : ""}`}>
      <Icon name="send" size={18} />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white ring-2 ring-white">{unread > 9 ? "9+" : unread}</span>
      )}
    </Link>
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
  useRealtime("notify", (e) => e.module === "announcements" && reload());
  const unread = feed.data?.unread ?? 0;
  return (
    <Link to="/announcements" className="relative rounded-full bg-white p-2.5 text-slate-600 shadow-sm ring-1 ring-slate-200 transition hover:text-slate-900 hover:shadow-md" aria-label={`Announcements${unread ? `, ${unread} unread` : ""}`}>
      <Icon name="bell" size={18} className={unread ? "animate-wiggle" : ""} />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white ring-2 ring-white">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Link>
  );
}

/** Students see their level and XP in the header — a constant nudge to keep learning. */
function XpChip() {
  const { info } = useAuth();
  const { pathname } = useLocation();
  const me = useApi<any>(info?.studentProfileId ? "/engagement/me" : null);
  const { reload } = me;
  useEffect(() => {
    reload();
  }, [pathname, reload]);
  if (!me.data) return null;
  return (
    <Link to="/rewards" title={`Level ${me.data.level.number} · ${me.data.level.name}`} className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-gradient-to-r from-amber-300 to-orange-400 py-1.5 pl-1.5 pr-3 text-sm font-bold text-amber-950 shadow-md shadow-amber-500/30 transition hover:scale-[1.03] sm:flex">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/70 text-xs">{me.data.level.number}</span>
      {me.data.xp} XP
      {me.data.streak.current > 0 && (
        <span className="ml-0.5 inline-flex items-center gap-0.5 rounded-full bg-white/60 px-1.5 text-xs">
          <Icon name="flame" size={12} className="fill-orange-500 text-orange-600" />
          {me.data.streak.current}
        </span>
      )}
    </Link>
  );
}

function usePageTitle() {
  const { pathname } = useLocation();
  if (pathname === "/") return "Dashboard";
  if (pathname.startsWith("/live/")) return "Live classroom";
  if (pathname.startsWith("/fees/receipts/")) return "Fee receipt";
  if (pathname.startsWith("/announcements")) return "Announcements";
  if (pathname.startsWith("/id-cards/me")) return "My ID card";
  if (pathname.startsWith("/academics/plan/")) return "Syllabus plan";
  if (pathname.startsWith("/academics/setup")) return "Academic setup";
  if (pathname.startsWith("/certificates/")) return "Certificate";
  if (pathname.startsWith("/payslips")) return "Payslips";
  if (pathname.startsWith("/directory/")) return "School directory";
  const all = NAV.flatMap((g) => g.items);
  return all.filter((n) => isActive(pathname, n.to)).sort((a, b) => b.to.length - a.to.length)[0]?.label ?? "AI Gurukul";
}

export function Layout() {
  const [menu, setMenu] = useState(false);
  const { pathname } = useLocation();
  const title = usePageTitle();
  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    tabTitle.page = `${title} · AI Gurukul`;
    renderTitle();
  }, [title]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-white/60 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex h-[4.25rem] max-w-7xl items-center gap-3 px-4 md:px-6">
          <Brand />
          <div className="flex flex-1 justify-center">
            <DesktopNav />
          </div>
          <div className="flex items-center gap-2">
            <XpChip />
            <MessagesIcon />
            <Bell />
            <UserMenu />
            <button className="rounded-full bg-white p-2.5 text-slate-700 shadow-sm ring-1 ring-slate-200 xl:hidden" onClick={() => setMenu(true)} aria-label="Open menu">
              <Icon name="menu" size={18} />
            </button>
          </div>
        </div>
      </header>
      {menu && <MobileMenu onClose={() => setMenu(false)} />}
      <main className="px-4 pb-16 pt-6 md:px-6">
        <div className="mx-auto max-w-7xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
