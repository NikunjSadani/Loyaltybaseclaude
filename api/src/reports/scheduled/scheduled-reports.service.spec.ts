import { ScheduledReportsService } from './scheduled-reports.service';
import { buildCreditsPayoutsReport } from './credits-payouts-report';
import { buildKycActionablesReport } from './kyc-actionables-report';
import { loadReportRecipients } from '../../common/report-recipients';
import { loadHolidaySet } from '../../common/holiday-calendar';
import type { ReportResult } from './report.types';

jest.mock('./credits-payouts-report', () => ({ buildCreditsPayoutsReport: jest.fn() }));
jest.mock('./kyc-actionables-report', () => ({ buildKycActionablesReport: jest.fn() }));
jest.mock('../../common/report-recipients', () => ({ loadReportRecipients: jest.fn() }));
jest.mock('../../common/holiday-calendar', () => ({ loadHolidaySet: jest.fn().mockResolvedValue(new Set<string>()) }));

const mockCredits = buildCreditsPayoutsReport as jest.Mock;
const mockKyc = buildKycActionablesReport as jest.Mock;
const mockRecipients = loadReportRecipients as jest.Mock;
const mockHolidays = loadHolidaySet as jest.Mock;

const NOW = new Date('2026-08-11T12:00:00Z').getTime(); // fixed → deterministic

const result = (key: ReportResult['key'], empty: boolean): ReportResult => ({
  key,
  subject: `[Gifsy] ${key} — 11 Aug 2026`,
  html: `<div>${key}</div>`,
  empty,
});

describe('ScheduledReportsService', () => {
  let svc: ScheduledReportsService;
  let sendEmail: jest.Mock;
  let prisma: { client: { findMany: jest.Mock }; programSetting: { findMany: jest.Mock } };

  beforeEach(() => {
    jest.clearAllMocks();
    mockHolidays.mockResolvedValue(new Set<string>());
    prisma = {
      client: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'deoleo', internalName: 'Deoleo', branding: { displayName: 'Deoleo India' } },
        ]),
      },
      programSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    sendEmail = jest.fn().mockResolvedValue(undefined);
    svc = new ScheduledReportsService(prisma as never, { sendEmail } as never);
  });

  it('sends credits when non-empty and recipients are set', async () => {
    mockRecipients.mockResolvedValue({ creditsPayouts: ['ops@gifsy.in'], kycActionables: [] });
    mockCredits.mockResolvedValue(result('creditsPayouts', false));
    mockKyc.mockResolvedValue(result('kycActionables', true));

    const out = await svc.runDailyReports(NOW);
    const credits = out.reports.find((r) => r.key === 'creditsPayouts');
    expect(credits?.status).toBe('sent');
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['ops@gifsy.in'], subject: expect.stringContaining('creditsPayouts') }),
    );
  });

  it('SUPPRESSES credits when empty (suppress-if-empty), even with recipients', async () => {
    mockRecipients.mockResolvedValue({ creditsPayouts: ['ops@gifsy.in'], kycActionables: [] });
    mockCredits.mockResolvedValue(result('creditsPayouts', true));
    mockKyc.mockResolvedValue(result('kycActionables', true));

    const out = await svc.runDailyReports(NOW);
    expect(out.reports.find((r) => r.key === 'creditsPayouts')?.status).toBe('suppressed-empty');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('ALWAYS sends the KYC digest even when empty (daily digest)', async () => {
    mockRecipients.mockResolvedValue({ creditsPayouts: [], kycActionables: ['ops@gifsy.in'] });
    mockCredits.mockResolvedValue(result('creditsPayouts', true));
    mockKyc.mockResolvedValue(result('kycActionables', true));

    const out = await svc.runDailyReports(NOW);
    expect(out.reports.find((r) => r.key === 'kycActionables')?.status).toBe('sent');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips a report with no recipients', async () => {
    mockRecipients.mockResolvedValue({ creditsPayouts: [], kycActionables: [] });
    mockCredits.mockResolvedValue(result('creditsPayouts', false));
    mockKyc.mockResolvedValue(result('kycActionables', false));

    const out = await svc.runDailyReports(NOW);
    expect(out.reports.every((r) => r.status === 'no-recipients')).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('isolates a failing report — the other still sends', async () => {
    mockRecipients.mockResolvedValue({ creditsPayouts: ['a@gifsy.in'], kycActionables: ['b@gifsy.in'] });
    mockCredits.mockRejectedValue(new Error('boom'));
    mockKyc.mockResolvedValue(result('kycActionables', false));

    const out = await svc.runDailyReports(NOW);
    expect(out.reports.find((r) => r.key === 'creditsPayouts')?.status).toBe('error');
    expect(out.reports.find((r) => r.key === 'kycActionables')?.status).toBe('sent');
    expect(sendEmail).toHaveBeenCalledTimes(1); // only the KYC one
  });
});
