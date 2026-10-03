/**
 * Employee Rewards — placeholder for a cockpit module not yet built (Phase 0 skeleton).
 * The capability-gated admin shell surfaces the employee world's nav; each module lands
 * here until its build phase ships the real page. Pure presentational (server component).
 */
export function EmployeeModuleStub({ module, phase }: { module: string; phase?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-20 text-center">
      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--brand-primary)]">
        Employee Rewards
      </p>
      <h2 className="mt-2 text-xl font-semibold text-gray-900">{module}</h2>
      <p className="mt-2 max-w-sm text-sm text-gray-500">
        This module is part of the employee-rewards cockpit and arrives in{' '}
        {phase ?? 'a later phase'} of the build.
      </p>
    </div>
  );
}

export default EmployeeModuleStub;
