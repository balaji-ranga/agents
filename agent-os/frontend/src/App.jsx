import { useState, useEffect } from 'react';
import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Workspace from './pages/Workspace';
import AgentWorkspace from './pages/AgentWorkspace';
import AgentChat from './pages/AgentChat';
import ContentToolsLogs from './pages/ContentToolsLogs';
import Broadcast from './pages/Broadcast';
import Kanban from './pages/Kanban';
import JobWorkflows from './pages/JobWorkflows';
import AgentWorkflows from './pages/AgentWorkflows';
import AgentWorkflowEditor from './pages/AgentWorkflowEditor';
import JobProfiles from './pages/JobProfiles';
import UserProfile from './pages/UserProfile';
import Login from './pages/Login';
import Register from './pages/Register';
import Admin from './pages/Admin';
import McpIntegrations from './pages/McpIntegrations';
import CustomScripts from './pages/CustomScripts';
import ExternalAgents from './pages/ExternalAgents';
import NotificationBell from './components/NotificationBell';
import { AdminNavMenu, CeoNavMenu } from './components/AppNavMenu';
import ImpersonationBanner from './components/ImpersonationBanner';
import { useAuth } from './context/AuthContext';

function Shell() {
  const { user, logout, loading } = useAuth();
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('agent-os-nav-collapsed') === '1');

  useEffect(() => {
    localStorage.setItem('agent-os-nav-collapsed', navCollapsed ? '1' : '0');
  }, [navCollapsed]);

  if (loading) {
    return <div style={{ padding: '2rem' }}>Loading…</div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className={`app-shell ${navCollapsed ? 'nav-collapsed' : ''}`}>
      <nav className={`app-nav ${navCollapsed ? 'collapsed' : ''}`}>
        <div className="app-nav-header">
          {!navCollapsed && (
            <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>Agent OS</div>
          )}
          <button
            type="button"
            className="nav-toggle"
            onClick={() => setNavCollapsed((c) => !c)}
            title={navCollapsed ? 'Expand menu' : 'Collapse menu'}
            aria-label={navCollapsed ? 'Expand menu' : 'Collapse menu'}
          >
            {navCollapsed ? '»' : '«'}
          </button>
        </div>
        {!navCollapsed && (
          <>
        <div style={{ padding: '0 1rem', marginBottom: '0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
          {user.name} ({user.role})
        </div>
        <div style={{ padding: '0 1rem', marginBottom: '1rem' }}>
          <NavLink to="/profile" style={({ isActive }) => ({ fontSize: '0.8rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
            Edit profile
          </NavLink>
        </div>
        <div style={{ padding: '0 1rem', marginBottom: '1rem' }}>
          <NotificationBell />
        </div>
          </>
        )}
        {navCollapsed && (
          <div style={{ padding: '0.35rem', marginBottom: '0.5rem', textAlign: 'center' }}>
            <NotificationBell />
          </div>
        )}
        {user.role === 'admin' && <AdminNavMenu collapsed={navCollapsed} />}
        {user.role === 'ceo' && <CeoNavMenu collapsed={navCollapsed} />}
        <button
          type="button"
          onClick={logout}
          className="nav-logout"
          title="Logout"
        >
          {navCollapsed ? '⎋' : 'Logout'}
        </button>
      </nav>
      <main className="app-main">
        <ImpersonationBanner />
        <Routes>
          {user.role === 'admin' && (
            <>
              <Route path="/admin" element={<Admin />} />
              <Route path="/integrations/mcp/*" element={<McpIntegrations />} />
              <Route path="/integrations/custom-scripts" element={<CustomScripts />} />
              <Route path="/integrations/external-agents" element={<ExternalAgents />} />
              <Route path="/profile" element={<UserProfile />} />
              <Route path="*" element={<Navigate to="/admin" replace />} />
            </>
          )}
          {user.role === 'ceo' && (
            <>
              <Route path="/" element={<Dashboard />} />
              <Route path="/profile" element={<UserProfile />} />
              <Route path="/job-profiles" element={<JobProfiles />} />
              <Route path="/workspace" element={<Workspace />} />
              <Route path="/content-tools" element={<ContentToolsLogs />} />
              <Route path="/integrations/mcp/*" element={<McpIntegrations />} />
              <Route path="/integrations/custom-scripts" element={<CustomScripts />} />
              <Route path="/integrations/external-agents" element={<ExternalAgents />} />
              <Route path="/broadcast" element={<Broadcast />} />
              <Route path="/kanban" element={<Kanban />} />
              <Route path="/job-workflows" element={<JobWorkflows />} />
              <Route path="/workflows" element={<AgentWorkflows />} />
              <Route path="/workflows/:workflowId/edit" element={<AgentWorkflowEditor />} />
              <Route path="/agents/:agentId/workspace" element={<AgentWorkspace />} />
              <Route path="/agents/:agentId/chat" element={<AgentChat />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/*" element={<Shell />} />
    </Routes>
  );
}
