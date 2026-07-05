import { useEffect, useState } from 'react';

import { Link } from 'react-router-dom';

import { api } from '../api';

import { useAuth, RequireAuth } from '../context/AuthContext';

import AgentChatPanel from '../components/AgentChatPanel';



const WORK_MODES = ['remote', 'hybrid', 'onsite', 'any'];

const WORKFLOW_GOALS = [

  { value: 'job_application', label: 'Job application' },

  { value: 'discovery_only', label: 'Discovery only' },

  { value: 'research', label: 'Research' },

];



const DEFAULT_LINKEDIN_SEARCH_PATTERN =
  'https://www.linkedin.com/jobs/search/?keywords={q}&location={loc}';

const DEFAULT_JOBSTREET_SEARCH_PATTERN =
  'https://sg.jobstreet.com/{title_slug}-jobs/in-{location_slug}';

const SEARCH_PATTERN_HELP = '{q}, {loc}, {title}, {location}, {title_slug}, {location_slug}';



function slugifyTitleForPath(title) {
  return String(title || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '');
}



function slugifyLocationForPath(location) {
  return String(location || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '');
}



function applySearchUrlPattern(template, title, location) {
  const t = String(title || '').trim();
  const loc = String(location || '').trim();
  return String(template || '')
    .replace(/\{q\}/g, encodeURIComponent(t))
    .replace(/\{loc\}/g, encodeURIComponent(loc))
    .replace(/\{title\}/g, t)
    .replace(/\{location\}/g, loc)
    .replace(/\{title_slug\}/g, slugifyTitleForPath(t))
    .replace(/\{location_slug\}/g, slugifyLocationForPath(loc));
}



function patternsFromIntake(intake = {}) {
  const p = intake.portal_search_patterns || {};
  return {
    linkedin_search_url_pattern: p['linkedin.com'] || DEFAULT_LINKEDIN_SEARCH_PATTERN,
    jobstreet_search_url_pattern: p['jobstreet.com.sg'] || DEFAULT_JOBSTREET_SEARCH_PATTERN,
  };
}



function buildPortalSearchPatch(form) {
  const patterns = {};
  const li = String(form.linkedin_search_url_pattern || '').trim();
  const js = String(form.jobstreet_search_url_pattern || '').trim();
  if (li) patterns['linkedin.com'] = li;
  if (js) patterns['jobstreet.com.sg'] = js;
  return { portal_search_patterns: patterns };
}



function previewDiscoveryUrls(form) {
  const titles = csvToArr(form.target_titles);
  const locations = csvToArr(form.locations);
  const title = titles[0] || 'SVP Head of Tech';
  const location = locations[0] || 'Singapore';
  const sources = csvToArr(form.sources).join(' ').toLowerCase();
  const out = [];
  if (!sources || sources.includes('linkedin')) {
    out.push({
      source: 'linkedin',
      url: applySearchUrlPattern(form.linkedin_search_url_pattern || DEFAULT_LINKEDIN_SEARCH_PATTERN, title, location),
    });
  }
  if (!sources || sources.includes('jobstreet')) {
    out.push({
      source: 'jobstreet',
      url: applySearchUrlPattern(form.jobstreet_search_url_pattern || DEFAULT_JOBSTREET_SEARCH_PATTERN, title, location),
    });
  }
  return out;
}



function arrToCsv(v) {

  if (Array.isArray(v)) return v.join(', ');

  return v || '';

}



function csvToArr(s) {

  return String(s || '')

    .split(',')

    .map((x) => x.trim())

    .filter(Boolean);

}



