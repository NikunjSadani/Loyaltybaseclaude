'use client';

import { useState, useRef, useCallback } from 'react';
import {
  Plus, Trash2, Save, Send, Archive, ChevronDown, ChevronUp,
  AlertCircle, Upload, Download, X, Users, UserCheck,
  Layers, UserCog, Shuffle, Bell, Tag, ShieldCheck,
  MessageSquare, Smartphone,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { IncentiveType, CalculationMethod, ChannelPartnerClass } from '@/types';
import { saveAdminScheme as persistAdminScheme } from '@/lib/schemes';
import { EnrollmentFormBuilder } from '@/components/admin/EnrollmentFormBuilder';
import type { EnrollmentFormConfig, FormField } from '@/lib/campaign';
import {
  validateCampaignSchemeForm,
  downloadEnhancedTemplate,
  parseEnhancedOutletExcel,
  validateNotificationConfig,
  type CampaignType,
  type NotificationFormConfig,
  type SchemeBuilderCampaignForm,
} from './scheme-builder-helpers';
import type { OutletRecord } from '@/lib/campaign';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SlabRow {
  id: string;
  from: string;
  to: string;
  rate: string;
}

interface SchemeFormData {
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  incentiveType: IncentiveType;
  calculationMethod: CalculationMethod;
  flatAmount: string;
  percentageRate: string;
  perUnitRate: string;
  slabs: SlabRow[];
  overachievementSlabs: SlabRow[];
  enableOverachievement: boolean;
  targetValue: string;
  targetQuantity: string;
  targetGrowthPct: string;
  holdingPeriodDays: string;
  applicableClasses: ChannelPartnerClass[];
  // Campaign type
  campaignType: CampaignType;
  // Outlet targeting
  outletTargeting: 'ALL' | 'SPECIFIC';
  targetedOutlets: OutletRecord[];
  // Self-registration
  requiresSelfRegistration: boolean;
  acceptDeadline: string;
  // Enrollment form
  enrollmentFormConfig: EnrollmentFormConfig;
  // Notifications
  notificationConfig: NotificationFormConfig | null;
  enableNotifications: boolean;
  // Advanced
  budgetCap: string;
  requireApprovalGate: boolean;
  tags: string[];
  tagInput: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// localStorage persistence
// ─────────────────────────────────────────────────────────────────────────────

// saveAdminScheme is imported from @/lib/schemes (see import above)

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const defaultSlab = (): SlabRow => ({
  id: Math.random().toString(36).slice(2),
  from: '', to: '', rate: '',
});

const defaultEnrollmentForm = (): EnrollmentFormConfig => ({
  captureGpsOnSubmit: false,
  requireOtp: true,
  fields: [],
});

// ─────────────────────────────────────────────────────────────────────────────
// Static lists
// ─────────────────────────────────────────────────────────────────────────────

const PARTNER_CLASSES = [
  ChannelPartnerClass.PLATINUM,
  ChannelPartnerClass.GOLD,
  ChannelPartnerClass.SILVER,
  ChannelPartnerClass.BRONZE,
  ChannelPartnerClass.STANDARD,
];

const INCENTIVE_TYPES = [
  { value: IncentiveType.SALES,           label: 'Sales Incentive'      },
  { value: IncentiveType.VISIBILITY,      label: 'Visibility Incentive' },
  { value: IncentiveType.SECONDARY_SALES, label: 'Secondary Sales'      },
  { value: IncentiveType.LOYALTY,         label: 'Loyalty Points'       },
  { value: IncentiveType.REFERRAL,        label: 'Referral Bonus'       },
  { value: IncentiveType.MILESTONE,       label: 'Milestone Achievement'},
];

const CALC_METHODS = [
  { value: CalculationMethod.FLAT,       label: 'Flat Amount'          },
  { value: CalculationMethod.PERCENTAGE, label: 'Percentage of Billing'},
  { value: CalculationMethod.SLAB,       label: 'Slab-based'           },
  { value: CalculationMethod.PER_UNIT,   label: 'Per Unit / Case'      },
];

const CLASS_COLORS: Record<ChannelPartnerClass, string> = {
  [ChannelPartnerClass.PLATINUM]: 'border-purple-300 bg-purple-50 text-purple-700',
  [ChannelPartnerClass.GOLD]:     'border-amber-300 bg-amber-50 text-amber-700',
  [ChannelPartnerClass.SILVER]:   'border-gray-300 bg-gray-50 text-gray-700',
  [ChannelPartnerClass.BRONZE]:   'border-orange-300 bg-orange-50 text-orange-700',
  [ChannelPartnerClass.STANDARD]: 'border-blue-300 bg-blue-50 text-blue-700',
};

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

interface SchemeBuilderProps {
  initialData?: Partial<SchemeFormData>;
  schemeId?: string;
  onSave?: (data: SchemeFormData) => void;
  onPublish?: (data: SchemeFormData) => void;
  onArchive?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function SchemeBuilder({ initialData, schemeId, onSave, onPublish, onArchive }: SchemeBuilderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState('');

  const [form, setForm] = useState<SchemeFormData>({
    name:                 initialData?.name ?? '',
    description:          initialData?.description ?? '',
    startDate:            initialData?.startDate ?? '',
    endDate:              initialData?.endDate ?? '',
    incentiveType:        initialData?.incentiveType ?? IncentiveType.SALES,
    calculationMethod:    initialData?.calculationMethod ?? CalculationMethod.SLAB,
    flatAmount:           initialData?.flatAmount ?? '',
    percentageRate:       initialData?.percentageRate ?? '',
    perUnitRate:          initialData?.perUnitRate ?? '',
    slabs:                initialData?.slabs ?? [defaultSlab()],
    overachievementSlabs: initialData?.overachievementSlabs ?? [defaultSlab()],
    enableOverachievement:initialData?.enableOverachievement ?? false,
    targetValue:          initialData?.targetValue ?? '',
    targetQuantity:       initialData?.targetQuantity ?? '',
    targetGrowthPct:      initialData?.targetGrowthPct ?? '',
    holdingPeriodDays:    initialData?.holdingPeriodDays ?? '30',
    applicableClasses:    initialData?.applicableClasses ?? [ChannelPartnerClass.GOLD, ChannelPartnerClass.SILVER],
    campaignType:         initialData?.campaignType ?? 'LOYALTY_ONLY',
    outletTargeting:      'ALL',
    targetedOutlets:      [],
    requiresSelfRegistration: false,
    acceptDeadline:       '',
    enrollmentFormConfig: initialData?.enrollmentFormConfig ?? defaultEnrollmentForm(),
    notificationConfig:   null,
    enableNotifications:  false,
    budgetCap:            '',
    requireApprovalGate:  false,
    tags:                 [],
    tagInput:             '',
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const [sectionsOpen, setSectionsOpen] = useState({
    campaignType:     true,
    basic:            true,
    eligibility:      true,
    outletTargeting:  true,
    enrollmentForm:   true,
    incentive:        true,
    target:           false,
    notifications:    false,
    advanced:         false,
  });

  const toggle = (section: keyof typeof sectionsOpen) =>
    setSectionsOpen((s) => ({ ...s, [section]: !s[section] }));

  const set = useCallback(<K extends keyof SchemeFormData>(key: K, value: SchemeFormData[K]) =>
    setForm((f) => ({ ...f, [key]: value })), []);

  const toggleClass = (cls: ChannelPartnerClass) => {
    const classes = form.applicableClasses.includes(cls)
      ? form.applicableClasses.filter((c) => c !== cls)
      : [...form.applicableClasses, cls];
    set('applicableClasses', classes);
  };

  const addSlab = (field: 'slabs' | 'overachievementSlabs') =>
    set(field, [...form[field], defaultSlab()]);

  const removeSlab = (field: 'slabs' | 'overachievementSlabs', id: string) =>
    set(field, form[field].filter((s) => s.id !== id));

  const updateSlab = (
    field: 'slabs' | 'overachievementSlabs',
    id: string,
    key: keyof SlabRow,
    value: string,
  ) =>
    set(field, form[field].map((s) => (s.id === id ? { ...s, [key]: value } : s)));

  // ── Excel upload ──────────────────────────────────────────────────────────

  const KYC_OUTLET_IDS = new Set<string>(); // TODO: populate from API

  const parseExcel = (file: File) => {
    setUploadError('');
    setUploadSuccess('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb   = XLSX.read(data, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });

        const { outlets, errors: rowErrors } = parseEnhancedOutletExcel(rows, KYC_OUTLET_IDS);

        if (rowErrors.length > 0 && outlets.length === 0) {
          setUploadError(`${rowErrors.length} error(s) found. First: ${rowErrors[0]}`);
          return;
        }

        set('targetedOutlets', outlets);
        setUploadSuccess(
          `${outlets.length} outlet${outlets.length !== 1 ? 's' : ''} loaded` +
          (rowErrors.length > 0 ? ` (${rowErrors.length} rows skipped)` : ''),
        );
        if (rowErrors.length > 0) {
          setUploadError(`Skipped rows: ${rowErrors.slice(0, 3).join(' | ')}${rowErrors.length > 3 ? ' …' : ''}`);
        }
      } catch {
        setUploadError('Could not read file. Upload a valid .xlsx or .csv file.');
      }
    };
    reader.readAsArrayBuffer(file);
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) parseExcel(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseExcel(file);
    e.target.value = '';
  };

  const handleTemplateDownload = () => {
    const autoFillFields = form.enrollmentFormConfig.fields
      .filter((f) => f.autoFillFromExcel)
      .map((f) => f.label);
    downloadEnhancedTemplate(autoFillFields);
  };

  // ── Enrollment form config update ─────────────────────────────────────────

  const handleEnrollmentFormChange = useCallback((config: EnrollmentFormConfig) => {
    set('enrollmentFormConfig', config);
  }, [set]);

  // ── Tags ──────────────────────────────────────────────────────────────────

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !form.tags.includes(tag)) {
      set('tags', [...form.tags, tag]);
    }
    set('tagInput', '');
  };

  const removeTag = (tag: string) =>
    set('tags', form.tags.filter((t) => t !== tag));

  // ── Validation ────────────────────────────────────────────────────────────

  const validate = (): boolean => {
    // Build a SchemeBuilderCampaignForm for the helper
    const helperForm: SchemeBuilderCampaignForm = {
      name:                  form.name,
      startDate:             form.startDate,
      endDate:               form.endDate,
      campaignType:          form.campaignType,
      applicableClasses:     form.applicableClasses,
      calculationMethod:     form.calculationMethod,
      flatAmount:            form.flatAmount,
      holdingPeriodDays:     form.holdingPeriodDays,
      outletTargeting:       form.outletTargeting,
      targetedOutlets:       form.targetedOutlets,
      requiresSelfRegistration: form.requiresSelfRegistration,
      acceptDeadline:        form.acceptDeadline,
      enrollmentFormFields:  form.enrollmentFormConfig.fields,
      captureGpsOnSubmit:    form.enrollmentFormConfig.captureGpsOnSubmit,
      requireOtp:            form.enrollmentFormConfig.requireOtp,
      notificationConfig:    form.enableNotifications ? form.notificationConfig : null,
      budgetCap:             form.budgetCap,
      requireApprovalGate:   form.requireApprovalGate,
      tags:                  form.tags,
    };

    const validationErrors = validateCampaignSchemeForm(helperForm);
    const notifErrors      = validateNotificationConfig(
      form.enableNotifications ? form.notificationConfig : null,
    );

    // Extra incentive validation
    if (form.calculationMethod === CalculationMethod.FLAT && !form.flatAmount) {
      validationErrors.push({ field: 'flatAmount', message: 'Enter flat amount.' });
    }
    if (form.calculationMethod === CalculationMethod.PERCENTAGE && !form.percentageRate) {
      validationErrors.push({ field: 'percentageRate', message: 'Enter percentage rate.' });
    }
    if (!form.holdingPeriodDays) {
      validationErrors.push({ field: 'holdingPeriodDays', message: 'Holding period is required.' });
    }

    const errorMap: Record<string, string> = {};
    for (const e of validationErrors) errorMap[e.field] = e.message;
    for (const msg of notifErrors)    errorMap['notificationConfig'] = msg;

    setErrors(errorMap);
    return Object.keys(errorMap).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    onSave?.(form);
    setSaving(false);
  };

  const handlePublish = async () => {
    if (!validate()) return;
    setPublishing(true);
    await new Promise((r) => setTimeout(r, 1000));

    const startFmt = form.startDate ? new Date(form.startDate).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : '';
    const endFmt   = form.endDate   ? new Date(form.endDate).toLocaleDateString('en-IN',   { month: 'short', year: '2-digit' }) : '';
    const now = new Date();
    const start = form.startDate ? new Date(form.startDate) : null;
    const end   = form.endDate   ? new Date(form.endDate)   : null;
    const derivedStatus = !start ? 'DRAFT'
      : now < start ? 'UPCOMING'
      : end && now > end ? 'EXPIRED'
      : 'ACTIVE';

    // Always persist to the shared scheme store regardless of self-registration flag
    persistAdminScheme({
      id:                       schemeId ?? `sch_${Date.now()}`,
      name:                     form.name,
      description:              form.description,
      period:                   startFmt && endFmt ? `${startFmt} – ${endFmt}` : '',
      startDate:                form.startDate,
      endDate:                  form.endDate,
      acceptDeadline:           form.acceptDeadline,
      outletTargeting:          form.outletTargeting,
      targetedOutletIds:        form.targetedOutlets.map((o) => o.outletId),
      requiresSelfRegistration: form.requiresSelfRegistration,
      publishedAt:              new Date().toISOString(),
      // Enriched display fields
      status:                   derivedStatus,
      incentiveType:            form.incentiveType,
      calculationMethod:        form.calculationMethod,
      applicableClasses:        form.applicableClasses,
      partnersEnrolled:         0,
      totalPayout:              '—',
    });

    onPublish?.(form);
    setPublishing(false);
  };

  // ── Sub-components ────────────────────────────────────────────────────────

  const SlabTable = ({
    field, label, unit,
  }: { field: 'slabs' | 'overachievementSlabs'; label: string; unit: string }) => (
    <div>
      <h4 className="text-xs font-semibold text-gray-600 mb-2">{label}</h4>
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left text-gray-500 font-medium">From ({unit})</th>
              <th className="px-3 py-2 text-left text-gray-500 font-medium">To ({unit})</th>
              <th className="px-3 py-2 text-left text-gray-500 font-medium">
                {form.calculationMethod === CalculationMethod.PERCENTAGE ? 'Rate (%)' : 'Points / ₹'}
              </th>
              <th className="px-3 py-2 w-10"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {form[field].map((slab, idx) => (
              <tr key={slab.id} className="hover:bg-gray-50">
                <td className="px-2 py-1.5">
                  <input type="number" value={slab.from}
                    onChange={(e) => updateSlab(field, slab.id, 'from', e.target.value)}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input type="number" value={slab.to}
                    onChange={(e) => updateSlab(field, slab.id, 'to', e.target.value)}
                    placeholder={idx === form[field].length - 1 ? '∞' : ''}
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input type="number" value={slab.rate}
                    onChange={(e) => updateSlab(field, slab.id, 'rate', e.target.value)}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  {form[field].length > 1 && (
                    <button onClick={() => removeSlab(field, slab.id)}
                      className="p-1 text-gray-400 hover:text-red-500 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={() => addSlab(field)}
        className="mt-2 flex items-center gap-1 text-xs text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] font-medium">
        <Plus className="w-3.5 h-3.5" /> Add Slab Row
      </button>
    </div>
  );

  const SectionHeader = ({
    title, section, badge,
  }: { title: string; section: keyof typeof sectionsOpen; badge?: React.ReactNode }) => (
    <button
      onClick={() => toggle(section)}
      className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors rounded-t-xl border-b border-gray-200"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-800">{title}</span>
        {badge}
      </div>
      {sectionsOpen[section]
        ? <ChevronUp className="w-4 h-4 text-gray-500" />
        : <ChevronDown className="w-4 h-4 text-gray-500" />}
    </button>
  );

  const Toggle = ({
    value, onChange, label, description,
  }: { value: boolean; onChange: (v: boolean) => void; label: string; description?: string }) => (
    <label className="flex items-start gap-3 cursor-pointer">
      <div
        onClick={() => onChange(!value)}
        className={`w-10 h-5 rounded-full transition-colors mt-0.5 ${value ? 'bg-[var(--brand-primary)]' : 'bg-gray-200'} relative shrink-0`}
      >
        <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow ${value ? 'left-5' : 'left-0.5'}`} />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-800">{label}</p>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
    </label>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  const showEligibility    = form.campaignType === 'LOYALTY_ONLY' || form.campaignType === 'MIXED';
  const showEnrollmentForm = form.campaignType === 'OPEN_CAMPAIGN' || form.campaignType === 'MIXED';

  return (
    <div className="space-y-4">

      {/* ── 1. Campaign Type ─────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Campaign Type" section="campaignType" />
        {sectionsOpen.campaignType && (
          <div className="p-4">
            <p className="text-xs text-gray-500 mb-3">
              Choose how outlets participate in this scheme. This drives which sections appear below.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {([
                {
                  value: 'LOYALTY_ONLY' as CampaignType,
                  Icon: Layers,
                  label: 'Loyalty Only',
                  desc: 'Existing KYC-approved loyalty partners. Auto-enrolled based on partner class.',
                  color: 'border-amber-300 bg-amber-50 text-amber-700',
                  iconBg: 'bg-amber-100 text-amber-700',
                },
                {
                  value: 'OPEN_CAMPAIGN' as CampaignType,
                  Icon: UserCog,
                  label: 'Open Campaign',
                  desc: 'Any outlet — KYC or non-KYC. Enrollment form required. Sales team or self-enroll.',
                  color: 'border-blue-300 bg-blue-50 text-blue-700',
                  iconBg: 'bg-blue-100 text-blue-700',
                },
                {
                  value: 'MIXED' as CampaignType,
                  Icon: Shuffle,
                  label: 'Mixed',
                  desc: 'Loyalty partners get auto-enrolled. Non-KYC outlets go through enrollment form.',
                  color: 'border-purple-300 bg-purple-50 text-purple-700',
                  iconBg: 'bg-purple-100 text-purple-700',
                },
              ]).map(({ value, Icon, label, desc, color, iconBg }) => {
                const active = form.campaignType === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => set('campaignType', value)}
                    className={`flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                      active ? color : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}
                  >
                    <div className={`p-2 rounded-lg shrink-0 ${active ? iconBg : 'bg-gray-100 text-gray-500'}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${active ? '' : 'text-gray-800'}`}>{label}</p>
                      <p className={`text-xs mt-0.5 ${active ? 'opacity-80' : 'text-gray-500'}`}>{desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── 2. Basic Info ─────────────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Basic Information" section="basic" />
        {sectionsOpen.basic && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Scheme Name <span className="text-red-500">*</span>
              </label>
              <input type="text" value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Summer Push Q1 2025"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              />
              {errors.name && <p className="text-xs text-red-500 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{errors.name}</p>}
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
              <textarea value={form.description}
                onChange={(e) => set('description', e.target.value)}
                rows={2}
                placeholder="Brief description of the scheme objective..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] resize-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Incentive Type <span className="text-red-500">*</span>
              </label>
              <select value={form.incentiveType}
                onChange={(e) => set('incentiveType', e.target.value as IncentiveType)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              >
                {INCENTIVE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Scheme Tags</label>
              <div className="flex flex-wrap gap-1.5 mb-1.5">
                {form.tags.map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 text-xs font-medium">
                    <Tag className="w-3 h-3" />
                    {tag}
                    <button onClick={() => removeTag(tag)} className="ml-0.5 text-gray-400 hover:text-red-500">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input type="text" value={form.tagInput}
                  onChange={(e) => set('tagInput', e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(form.tagInput); }}}
                  placeholder="Type and press Enter"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
                <button type="button" onClick={() => addTag(form.tagInput)}
                  className="px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg text-xs hover:bg-gray-200 transition-colors">
                  Add
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Start Date <span className="text-red-500">*</span>
              </label>
              <input type="date" value={form.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              />
              {errors.startDate && <p className="text-xs text-red-500 mt-1">{errors.startDate}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                End Date <span className="text-red-500">*</span>
              </label>
              <input type="date" value={form.endDate}
                onChange={(e) => set('endDate', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
              />
              {errors.endDate && <p className="text-xs text-red-500 mt-1">{errors.endDate}</p>}
            </div>
          </div>
        )}
      </div>

      {/* ── 3. Partner Eligibility (LOYALTY_ONLY / MIXED) ────────────────── */}
      {showEligibility && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <SectionHeader title="Partner Eligibility" section="eligibility" />
          {sectionsOpen.eligibility && (
            <div className="p-4">
              <p className="text-xs text-gray-500 mb-3">Select which partner classes are eligible:</p>
              <div className="flex flex-wrap gap-3">
                {PARTNER_CLASSES.map((cls) => {
                  const checked = form.applicableClasses.includes(cls);
                  return (
                    <label key={cls}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 cursor-pointer transition-all text-sm font-medium ${
                        checked ? CLASS_COLORS[cls] : 'border-gray-200 bg-white text-gray-500'
                      }`}>
                      <input type="checkbox" checked={checked}
                        onChange={() => toggleClass(cls)} className="sr-only" />
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center ${checked ? 'border-current bg-current' : 'border-gray-300'}`}>
                        {checked && (
                          <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 10 10" fill="none">
                            <path d="M1.5 5L4 7.5L8.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                      {cls}
                    </label>
                  );
                })}
              </div>
              {errors.applicableClasses && (
                <p className="text-xs text-red-500 mt-2 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />{errors.applicableClasses}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 4. Outlet Targeting & Self-Registration ───────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader
          title="Outlet Targeting & Self-Registration"
          section="outletTargeting"
          badge={
            form.targetedOutlets.length > 0
              ? <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-semibold">{form.targetedOutlets.length} outlets</span>
              : undefined
          }
        />
        {sectionsOpen.outletTargeting && (
          <div className="p-4 space-y-5">
            {/* Mode */}
            <div>
              <p className="text-xs font-semibold text-gray-700 mb-3">Which outlets should this scheme apply to?</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {([
                  { value: 'ALL',      Icon: Users,     label: 'All eligible outlets',  desc: 'All outlets matching criteria' },
                  { value: 'SPECIFIC', Icon: UserCheck, label: 'Specific outlets only', desc: 'Upload Excel with outlet IDs'   },
                ] as const).map(({ value, Icon, label, desc }) => (
                  <button key={value} type="button" onClick={() => set('outletTargeting', value)}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all ${
                      form.outletTargeting === value ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <div className={`p-1.5 rounded-lg shrink-0 ${form.outletTargeting === value ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-500'}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <p className={`text-sm font-semibold ${form.outletTargeting === value ? 'text-[var(--brand-primary)]' : 'text-gray-800'}`}>{label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Excel upload */}
            {form.outletTargeting === 'SPECIFIC' && (
              <div className="space-y-3">
                {/* Info about the new multi-column format */}
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
                  <strong>Enhanced format:</strong> The template now supports multi-column outlet data —
                  outlet_id, outlet_name, outlet_type, state, city, pincode, assigned_employee_id, plus any
                  auto-fill form fields. KYC outlets need only outlet_id + assigned_employee_id.
                  Non-KYC outlets require all standard fields.
                </div>

                {/* Drop zone */}
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={handleFileDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                    dragOver ? 'border-[var(--brand-primary)] bg-green-50' : 'border-gray-300 hover:border-gray-400 bg-gray-50'
                  }`}
                >
                  <Upload className="w-6 h-6 text-gray-400 mx-auto mb-2" />
                  <p className="text-sm font-medium text-gray-700">Drop your Excel file here</p>
                  <p className="text-xs text-gray-400 mt-0.5">or click to browse · .xlsx or .csv</p>
                  <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
                    className="hidden" onChange={handleFileChange} />
                </div>

                {/* Template download */}
                <button type="button" onClick={handleTemplateDownload}
                  className="flex items-center gap-2 text-xs font-medium text-[var(--brand-primary)] hover:text-[var(--brand-primary-dark)] transition-colors">
                  <Download className="w-3.5 h-3.5" />
                  Download template (.xlsx)
                  {form.enrollmentFormConfig.fields.filter((f) => f.autoFillFromExcel).length > 0 && (
                    <span className="text-gray-400">(includes {form.enrollmentFormConfig.fields.filter((f) => f.autoFillFromExcel).length} auto-fill columns)</span>
                  )}
                </button>

                {/* Status messages */}
                {uploadSuccess && (
                  <p className="text-xs text-green-600 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
                    {uploadSuccess}
                  </p>
                )}
                {uploadError && (
                  <p className="text-xs text-amber-600 flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{uploadError}
                  </p>
                )}

                {/* Preview table */}
                {form.targetedOutlets.length > 0 && (
                  <div className="border border-green-200 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 bg-green-50 border-b border-green-200">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-semibold text-green-800">
                          {form.targetedOutlets.length} outlet{form.targetedOutlets.length !== 1 ? 's' : ''} loaded
                        </p>
                        <span className="text-xs text-green-600">
                          ({form.targetedOutlets.filter((o) => o.isKycEnrolled).length} KYC,{' '}
                          {form.targetedOutlets.filter((o) => !o.isKycEnrolled).length} non-KYC)
                        </span>
                      </div>
                      <button type="button"
                        onClick={() => { set('targetedOutlets', []); setUploadSuccess(''); setUploadError(''); }}
                        className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600 font-medium">
                        <X className="w-3 h-3" /> Clear
                      </button>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">#</th>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">Outlet ID</th>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">Name</th>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">Type</th>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">State</th>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">Employee</th>
                            <th className="px-3 py-2 text-left text-gray-500 font-medium">KYC</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {form.targetedOutlets.slice(0, 100).map((outlet, i) => (
                            <tr key={outlet.outletId} className="hover:bg-gray-50">
                              <td className="px-3 py-1.5 text-gray-400">{i + 1}</td>
                              <td className="px-3 py-1.5 font-mono text-gray-800">{outlet.outletId}</td>
                              <td className="px-3 py-1.5 text-gray-700">{outlet.outletName || <span className="text-gray-400 italic">from system</span>}</td>
                              <td className="px-3 py-1.5 text-gray-600">{outlet.outletType}</td>
                              <td className="px-3 py-1.5 text-gray-600">{outlet.state || '—'}</td>
                              <td className="px-3 py-1.5 font-mono text-gray-600">{outlet.assignedEmployeeId ?? <span className="text-amber-500">untagged</span>}</td>
                              <td className="px-3 py-1.5">
                                {outlet.isKycEnrolled
                                  ? <span className="text-green-600 font-medium">✓</span>
                                  : <span className="text-gray-400 font-medium">—</span>}
                              </td>
                            </tr>
                          ))}
                          {form.targetedOutlets.length > 100 && (
                            <tr>
                              <td colSpan={7} className="px-3 py-2 text-center text-xs text-gray-400">
                                + {form.targetedOutlets.length - 100} more
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {errors.targetedOutlets && (
                  <p className="text-xs text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />{errors.targetedOutlets}
                  </p>
                )}
              </div>
            )}

            {/* Self-registration */}
            <div className="border-t border-gray-100 pt-4 space-y-3">
              <Toggle
                value={form.requiresSelfRegistration}
                onChange={(v) => set('requiresSelfRegistration', v)}
                label="Allow self-registration"
                description="Eligible outlets see this scheme on their home screen and can accept to participate"
              />
              {form.requiresSelfRegistration && (
                <div className="ml-13 pl-1 space-y-2">
                  <div className="max-w-xs">
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Accept by <span className="text-red-500">*</span>
                    </label>
                    <input type="date" value={form.acceptDeadline}
                      onChange={(e) => set('acceptDeadline', e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                    />
                    {errors.acceptDeadline && (
                      <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />{errors.acceptDeadline}
                      </p>
                    )}
                  </div>
                  <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    <p className="text-xs text-amber-700">
                      Outlets that don't accept by the deadline will not be enrolled.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 5. Enrollment Form Builder (OPEN_CAMPAIGN / MIXED) ───────────── */}
      {showEnrollmentForm && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <SectionHeader
            title="Enrollment Form"
            section="enrollmentForm"
            badge={
              form.enrollmentFormConfig.fields.length > 0
                ? <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-xs font-semibold">
                    {form.enrollmentFormConfig.fields.length} field{form.enrollmentFormConfig.fields.length !== 1 ? 's' : ''}
                  </span>
                : <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-medium">Required</span>
            }
          />
          {sectionsOpen.enrollmentForm && (
            <div className="p-4">
              {errors.enrollmentFormFields && (
                <p className="text-xs text-red-500 mb-3 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />{errors.enrollmentFormFields}
                </p>
              )}
              <EnrollmentFormBuilder
                config={form.enrollmentFormConfig}
                onChange={handleEnrollmentFormChange}
                showAutoFill={form.outletTargeting === 'SPECIFIC'}
              />
            </div>
          )}
        </div>
      )}

      {/* ── 6. Incentive Calculation ──────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Incentive Calculation" section="incentive" />
        {sectionsOpen.incentive && (
          <div className="p-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Calculation Method <span className="text-red-500">*</span>
              </label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {CALC_METHODS.map((m) => (
                  <button key={m.value} onClick={() => set('calculationMethod', m.value)}
                    className={`py-2.5 px-3 rounded-lg text-xs font-medium border-2 transition-all ${
                      form.calculationMethod === m.value
                        ? 'border-[var(--brand-primary)] bg-green-50 text-[var(--brand-primary)]'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {form.calculationMethod === CalculationMethod.FLAT && (
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-gray-700 mb-1">Flat Amount (₹) <span className="text-red-500">*</span></label>
                <input type="number" value={form.flatAmount}
                  onChange={(e) => set('flatAmount', e.target.value)}
                  placeholder="500"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
                {errors.flatAmount && <p className="text-xs text-red-500 mt-1">{errors.flatAmount}</p>}
              </div>
            )}

            {form.calculationMethod === CalculationMethod.PERCENTAGE && (
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-gray-700 mb-1">Rate (% of billing) <span className="text-red-500">*</span></label>
                <input type="number" value={form.percentageRate}
                  onChange={(e) => set('percentageRate', e.target.value)}
                  placeholder="2.5" step="0.1" min="0" max="100"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
                {errors.percentageRate && <p className="text-xs text-red-500 mt-1">{errors.percentageRate}</p>}
              </div>
            )}

            {form.calculationMethod === CalculationMethod.PER_UNIT && (
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-gray-700 mb-1">Rate per Unit / Case (₹)</label>
                <input type="number" value={form.perUnitRate}
                  onChange={(e) => set('perUnitRate', e.target.value)}
                  placeholder="10"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
              </div>
            )}

            {form.calculationMethod === CalculationMethod.SLAB && (
              <SlabTable field="slabs" label="Incentive Slabs" unit="₹" />
            )}

            {/* Overachievement */}
            <div className="border-t border-gray-100 pt-4">
              <Toggle
                value={form.enableOverachievement}
                onChange={(v) => set('enableOverachievement', v)}
                label="Enable Overachievement Slabs"
              />
              {form.enableOverachievement && (
                <div className="mt-3">
                  <SlabTable field="overachievementSlabs" label="Overachievement Slabs (above target)" unit="₹" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 7. Target Configuration ───────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Target Configuration" section="target" />
        {sectionsOpen.target && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { key: 'targetValue',      label: 'Value Target (₹ Lakh)', placeholder: '25',  hint: 'Minimum billing value' },
              { key: 'targetQuantity',   label: 'Quantity Target (Cases)', placeholder: '500', hint: 'Minimum case quantity' },
              { key: 'targetGrowthPct',  label: 'Growth Target (%)',       placeholder: '15',  hint: 'vs. previous period'   },
            ].map(({ key, label, placeholder, hint }) => (
              <div key={key}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
                <input type="number"
                  value={form[key as keyof SchemeFormData] as string}
                  onChange={(e) => set(key as keyof SchemeFormData, e.target.value as never)}
                  placeholder={placeholder}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
                <p className="text-xs text-gray-400 mt-1">{hint}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 8. Notifications (MSG91) ─────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader
          title="Notifications (MSG91)"
          section="notifications"
          badge={
            form.enableNotifications
              ? <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-semibold">Enabled</span>
              : undefined
          }
        />
        {sectionsOpen.notifications && (
          <div className="p-4 space-y-4">
            <Toggle
              value={form.enableNotifications}
              onChange={(v) => {
                set('enableNotifications', v);
                if (v && !form.notificationConfig) {
                  set('notificationConfig', {
                    whatsappTemplateId: '',
                    smsTemplateId: '',
                    variableMapping: {},
                    otpRequired: true,
                  });
                }
              }}
              label="Send notifications via MSG91"
              description="Send WhatsApp / SMS to outlets when the scheme goes live and when they enroll"
            />

            {form.enableNotifications && form.notificationConfig && (
              <div className="space-y-4 pt-2">
                {/* WhatsApp */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5 text-green-600" />
                      WhatsApp Template ID
                    </label>
                    <input type="text"
                      value={form.notificationConfig.whatsappTemplateId}
                      onChange={(e) => set('notificationConfig', { ...form.notificationConfig!, whatsappTemplateId: e.target.value })}
                      placeholder="e.g. tmpl_abc123"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                    />
                    <p className="text-xs text-gray-400 mt-1">WhatsApp template registered with MSG91</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                      <Smartphone className="w-3.5 h-3.5 text-blue-600" />
                      SMS Template ID
                    </label>
                    <input type="text"
                      value={form.notificationConfig.smsTemplateId}
                      onChange={(e) => set('notificationConfig', { ...form.notificationConfig!, smsTemplateId: e.target.value })}
                      placeholder="e.g. sms_xyz789"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                    />
                    <p className="text-xs text-gray-400 mt-1">Fallback SMS template if WhatsApp unavailable</p>
                  </div>
                </div>

                {errors.notificationConfig && (
                  <p className="text-xs text-red-500 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />{errors.notificationConfig}
                  </p>
                )}

                {/* OTP */}
                <div className="border-t border-gray-100 pt-3">
                  <Toggle
                    value={form.notificationConfig.otpRequired}
                    onChange={(v) => set('notificationConfig', { ...form.notificationConfig!, otpRequired: v })}
                    label="Require OTP verification during enrollment"
                    description="An OTP is sent to the outlet's registered mobile number via MSG91 before the form can be submitted"
                  />
                </div>

                {/* Variable mapping hint */}
                <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
                  <p className="text-xs text-blue-700 font-medium mb-1">Template variable mapping</p>
                  <p className="text-xs text-blue-600">
                    Use <code className="bg-blue-100 px-1 rounded">{'{{1}}'}</code> for Outlet Name,{' '}
                    <code className="bg-blue-100 px-1 rounded">{'{{2}}'}</code> for Scheme Name,{' '}
                    <code className="bg-blue-100 px-1 rounded">{'{{3}}'}</code> for OTP (when OTP enabled).
                    Configure MSG91 template variables to match these positions.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 9. Advanced Settings ──────────────────────────────────────────── */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Advanced Settings" section="advanced" />
        {sectionsOpen.advanced && (
          <div className="p-4 space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Holding period */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Holding Period (Days) <span className="text-red-500">*</span>
                </label>
                <input type="number" value={form.holdingPeriodDays}
                  onChange={(e) => set('holdingPeriodDays', e.target.value)}
                  min="0" max="365"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
                <p className="text-xs text-gray-400 mt-1">Points locked for this many days before becoming redeemable</p>
                {errors.holdingPeriodDays && <p className="text-xs text-red-500 mt-1">{errors.holdingPeriodDays}</p>}
              </div>

              {/* Budget cap */}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Budget Cap (₹)</label>
                <input type="number" value={form.budgetCap}
                  onChange={(e) => set('budgetCap', e.target.value)}
                  placeholder="Leave blank for no cap"
                  min="1"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]"
                />
                <p className="text-xs text-gray-400 mt-1">Scheme auto-pauses when total payout reaches this limit</p>
                {errors.budgetCap && <p className="text-xs text-red-500 mt-1">{errors.budgetCap}</p>}
              </div>
            </div>

            {/* Approval gate */}
            <div className="border-t border-gray-100 pt-4">
              <Toggle
                value={form.requireApprovalGate}
                onChange={(v) => set('requireApprovalGate', v)}
                label="Require approval before payout"
                description={
                  form.requireApprovalGate
                    ? "Enrollments go into PENDING state. Gifsy Admin must approve each batch before payouts are triggered."
                    : "Enrollments are auto-approved and payouts are triggered immediately after the holding period."
                }
              />
              {form.requireApprovalGate && (
                <div className="mt-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  <p className="text-xs text-amber-700 flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                    All enrollments will require manual approval by Gifsy Admin before disbursement.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Action Buttons ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between pt-2">
        <div>
          {schemeId && (
            <button onClick={onArchive}
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
              <Archive className="w-4 h-4" /> Archive Scheme
            </button>
          )}
        </div>
        <div className="flex gap-3">
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium border border-[var(--brand-primary)] text-[var(--brand-primary)] rounded-lg hover:bg-green-50 transition-colors disabled:opacity-60">
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Draft'}
          </button>
          <button onClick={handlePublish} disabled={publishing}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[var(--brand-primary)] text-white rounded-lg hover:bg-[var(--brand-primary-dark)] transition-colors disabled:opacity-60">
            <Send className="w-4 h-4" />
            {publishing ? 'Publishing...' : 'Publish Scheme'}
          </button>
        </div>
      </div>
    </div>
  );
}
