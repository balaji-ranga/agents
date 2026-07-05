import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setAuthToken } from '../api';

const AuthContext = createContext(null);

const TOKEN_KEY = 'agent-os-auth-token';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [agents, setAgents] = useState([]);
  const [dataCeoUserId, setDataCeoUserId] = useState(null);
  const [usesPlatformDb, setUsesPlatformDb] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      setUser(null);
      setAgents([]);
      setDataCeoUserId(null);
      setUsesPlatformDb(false);
      setLoading(false);
      return;
    }
    setAuthToken(token);
    try {
      const data = await api.authMe();
      setUser(data.user);
      setAgents(data.agents || []);
      setDataCeoUserId(data.data_ceo_user_id || null);
      setUsesPlatformDb(!!data.uses_platform_db);
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      setAuthToken(null);
      setUser(null);
      setAgents([]);
      setDataCeoUserId(null);
      setUsesPlatformDb(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = async (email, password, admin = false) => {
    const data = admin ? await api.authAdminLogin({ email, password }) : await api.authLogin({ email, password });
    localStorage.setItem(TOKEN_KEY, data.session.token);
    setAuthToken(data.session.token);
    setUser(data.user);
    if (data.user.role === 'ceo') {
      const me = await api.authMe();
      setAgents(me.agents || []);
      setDataCeoUserId(me.data_ceo_user_id || null);
      setUsesPlatformDb(!!me.uses_platform_db);
    }
    return data.user;
  };

  const register = async (body) => {
    const data = await api.authRegister(body);
    localStorage.setItem(TOKEN_KEY, data.session.token);
    setAuthToken(data.session.token);
    setUser(data.user);
    setAgents([]);
    const me = await api.authMe();
    setAgents(me.agents || []);
    setDataCeoUserId(me.data_ceo_user_id || null);
    setUsesPlatformDb(!!me.uses_platform_db);
    return data.user;
  };

  const logout = async () => {
    try {
      await api.authLogout();
    } catch (_) {}
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
    setAgents([]);
    setDataCeoUserId(null);
    setUsesPlatformDb(false);
  };

  return (
    <AuthContext.Provider value={{ user, agents, dataCeoUserId, usesPlatformDb, loading, login, register, logout, reload: loadMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function RequireAuth({ children, role }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (!user) {
    window.location.href = '/login';
    return null;
  }
  if (role && user.role !== role) {
    return <div style={{ padding: '2rem', color: '#f87171' }}>Access denied — {role} role required.</div>;
  }
  return children;
}