function ProfileForm({ initial, onSave, onCancel, busy, title, isEdit = false }) {

  const [form, setForm] = useState(initial);

  useEffect(() => setForm(initial), [initial]);



  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));



  const submit = (e) => {

    e.preventDefault();

    onSave(form);

  };



  const field = (label, key, opts = {}) => (

    <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>

      <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{label}</span>

      {opts.type === 'select' ? (

        <select

          value={form[key]}

          onChange={(e) => set(key, e.target.value)}

          style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}

        >

          {(opts.options || []).map((o) => (

            <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>

          ))}

        </select>

      ) : (

        <input

          value={form[key]}

          onChange={(e) => set(key, e.target.value)}

          placeholder={opts.placeholder}

          style={{ padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}

        />

      )}

    </label>

  );



  return (

    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>

      <h3 style={{ margin: 0 }}>{title}</h3>

      {field('Display name', 'display_name')}

      {isEdit
        ? field('Profile ID (slug)', 'new_profile_id', { placeholder: 'change slug to rename' })
        : field('Profile ID (slug)', 'profile_id', { placeholder: 'auto from name if empty' })}

      {field('Target titles (comma-separated)', 'target_titles')}

      {field('Locations (comma-separated)', 'locations')}

      {field('Work mode', 'work_mode', { type: 'select', options: WORK_MODES.map((m) => ({ value: m, label: m })) })}

      {field('Sources (comma-separated)', 'sources', { placeholder: 'linkedin, jobstreet' })}

      {field('LinkedIn search URL pattern', 'linkedin_search_url_pattern', {
        placeholder: DEFAULT_LINKEDIN_SEARCH_PATTERN,
      })}

      {field('JobStreet search URL pattern', 'jobstreet_search_url_pattern', {
        placeholder: DEFAULT_JOBSTREET_SEARCH_PATTERN,
      })}

      <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--muted)' }}>
        Placeholders: {SEARCH_PATTERN_HELP}. JobStreet example: https://sg.jobstreet.com/SVP-head-of-tech-jobs/in-Singapore
      </p>

      {previewDiscoveryUrls(form).length > 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--muted)', padding: '0.5rem', borderRadius: 6, border: '1px dashed var(--border)' }}>
          <strong style={{ color: 'var(--text)' }}>Preview (first title + location)</strong>
          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            {previewDiscoveryUrls(form).map((u) => (
              <li key={u.source} style={{ wordBreak: 'break-all' }}>
                [{u.source}] {u.url}
              </li>
            ))}
          </ul>
        </div>
      )}

      {field('Master resume path', 'master_resume_path')}

      {field('LinkedIn profile URL', 'linkedin_profile')}

      {field('Fit threshold (0–100)', 'fit_threshold')}

      {field('Workflow goal', 'workflow_goal', { type: 'select', options: WORKFLOW_GOALS })}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>

        <button type="submit" disabled={busy} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff' }}>

          {busy ? 'Saving…' : 'Save'}

        </button>

        <button type="button" onClick={onCancel} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>

          Cancel

        </button>

      </div>

    </form>

  );

}



