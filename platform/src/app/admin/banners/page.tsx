'use client';

import React, { useState, useEffect, CSSProperties } from 'react';
import {
  Plus, Pencil, Trash2, ToggleLeft, ToggleRight,
  Type, Video, Eye, Save, X, ExternalLink, Image,
  LayoutDashboard, Expand,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  BG_OPTIONS, getBgStyle, toEmbedUrl,
  fetchBanners, updateBanners, newBanner, getActiveBanners,
  loadPopups, savePopups, newPopup,
  type Banner, type Popup, type BannerAudience, type PopupFrequency,
} from '@/lib/banner';

type Tab = 'banners' | 'popups';

const AUDIENCE_LABELS: Record<BannerAudience, string> = {
  ALL: 'All Partners',
  SSS: 'Retailers only',
  WHOLESALER: 'Wholesalers only',
  SUB_STOCKIST: 'Sub-Stockists only',
};

const FREQUENCY_LABELS: Record<PopupFrequency, string> = {
  always: 'Every visit',
  once:   'Once only',
  daily:  'Once per day',
};

// ── Colour picker ─────────────────────────────────────────────────────────────
function ColourPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-2">
      {BG_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          title={opt.label}
          className={`w-7 h-7 rounded-full border-2 transition-all ${value === opt.value ? 'border-gray-800 scale-110' : 'border-transparent'}`}
          style={{ background: `linear-gradient(135deg, ${opt.from}, ${opt.to})` }}
        />
      ))}
    </div>
  );
}

// ── Banner live preview ───────────────────────────────────────────────────────
function BannerPreview({ b }: { b: Banner }) {
  if (b.type === 'video' && b.videoUrl) {
    return (
      <div className="rounded-2xl overflow-hidden aspect-video bg-black">
        <iframe src={toEmbedUrl(b.videoUrl)} className="w-full h-full" allowFullScreen />
      </div>
    );
  }
  return (
    <div className="rounded-2xl p-5 text-white" style={getBgStyle(b.bgColor) as CSSProperties}>
      {b.title && <p className="text-base font-bold">{b.title}</p>}
      {b.body  && <p className="text-sm text-white/80 mt-1.5 leading-relaxed">{b.body}</p>}
      {b.ctaLabel && (
        <button className="mt-3 px-4 py-1.5 bg-white/20 rounded-lg text-sm font-semibold">{b.ctaLabel}</button>
      )}
    </div>
  );
}

// ── Popup live preview ────────────────────────────────────────────────────────
function PopupPreview({ p }: { p: Popup }) {
  return (
    <div className="relative rounded-2xl overflow-hidden" style={{ minHeight: 260 }}>
      {/* Overlay mock */}
      <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl overflow-hidden shadow-2xl">
          {p.type === 'video' && p.videoUrl ? (
            <div className="aspect-video bg-black">
              <iframe src={toEmbedUrl(p.videoUrl)} className="w-full h-full" allowFullScreen />
            </div>
          ) : p.type === 'image' && p.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.imageUrl} alt="poster" className="w-full object-cover max-h-52" />
          ) : (
            <div className="p-5 text-white" style={getBgStyle(p.bgColor) as CSSProperties}>
              {p.title && <p className="text-base font-bold">{p.title}</p>}
              {p.body  && <p className="text-sm text-white/80 mt-1.5 leading-relaxed">{p.body}</p>}
            </div>
          )}
          {(p.ctaLabel || (p.type !== 'video' && p.type !== 'image')) && (
            <div className="p-4 flex flex-col gap-2">
              {p.ctaLabel && (
                <button className="w-full py-2 bg-[var(--brand-primary)] text-white rounded-xl text-sm font-semibold">{p.ctaLabel}</button>
              )}
              <button className="w-full py-1.5 text-xs text-gray-400 hover:text-gray-600">Close</button>
            </div>
          )}
        </div>
      </div>
      {/* Background hint */}
      <div className="h-64 bg-gradient-to-b from-gray-100 to-gray-200 rounded-2xl" />
    </div>
  );
}

// ── Input helpers ─────────────────────────────────────────────────────────────
const inputCls = 'w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]';
const labelCls = 'text-xs font-medium text-gray-600 block mb-1';

