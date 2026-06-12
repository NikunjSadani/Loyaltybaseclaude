'use client';

import { useState } from 'react';
import { Filter } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FilterValues {
  period:       string;
  state:        string;
  region:       string;
  partnerClass: string;
  outletType:   string;
}

interface FilterBarProps {
  onChange?:       (values: FilterValues) => void;
  showOutletType?: boolean;
}

// ── Options ───────────────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { value: '2026-05', label: 'May 2026 (Current)' },
  { value: '2026-04', label: 'Apr 2026'            },
  { value: '2026-03', label: 'Mar 2026'            },
  { value: '2026-Q2', label: 'Q2 FY26 (Apr–Jun)'  },
  { value: 'ytd',     label: 'YTD FY26'            },
];

const STATE_OPTIONS = [
  { value: 'all',         label: 'All States'  },
  { value: 'Maharashtra', label: 'Maharashtra' },
  { value: 'Delhi',       label: 'Delhi'       },
  { value: 'Karnataka',   label: 'Karnataka'   },
  { value: 'Tamil Nadu',  label: 'Tamil Nadu'  },
  { value: 'Telangana',   label: 'Telangana'   },
  { value: 'West Bengal', label: 'West Bengal' },
];

const REGION_OPTIONS: Record<string, { value: string; label: string }[]> = {
  all: [{ value: 'all', label: 'All Regions' }],
  Maharashtra: [
    { value: 'all',         label: 'All Regions'  },
    { value: 'Mumbai West', label: 'Mumbai West'  },
    { value: 'Mumbai East', label: 'Mumbai East'  },
    { value: 'Pune Metro',  label: 'Pune Metro'   },
    { value: 'Nashik',      label: 'Nashik'       },
  ],
  Delhi: [
    { value: 'all',             label: 'All Regions'      },
    { value: 'Delhi NCR North', label: 'Delhi NCR North'  },
    { value: 'Delhi NCR South', label: 'Delhi NCR South'  },
    { value: 'Noida / Gurgaon', label: 'Noida / Gurgaon' },
  ],
  Karnataka: [
    { value: 'all',             label: 'All Regions'     },
    { value: 'Bengaluru Urban', label: 'Bengaluru Urban' },
    { value: 'Bengaluru Rural', label: 'Bengaluru Rural' },
    { value: 'Mysuru',          label: 'Mysuru'          },
  ],
};

const PARTNER_CLASSES = ['All', 'Gold', 'Silver', 'Platinum'] as const;

const OUTLET_TYPES = [
  { value: 'all',          label: 'All Types'    },
  { value: 'SSS',     label: 'SSS'     },
  { value: 'WHOLESALER',   label: 'Wholesaler'   },
  { value: 'SUB_STOCKIST', label: 'Sub-stockist' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function FilterBar({ onChange, showOutletType = false }: FilterBarProps) {
  const [period,       setPeriod]       = useState('2026-05');
  const [state,        setState]        = useState('all');
  const [region,       setRegion]       = useState('all');
  const [partnerClass, setPartnerClass] = useState('All');
  const [outletType,   setOutletType]   = useState('all');

  function notify(next: Partial<FilterValues>) {
    const values: FilterValues = {
      period,
      state,
      region,
      partnerClass,
      outletType,
      ...next,
    };
    onChange?.(values);
  }

  function handleState(s: string) {
    setState(s);
    setRegion('all');
    notify({ state: s, region: 'all' });
  }

  function handlePeriod(p: string) {
    setPeriod(p);
    notify({ period: p });
  }

  function handleRegion(r: string) {
    setRegion(r);
    notify({ region: r });
  }

  function handleClass(c: string) {
    setPartnerClass(c);
    notify({ partnerClass: c });
  }

  function handleOutletType(t: string) {
    setOutletType(t);
    notify({ outletType: t });
  }

  const regionOptions = REGION_OPTIONS[state] ?? REGION_OPTIONS.all;

  return (
    <div className="bg-white rounded-xl border border-gray-200 px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 mr-1">
          <Filter className="w-3.5 h-3.5" />
          Filters
        </div>

        {/* Period */}
        <select
          value={period}
          onChange={(e) => handlePeriod(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
        >
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* State */}
        <select
          value={state}
          onChange={(e) => handleState(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
        >
          {STATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Region — only when a state is selected */}
        {state !== 'all' && (
          <select
            value={region}
            onChange={(e) => handleRegion(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
          >
            {regionOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}

        {/* Separator */}
        <div className="h-4 w-px bg-gray-200 mx-1" />

        {/* Partner class pills */}
        <div className="flex gap-1">
          {PARTNER_CLASSES.map((cls) => (
            <button
              key={cls}
              onClick={() => handleClass(cls)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-all ${
                partnerClass === cls
                  ? 'bg-[var(--brand-primary)] text-white border-[var(--brand-primary)]'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
              }`}
            >
              {cls}
            </button>
          ))}
        </div>

        {/* Outlet type — only when opted in */}
        {showOutletType && (
          <>
            <div className="h-4 w-px bg-gray-200 mx-1" />
            <select
              value={outletType}
              onChange={(e) => handleOutletType(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] bg-white text-gray-700"
            >
              {OUTLET_TYPES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </>
        )}
      </div>
    </div>
  );
}
