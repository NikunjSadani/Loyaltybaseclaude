'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, LogOut, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SidebarItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

export interface SidebarSection {
  title?: string;
  items: SidebarItem[];
}

interface SidebarProps {
  sections: SidebarSection[];
  onLogout?: () => void;
  userName?: string;
  userRole?: string;
  logoLabel?: string;
}

export function Sidebar({
  sections,
  onLogout,
  userName,
  userRole,
  logoLabel = 'Deoleo Loyalty',
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col bg-[#1A1A2E] text-white transition-all duration-300',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/10">
        <div className="w-8 h-8 bg-[var(--brand-primary)] rounded-lg flex items-center justify-center shrink-0">
          <svg viewBox="0 0 40 40" className="w-5 h-5 fill-white">
            <path d="M20 4L36 12v16L20 36 4 28V12L20 4z" />
          </svg>
        </div>
        {!collapsed && (
          <span className="font-bold text-sm leading-tight truncate">{logoLabel}</span>
        )}
      </div>

      {/* Nav sections */}
      <nav className="flex-1 py-4 overflow-y-auto">
        {sections.map((section, si) => (
          <div key={si} className="mb-4">
            {section.title && !collapsed && (
              <p className="px-4 mb-1 text-[10px] font-semibold uppercase tracking-widest text-white/40">
                {section.title}
              </p>
            )}
            {section.items.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(item.href + '/');
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    'flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm transition-colors',
                    isActive
                      ? 'bg-[var(--brand-primary)] text-white font-medium'
                      : 'text-white/70 hover:bg-white/10 hover:text-white',
                    collapsed && 'justify-center px-2',
                  )}
                >
                  <Icon className="h-4.5 w-4.5 shrink-0" />
                  {!collapsed && (
                    <span className="flex-1 truncate">{item.label}</span>
                  )}
                  {!collapsed && item.badge !== undefined && item.badge > 0 && (
                    <span className="ml-auto bg-[var(--brand-primary)] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User + collapse */}
      <div className="border-t border-white/10 p-3">
        {!collapsed && userName && (
          <div className="px-2 py-2 mb-1">
            <p className="text-sm font-medium text-white truncate">{userName}</p>
            {userRole && (
              <p className="text-xs text-white/50 truncate">{userRole}</p>
            )}
          </div>
        )}
        {onLogout && (
          <button
            onClick={onLogout}
            className={cn(
              'flex items-center gap-3 w-full px-2 py-2 rounded-lg text-sm text-white/70',
              'hover:bg-white/10 hover:text-white transition-colors',
              collapsed && 'justify-center',
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && <span>Sign Out</span>}
          </button>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center justify-center w-full mt-1 p-2 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
