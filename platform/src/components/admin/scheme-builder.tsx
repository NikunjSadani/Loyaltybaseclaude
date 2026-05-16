'use client';

import { useState } from 'react';
import { Plus, Trash2, Save, Send, Archive, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';
import { IncentiveType, CalculationMethod, ChannelPartnerClass } from '@/types';

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
}

const defaultSlab = (): SlabRow => ({
  id: Math.random().toString(36).slice(2),
  from: '',
  to: '',
  rate: '',
});

const PARTNER_CLASSES = [
  ChannelPartnerClass.PLATINUM,
  ChannelPartnerClass.GOLD,
  ChannelPartnerClass.SILVER,
  ChannelPartnerClass.BRONZE,
  ChannelPartnerClass.STANDARD,
];

const INCENTIVE_TYPES = [
  { value: IncentiveType.SALES, label: 'Sales Incentive' },
  { value: IncentiveType.VISIBILITY, label: 'Visibility Incentive' },
  { value: IncentiveType.SECONDARY_SALES, label: 'Secondary Sales' },
  { value: IncentiveType.LOYALTY, label: 'Loyalty Points' },
  { value: IncentiveType.REFERRAL, label: 'Referral Bonus' },
  { value: IncentiveType.MILESTONE, label: 'Milestone Achievement' },
];

const CALC_METHODS = [
  { value: CalculationMethod.FLAT, label: 'Flat Amount' },
  { value: CalculationMethod.PERCENTAGE, label: 'Percentage of Billing' },
  { value: CalculationMethod.SLAB, label: 'Slab-based' },
  { value: CalculationMethod.PER_UNIT, label: 'Per Unit / Case' },
];

interface SchemeBuilderProps {
  initialData?: Partial<SchemeFormData>;
  schemeId?: string;
  onSave?: (data: SchemeFormData) => void;
  onPublish?: (data: SchemeFormData) => void;
  onArchive?: () => void;
}

