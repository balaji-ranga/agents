import { useCallback, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import McpRegistryView from '../components/mcp/McpRegistryView';
import McpTestView from '../components/mcp/McpTestView';

export default function McpIntegrations() {
  const { user } = useAuth();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .mcpServersList()
      .then((r) => setServers(r.servers || []))
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Routes>
      <Route
        index
        element={
          <McpRegistryView servers={servers} loading={loading} user={user} onRefresh={load} />
        }
      />
      <Route path="test/:serverId" element={<McpTestView />} />
    </Routes>
  );
}
