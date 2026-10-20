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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  tenant_owner: [...PERMISSIONS].filter((p) => !["assessments.take", "planner.self", "reports.self", "reports.children", "classes.attend"].includes(p)),
  tenant_admin: [
    "members.manage", "curriculum.read", "content.manage", "assessments.manage",
    "planner.manage_students", "reports.class", "reports.tenant", "usage.read", "classes.manage",
    "announcements.manage", "fees.manage", "exams.manage", "library.manage",
  ],
  teacher: [
    "curriculum.read", "content.manage", "assessments.manage", "assessments.review",
    "planner.manage_students", "reports.class", "classes.manage", "announcements.manage",
  ],
  // Staff / HR: people administration and organisation reports, but no access to
  // individual students' academic records, content or classes.
  staff: ["curriculum.read", "members.manage", "reports.tenant", "usage.read", "announcements.manage", "fees.manage", "library.manage"],
  // Accountant: fee collection only. Librarian: the library only.
  accountant: ["curriculum.read", "fees.manage"],
  librarian: ["curriculum.read", "library.manage"],
  content_reviewer: ["curriculum.read", "content.review"],
  parent: ["curriculum.read", "reports.children", "tenant.billing"],
  student: ["curriculum.read", "tutor.use", "assessments.take", "planner.self", "reports.self", "classes.attend"],
};

export const ROLE_NAMES: Record<string, string> = {
  tenant_owner: "Tenant owner",
  tenant_admin: "Tenant admin",
  teacher: "Teacher",
  staff: "Staff / HR",
  content_reviewer: "Content reviewer",
  accountant: "Accountant",
  librarian: "Librarian",
  parent: "Parent / guardian",
  student: "Student",
};