// ── Banner form ───────────────────────────────────────────────────────────────
function BannerForm({ initial, onSave, onCancel }: { initial: Banner; onSave: (b: Banner) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Banner>(initial);
  const set = <K extends keyof Banner>(k: K, v: Banner[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        {/* Type */}
        <div>
          <p className={labelCls}>Type</p>
          <div className="flex gap-2">
            {(['text', 'video'] as const).map((t) => (
              <button key={t} onClick={() => set('type', t)}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border text-sm font-medium transition-all ${form.type === t ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                {t === 'text' ? <Type className="h-4 w-4" /> : <Video className="h-4 w-4" />}
                {t === 'text' ? 'Text' : 'Video'}
              </button>
            ))}
          </div>
        </div>

        {form.type === 'text' && (<>
          <div>
            <label className={labelCls}>Title</label>
            <input className={inputCls} placeholder="e.g. 🎉 Diwali Special!" value={form.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Message</label>
            <textarea className={`${inputCls} resize-none`} rows={3} placeholder="Announcement text..." value={form.body} onChange={(e) => set('body', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Button Label</label>
              <input className={inputCls} placeholder="Learn More" value={form.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Button Link</label>
              <input className={inputCls} placeholder="https://..." value={form.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} />
            </div>
          </div>
          <div>
            <p className={labelCls}>Background</p>
            <ColourPicker value={form.bgColor} onChange={(v) => set('bgColor', v)} />
          </div>
        </>)}

        {form.type === 'video' && (
          <div>
            <label className={labelCls}>YouTube URL</label>
            <input className={inputCls} placeholder="https://www.youtube.com/watch?v=..." value={form.videoUrl} onChange={(e) => set('videoUrl', e.target.value)} />
            <p className="text-xs text-gray-400 mt-1">Paste any YouTube link — auto-converted to embed.</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className={labelCls}>Show To</p>
            <select className={inputCls} value={form.audience} onChange={(e) => set('audience', e.target.value as BannerAudience)}>
              {(Object.keys(AUDIENCE_LABELS) as BannerAudience[]).map((a) => (
                <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>
              ))}
            </select>
          </div>
          <div>
            <p className={labelCls}>Priority (0 = shown first)</p>
            <input
              type="number"
              min={0}
              max={99}
              className={inputCls}
              value={form.priority ?? 0}
              onChange={(e) => set('priority', Math.max(0, Number(e.target.value)))}
            />
          </div>
        </div>

        {/* Schedule */}
        <div>
          <p className={`${labelCls} mb-2`}>Schedule <span className="font-normal text-gray-400">(optional — leave blank to run indefinitely)</span></p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Start Date</label>
              <input
                type="date"
                className={inputCls}
                value={form.startDate ?? ''}
                onChange={(e) => set('startDate', e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls}>End Date</label>
              <input
                type="date"
                className={inputCls}
                value={form.endDate ?? ''}
                min={form.startDate ?? ''}
                onChange={(e) => set('endDate', e.target.value)}
              />
            </div>
          </div>
          {form.startDate && form.endDate && new Date(form.endDate) < new Date(form.startDate) && (
            <p className="text-xs text-red-500 mt-1">End date must be after start date.</p>
          )}
        </div>

        {/* Show in Sales App */}
        <div className="flex items-center justify-between p-3 bg-indigo-50 rounded-xl border border-indigo-100">
          <div>
            <p className="text-sm font-medium text-indigo-900">Show in Sales App</p>
            <p className="text-xs text-indigo-500 mt-0.5">Display this banner to the internal sales team on their dashboard.</p>
          </div>
          <button
            type="button"
            onClick={() => set('showInSalesApp', !form.showInSalesApp)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${form.showInSalesApp ? 'bg-indigo-600' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.showInSalesApp ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}><X className="h-4 w-4 mr-1" />Cancel</Button>
          <Button variant="primary" className="flex-1" onClick={() => onSave({ ...form, updatedAt: new Date().toISOString() })}
            disabled={form.type === 'text' ? !form.title : !form.videoUrl}>
            <Save className="h-4 w-4 mr-1" />Save
          </Button>
        </div>
      </div>

      <div>
        <p className={`${labelCls} mb-2`}>Live Preview</p>
        <BannerPreview b={form} />
        <p className="text-xs text-gray-400 mt-2 flex items-center gap-1"><Eye className="h-3 w-3" />Appears as a strip at the top of the home screen.</p>
      </div>
    </div>
  );
}

// ── Popup form ────────────────────────────────────────────────────────────────
function PopupForm({ initial, onSave, onCancel }: { initial: Popup; onSave: (p: Popup) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Popup>(initial);
  const set = <K extends keyof Popup>(k: K, v: Popup[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        {/* Type */}
        <div>
          <p className={labelCls}>Popup Content</p>
          <div className="flex gap-2">
            {(['text', 'image', 'video'] as const).map((t) => (
              <button key={t} onClick={() => set('type', t)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-xs font-medium transition-all ${form.type === t ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                {t === 'text' ? <Type className="h-3.5 w-3.5" /> : t === 'image' ? <Image className="h-3.5 w-3.5" /> : <Video className="h-3.5 w-3.5" />}
                {t === 'text' ? 'Text' : t === 'image' ? 'Poster' : 'Video'}
              </button>
            ))}
          </div>
        </div>

        {form.type === 'text' && (<>
          <div>
            <label className={labelCls}>Title</label>
            <input className={inputCls} placeholder="Popup headline" value={form.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Message</label>
            <textarea className={`${inputCls} resize-none`} rows={4} placeholder="Popup body text..." value={form.body} onChange={(e) => set('body', e.target.value)} />
          </div>
          <div>
            <p className={labelCls}>Background</p>
            <ColourPicker value={form.bgColor} onChange={(v) => set('bgColor', v)} />
          </div>
        </>)}

        {form.type === 'image' && (
          <div>
            <label className={labelCls}>Poster Image URL</label>
            <input className={inputCls} placeholder="https://example.com/poster.jpg" value={form.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} />
            <p className="text-xs text-gray-400 mt-1">Use a direct image link (JPG, PNG, WebP). Recommended: 800×1000px portrait.</p>
          </div>
        )}

        {form.type === 'video' && (
          <div>
            <label className={labelCls}>YouTube URL</label>
            <input className={inputCls} placeholder="https://www.youtube.com/watch?v=..." value={form.videoUrl} onChange={(e) => set('videoUrl', e.target.value)} />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Button Label</label>
            <input className={inputCls} placeholder="Shop Now" value={form.ctaLabel} onChange={(e) => set('ctaLabel', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Button Link</label>
            <input className={inputCls} placeholder="https://..." value={form.ctaUrl} onChange={(e) => set('ctaUrl', e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className={labelCls}>Show To</p>
            <select className={inputCls} value={form.audience} onChange={(e) => set('audience', e.target.value as BannerAudience)}>
              {(Object.keys(AUDIENCE_LABELS) as BannerAudience[]).map((a) => (
                <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>
              ))}
            </select>
          </div>
          <div>
            <p className={labelCls}>Frequency</p>
            <select className={inputCls} value={form.frequency} onChange={(e) => set('frequency', e.target.value as PopupFrequency)}>
              {(Object.keys(FREQUENCY_LABELS) as PopupFrequency[]).map((f) => (
                <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}><X className="h-4 w-4 mr-1" />Cancel</Button>
          <Button variant="primary" className="flex-1" onClick={() => onSave({ ...form, updatedAt: new Date().toISOString() })}
            disabled={form.type === 'text' ? !form.title : form.type === 'image' ? !form.imageUrl : !form.videoUrl}>
            <Save className="h-4 w-4 mr-1" />Save
          </Button>
        </div>
      </div>

      <div>
        <p className={`${labelCls} mb-2`}>Live Preview</p>
        <PopupPreview p={form} />
        <p className="text-xs text-gray-400 mt-2 flex items-center gap-1"><Expand className="h-3 w-3" />Appears as a full-screen overlay when partners open the app.</p>
      </div>
    </div>
  );
}

// ── Row components ────────────────────────────────────────────────────────────
function ItemRow<T extends { id: string; active: boolean; type: string; title: string; audience: BannerAudience; updatedAt: string; ctaUrl?: string; priority?: number; startDate?: string; endDate?: string }>({
  item, typeIcon, onToggle, onEdit, onDelete,
}: { item: T; typeIcon: React.ReactNode; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={`flex items-center gap-4 px-5 py-4 ${item.active ? 'bg-emerald-50/40' : ''}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${item.type === 'video' ? 'bg-blue-100 text-blue-600' : item.type === 'image' ? 'bg-purple-100 text-purple-600' : 'bg-gray-100 text-gray-500'}`}>
        {typeIcon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 truncate">{item.title || `${item.type} content`}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-xs text-gray-400">{AUDIENCE_LABELS[item.audience]}</span>
          {item.priority !== undefined && (
            <>
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-400">Priority {item.priority}</span>
            </>
          )}
          {(item.startDate || item.endDate) && (
            <>
              <span className="text-gray-300">·</span>
              <span className="text-xs text-gray-400">
                {item.startDate
                  ? new Date(item.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                  : '∞'
                }
                {' → '}
                {item.endDate
                  ? new Date(item.endDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                  : '∞'
                }
              </span>
            </>
          )}
          <span className="text-gray-300">·</span>
          <span className="text-xs text-gray-400">Updated {new Date(item.updatedAt).toLocaleDateString('en-IN')}</span>
        </div>
      </div>
      <Badge variant={item.active ? 'success' : 'default'}>{item.active ? 'Active' : 'Inactive'}</Badge>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={onToggle} className={`p-1.5 rounded-lg transition-colors ${item.active ? 'text-emerald-600 hover:bg-emerald-50' : 'text-gray-400 hover:bg-gray-100'}`} title={item.active ? 'Deactivate' : 'Activate'}>
          {item.active ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
        </button>
        <button onClick={onEdit} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"><Pencil className="h-4 w-4" /></button>
        {item.ctaUrl && (
          <a href={item.ctaUrl} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"><ExternalLink className="h-4 w-4" /></a>
        )}
        <button onClick={onDelete} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function BannersPage() {
  const [tab, setTab] = useState<Tab>('banners');
  const [banners, setBanners] = useState<Banner[]>([]);
  const [popups,  setPopups]  = useState<Popup[]>([]);
  const [editingBanner, setEditingBanner] = useState<Banner | null>(null);
  const [editingPopup,  setEditingPopup]  = useState<Popup | null>(null);
  const [creatingBanner, setCreatingBanner] = useState(false);
  const [creatingPopup,  setCreatingPopup]  = useState(false);

  useEffect(() => {
    fetchBanners().then(({ banners: b, popups: p }) => {
      // Merge with localStorage popups as fallback (popups not yet on API)
      setBanners(b.length > 0 ? b : []);
      setPopups(p.length > 0 ? p : loadPopups());
    });
  }, []);

  // Banner handlers
  const persistBanners = (b: Banner[]) => { setBanners(b); updateBanners({ banners: b, popups }); };
  const saveBanner = (b: Banner) => {
    persistBanners(banners.find((x) => x.id === b.id) ? banners.map((x) => x.id === b.id ? b : x) : [...banners, b]);
    setEditingBanner(null); setCreatingBanner(false);
  };
  // Multiple banners can be active simultaneously — toggle just this one
  const toggleBanner = (id: string) => persistBanners(banners.map((b) => b.id === id ? { ...b, active: !b.active } : b));
  const deleteBanner = (id: string) => persistBanners(banners.filter((b) => b.id !== id));

  // Popup handlers
  const persistPopups = (p: Popup[]) => { setPopups(p); savePopups(p); updateBanners({ banners, popups: p }); };
  const savePopup = (p: Popup) => {
    persistPopups(popups.find((x) => x.id === p.id) ? popups.map((x) => x.id === p.id ? p : x) : [...popups, p]);
    setEditingPopup(null); setCreatingPopup(false);
  };
  const togglePopup = (id: string) => persistPopups(popups.map((p) => ({ ...p, active: p.id === id ? !p.active : false })));
  const deletePopup = (id: string) => persistPopups(popups.filter((p) => p.id !== id));

  const activeBanners = getActiveBanners().filter((b) => banners.some((x) => x.id === b.id));
  const activePopup   = popups.find((p) => p.active);
  const isEditing = creatingBanner || editingBanner || creatingPopup || editingPopup;

  const typeIcon = (type: string) =>
    type === 'video' ? <Video className="h-4 w-4" /> : type === 'image' ? <Image className="h-4 w-4" /> : <Type className="h-4 w-4" />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Partner Communications</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage banners and popups shown to partners on the home screen.</p>
        </div>
        {!isEditing && (
          <Button variant="primary" onClick={() => tab === 'banners' ? setCreatingBanner(true) : setCreatingPopup(true)}>
            <Plus className="h-4 w-4 mr-1" /> New {tab === 'banners' ? 'Banner' : 'Popup'}
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        {([['banners', 'Strip Banner', LayoutDashboard], ['popups', 'Full-Screen Popup', Expand]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t as Tab)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t ? 'bg-white text-[var(--brand-primary)] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            <Icon className="h-4 w-4" />{label}
          </button>
        ))}
      </div>

      {/* ── BANNERS TAB ── */}
      {tab === 'banners' && (<>
        {(creatingBanner || editingBanner) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-800 mb-4">{editingBanner ? 'Edit Banner' : 'New Banner'}</h2>
            <BannerForm initial={editingBanner ?? newBanner()} onSave={saveBanner} onCancel={() => { setEditingBanner(null); setCreatingBanner(false); }} />
          </div>
        )}
        {activeBanners.length > 0 && !editingBanner && !creatingBanner && (
          <div className="bg-white rounded-xl border border-emerald-200 p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <p className="text-sm font-semibold text-gray-800">Currently Live</p>
              <Badge variant="success">{activeBanners.length} Active</Badge>
              <span className="text-xs text-gray-400">— partners swipe between them</span>
            </div>
            <div className="space-y-3">
              {activeBanners.map((b, i) => (
                <div key={b.id}>
                  <p className="text-xs text-gray-400 mb-1.5">#{i + 1} · Priority {b.priority}</p>
                  <BannerPreview b={b} />
                </div>
              ))}
            </div>
          </div>
        )}
        {banners.length === 0 && !creatingBanner ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3"><Type className="h-6 w-6 text-gray-400" /></div>
            <p className="text-sm font-medium text-gray-700">No banners yet</p>
            <p className="text-xs text-gray-400 mt-1">Create your first banner to engage partners.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-800">All Banners</p>
              <p className="text-xs text-gray-400">{banners.length} banner{banners.length !== 1 ? 's' : ''}</p>
            </div>
            <div className="divide-y divide-gray-50">
              {banners.map((b) => (
                <ItemRow key={b.id} item={b} typeIcon={typeIcon(b.type)} onToggle={() => toggleBanner(b.id)} onEdit={() => setEditingBanner(b)} onDelete={() => deleteBanner(b.id)} />
              ))}
            </div>
          </div>
        )}
      </>)}

      {/* ── POPUPS TAB ── */}
      {tab === 'popups' && (<>
        {(creatingPopup || editingPopup) && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-800 mb-4">{editingPopup ? 'Edit Popup' : 'New Popup'}</h2>
            <PopupForm initial={editingPopup ?? newPopup()} onSave={savePopup} onCancel={() => { setEditingPopup(null); setCreatingPopup(false); }} />
          </div>
        )}
        {activePopup && !editingPopup && !creatingPopup && (
          <div className="bg-white rounded-xl border border-emerald-200 p-5">
            <div className="flex items-center gap-2 mb-3">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <p className="text-sm font-semibold text-gray-800">Currently Live</p>
              <Badge variant="success">Active</Badge>
              <span className="text-xs text-gray-400 ml-1">· {FREQUENCY_LABELS[activePopup.frequency]}</span>
            </div>
            <PopupPreview p={activePopup} />
          </div>
        )}
        {popups.length === 0 && !creatingPopup ? (
          <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
            <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3"><Expand className="h-6 w-6 text-gray-400" /></div>
            <p className="text-sm font-medium text-gray-700">No popups yet</p>
            <p className="text-xs text-gray-400 mt-1">Create a full-screen popup for announcements or promotions.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <p className="text-sm font-semibold text-gray-800">All Popups</p>
              <p className="text-xs text-gray-400">{popups.length} popup{popups.length !== 1 ? 's' : ''}</p>
            </div>
            <div className="divide-y divide-gray-50">
              {popups.map((p) => (
                <ItemRow key={p.id} item={{ ...p, title: p.title || (p.type === 'image' ? 'Poster popup' : p.type === 'video' ? 'Video popup' : 'Text popup') }} typeIcon={typeIcon(p.type)} onToggle={() => togglePopup(p.id)} onEdit={() => setEditingPopup(p)} onDelete={() => deletePopup(p.id)} />
              ))}
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}
