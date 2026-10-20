import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { NoAccess, Spinner } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { AcademicSetupPage, AcademicsPage, MySyllabusPage, SubjectPlanPage } from "./pages/AcademicsPage";
import { AdmissionsPage, PublicApplyPage } from "./pages/AdmissionsPage";
import { AnnouncementsPage } from "./pages/AnnouncementsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { CertificatePage, IdCardsPage, MyIdCardPage } from "./pages/IdCardsPage";
import { LeavePage } from "./pages/LeavePage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { MessagesPage } from "./pages/MessagesPage";
import { MyPayslipsPage, PayslipPage, StaffPage } from "./pages/StaffPage";
import { AssignmentDetailPage, AssignmentsPage } from "./pages/AssignmentsPage";
import { AttendancePage } from "./pages/AttendancePage";
import { AuthPage } from "./pages/AuthPage";
import { BillingPage } from "./pages/BillingPage";
import { ChildReportPage } from "./pages/ChildReportPage";
import { ClassesPage } from "./pages/ClassesPage";
import { ClassroomPage } from "./pages/ClassroomPage";
import { ContentPage } from "./pages/ContentPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ExamDetailPage, ExamsPage } from "./pages/ExamsPage";
import { FeesPage, ReceiptPage } from "./pages/FeesPage";
import { HostelPage } from "./pages/HostelPage";
import { LibraryPage } from "./pages/LibraryPage";
import { RewardsPage } from "./pages/RewardsPage";
import { TransportPage } from "./pages/TransportPage";
import { GradebookPage } from "./pages/GradebookPage";
import { JoinPage } from "./pages/JoinPage";
import { LearnPage } from "./pages/LearnPage";
import { LessonPage } from "./pages/LessonPage";
import { ParentPage } from "./pages/ParentPage";
import { PeoplePage } from "./pages/PeoplePage";
import { PlanPage } from "./pages/PlanPage";
import { PlatformAdminPage } from "./pages/PlatformAdminPage";
import { QuizPage } from "./pages/QuizPage";
import { ReportCardPage } from "./pages/ReportCardPage";
import { ResultsPage } from "./pages/ResultsPage";
import { StudentHome } from "./pages/StudentHome";
import { TimetablePage } from "./pages/TimetablePage";
import { TutorPage } from "./pages/TutorPage";
import "./index.css";

/** Render the page only when the caller's role has one of the permissions; the API enforces the same rule. */
function Guard({ any, what, children }: { any: string[]; what: string; children: ReactNode }) {
  const { can } = useAuth();
  return any.some(can) ? <>{children}</> : <NoAccess what={what} />;
}

const CLASSROOM = ["classes.manage", "classes.attend"];
const CLASSROOM_OR_PARENT = [...CLASSROOM, "reports.children"];
const EXAMS = [...CLASSROOM_OR_PARENT, "exams.manage"];
const FEES = ["fees.manage", "classes.attend", "reports.children"];

