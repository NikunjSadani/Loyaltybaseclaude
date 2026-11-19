'use client';

/* ─── Gifsy console — Help & videos for ONE client ───────────────────────────
   List / create / edit / reorder / publish / delete the client's help guides, upload
   each guide's video (MP4 ≤ 50 MB, sent in 8 MB parts) and poster, and edit its 3–6
   numbered steps. Every change is audited server-side. Members only see PUBLISHED
   guides, and only while the client's `helpVideos` feature flag is ON (this page
   says so loudly when it is OFF). See platform/docs/plans/HELP-VIDEOS.md.
─────────────────────────────────────────────────────────────────────────────── */

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Eye, EyeOff, Film, ImageIcon, Pencil, Plus, Trash2, Upload, X,
} from 'lucide-react';
import { api } from '@/lib/api-client';

type Audience = 'SALES' | 'PARTNER';

interface HelpTopicAdmin {
  id: string;
  audience: Audience;
  roles: string[];
  title: string;
  description: string | null;
  sortOrder: number;
  isPublished: boolean;
  steps: string[];
  hasVideo: boolean;
  videoBytes: number | null;
  videoUrl: string | null;
  posterUrl: string | null;
}

interface RoleOption { code: string; label: string }

const AUDIENCE_LABEL: Record<Audience, string> = { SALES: 'Sales app', PARTNER: 'Partner app' };
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_POSTER_BYTES = 5 * 1024 * 1024;
const POSTER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const STEPS_MIN = 3;
const STEPS_MAX = 6;

const inputCls = 'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-sky-400';
const btnCls = 'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-white/10 text-white/80 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';

