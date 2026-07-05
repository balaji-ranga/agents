import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', region: '', mobile: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register(form);
      navigate('/job-profiles');
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  const field = (label, key, type = 'text', required = false) => (
    <label>
      <span style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>{label}</span>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        required={required}
        style={{ width: '100%', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
      />
    </label>
  );

  return (
    <div style={{ maxWidth: 480, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Register CEO account</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
        Creates your private SQLite store and grants standard workspace agents (BalServe, TechResearcher, Job Discovery, etc.).
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {field('Full name', 'name', 'text', true)}
        {field('Email', 'email', 'email', true)}
        {field('Password', 'password', 'password', true)}
        {field('Region', 'region')}
        {field('Mobile', 'mobile', 'tel')}
        {error && <div style={{ color: '#f87171' }}>{error}</div>}
        <button type="submit" disabled={submitting} style={{ padding: '0.65rem', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none' }}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p style={{ marginTop: '1rem', fontSize: '0.9rem' }}>
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
