import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth, RequireAuth } from '../context/AuthContext';

function AdminPanel() {
  const { logout } = useAuth();
  const [users, setUsers] = useState([]);
  const [agents, setAgents] = useState({ standard: [], custom: [] });
  const [selected, setSelected] = useState(null);
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', password: '', region: '', mobile: '' });

  const load = () => {
    api.adminUsers().then((r) => setUsers(r.users || [])).catch((e) => setError(e.message));
    api.adminAgentsGrouped().then(setAgents).catch(() => {});
  };

  useEffect(() => {
    load();
  }, []);

  const loadUser = (userId) => {
    api.adminUserGet(userId).then((r) => {
      setSelected(r.user);
      setSelectedAgents(r.agents || []);
    });
  };

  const toggleUser = async (userId, enabled) => {
    await api.adminUserSetEnabled(userId, enabled);
    load();
    if (selected?.id === userId) loadUser(userId);
  };

  const registerUser = async (e) => {
    e.preventDefault();
    await api.adminRegisterUser(form);
    setForm({ name: '', email: '', password: '', region: '', mobile: '' });
    load();
  };

  const toggleAgent = async (agentId, enabled) => {
    if (!selected) return;
    if (enabled) await api.adminEnableAgent(selected.id, agentId);
    else await api.adminDisableAgent(selected.id, agentId);
    loadUser(selected.id);
  };

  return (
    <div style={{ padding: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Admin</h1>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <Link to="/">Dashboard</Link>
          <button type="button" onClick={logout} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: '0.35rem 0.65rem', cursor: 'pointer' }}>
            Logout
          </button>
        </div>
      </div>
      {error && <div style={{ color: '#f87171', marginBottom: '1rem' }}>{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        <section>
          <h2>Users</h2>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {users.map((u) => (
              <div
                key={u.id}
                onClick={() => loadUser(u.id)}
                style={{
                  padding: '0.65rem 0.85rem',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: selected?.id === u.id ? 'rgba(124,58,237,0.12)' : 'transparent',
                }}
              >
                <div style={{ fontWeight: 600 }}>{u.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({u.role})</span></div>
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{u.email}</div>
                <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                  <span style={{ fontSize: '0.8rem', color: u.enabled ? '#22c55e' : '#f87171' }}>{u.enabled ? 'Enabled' : 'Disabled'}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleUser(u.id, !u.enabled);
                    }}
                    style={{ fontSize: '0.75rem', padding: '0.15rem 0.4rem', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    {u.enabled ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: '1.5rem' }}>Register CEO user</h3>
          <form onSubmit={registerUser} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={{ padding: '0.45rem', borderRadius: 6, border: '1px solid var(--border)' }} />
            <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required style={{ padding: '0.45rem', borderRadius: 6, border: '1px solid var(--border)' }} />
            <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required style={{ padding: '0.45rem', borderRadius: 6, border: '1px solid var(--border)' }} />
            <input placeholder="Region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} style={{ padding: '0.45rem', borderRadius: 6, border: '1px solid var(--border)' }} />
            <input placeholder="Mobile" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} style={{ padding: '0.45rem', borderRadius: 6, border: '1px solid var(--border)' }} />
            <button type="submit" style={{ padding: '0.5rem', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none' }}>Register user</button>
          </form>
        </section>

        <section>
          <h2>User agents {selected ? `— ${selected.name}` : ''}</h2>
          {!selected && <p style={{ color: 'var(--muted)' }}>Select a user to manage agent access.</p>}
          {selected && (
            <>
              <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Standard agents ship with every CEO. Toggle access per user.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {selectedAgents.map((a) => (
                  <div key={a.agent_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', border: '1px solid var(--border)', borderRadius: 6 }}>
                    <div>
                      <strong>{a.name}</strong>
                      <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--muted)' }}>{a.agent_type || 'standard'}</span>
                    </div>
                    <button type="button" onClick={() => toggleAgent(a.agent_id, !a.enabled)} style={{ padding: '0.25rem 0.5rem', borderRadius: 4, border: '1px solid var(--border)', cursor: 'pointer' }}>
                      {a.enabled ? 'Revoke' : 'Grant'}
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => api.adminGrantStandardAgents(selected.id).then(() => loadUser(selected.id))} style={{ marginTop: 12, padding: '0.4rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}>
                Re-grant all standard agents
              </button>
            </>
          )}

          <h3 style={{ marginTop: '1.5rem' }}>Agent catalog</h3>
          <div style={{ fontSize: '0.85rem' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Standard ({agents.standard?.length || 0})</div>
            {(agents.standard || []).map((a) => (
              <div key={a.id} style={{ color: 'var(--muted)' }}>{a.name} ({a.id})</div>
            ))}
            <div style={{ fontWeight: 600, margin: '8px 0 4px' }}>Custom ({agents.custom?.length || 0})</div>
            {(agents.custom || []).map((a) => (
              <div key={a.id} style={{ color: 'var(--muted)' }}>{a.name} ({a.id})</div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function Admin() {
  return (
    <RequireAuth role="admin">
      <AdminPanel />
    </RequireAuth>
  );
}
