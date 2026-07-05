import { Routes, Route, NavLink, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Workspace from './pages/Workspace';
import AgentWorkspace from './pages/AgentWorkspace';
import AgentChat from './pages/AgentChat';
import ContentToolsLogs from './pages/ContentToolsLogs';
import Broadcast from './pages/Broadcast';
import Kanban from './pages/Kanban';
import JobWorkflows from './pages/JobWorkflows';
import JobProfiles from './pages/JobProfiles';
import UserProfile from './pages/UserProfile';
import Login from './pages/Login';
import Register from './pages/Register';
import Admin from './pages/Admin';
import NotificationBell from './components/NotificationBell';
import { useAuth } from './context/AuthContext';

function Shell() {
  const { user, logout, loading } = useAuth();

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
    <div className="app-shell">
      <nav className="app-nav" style={{
        width: 200,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        padding: '1rem 0',
      }}>
        <div style={{ padding: '0 1rem', marginBottom: '0.75rem', fontWeight: 600, fontSize: '1.1rem' }}>
          Agent OS
        </div>
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
        {user.role === 'admin' && (
          <NavLink to="/admin" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
            Admin
          </NavLink>
        )}
        {user.role === 'ceo' && (
          <>
            <NavLink to="/" end style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Dashboard
            </NavLink>
            <NavLink to="/job-profiles" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Job profiles
            </NavLink>
            <NavLink to="/job-workflows" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Job workflows
            </NavLink>
            <NavLink to="/kanban" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Kanban
            </NavLink>
            <NavLink to="/workspace" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Workspace (MD)
            </NavLink>
            <NavLink to="/content-tools" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Content tools
            </NavLink>
            <NavLink to="/broadcast" style={({ isActive }) => ({ display: 'block', padding: '0.5rem 1rem', color: isActive ? 'var(--accent)' : 'var(--muted)' })}>
              Broadcast
            </NavLink>
          </>
        )}
        <button
          type="button"
          onClick={logout}
          style={{ display: 'block', margin: '1rem 1rem 0', padding: '0.35rem 0.65rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          Logout
        </button>
      </nav>
      <main className="app-main">
        <Routes>
          {user.role === 'admin' && (
            <>
              <Route path="/admin" element={<Admin />} />
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
              <Route path="/broadcast" element={<Broadcast />} />
              <Route path="/kanban" element={<Kanban />} />
              <Route path="/job-workflows" element={<JobWorkflows />} />
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
