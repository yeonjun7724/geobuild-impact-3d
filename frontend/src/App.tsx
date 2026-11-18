import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ProjectsPage from "./pages/ProjectsPage";
import WorkspacePage from "./pages/WorkspacePage";
import AnalysisPage from "./pages/AnalysisPage";
import ComparePage from "./pages/ComparePage";
import ReportPage from "./pages/ReportPage";
import DataPage from "./pages/DataPage";
import CapturePage from "./pages/CapturePage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<WorkspacePage />} />
        <Route path="/projects/:id/analysis" element={<AnalysisPage />} />
        <Route path="/projects/:id/compare/:runId" element={<ComparePage />} />
        <Route path="/projects/:id/data" element={<DataPage />} />
        <Route path="/datasets" element={<Navigate to="/projects" replace />} />
        <Route path="/reports/:runId" element={<ReportPage />} />
        <Route path="/capture/:runId" element={<CapturePage />} />
        <Route path="*" element={<div className="p-10">페이지 없음</div>} />
      </Routes>
    </BrowserRouter>
  );
}