function App() {
  const { user, loading, info } = useAuth();
  const { pathname } = useLocation();
  // The public admission form works without signing in.
  if (pathname.startsWith("/apply/"))
    return (
      <Routes>
        <Route path="/apply/:slug" element={<PublicApplyPage />} />
      </Routes>
    );
  if (loading) return <Spinner />;
  if (!user) return <AuthPage />;
  const home = user.is_platform_admin && !info ? <Navigate to="/platform" replace /> : <DashboardPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={home} />
        <Route path="today" element={<Guard any={["planner.self"]} what="the study day"><StudentHome /></Guard>} />
        <Route path="learn" element={<LearnPage />} />
        <Route path="learn/lessons/:id" element={<LessonPage />} />
        <Route path="tutor" element={<Guard any={["tutor.use"]} what="the AI teacher"><TutorPage /></Guard>} />
        <Route path="classes" element={<Guard any={CLASSROOM} what="live classes"><ClassesPage /></Guard>} />
        <Route path="live/:id" element={<Guard any={CLASSROOM} what="this live class"><ClassroomPage /></Guard>} />
        <Route path="timetable" element={<Guard any={CLASSROOM} what="the timetable"><TimetablePage /></Guard>} />
        <Route path="assignments" element={<Guard any={CLASSROOM_OR_PARENT} what="assignments"><AssignmentsPage /></Guard>} />
        <Route path="assignments/:id" element={<Guard any={CLASSROOM_OR_PARENT} what="this assignment"><AssignmentDetailPage /></Guard>} />
        <Route path="attendance" element={<Guard any={CLASSROOM_OR_PARENT} what="attendance"><AttendancePage /></Guard>} />
        <Route path="gradebook" element={<Guard any={["classes.manage"]} what="the gradebook"><GradebookPage /></Guard>} />
        <Route path="report-card" element={<Guard any={[...CLASSROOM_OR_PARENT, "reports.class"]} what="report cards"><ReportCardPage /></Guard>} />
        <Route path="announcements" element={<AnnouncementsPage />} />
        <Route path="exams" element={<Guard any={EXAMS} what="exams"><ExamsPage /></Guard>} />
        <Route path="exams/:id" element={<Guard any={EXAMS} what="this exam"><ExamDetailPage /></Guard>} />
        <Route path="fees" element={<Guard any={FEES} what="fees"><FeesPage /></Guard>} />
        <Route path="fees/receipts/:id" element={<Guard any={FEES} what="this receipt"><ReceiptPage /></Guard>} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="transport" element={<Guard any={["transport.manage", "classes.attend", "reports.children"]} what="transport"><TransportPage /></Guard>} />
        <Route path="hostel" element={<Guard any={["hostel.manage", "classes.attend", "reports.children"]} what="the hostel"><HostelPage /></Guard>} />
        <Route path="syllabus" element={<Guard any={[...CLASSROOM_OR_PARENT]} what="the syllabus"><MySyllabusPage /></Guard>} />
        <Route path="academics" element={<Guard any={["academics.manage", "reports.tenant"]} what="the syllabus tracker"><AcademicsPage /></Guard>} />
        <Route path="academics/setup" element={<Guard any={["academics.manage"]} what="academic setup"><AcademicSetupPage /></Guard>} />
        <Route path="academics/plan/:id" element={<SubjectPlanPage />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="messages/:id" element={<MessagesPage />} />
        <Route path="meetings" element={<Guard any={["classes.manage", "reports.children"]} what="meetings"><MeetingsPage /></Guard>} />
        <Route path="leave" element={<LeavePage />} />
        <Route path="calendar" element={<CalendarPage />} />
        <Route path="admissions" element={<Guard any={["admissions.manage"]} what="admissions"><AdmissionsPage /></Guard>} />
        <Route path="id-cards" element={<Guard any={["admissions.manage", "members.manage"]} what="ID cards"><IdCardsPage /></Guard>} />
        <Route path="id-cards/me" element={<MyIdCardPage />} />
        <Route path="certificates/:studentId" element={<Guard any={["admissions.manage"]} what="certificates"><CertificatePage /></Guard>} />
        <Route path="staff" element={<Guard any={["payroll.manage"]} what="staff & payroll"><StaffPage /></Guard>} />
        <Route path="payslips" element={<MyPayslipsPage />} />
        <Route path="payslips/:id" element={<PayslipPage />} />
        <Route path="rewards" element={<Guard any={["classes.attend", "reports.children"]} what="rewards"><RewardsPage /></Guard>} />
        <Route path="plan" element={<Guard any={["planner.self"]} what="the study plan"><PlanPage /></Guard>} />
        <Route path="results" element={<Guard any={["reports.self"]} what="results"><ResultsPage /></Guard>} />
        <Route path="results/quiz/:id" element={<Guard any={["assessments.take"]} what="this quiz"><QuizPage /></Guard>} />
        <Route path="children" element={<Guard any={["reports.children"]} what="children"><ParentPage /></Guard>} />
        <Route path="children/:studentId" element={<Guard any={["reports.children"]} what="this report"><ChildReportPage /></Guard>} />
        <Route path="content" element={<Guard any={["content.manage", "content.review"]} what="content"><ContentPage /></Guard>} />
        <Route path="billing" element={<Guard any={["tenant.billing"]} what="billing"><BillingPage /></Guard>} />
        <Route path="people" element={<Guard any={["members.manage"]} what="people"><PeoplePage /></Guard>} />
        <Route path="join" element={<JoinPage />} />
        <Route path="platform" element={<PlatformAdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