function mb(bytes: number | null): string {
  return bytes == null ? '' : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─── Editor ─────────────────────────────────────────────────────────────────── */

interface Draft {
  audience: Audience;
  title: string;
  description: string;
  roles: string[];
  steps: string[];
}

function TopicEditor({
  initial,
  roleOptions,
  isNew,
  onSave,
  onCancel,
}: {
  initial: Draft;
  roleOptions: Record<Audience, RoleOption[]>;
  isNew: boolean;
  onSave: (d: Draft) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opts = roleOptions[d.audience] ?? [];
  // Keep any saved role that is no longer offered visible, so it can be seen and cleared (never silently kept).
  const extraRoles = d.roles.filter((r) => !opts.some((o) => o.code === r));

  const setStep = (i: number, v: string) => setD((p) => ({ ...p, steps: p.steps.map((s, j) => (j === i ? v : s)) }));
  const moveStep = (i: number, dir: -1 | 1) =>
    setD((p) => {
      const j = i + dir;
      if (j < 0 || j >= p.steps.length) return p;
      const steps = [...p.steps];
      [steps[i], steps[j]] = [steps[j], steps[i]];
      return { ...p, steps };
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave({ ...d, steps: d.steps.map((s) => s.trim()).filter(Boolean) });
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <div className="space-y-4 bg-white/5 border border-sky-400/30 rounded-xl p-4" data-testid="help-topic-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-white/50">Shown in</span>
          <select
            className={inputCls}
            value={d.audience}
            onChange={(e) => setD((p) => ({ ...p, audience: e.target.value as Audience, roles: [] }))}
            aria-label="Audience"
          >
            <option value="SALES">Sales app</option>
            <option value="PARTNER">Partner app</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-white/50">Title (max 80)</span>
          <input className={inputCls} value={d.title} maxLength={80} onChange={(e) => setD((p) => ({ ...p, title: e.target.value }))} aria-label="Title" />
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-white/50">Short description (optional, max 200)</span>
        <input className={inputCls} value={d.description} maxLength={200} onChange={(e) => setD((p) => ({ ...p, description: e.target.value }))} aria-label="Short description" />
      </label>

      <fieldset>
        <legend className="text-xs text-white/50 mb-1">Who sees it — none ticked = everyone in the {AUDIENCE_LABEL[d.audience]}</legend>
        <div className="flex flex-wrap gap-2">
          {[...opts, ...extraRoles.map((code) => ({ code, label: `${code} (no longer offered)` }))].map((o) => {
            const on = d.roles.includes(o.code);
            return (
              <label key={o.code} className={`text-xs px-2 py-1 rounded-lg border cursor-pointer ${on ? 'border-sky-400 bg-sky-400/10 text-sky-200' : 'border-white/10 text-white/60'}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  onChange={() => setD((p) => ({ ...p, roles: on ? p.roles.filter((r) => r !== o.code) : [...p.roles, o.code] }))}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-xs text-white/50 mb-1">Steps — {STEPS_MIN} to {STEPS_MAX} short lines (needed to publish)</legend>
        <ol className="space-y-2">
          {d.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="text-xs text-white/40 w-5 text-right">{i + 1}.</span>
              <input className={inputCls} value={s} maxLength={200} onChange={(e) => setStep(i, e.target.value)} aria-label={`Step ${i + 1}`} />
              <button type="button" className={btnCls} onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}><ArrowUp className="w-3.5 h-3.5" /></button>
              <button type="button" className={btnCls} onClick={() => moveStep(i, 1)} disabled={i === d.steps.length - 1} aria-label={`Move step ${i + 1} down`}><ArrowDown className="w-3.5 h-3.5" /></button>
              <button type="button" className={btnCls} onClick={() => setD((p) => ({ ...p, steps: p.steps.filter((_, j) => j !== i) }))} aria-label={`Remove step ${i + 1}`}><X className="w-3.5 h-3.5" /></button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={`${btnCls} mt-2`}
          onClick={() => setD((p) => ({ ...p, steps: [...p.steps, ''] }))}
          disabled={d.steps.length >= STEPS_MAX}
        >
          <Plus className="w-3.5 h-3.5" /> Add step
        </button>
      </fieldset>

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={saving} className="px-3 py-1.5 rounded-lg bg-sky-500 text-white text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving…' : isNew ? 'Create guide' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className={btnCls}>Cancel</button>
      </div>
    </div>
  );
}

/* ─── Topic card ─────────────────────────────────────────────────────────────── */

function TopicCard({
  topic,
  index,
  count,
  roleLabels,
  slug,
  onChanged,
  onMove,
  onEdit,
  onDelete,
}: {
  topic: HelpTopicAdmin;
  index: number;
  count: number;
  roleLabels: Map<string, string>;
  slug: string;
  onChanged: (t: HelpTopicAdmin) => void;
  onMove: (dir: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const base = `/api/gifsy/clients/${encodeURIComponent(slug)}/help-topics/${encodeURIComponent(topic.id)}`;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState(false);
  const videoInput = useRef<HTMLInputElement>(null);
  const posterInput = useRef<HTMLInputElement>(null);

  const run = async (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    setError(null);
    try {
      const err = await fn();
      if (err) setError(err);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const togglePublish = () =>
    run('publish', async () => {
      const r = await api.patch<HelpTopicAdmin>(base, { isPublished: !topic.isPublished });
      if (!r.success) return r.error;
      onChanged(r.data);
      return null;
    });

  const removeMedia = (kind: 'video' | 'poster') =>
    run(`remove-${kind}`, async () => {
      if (!window.confirm(kind === 'video' ? 'Remove this guide\'s video? The steps stay.' : 'Remove the poster image?')) return null;
      const r = await api.del<HelpTopicAdmin>(`${base}/${kind}`);
      if (!r.success) return r.error;
      onChanged(r.data);
      return null;
    });

  const uploadPoster = (file: File) =>
    run('poster', async () => {
      if (!POSTER_TYPES.includes(file.type)) return 'Poster must be a PNG, JPG or WEBP image.';
      if (file.size > MAX_POSTER_BYTES) return 'Poster is too large — the limit is 5 MB.';
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${base}/poster`, { method: 'POST', body: fd });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) return body?.error ?? `Upload failed (${res.status}).`;
      onChanged(body.data as HelpTopicAdmin);
      return null;
    });

  const uploadVideo = (file: File) =>
    run('video', async () => {
      const isMp4 = file.type === 'video/mp4' || /\.mp4$/i.test(file.name);
      if (!isMp4) return 'Upload an .mp4 video (H.264). Other formats do not play on every phone.';
      if (file.size <= 0) return 'The file is empty.';
      if (file.size > MAX_VIDEO_BYTES) return `The video is ${mb(file.size)} — the limit is 50 MB. Compress it and try again.`;
      const start = await api.post<{ uploadId: string; partBytes: number }>(`${base}/video-uploads?bytes=${file.size}`, {});
      if (!start.success) return start.error;
      const { uploadId, partBytes } = start.data;
      const parts = Math.ceil(file.size / partBytes);
      setProgress(0);
      for (let i = 0; i < parts; i++) {
        const fd = new FormData();
        fd.append('file', file.slice(i * partBytes, Math.min(file.size, (i + 1) * partBytes)), `part-${i}`);
        const res = await fetch(`${base}/video-uploads/${uploadId}/parts/${i}`, { method: 'POST', body: fd });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          return body?.error ?? `Upload failed at part ${i + 1} of ${parts} (${res.status}). Nothing was saved — try again.`;
        }
        setProgress(Math.round(((i + 1) / parts) * 100));
      }
      const done = await api.post<HelpTopicAdmin>(`${base}/video-uploads/${uploadId}/complete`, {});
      if (!done.success) return done.error;
      onChanged(done.data);
      return null;
    });

  const roles = topic.roles.length === 0 ? ['Everyone'] : topic.roles.map((r) => roleLabels.get(r) ?? r);

  return (
    <li className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-3" data-testid="help-topic-card">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-1">
          <button type="button" className={btnCls} onClick={() => onMove(-1)} disabled={index === 0 || !!busy} aria-label={`Move "${topic.title}" up`}><ArrowUp className="w-3.5 h-3.5" /></button>
          <button type="button" className={btnCls} onClick={() => onMove(1)} disabled={index === count - 1 || !!busy} aria-label={`Move "${topic.title}" down`}><ArrowDown className="w-3.5 h-3.5" /></button>
        </div>
        {topic.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={topic.posterUrl} alt="" className="w-24 h-14 object-cover rounded-lg bg-black shrink-0" />
        ) : (
          <div className="w-24 h-14 rounded-lg bg-white/5 flex items-center justify-center shrink-0"><Film className="w-5 h-5 text-white/30" /></div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-white">{topic.title}</p>
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${topic.isPublished ? 'bg-green-500/15 text-green-300' : 'bg-white/10 text-white/50'}`}>
              {topic.isPublished ? 'Published' : 'Draft'}
            </span>
          </div>
          {topic.description && <p className="text-xs text-white/50 mt-0.5">{topic.description}</p>}
          <p className="text-xs text-white/40 mt-1" data-testid="help-topic-audience">
            {AUDIENCE_LABEL[topic.audience]} · {roles.join(', ')}
          </p>
          <p className="text-xs text-white/40">
            {topic.steps.length} step{topic.steps.length === 1 ? '' : 's'} · {topic.hasVideo ? `Video ${mb(topic.videoBytes)}` : 'No video'}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnCls} onClick={togglePublish} disabled={!!busy}>
          {topic.isPublished ? <><EyeOff className="w-3.5 h-3.5" /> Unpublish</> : <><Eye className="w-3.5 h-3.5" /> Publish</>}
        </button>
        <button type="button" className={btnCls} onClick={onEdit} disabled={!!busy}><Pencil className="w-3.5 h-3.5" /> Edit</button>
        <button type="button" className={btnCls} onClick={() => videoInput.current?.click()} disabled={!!busy}>
          <Upload className="w-3.5 h-3.5" /> {topic.hasVideo ? 'Replace video' : 'Upload video'}
        </button>
        {topic.hasVideo && (
          <>
            <button type="button" className={btnCls} onClick={() => setPreview((p) => !p)} disabled={!!busy}><Film className="w-3.5 h-3.5" /> {preview ? 'Hide preview' : 'Preview'}</button>
            <button type="button" className={btnCls} onClick={() => removeMedia('video')} disabled={!!busy}><X className="w-3.5 h-3.5" /> Remove video</button>
          </>
        )}
        <button type="button" className={btnCls} onClick={() => posterInput.current?.click()} disabled={!!busy}>
          <ImageIcon className="w-3.5 h-3.5" /> {topic.posterUrl ? 'Replace poster' : 'Upload poster'}
        </button>
        {topic.posterUrl && (
          <button type="button" className={btnCls} onClick={() => removeMedia('poster')} disabled={!!busy}><X className="w-3.5 h-3.5" /> Remove poster</button>
        )}
        <button type="button" className={`${btnCls} text-red-300 border-red-400/30`} onClick={onDelete} disabled={!!busy}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
      </div>

      <input
        ref={videoInput}
        type="file"
        accept="video/mp4,.mp4"
        className="hidden"
        data-testid="help-video-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void uploadVideo(f);
        }}
      />
      <input
        ref={posterInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid="help-poster-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void uploadPoster(f);
        }}
      />

      {busy === 'video' && (
        <p className="text-xs text-sky-300" role="status">Uploading video… {progress ?? 0}%</p>
      )}
      {busy && busy !== 'video' && <p className="text-xs text-white/50" role="status">Working…</p>}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

      {preview && topic.videoUrl && (
        <video className="w-full max-w-md rounded-lg bg-black" src={topic.videoUrl} poster={topic.posterUrl ?? undefined} controls playsInline preload="metadata" />
      )}
      {topic.steps.length > 0 && (
        <ol className="list-decimal list-inside text-xs text-white/60 space-y-0.5">
          {topic.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
    </li>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function HelpVideosConsolePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const base = `/api/gifsy/clients/${encodeURIComponent(slug)}/help-topics`;
  const [topics, setTopics] = useState<HelpTopicAdmin[] | null>(null);
  const [flagOn, setFlagOn] = useState<boolean>(false);
  const [roleOptions, setRoleOptions] = useState<Record<Audience, RoleOption[]>>({ SALES: [], PARTNER: [] });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    const [list, opts] = await Promise.all([
      api.get<{ flagOn: boolean; topics: HelpTopicAdmin[] }>(base),
      api.get<Record<Audience, RoleOption[]>>(`${base}/role-options`),
    ]);
    if (!list.success) {
      setLoadError(list.error || 'Could not load the guides.');
      return;
    }
    setTopics(list.data.topics);
    setFlagOn(list.data.flagOn);
    if (opts.success) setRoleOptions(opts.data);
    else setPageError('Could not load the role list — reload before editing who sees a guide.');
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const replace = (t: HelpTopicAdmin) => setTopics((prev) => (prev ? prev.map((x) => (x.id === t.id ? t : x)) : prev));

  const saveNew = async (d: Draft): Promise<string | null> => {
    const r = await api.post<HelpTopicAdmin>(base, {
      audience: d.audience, title: d.title, description: d.description || null, roles: d.roles, steps: d.steps,
    });
    if (!r.success) return r.error;
    setTopics((prev) => [...(prev ?? []), r.data]);
    setEditing(null);
    return null;
  };

  const saveEdit = (id: string) => async (d: Draft): Promise<string | null> => {
    const r = await api.patch<HelpTopicAdmin>(`${base}/${encodeURIComponent(id)}`, {
      audience: d.audience, title: d.title, description: d.description || null, roles: d.roles, steps: d.steps,
    });
    if (!r.success) return r.error;
    // An audience change moves the guide to the end of the other list — reload for the true order.
    await load();
    setEditing(null);
    return null;
  };

  const remove = async (t: HelpTopicAdmin) => {
    if (!window.confirm(`Delete "${t.title}"? Members stop seeing it immediately.`)) return;
    setPageError(null);
    const r = await api.del<{ id: string }>(`${base}/${encodeURIComponent(t.id)}`);
    if (!r.success) {
      setPageError(r.error);
      return;
    }
    setTopics((prev) => (prev ? prev.filter((x) => x.id !== t.id) : prev));
  };

  const move = async (audience: Audience, list: HelpTopicAdmin[], index: number, dir: -1 | 1) => {
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((t) => t.id);
    [ids[index], ids[j]] = [ids[j], ids[index]];
    setPageError(null);
    const r = await api.post<HelpTopicAdmin[]>(`${base}/reorder`, { audience, ids });
    if (!r.success) {
      setPageError(r.error);
      await load();
      return;
    }
    setTopics((prev) => [...(prev ?? []).filter((t) => t.audience !== audience), ...r.data]);
  };

  const roleLabels = (a: Audience) => new Map(roleOptions[a].map((o) => [o.code, o.label]));

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/gifsy/clients/${encodeURIComponent(slug)}`} className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70 mb-2">
          <ArrowLeft className="w-3.5 h-3.5" /> Client settings
        </Link>
        <h1 className="text-xl font-bold text-white">Help &amp; videos</h1>
        <p className="text-sm text-white/40">
          Short how-to videos with numbered steps, shown on the sales and partner app Profile. Members only see
          published guides.
        </p>
      </div>

      {topics && !flagOn && (
        <div role="status" data-testid="help-flag-off" className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            The <b>Help &amp; videos</b> feature is OFF for this client — members see nothing yet, even published guides.
            Turn it on under Client settings → Features when the guides are ready.
          </span>
        </div>
      )}

      {loadError && <p role="alert" className="text-sm text-red-400">{loadError}</p>}
      {pageError && <p role="alert" className="text-sm text-red-400">{pageError}</p>}
      {!topics && !loadError && <p className="text-sm text-white/40">Loading…</p>}

      {topics && (
        <>
          {editing === 'new' ? (
            <TopicEditor
              isNew
              initial={{ audience: 'SALES', title: '', description: '', roles: [], steps: ['', '', ''] }}
              roleOptions={roleOptions}
              onSave={saveNew}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button type="button" onClick={() => setEditing('new')} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500 text-white text-sm font-medium">
              <Plus className="w-4 h-4" /> New guide
            </button>
          )}

          {(['SALES', 'PARTNER'] as Audience[]).map((aud) => {
            const list = topics.filter((t) => t.audience === aud).sort((a, b) => a.sortOrder - b.sortOrder);
            const labels = roleLabels(aud);
            return (
              <section key={aud} className="space-y-3" data-testid={`help-section-${aud}`}>
                <h2 className="text-sm font-semibold text-white/80">{AUDIENCE_LABEL[aud]} <span className="text-white/40 font-normal">({list.length})</span></h2>
                {list.length === 0 ? (
                  <p className="text-sm text-white/40">No guides yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {list.map((t, i) =>
                      editing === t.id ? (
                        <li key={t.id}>
                          <TopicEditor
                            isNew={false}
                            initial={{ audience: t.audience, title: t.title, description: t.description ?? '', roles: t.roles, steps: t.steps }}
                            roleOptions={roleOptions}
                            onSave={saveEdit(t.id)}
                            onCancel={() => setEditing(null)}
                          />
                        </li>
                      ) : (
                        <TopicCard
                          key={t.id}
                          topic={t}
                          index={i}
                          count={list.length}
                          roleLabels={labels}
                          slug={slug}
                          onChanged={replace}
                          onMove={(dir) => void move(aud, list, i, dir)}
                          onEdit={() => setEditing(t.id)}
                          onDelete={() => void remove(t)}
                        />
                      ),
                    )}
                  </ul>
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
