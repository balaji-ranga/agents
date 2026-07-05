import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [adminMode, setAdminMode] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await login(email, password, adminMode);
      navigate(user.role === 'admin' ? '/admin' : '/');
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '3rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '0.25rem' }}>{adminMode ? 'Admin login' : 'CEO login'}</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.5rem' }}>
        {adminMode ? 'Platform administration' : 'Sign in to your Agent OS workspace'}
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <label>
          <span style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }} />
        </label>
        <label>
          <span style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }} />
        </label>
        {error && <div style={{ color: '#f87171', fontSize: '0.9rem' }}>{error}</div>}
        <button type="submit" disabled={submitting} style={{ padding: '0.65rem', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
        <button type="button" onClick={() => setAdminMode(!adminMode)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>
          {adminMode ? '← CEO login' : 'Admin login →'}
        </button>
      </div>
      {!adminMode && (
        <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
          New CEO? <Link to="/register">Register</Link>
        </p>
      )}
    </div>
  );
}
