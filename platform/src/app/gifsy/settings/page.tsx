'use client';

import { useState, useEffect } from 'react';
import {
  Globe, Shield, Bell, Database, Key, Save, CheckCircle, CreditCard,
} from 'lucide-react';
import { getGifsySettings, saveGifsySettings } from '@/lib/gifsy-settings';

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';

export default function GifsySettingsPage() {
  const [saved,       setSaved]       = useState(false);
  // Redemption threshold state — loaded from persisted settings
  const [minBank,     setMinBank]     = useState(250);
  const [minVoucher,  setMinVoucher]  = useState(250);

  useEffect(() => {
    const s = getGifsySettings();
    setMinBank(s.minBankTransferAmount);
    setMinVoucher(s.minVoucherFreeAmount);
  }, []);

  const flashSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleRedemptionSave = () => {
    saveGifsySettings({ minBankTransferAmount: minBank, minVoucherFreeAmount: minVoucher });
    flashSaved();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Platform Settings</h1>
          <p className="text-sm text-white/50 mt-0.5">Global configuration for the Gifsy Loyalty Platform</p>
        </div>
        {saved && (
          <span className="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-1.5 rounded-lg">
            <CheckCircle className="w-3.5 h-3.5" />Saved
          </span>
        )}
      </div>

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300">
        <strong>Dev mode:</strong> Settings are in-memory only. DB persistence applies in Phase 2.
      </div>

      {/* Platform identity */}
      <SettingSection icon={Globe} title="Platform Identity">
        <Field label="Platform name">
          <input defaultValue="Gifsy Loyalty Platform" className={INPUT_CLS} />
        </Field>
        <Field label="Default domain">
          <input defaultValue="loyaltybase.in" className={INPUT_CLS + ' font-mono'} />
        </Field>
        <Field label="Support email">
          <input defaultValue="support@gifsy.in" className={INPUT_CLS} />
        </Field>
        <SaveButton onClick={flashSaved} />
      </SettingSection>

      {/* Security */}
      <SettingSection icon={Shield} title="Security">
        <Field label="JWT expiry (days)">
          <input type="number" defaultValue={7} min={1} max={90} className={INPUT_CLS} />
        </Field>
        <Field label="OTP expiry (minutes)">
          <input type="number" defaultValue={10} min={5} max={60} className={INPUT_CLS} />
        </Field>
        <Field label="Max OTP attempts per session">
          <input type="number" defaultValue={3} min={1} max={10} className={INPUT_CLS} />
        </Field>
        <SaveButton onClick={flashSaved} />
      </SettingSection>

      {/* Redemption Thresholds */}
      <SettingSection icon={CreditCard} title="Redemption Thresholds">
        <Field label="Minimum bank / DBT transfer amount (₹)">
          <input
            data-testid="settings-min-bank-transfer"
            type="number"
            min={1}
            value={minBank}
            onChange={(e) => setMinBank(Number(e.target.value))}
            className={INPUT_CLS}
          />
        </Field>
        <Field label="Minimum voucher redemption amount (₹)">
          <input
            data-testid="settings-min-voucher"
            type="number"
            min={1}
            value={minVoucher}
            onChange={(e) => setMinVoucher(Number(e.target.value))}
            className={INPUT_CLS}
          />
        </Field>
        <SaveButton data-testid="settings-redemption-save" onClick={handleRedemptionSave} />
      </SettingSection>

      {/* Notifications */}
      <SettingSection icon={Bell} title="Platform Notifications">
        <Field label="Platform alert email (for GIFSY_ADMIN)">
          <input defaultValue="alerts@gifsy.in" className={INPUT_CLS} />
        </Field>
        <Field label="SLA breach alert threshold (hours)">
          <input type="number" defaultValue={48} min={1} className={INPUT_CLS} />
        </Field>
        <SaveButton onClick={flashSaved} />
      </SettingSection>

      {/* DB */}
      <SettingSection icon={Database} title="Data Retention">
        <Field label="Audit log retention (days)">
          <input type="number" defaultValue={365} min={90} className={INPUT_CLS} />
        </Field>
        <Field label="Notification queue retention (days)">
          <input type="number" defaultValue={30} min={7} className={INPUT_CLS} />
        </Field>
        <SaveButton onClick={flashSaved} />
      </SettingSection>

      {/* Environment info */}
      <SettingSection icon={Key} title="Environment">
        <div className="space-y-2">
          {[
            { key: 'NODE_ENV',              value: 'development' },
            { key: 'DATABASE_URL',           value: '•••••••••••••••• (set in env)' },
            { key: 'JWT_SECRET',             value: '•••••••••••••••• (set in env)' },
            { key: 'DEOLEO_MSG91_AUTH_KEY',  value: '•••••••••••••••• (set in env)' },
          ].map(({ key, value }) => (
            <div key={key} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 border border-white/5">
              <span className="text-xs font-mono text-white/60">{key}</span>
              <span className="text-xs font-mono text-white/30">{value}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-white/30 mt-2">Env vars are read-only. Update them in your deployment environment.</p>
      </SettingSection>
    </div>
  );
}

function SettingSection({
  icon: Icon, title, children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2.5">
        <Icon className="w-4 h-4 text-white/50" />
        <span className="text-sm font-semibold text-white">{title}</span>
      </div>
      <div className="px-5 py-5 space-y-4">
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-white/50 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function SaveButton({ onClick, 'data-testid': testId }: { onClick: () => void; 'data-testid'?: string }) {
  return (
    <div className="pt-1">
      <button
        data-testid={testId}
        onClick={onClick}
        className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity"
      >
        <Save className="w-3.5 h-3.5" />Save Section
      </button>
    </div>
  );
}
