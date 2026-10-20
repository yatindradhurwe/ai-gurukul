// Permission catalogue. Roles map to permission sets; every route checks a
// permission on the server — hiding UI is never access control.
export const PERMISSIONS = [
  "tenant.manage",
  "tenant.billing",
  "members.manage",
  "curriculum.read",
  "content.manage",
  "content.review",
  "assessments.manage",
  "assessments.review",
  "assessments.take",
  "tutor.use",
  "planner.self",
  "planner.manage_students",
  "reports.self",
  "reports.children",
  "reports.class",
  "reports.tenant",
  "usage.read",
  "classes.manage",
  "classes.attend",
  "announcements.manage",
  "fees.manage",
  "exams.manage",
  "library.manage",
  "transport.manage",
  "hostel.manage",
  "admissions.manage",
  "payroll.manage",
  "leave.approve",
  "academics.manage",
  "directory.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  tenant_owner: [...PERMISSIONS].filter((p) => !["assessments.take", "planner.self", "reports.self", "reports.children", "classes.attend"].includes(p)),
  tenant_admin: [
    "members.manage", "curriculum.read", "content.manage", "assessments.manage",
    "planner.manage_students", "reports.class", "reports.tenant", "usage.read", "classes.manage",
    "announcements.manage", "fees.manage", "exams.manage", "library.manage", "transport.manage", "hostel.manage",
    "admissions.manage", "payroll.manage", "leave.approve", "academics.manage", "directory.manage",
  ],
  teacher: [
    "curriculum.read", "content.manage", "assessments.manage", "assessments.review",
    "planner.manage_students", "reports.class", "classes.manage", "announcements.manage",
  ],
  // Staff / HR: people administration and organisation reports, but no access to
  // individual students' academic records, content or classes.
  staff: ["curriculum.read", "members.manage", "reports.tenant", "usage.read", "announcements.manage", "fees.manage", "library.manage", "transport.manage", "hostel.manage", "admissions.manage", "payroll.manage", "leave.approve"],
  // Accountant: fee collection only. Librarian: the library only.
  accountant: ["curriculum.read", "fees.manage", "payroll.manage"],
  librarian: ["curriculum.read", "library.manage"],
  // Transport manager: buses, routes and riders. Warden: hostel rooms and residents.
  transport_manager: ["curriculum.read", "transport.manage"],
  warden: ["curriculum.read", "hostel.manage"],
  content_reviewer: ["curriculum.read", "content.review"],
  parent: ["curriculum.read", "reports.children", "tenant.billing"],
  student: ["curriculum.read", "tutor.use", "assessments.take", "planner.self", "reports.self", "classes.attend"],
};

/** Roles held by school employees (they get staff attendance, leave and payslips). */
export const STAFF_ROLES = ["tenant_owner", "tenant_admin", "teacher", "staff", "accountant", "librarian", "transport_manager", "warden", "content_reviewer"];

export const ROLE_NAMES: Record<string, string> = {
  tenant_owner: "Tenant owner",
  tenant_admin: "Tenant admin",
  teacher: "Teacher",
  staff: "Staff / HR",
  content_reviewer: "Content reviewer",
  accountant: "Accountant",
  librarian: "Librarian",
  transport_manager: "Transport manager",
  warden: "Hostel warden",
  parent: "Parent / guardian",
  student: "Student",
};

/**
 * Permissions a principal may switch on or off per role, grouped by module.
 * Left out: tenant.manage (the owner's alone), and permissions tied to being a
 * student or parent (assessments.take, planner.self, reports.self,
 * reports.children, classes.attend), which only make sense for those accounts.
 */
export const EDITABLE_PERMISSIONS: { id: Permission; module: string; label: string; hint: string }[] = [
  { id: "members.manage", module: "People & office", label: "People & invitations", hint: "Invite members, change roles" },
  { id: "directory.manage", module: "People & office", label: "School directory", hint: "All staff and students, profiles, documents, promotions" },
  { id: "admissions.manage", module: "People & office", label: "Admissions & ID cards", hint: "Enquiries, admitting students, certificates" },
  { id: "payroll.manage", module: "People & office", label: "Staff HR & payroll", hint: "Staff records, attendance, payslips" },
  { id: "leave.approve", module: "People & office", label: "Approve leave", hint: "Student, staff leave and out-passes" },
  { id: "academics.manage", module: "Academics", label: "Academic setup", hint: "Years, holidays, syllabi, class subjects" },
  { id: "exams.manage", module: "Academics", label: "Exams", hint: "Date sheets, papers, declaring results" },
  { id: "reports.class", module: "Academics", label: "Class reports", hint: "Report cards and class results" },
  { id: "reports.tenant", module: "Academics", label: "School-wide reports", hint: "Dashboards across the school" },
  { id: "planner.manage_students", module: "Academics", label: "Students' study plans", hint: "View and adjust plans" },
  { id: "classes.manage", module: "Classroom", label: "Teach classes", hint: "Attendance, gradebook, assignments, live classes" },
  { id: "announcements.manage", module: "Classroom", label: "Post announcements", hint: "School and class notices" },
  { id: "assessments.manage", module: "Classroom", label: "Create tests", hint: "Quizzes and question banks" },
  { id: "assessments.review", module: "Classroom", label: "Review answers", hint: "Mark written answers" },
  { id: "curriculum.read", module: "Learning", label: "Courses", hint: "Read chapters and lessons" },
  { id: "tutor.use", module: "Learning", label: "AI teacher", hint: "Ask the AI teacher" },
  { id: "content.manage", module: "Learning", label: "Manage content", hint: "Upload and edit course material" },
  { id: "content.review", module: "Learning", label: "Approve content", hint: "Review material before students see it" },
  { id: "fees.manage", module: "Campus", label: "Fees", hint: "Fee structures, collections, receipts" },
  { id: "library.manage", module: "Campus", label: "Library", hint: "Catalogue, issue and return" },
  { id: "transport.manage", module: "Campus", label: "Transport", hint: "Buses, routes and riders" },
  { id: "hostel.manage", module: "Campus", label: "Hostel", hint: "Rooms, beds and residents" },
  { id: "usage.read", module: "Organisation", label: "Usage", hint: "AI and platform usage" },
  { id: "tenant.billing", module: "Organisation", label: "Subscription", hint: "Plan and billing" },
];

/** Roles whose access can't be changed: the owner always keeps everything (no lock-outs). */
export const LOCKED_ROLES = ["tenant_owner"];

export type AccessOverrides = Record<string, { grant?: string[]; revoke?: string[] }>;

const editable = new Set<string>(EDITABLE_PERMISSIONS.map((p) => p.id));

/** A role's permissions in one organization: the defaults, plus the principal's grants, minus revocations. */
export function permissionsFor(role: string, overrides: AccessOverrides | null | undefined): Permission[] {
  const base = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  const o = LOCKED_ROLES.includes(role) ? undefined : overrides?.[role];
  for (const p of o?.grant ?? []) if (editable.has(p)) base.add(p as Permission);
  for (const p of o?.revoke ?? []) if (editable.has(p)) base.delete(p as Permission);
  return [...base];
}
