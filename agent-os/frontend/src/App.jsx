import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Workspace from './pages/Workspace';
import AgentWorkspace from './pages/AgentWorkspace';
import AgentChat from './pages/AgentChat';

function App() {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav style={{
        width: 200,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        padding: '1rem 0',
      }}>
        <div style={{ padding: '0 1rem', marginBottom: '1rem', fontWeight: 600, fontSize: '1.1rem' }}>
          Agent OS
        </div>
        <NavLink
          to="/"
          end
          style={({ isActive }) => ({
            display: 'block',
            padding: '0.5rem 1rem',
            color: isActive ? 'var(--accent)' : 'var(--muted)',
          })}
        >
          Dashboard
        </NavLink>
        <NavLink
          to="/workspace"
          style={({ isActive }) => ({
            display: 'block',
            padding: '0.5rem 1rem',
            color: isActive ? 'var(--accent)' : 'var(--muted)',
          })}
        >
          Workspace (MD)
        </NavLink>
      </nav>
      <main style={{ flex: 1, overflow: 'auto' }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/workspace" element={<Workspace />} />
          <Route path="/agents/:agentId/workspace" element={<AgentWorkspace />} />
          <Route path="/agents/:agentId/chat" element={<AgentChat />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
