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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  tenant_owner: [...PERMISSIONS].filter((p) => !["assessments.take", "planner.self", "reports.self", "reports.children"].includes(p)),
  tenant_admin: [
    "members.manage", "curriculum.read", "content.manage", "assessments.manage",
    "planner.manage_students", "reports.class", "reports.tenant", "usage.read",
  ],
  teacher: [
    "curriculum.read", "content.manage", "assessments.manage", "assessments.review",
    "planner.manage_students", "reports.class",
  ],
  content_reviewer: ["curriculum.read", "content.review"],
  parent: ["curriculum.read", "reports.children", "tenant.billing"],
  student: ["curriculum.read", "tutor.use", "assessments.take", "planner.self", "reports.self"],
};

export const ROLE_NAMES: Record<string, string> = {
  tenant_owner: "Tenant owner",
  tenant_admin: "Tenant admin",
  teacher: "Teacher",
  content_reviewer: "Content reviewer",
  parent: "Parent / guardian",
  student: "Student",
};