export function SchemeBuilder({ initialData, schemeId, onSave, onPublish, onArchive }: SchemeBuilderProps) {
  const [form, setForm] = useState<SchemeFormData>({
    name: initialData?.name ?? '',
    description: initialData?.description ?? '',
    startDate: initialData?.startDate ?? '',
    endDate: initialData?.endDate ?? '',
    incentiveType: initialData?.incentiveType ?? IncentiveType.SALES,
    calculationMethod: initialData?.calculationMethod ?? CalculationMethod.SLAB,
    flatAmount: initialData?.flatAmount ?? '',
    percentageRate: initialData?.percentageRate ?? '',
    perUnitRate: initialData?.perUnitRate ?? '',
    slabs: initialData?.slabs ?? [defaultSlab()],
    overachievementSlabs: initialData?.overachievementSlabs ?? [defaultSlab()],
    enableOverachievement: initialData?.enableOverachievement ?? false,
    targetValue: initialData?.targetValue ?? '',
    targetQuantity: initialData?.targetQuantity ?? '',
    targetGrowthPct: initialData?.targetGrowthPct ?? '',
    holdingPeriodDays: initialData?.holdingPeriodDays ?? '30',
    applicableClasses: initialData?.applicableClasses ?? [ChannelPartnerClass.GOLD, ChannelPartnerClass.SILVER],
  });

  const [errors, setErrors] = useState<Partial<Record<keyof SchemeFormData, string>>>({});
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState({
    basic: true,
    eligibility: true,
    incentive: true,
    target: true,
    advanced: false,
  });

  const toggle = (section: keyof typeof sectionsOpen) =>
    setSectionsOpen((s) => ({ ...s, [section]: !s[section] }));

  const set = <K extends keyof SchemeFormData>(key: K, value: SchemeFormData[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

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
    value: string
  ) =>
    set(
      field,
      form[field].map((s) => (s.id === id ? { ...s, [key]: value } : s))
    );

  const validate = (): boolean => {
    const e: typeof errors = {};
    if (!form.name.trim()) e.name = 'Scheme name is required';
    if (!form.startDate) e.startDate = 'Start date is required';
    if (!form.endDate) e.endDate = 'End date is required';
    if (form.startDate && form.endDate && form.startDate >= form.endDate)
      e.endDate = 'End date must be after start date';
    if (form.applicableClasses.length === 0) e.applicableClasses = 'Select at least one partner class';
    if (form.calculationMethod === CalculationMethod.FLAT && !form.flatAmount)
      e.flatAmount = 'Enter flat amount';
    if (form.calculationMethod === CalculationMethod.PERCENTAGE && !form.percentageRate)
      e.percentageRate = 'Enter percentage rate';
    if (!form.holdingPeriodDays) e.holdingPeriodDays = 'Holding period is required';
    setErrors(e);
    return Object.keys(e).length === 0;
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
    onPublish?.(form);
    setPublishing(false);
  };

  const SlabTable = ({
    field,
    label,
    unit,
  }: {
    field: 'slabs' | 'overachievementSlabs';
    label: string;
    unit: string;
  }) => (
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
                  <input
                    type="number"
                    value={slab.from}
                    onChange={(e) => updateSlab(field, slab.id, 'from', e.target.value)}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#C8102E]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    value={slab.to}
                    onChange={(e) => updateSlab(field, slab.id, 'to', e.target.value)}
                    placeholder={idx === form[field].length - 1 ? '∞' : ''}
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#C8102E]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    value={slab.rate}
                    onChange={(e) => updateSlab(field, slab.id, 'rate', e.target.value)}
                    placeholder="0"
                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#C8102E]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  {form[field].length > 1 && (
                    <button
                      onClick={() => removeSlab(field, slab.id)}
                      className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={() => addSlab(field)}
        className="mt-2 flex items-center gap-1 text-xs text-[#C8102E] hover:text-[#a00d25] font-medium"
      >
        <Plus className="w-3.5 h-3.5" />
        Add Slab Row
      </button>
    </div>
  );

  const SectionHeader = ({
    title,
    section,
  }: {
    title: string;
    section: keyof typeof sectionsOpen;
  }) => (
    <button
      onClick={() => toggle(section)}
      className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors rounded-t-xl border-b border-gray-200"
    >
      <span className="text-sm font-semibold text-gray-800">{title}</span>
      {sectionsOpen[section] ? (
        <ChevronUp className="w-4 h-4 text-gray-500" />
      ) : (
        <ChevronDown className="w-4 h-4 text-gray-500" />
      )}
    </button>
  );

  return (
    <div className="space-y-4">
      {/* Basic Info */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Basic Information" section="basic" />
        {sectionsOpen.basic && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Scheme Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Summer Push Q1 2025"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              {errors.name && (
                <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {errors.name}
                </p>
              )}
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                rows={2}
                placeholder="Brief description of the scheme objective..."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E] resize-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Incentive Type <span className="text-red-500">*</span>
              </label>
              <select
                value={form.incentiveType}
                onChange={(e) => set('incentiveType', e.target.value as IncentiveType)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              >
                {INCENTIVE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Start Date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              {errors.startDate && <p className="text-xs text-red-500 mt-1">{errors.startDate}</p>}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                End Date <span className="text-red-500">*</span>
              </label>
              <input
                type="date"
                value={form.endDate}
                onChange={(e) => set('endDate', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              {errors.endDate && <p className="text-xs text-red-500 mt-1">{errors.endDate}</p>}
            </div>
          </div>
        )}
      </div>

      {/* Eligibility */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Partner Eligibility" section="eligibility" />
        {sectionsOpen.eligibility && (
          <div className="p-4">
            <p className="text-xs text-gray-500 mb-3">
              Select which partner classes are eligible for this scheme:
            </p>
            <div className="flex flex-wrap gap-3">
              {PARTNER_CLASSES.map((cls) => {
                const checked = form.applicableClasses.includes(cls);
                const colors: Record<ChannelPartnerClass, string> = {
                  [ChannelPartnerClass.PLATINUM]: 'border-purple-300 bg-purple-50 text-purple-700',
                  [ChannelPartnerClass.GOLD]: 'border-amber-300 bg-amber-50 text-amber-700',
                  [ChannelPartnerClass.SILVER]: 'border-gray-300 bg-gray-50 text-gray-700',
                  [ChannelPartnerClass.BRONZE]: 'border-orange-300 bg-orange-50 text-orange-700',
                  [ChannelPartnerClass.STANDARD]: 'border-blue-300 bg-blue-50 text-blue-700',
                };
                return (
                  <label
                    key={cls}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 cursor-pointer transition-all text-sm font-medium ${
                      checked ? colors[cls] : 'border-gray-200 bg-white text-gray-500'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleClass(cls)}
                      className="sr-only"
                    />
                    <div
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                        checked ? 'border-current bg-current' : 'border-gray-300'
                      }`}
                    >
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
                <AlertCircle className="w-3 h-3" /> {errors.applicableClasses}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Incentive Calculation */}
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
                  <button
                    key={m.value}
                    onClick={() => set('calculationMethod', m.value)}
                    className={`py-2.5 px-3 rounded-lg text-xs font-medium border-2 transition-all ${
                      form.calculationMethod === m.value
                        ? 'border-[#C8102E] bg-red-50 text-[#C8102E]'
                        : 'border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {form.calculationMethod === CalculationMethod.FLAT && (
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Flat Amount (₹) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={form.flatAmount}
                  onChange={(e) => set('flatAmount', e.target.value)}
                  placeholder="500"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
                />
                {errors.flatAmount && <p className="text-xs text-red-500 mt-1">{errors.flatAmount}</p>}
              </div>
            )}

            {form.calculationMethod === CalculationMethod.PERCENTAGE && (
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rate (% of billing value) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={form.percentageRate}
                  onChange={(e) => set('percentageRate', e.target.value)}
                  placeholder="2.5"
                  step="0.1"
                  min="0"
                  max="100"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
                />
                {errors.percentageRate && <p className="text-xs text-red-500 mt-1">{errors.percentageRate}</p>}
              </div>
            )}

            {form.calculationMethod === CalculationMethod.PER_UNIT && (
              <div className="max-w-xs">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rate per Unit / Case (₹)
                </label>
                <input
                  type="number"
                  value={form.perUnitRate}
                  onChange={(e) => set('perUnitRate', e.target.value)}
                  placeholder="10"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
                />
              </div>
            )}

            {form.calculationMethod === CalculationMethod.SLAB && (
              <SlabTable field="slabs" label="Incentive Slabs" unit="₹" />
            )}

            {/* Overachievement */}
            <div className="border-t border-gray-100 pt-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  onClick={() => set('enableOverachievement', !form.enableOverachievement)}
                  className={`w-10 h-5 rounded-full transition-colors ${
                    form.enableOverachievement ? 'bg-[#C8102E]' : 'bg-gray-200'
                  } relative`}
                >
                  <div
                    className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow ${
                      form.enableOverachievement ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </div>
                <span className="text-sm font-medium text-gray-700">Enable Overachievement Slabs</span>
              </label>
              {form.enableOverachievement && (
                <div className="mt-3">
                  <SlabTable
                    field="overachievementSlabs"
                    label="Overachievement Slabs (above target)"
                    unit="₹"
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Target Configuration */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Target Configuration" section="target" />
        {sectionsOpen.target && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Value Target (₹ Lakh)
              </label>
              <input
                type="number"
                value={form.targetValue}
                onChange={(e) => set('targetValue', e.target.value)}
                placeholder="e.g. 25"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              <p className="text-xs text-gray-400 mt-1">Minimum billing value</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Quantity Target (Cases)
              </label>
              <input
                type="number"
                value={form.targetQuantity}
                onChange={(e) => set('targetQuantity', e.target.value)}
                placeholder="e.g. 500"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              <p className="text-xs text-gray-400 mt-1">Minimum case quantity</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Growth Target (%)
              </label>
              <input
                type="number"
                value={form.targetGrowthPct}
                onChange={(e) => set('targetGrowthPct', e.target.value)}
                placeholder="e.g. 15"
                min="0"
                max="200"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              <p className="text-xs text-gray-400 mt-1">vs. previous period</p>
            </div>
          </div>
        )}
      </div>

      {/* Advanced Settings */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <SectionHeader title="Advanced Settings" section="advanced" />
        {sectionsOpen.advanced && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Holding Period (Days) <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                value={form.holdingPeriodDays}
                onChange={(e) => set('holdingPeriodDays', e.target.value)}
                min="0"
                max="365"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#C8102E]"
              />
              <p className="text-xs text-gray-400 mt-1">
                Points are locked for this many days before becoming redeemable
              </p>
              {errors.holdingPeriodDays && (
                <p className="text-xs text-red-500 mt-1">{errors.holdingPeriodDays}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-2">
        <div>
          {schemeId && (
            <button
              onClick={onArchive}
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Archive className="w-4 h-4" />
              Archive Scheme
            </button>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium border border-[#C8102E] text-[#C8102E] rounded-lg hover:bg-red-50 transition-colors disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Draft'}
          </button>
          <button
            onClick={handlePublish}
            disabled={publishing}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-[#C8102E] text-white rounded-lg hover:bg-[#a00d25] transition-colors disabled:opacity-60"
          >
            <Send className="w-4 h-4" />
            {publishing ? 'Publishing...' : 'Publish Scheme'}
          </button>
        </div>
      </div>
    </div>
  );
}