function JobProfilesPanel() {

  const { user, usesPlatformDb } = useAuth();

  const [data, setData] = useState(null);

  const [detail, setDetail] = useState(null);

  const [selectedId, setSelectedId] = useState(null);

  const [tab, setTab] = useState('overview');

  const [portalData, setPortalData] = useState(null);

  const [connectResult, setConnectResult] = useState(null);

  const [loginResult, setLoginResult] = useState(null);

  const [workflowResult, setWorkflowResult] = useState(null);

  const [pipelineStatus, setPipelineStatus] = useState(null);

  const [loading, setLoading] = useState(true);

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState(null);

  const [modal, setModal] = useState(null);



  const load = () => {

    setLoading(true);

    api

      .jobApplicantProfiles()

      .then((r) => {

        setData(r);

        if (!selectedId && r.profiles?.length) setSelectedId(r.profiles[0].id);

      })

      .catch((e) => setError(e.message))

      .finally(() => setLoading(false));

  };



  useEffect(() => {

    load();

  }, []);



  useEffect(() => {

    if (!selectedId) {

      setDetail(null);

      return;

    }

    api.jobApplicantProfileGet(selectedId).then(setDetail).catch(() => setDetail(null));

    api.jobApplicantPortalAuth(selectedId).then(setPortalData).catch(() => setPortalData(null));

    api.jobApplicantPipelineStatus().then(setPipelineStatus).catch(() => setPipelineStatus(null));

    setConnectResult(null);

    setWorkflowResult(null);

  }, [selectedId]);



  const connectPortals = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      const result = await api.jobApplicantConnectPortals(selectedId, { warmup: true });

      setConnectResult(result);

      setPortalData(await api.jobApplicantPortalAuth(selectedId));

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const markLoggedIn = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      const result = await api.jobApplicantBrowserCompleteLogin({ profile_id: selectedId, linkedin: true, jobstreet: true });

      if (!result.ok && !result.ready && !result.session_ready) {

        setError(result.error || 'Could not verify portal login — log in in Chromium, then Save & connect.');

        return;

      }

      setPortalData(await api.jobApplicantPortalAuth(selectedId));

      setConnectResult({ ...result, manual_steps: ['Portal session saved.', 'You can now Run full workflow on the Overview tab.'] });

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const startLoginBrowser = async (spawnTerminal = false) => {

    setBusy(true);

    setError(null);

    setLoginResult(null);

    try {

      const result = await api.jobApplicantBrowserStartLogin({ spawn_terminal: spawnTerminal });

      setLoginResult(result);

      setConnectResult(result);

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const spawnLoginScript = async () => {

    setBusy(true);

    setError(null);

    try {

      const result = await api.jobApplicantBrowserSpawnLoginScript();

      setLoginResult(result);

      if (!result.spawned && result.hint) setError(result.hint);

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const harvestListings = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      const result = await api.jobApplicantHarvestListings(selectedId, {});

      setWorkflowResult({

        harvest: result,

        message: `Harvested ${result.count ?? 0} URLs (${result.new_count ?? 0} new). Job Discovery uses this via job_portal_harvest_listings during workflow.`,

      });

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const runWorkflowNow = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    setWorkflowResult(null);

    try {

      const result = await api.jobApplicantWorkflowRun({ profile_id: selectedId });

      if (result?.login_required) {

        setError(`${result.error || 'Portal login required'}. Go to Connect portals tab → Open login browser → Save & connect.`);

        setTab('portals');

        return;

      }

      setWorkflowResult(result);

      setPipelineStatus(await api.jobApplicantPipelineStatus());

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const startPipeline = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      const result = await api.jobApplicantPipelineStart({ profile_id: selectedId });

      setWorkflowResult({ pipeline: result, message: 'Async pipeline started — watch Kanban for Job Discovery → Fit Scoring → Resume Tailoring cards.' });

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const createProfile = async (form) => {

    setBusy(true);

    setError(null);

    try {

      const patch = {

        target_titles: csvToArr(form.target_titles),

        locations: csvToArr(form.locations),

        work_mode: form.work_mode,

        sources: csvToArr(form.sources),

        master_resume_path: form.master_resume_path,

        linkedin_profile: form.linkedin_profile,

        fit_threshold: form.fit_threshold ? Number(form.fit_threshold) : undefined,

        workflow_goal: form.workflow_goal,

        ...buildPortalSearchPatch(form),

      };

      const profile = await api.jobApplicantProfileCreate({

        display_name: form.display_name,

        profile_id: form.profile_id || undefined,

        patch,

      });

      setModal(null);

      setSelectedId(profile.id);

      load();

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const updateProfile = async (form) => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      const patch = {

        display_name: form.display_name,

        target_titles: csvToArr(form.target_titles),

        locations: csvToArr(form.locations),

        work_mode: form.work_mode,

        sources: csvToArr(form.sources),

        master_resume_path: form.master_resume_path,

        linkedin_profile: form.linkedin_profile,

        fit_threshold: form.fit_threshold ? Number(form.fit_threshold) : undefined,

        workflow_goal: form.workflow_goal,

        ...buildPortalSearchPatch(form),

      };

      await api.jobApplicantProfileUpdate(selectedId, patch);

      if (form.new_profile_id && form.new_profile_id !== selectedId) {

        const renamed = await api.jobApplicantProfileRename(selectedId, {

          display_name: form.display_name,

          new_profile_id: form.new_profile_id,

        });

        setSelectedId(renamed.id);

      }

      setModal(null);

      load();

      setDetail(await api.jobApplicantProfileGet(form.new_profile_id || selectedId));

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const deleteProfile = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      await api.jobApplicantProfileDelete(selectedId, true);

      setModal(null);

      setSelectedId(null);

      setDetail(null);

      load();

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const confirmProfile = async () => {

    if (!selectedId) return;

    setBusy(true);

    setError(null);

    try {

      await api.jobApplicantProfileConfirm(selectedId, { confirm: true, honesty_ack: true });

      load();

      setDetail(await api.jobApplicantProfileGet(selectedId));

    } catch (e) {

      setError(e.message);

    } finally {

      setBusy(false);

    }

  };



  const selected = data?.profiles?.find((p) => p.id === selectedId);

  const intake = detail?.intake || {};



  const emptyForm = {

    display_name: '',

    profile_id: '',

    target_titles: '',

    locations: '',

    work_mode: 'hybrid',

    sources: 'linkedin, jobstreet',

    master_resume_path: '',

    linkedin_profile: '',

    fit_threshold: '70',

    workflow_goal: 'job_application',

    linkedin_search_url_pattern: DEFAULT_LINKEDIN_SEARCH_PATTERN,

    jobstreet_search_url_pattern: DEFAULT_JOBSTREET_SEARCH_PATTERN,

  };



  const editFormFromDetail = detail

    ? {

        display_name: detail.display_name || detail.id,

        new_profile_id: detail.id,

        target_titles: arrToCsv(intake.target_titles),

        locations: arrToCsv(intake.locations),

        work_mode: intake.work_mode || 'hybrid',

        sources: arrToCsv(intake.sources),

        master_resume_path: intake.master_resume_path || '',

        linkedin_profile: intake.linkedin_profile || '',

        fit_threshold: String(intake.fit_threshold ?? '70'),

        workflow_goal: intake.workflow_goal || 'job_application',

        ...patternsFromIntake(intake),

      }

    : emptyForm;



  const tabBtn = (id, label) => (

    <button

      type="button"

      onClick={() => setTab(id)}

      style={{

        padding: '0.4rem 0.75rem',

        borderRadius: 6,

        border: '1px solid var(--border)',

        background: tab === id ? 'rgba(124,58,237,0.15)' : 'transparent',

        color: tab === id ? 'var(--accent)' : 'var(--muted)',

        cursor: 'pointer',

        fontSize: '0.85rem',

      }}

    >

      {label}

    </button>

  );



  return (

    <div style={{ padding: '1.5rem', maxWidth: 1100, margin: '0 auto' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.75rem' }}>

        <div>

          <h1 style={{ margin: 0 }}>Job profiles</h1>

          <p style={{ margin: '0.25rem 0 0', color: 'var(--muted)', fontSize: '0.9rem' }}>

            CEO: {user?.name}

            {usesPlatformDb ? ' · platform DB (legacy data)' : ''}

          </p>

        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>

          <Link to="/job-workflows">Workflows →</Link>

          <Link to="/profile" style={{ fontSize: '0.9rem' }}>My account</Link>

        </div>

      </div>



      {error && <div style={{ color: '#f87171', marginBottom: '1rem' }}>{error}</div>}

      {loading && <p>Loading profiles…</p>}



      {!loading && (

        <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '1rem' }}>

          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>

            <button

              type="button"

              onClick={() => setModal('create')}

              style={{

                display: 'block',

                width: '100%',

                padding: '0.65rem 0.85rem',

                border: 'none',

                borderBottom: '1px solid var(--border)',

                background: 'rgba(124,58,237,0.08)',

                color: 'var(--accent)',

                fontWeight: 600,

                cursor: 'pointer',

                textAlign: 'left',

              }}

            >

              + New profile

            </button>

            {(data?.profiles || []).map((p) => (

              <button

                key={p.id}

                type="button"

                onClick={() => { setSelectedId(p.id); setTab('overview'); }}

                style={{

                  display: 'block',

                  width: '100%',

                  textAlign: 'left',

                  padding: '0.65rem 0.85rem',

                  border: 'none',

                  borderBottom: '1px solid var(--border)',

                  background: selectedId === p.id ? 'rgba(124,58,237,0.12)' : 'var(--surface)',

                  color: 'var(--text)',

                  cursor: 'pointer',

                }}

              >

                <div style={{ fontWeight: 600 }}>{p.display_name || p.id}</div>

                <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>

                  {p.status}{p.is_active ? ' · active' : ''}

                </div>

              </button>

            ))}

            {(!data?.profiles || data.profiles.length === 0) && (

              <p style={{ padding: '0.85rem', color: 'var(--muted)', fontSize: '0.9rem' }}>

                No profiles yet. Create one or chat with Job Discovery.

              </p>

            )}

          </div>



          <div>

            {!selected && (

              <div style={{ padding: '2rem', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--muted)' }}>

                <p>Select a profile or create a new one.</p>

                <p style={{ fontSize: '0.9rem' }}>Use <strong>Job Discovery chat</strong> for guided intake, or fill the form with <strong>New profile</strong>.</p>

              </div>

            )}



            {selected && (

              <>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginBottom: '0.75rem' }}>

                  <div>

                    <h2 style={{ margin: 0 }}>{selected.display_name || selected.id}</h2>

                    <p style={{ color: 'var(--muted)', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>

                      ID: {selected.id} · Status: <strong>{selected.status}</strong>

                      {selected.is_active && ' · currently active'}

                    </p>

                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>

                    <button type="button" onClick={() => setModal('edit')} style={{ padding: '0.4rem 0.7rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.85rem' }}>

                      Edit

                    </button>

                    {selected.status === 'draft' && detail?.intake_complete && (

                      <button type="button" disabled={busy} onClick={confirmProfile} style={{ padding: '0.4rem 0.7rem', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', fontSize: '0.85rem' }}>

                        Confirm & activate

                      </button>

                    )}

                    <button type="button" onClick={() => setModal('delete')} style={{ padding: '0.4rem 0.7rem', borderRadius: 6, border: '1px solid #f87171', background: 'transparent', color: '#f87171', fontSize: '0.85rem' }}>

                      Delete

                    </button>

                  </div>

                </div>



                <div style={{ display: 'flex', gap: 6, marginBottom: '1rem', flexWrap: 'wrap' }}>

                  {tabBtn('overview', 'Overview')}

                  {tabBtn('chat', 'Job Discovery chat')}

                  {tabBtn('portals', 'Connect portals')}

                </div>



                {tab === 'overview' && (

                  <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 8 }}>

                    {selected.status === 'draft' && !detail?.intake_complete && (

                      <p style={{ color: '#eab308', fontSize: '0.9rem' }}>

                        Profile incomplete — missing: {(detail?.missing_fields || selected.missing_fields || []).join(', ') || 'see Job Discovery chat'}

                      </p>

                    )}

                    <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: '140px 1fr', gap: '0.5rem 1rem', fontSize: '0.9rem' }}>

                      <dt style={{ color: 'var(--muted)' }}>Target titles</dt>

                      <dd style={{ margin: 0 }}>{arrToCsv(intake.target_titles) || '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>Locations</dt>

                      <dd style={{ margin: 0 }}>{arrToCsv(intake.locations) || '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>Work mode</dt>

                      <dd style={{ margin: 0 }}>{intake.work_mode || '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>Sources</dt>

                      <dd style={{ margin: 0 }}>{arrToCsv(intake.sources) || '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>Discovery URLs</dt>

                      <dd style={{ margin: 0 }}>

                        {previewDiscoveryUrls({

                          target_titles: arrToCsv(intake.target_titles),

                          locations: arrToCsv(intake.locations),

                          sources: arrToCsv(intake.sources),

                          ...patternsFromIntake(intake),

                        }).length ? (

                          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>

                            {previewDiscoveryUrls({

                              target_titles: arrToCsv(intake.target_titles),

                              locations: arrToCsv(intake.locations),

                              sources: arrToCsv(intake.sources),

                              ...patternsFromIntake(intake),

                            }).map((u) => (

                              <li key={u.source} style={{ wordBreak: 'break-all' }}>

                                [{u.source}] {u.url}

                              </li>

                            ))}

                          </ul>

                        ) : '—'}

                      </dd>

                      <dt style={{ color: 'var(--muted)' }}>Resume</dt>

                      <dd style={{ margin: 0 }}>{intake.master_resume_path || '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>LinkedIn</dt>

                      <dd style={{ margin: 0 }}>{intake.linkedin_profile || '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>Fit threshold</dt>

                      <dd style={{ margin: 0 }}>{intake.fit_threshold ?? '—'}</dd>

                      <dt style={{ color: 'var(--muted)' }}>Schedule</dt>

                      <dd style={{ margin: 0 }}>{detail?.workflow_schedule_label || selected.preview?.workflow_schedule_label || '—'}</dd>

                    </dl>

                    <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>

                      Tip: use the <button type="button" onClick={() => setTab('chat')} style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}>Job Discovery chat</button> tab to refine intake with the agent.

                    </p>



                    {selected.status === 'active' && (

                      <div style={{ marginTop: '1.25rem', padding: '1rem', border: '1px solid var(--accent)', borderRadius: 8, background: 'rgba(124,58,237,0.06)' }}>

                        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Run job workflow</h3>

                        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--muted)' }}>

                          Starts discovery against this profile when the tracker is empty, then Fit Scorer → Resume Tailor → CEO Kanban review (agent handoff). Daily schedule uses the same pipeline automatically.

                        </p>

                        {pipelineStatus?.job_counts && (

                          <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem' }}>

                            Tracker: {pipelineStatus.job_counts.discovered} discovered · {pipelineStatus.job_counts.shortlisted} shortlisted · {pipelineStatus.job_counts.awaiting_approval} awaiting approval

                          </p>

                        )}

                        <ol style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', fontSize: '0.85rem', color: 'var(--muted)' }}>

                          <li><button type="button" onClick={runWorkflowNow} style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}>Run full workflow</button> — discover (if needed) → score → tailor → CEO review</li>

                          <li><button type="button" onClick={() => setTab('portals')} style={{ background: 'none', border: 'none', color: 'var(--accent)', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}>Connect portals</button> first if LinkedIn login is required</li>

                          <li><Link to="/kanban">Kanban</Link> — approve CEO review task</li>

                        </ol>

                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>

                          <button type="button" disabled={busy} onClick={runWorkflowNow} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>

                            {busy ? 'Starting…' : 'Run full workflow'}

                          </button>

                          <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { setWorkflowResult(await api.jobApplicantWorkflowRun({ profile_id: selectedId, sync_only: true })); } catch (e) { setError(e.message); } finally { setBusy(false); } }} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' }}>

                            Score & review only

                          </button>

                          <button type="button" disabled={busy} onClick={harvestListings} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' }}>

                            {busy ? 'Harvesting…' : 'Harvest job URLs'}

                          </button>

                          <Link to={`/job-workflows?profile_id=${encodeURIComponent(selectedId)}`} style={{ padding: '0.5rem 0.85rem', fontSize: '0.9rem', alignSelf: 'center' }}>

                            View workflows →

                          </Link>

                          <Link to="/kanban" style={{ padding: '0.5rem 0.85rem', fontSize: '0.9rem', alignSelf: 'center' }}>

                            Kanban →

                          </Link>

                        </div>

                        {workflowResult && (

                          <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>

                            {workflowResult.message || workflowResult.next_step ? (

                              <p style={{ margin: '0 0 0.5rem', color: 'var(--text)' }}>{workflowResult.message || workflowResult.next_step}</p>

                            ) : null}

                            <pre style={{ margin: 0, fontSize: '0.75rem', overflow: 'auto', padding: '0.5rem', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border)' }}>

                              {JSON.stringify(workflowResult, null, 2)}

                            </pre>

                          </div>

                        )}

                      </div>

                    )}

                  </div>

                )}



                {tab === 'chat' && (

                  <div style={{ padding: '1rem', border: '1px solid var(--border)', borderRadius: 8 }}>

                    <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--muted)' }}>

                      Chat with Job Discovery to create or update this profile. Context: profile <code>{selectedId}</code>

                    </p>

                    <AgentChatPanel

                      agentId="jobdiscovery"

                      profileId={selectedId}

                      minHeight={320}

                      quickActions={[

                        {

                          label: 'Start full workflow (API)',

                          message: `Call job_pipeline_start with profile_id "${selectedId}" to run discovery → fit scoring → resume tailoring → CEO review for this profile. Do not browse manually without jobs_append.`,

                        },

                        {

                          label: 'Chat discovery only',

                          message: `Run browser discovery for profile_id "${selectedId}". jobs_append each job with full details. Pipeline handoff continues automatically if job_pipeline_start was used; otherwise call job_run_workflow_now after append.`,

                        },

                        {

                          label: 'Run workflow only',

                          message: `Call job_run_workflow_now for profile_id "${selectedId}" — score discovered jobs, tailor cover letters, create Kanban CEO review. Report task id and counts.`,

                        },

                      ]}

                    />

                    <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--muted)' }}>

                      Or open full chat: <Link to={`/agents/jobdiscovery/chat?profile_id=${encodeURIComponent(selectedId)}`}>Job Discovery →</Link>

                    </p>

                  </div>

                )}



                {tab === 'portals' && (

                  <div style={{ padding: '1rem', border: '1px solid var(--accent)', borderRadius: 8, background: 'rgba(124,58,237,0.06)' }}>

                    <h3 style={{ margin: '0 0 0.5rem' }}>Connect job portals</h3>

                    <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: '0 0 0.75rem' }}>

                      Saves session via OpenClaw browser (no passwords stored). Open login browser → sign in inside Chromium → **Save & connect** (required — cookies are not saved until then).

                    </p>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1rem' }}>

                      <button type="button" disabled={busy} onClick={() => startLoginBrowser(false)} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }}>

                        {busy ? 'Opening…' : 'Open login browser'}

                      </button>

                      <button type="button" disabled={busy} onClick={() => startLoginBrowser(true)} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>

                        Login script + browser

                      </button>

                      <button type="button" disabled={busy} onClick={spawnLoginScript} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}>

                        Launch login script (terminal)

                      </button>

                      <button type="button" disabled={busy} onClick={connectPortals} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer' }}>

                        Refresh portal status

                      </button>

                      <button type="button" disabled={busy} onClick={markLoggedIn} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', cursor: 'pointer', fontWeight: 600 }}>

                        Save & connect

                      </button>

                    </div>

                    <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: '0 0 0.75rem' }}>

                      Opens OpenClaw Playwright Chromium — no passwords stored in Agent OS. After logging in, click <strong>Mark logged in</strong>.

                    </p>

                    {(loginResult?.instructions || connectResult?.manual_steps) && (

                      <ul style={{ fontSize: '0.85rem', paddingLeft: '1.25rem', margin: '0 0 0.75rem', color: 'var(--muted)' }}>

                        {(loginResult?.instructions || connectResult?.manual_steps || []).map((s, i) => (

                          <li key={i}>{s}</li>

                        ))}

                      </ul>

                    )}

                    {portalData?.global_browser_auth && (

                      <div style={{ fontSize: '0.8rem', marginBottom: '0.75rem', color: 'var(--muted)' }}>

                        Browser profile: {portalData.global_browser_auth.persistent_profile_exists || portalData.global_browser_auth.session_saved ? 'active' : 'not created yet'} · LinkedIn: {portalData.global_browser_auth.linkedin_logged_in ? 'connected' : 'login required'} · JobStreet: {portalData.global_browser_auth.jobstreet_logged_in ? 'connected' : 'login required'}

                      </div>

                    )}



                    {(portalData?.portals || []).map((p) => (

                      <div key={p.key} style={{ marginBottom: 8, padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)' }}>

                        <div style={{ fontWeight: 600 }}>{p.label}</div>

                        <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{p.login_url}</div>

                        <div style={{ fontSize: '0.85rem', marginTop: 4, color: portalData.portal_auth?.[p.key]?.session_ok ? '#22c55e' : '#eab308' }}>

                          {portalData.portal_auth?.[p.key]?.connect_status || (portalData.portal_auth?.[p.key]?.session_ok ? 'connected' : 'login_required')}

                        </div>

                      </div>

                    ))}



                    {connectResult?.manual_steps && (

                      <details style={{ marginTop: 8 }}>

                        <summary style={{ cursor: 'pointer', fontSize: '0.85rem' }}>Manual steps</summary>

                        <ol style={{ fontSize: '0.85rem', paddingLeft: '1.25rem' }}>

                          {connectResult.manual_steps.map((s, i) => (

                            <li key={i}>{s}</li>

                          ))}

                        </ol>

                      </details>

                    )}

                  </div>

                )}

              </>

            )}



            {!selected && (

              <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid var(--border)', borderRadius: 8 }}>

                <h3 style={{ marginTop: 0 }}>Job Discovery chat</h3>

                <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Start a new profile via conversation.</p>

                <AgentChatPanel agentId="jobdiscovery" minHeight={280} />

              </div>

            )}

          </div>

        </div>

      )}



      {modal && (

        <div

          style={{

            position: 'fixed',

            inset: 0,

            background: 'rgba(0,0,0,0.6)',

            display: 'flex',

            alignItems: 'center',

            justifyContent: 'center',

            zIndex: 100,

            padding: '1rem',

          }}

          onClick={() => !busy && setModal(null)}

        >

          <div

            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '1.25rem', maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto' }}

            onClick={(e) => e.stopPropagation()}

          >

            {modal === 'create' && (

              <ProfileForm title="New job profile" initial={emptyForm} onSave={createProfile} onCancel={() => setModal(null)} busy={busy} />

            )}

            {modal === 'edit' && (

              <ProfileForm title="Edit profile" initial={editFormFromDetail} onSave={updateProfile} onCancel={() => setModal(null)} busy={busy} isEdit />

            )}

            {modal === 'delete' && (

              <div>

                <h3 style={{ marginTop: 0 }}>Delete profile?</h3>

                <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>

                  This removes <strong>{selected?.display_name || selectedId}</strong> and its job applications. This cannot be undone.

                </p>

                <div style={{ display: 'flex', gap: 8, marginTop: '1rem' }}>

                  <button type="button" disabled={busy} onClick={deleteProfile} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: 'none', background: '#f87171', color: '#fff' }}>

                    {busy ? 'Deleting…' : 'Delete permanently'}

                  </button>

                  <button type="button" onClick={() => setModal(null)} style={{ padding: '0.5rem 0.85rem', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>

                    Cancel

                  </button>

                </div>

              </div>

            )}

          </div>

        </div>

      )}

    </div>

  );

}



export default function JobProfiles() {

  return (

    <RequireAuth role="ceo">

      <JobProfilesPanel />

    </RequireAuth>

  );

}

