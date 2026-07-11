import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import CustomScriptRegistryView from '../components/custom-scripts/CustomScriptRegistryView';

export default function CustomScripts() {
  const { user } = useAuth();
  const [scripts, setScripts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api
      .customScriptsList()
      .then((r) => setScripts(r.scripts || []))
      .catch(() => setScripts([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return <CustomScriptRegistryView scripts={scripts} loading={loading} user={user} onRefresh={load} />;
}
