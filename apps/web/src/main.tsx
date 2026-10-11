import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { AuthPage } from "./pages/AuthPage";
import { BillingPage } from "./pages/BillingPage";
import { ChildReportPage } from "./pages/ChildReportPage";
import { ClassesPage } from "./pages/ClassesPage";
import { ClassroomPage } from "./pages/ClassroomPage";
import { ContentPage } from "./pages/ContentPage";
import { LearnPage } from "./pages/LearnPage";
import { LessonPage } from "./pages/LessonPage";
import { ParentPage } from "./pages/ParentPage";
import { PlanPage } from "./pages/PlanPage";
import { QuizPage } from "./pages/QuizPage";
import { ResultsPage } from "./pages/ResultsPage";
import { StudentHome } from "./pages/StudentHome";
import { TutorPage } from "./pages/TutorPage";
import "./index.css";

function App() {
  const { user, loading, can } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <AuthPage />;
  const home = can("planner.self") ? <StudentHome /> : can("reports.children") ? <Navigate to="/children" replace /> : can("classes.manage") ? <Navigate to="/classes" replace /> : <Navigate to="/learn" replace />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={home} />
        <Route path="learn" element={<LearnPage />} />
        <Route path="learn/lessons/:id" element={<LessonPage />} />
        <Route path="tutor" element={<TutorPage />} />
        <Route path="classes" element={<ClassesPage />} />
        <Route path="live/:id" element={<ClassroomPage />} />
        <Route path="plan" element={<PlanPage />} />
        <Route path="results" element={<ResultsPage />} />
        <Route path="results/quiz/:id" element={<QuizPage />} />
        <Route path="children" element={<ParentPage />} />
        <Route path="children/:studentId" element={<ChildReportPage />} />
        <Route path="content" element={<ContentPage />} />
        <Route path="billing" element={<BillingPage />} />
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
