/**
 * Voucher PIN (card number + PIN gift cards) — pure helpers: Hubble credential split, the manual
 * write guard, the member notification (one `voucher_code` template, single-line code var), the
 * masked audit, the bulk-sheet column, and the vendor DTO.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as XLSX from 'xlsx';
import { hubbleVoucherCredentials, isSalesViewer } from './rewards.service';
import { planVoucherWrite, VOUCHER_PIN_NEEDS_CODE_MESSAGE } from './voucher-write-guard';
import {
  notifyVoucherIssued,
  recordVoucherIssuedAudit,
  voucherCodeVar,
  whatsappSafeVar,
} from './voucher-issuance';
import {
  buildFulfilmentTemplateBuffer,
  FULFILMENT_COLS,
  parseFulfilmentUploadBuffer,
} from './rewards-fulfilment.helpers';
import { VendorFulfilmentDto, VendorTransitionDto } from '../vendor/dto/vendor.dto';
import { VARIABLE_CONTRACTS, defaultConfig } from '../notification-templates/notification-templates.config';

describe('hubbleVoucherCredentials', () => {
  it('card number + PIN → code = number, pin = PIN (trimmed)', () => {
    expect(hubbleVoucherCredentials({ cardNumber: ' 6001 ', cardPin: ' 42 ' } as never)).toEqual({ code: '6001', pin: '42' });
  });
  it('number only → unchanged (no PIN)', () => {
    expect(hubbleVoucherCredentials({ cardNumber: 'AMZ-1', cardPin: null } as never)).toEqual({ code: 'AMZ-1', pin: null });
  });
  it('PIN only → the PIN is the code (unchanged), no separate PIN', () => {
    expect(hubbleVoucherCredentials({ cardNumber: '  ', cardPin: 'P-9' } as never)).toEqual({ code: 'P-9', pin: null });
  });
  it('nothing → nulls', () => {
    expect(hubbleVoucherCredentials(undefined)).toEqual({ code: null, pin: null });
  });
});

describe('isSalesViewer', () => {
  it('flags every sales hierarchy role and nothing else', () => {
    for (const r of ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR']) expect(isSalesViewer(r)).toBe(true);
    for (const r of ['RETAILER', 'SSS', 'GIFSY_ADMIN', 'CLIENT_ADMIN', undefined]) expect(isSalesViewer(r)).toBe(false);
  });
});

describe('planVoucherWrite — PIN', () => {
  const paid = { status: 'CONFIRMED', voucherCode: null, voucherProvider: null, voucherPin: null, pointsDeducted: 10, redemptionMode: 'GIFT_CARD' };

  it('a code + PIN plans both columns in one write', () => {
    const plan = planVoucherWrite(paid, { voucherCode: 'C-1', voucherPin: ' 99 ' });
    expect(plan.data).toEqual({ voucherCode: 'C-1', voucherPin: '99' });
    expect(plan.issuesNewCode).toBe(true);
  });
  it('a blank PIN is "no PIN" (not a clear)', () => {
    expect(planVoucherWrite(paid, { voucherCode: 'C-1', voucherPin: '  ' }).data).toEqual({ voucherCode: 'C-1' });
    expect(planVoucherWrite(paid, { voucherPin: '' }).guard).toBeNull();
  });
  it('a PIN without a code → 400 "Enter the card number before the PIN"', () => {
    expect(() => planVoucherWrite(paid, { voucherPin: '99' })).toThrow(VOUCHER_PIN_NEEDS_CODE_MESSAGE);
    expect(() => planVoucherWrite(paid, { voucherPin: '99', voucherProvider: 'X' })).toThrow(BadRequestException);
  });
  it('a different PIN on an issued code is a replace (400); the same PIN is a no-op', () => {
    const issued = { ...paid, voucherCode: 'C-1', voucherPin: '99' };
    expect(() => planVoucherWrite(issued, { voucherPin: '11' })).toThrow(/already issued/);
    expect(planVoucherWrite(issued, { voucherCode: 'C-1', voucherPin: '99' }).guard).toBeNull();
  });
});

describe('notifyVoucherIssued — card + PIN via the one voucher_code template', () => {
  const deps = (order: Record<string, unknown>) => {
    const notifyUserWithChannels = jest.fn().mockResolvedValue(undefined);
    return {
      notifyUserWithChannels,
      deps: {
        prisma: {
          redemptionOrder: { findUnique: jest.fn().mockResolvedValue(order) },
          client: { findUnique: jest.fn().mockResolvedValue({ branding: { displayName: 'Bajaj' }, internalName: 'bajaj' }) },
        },
        notifications: { notifyUserWithChannels },
        logger: new Logger('test'),
      },
    };
  };
  const base = {
    valuePaise: 50000n, orderNumber: 'RDM-1', reward: { name: 'Croma Gift Card' },
    partner: { userId: 'u1', phone: '9000000001', ownerName: 'Asha' },
  };

  it('no PIN → vars, body and event byte-identical to before', async () => {
    const { deps: d, notifyUserWithChannels } = deps({ ...base, voucherCode: 'AMZ-1234', voucherPin: null });
    await notifyVoucherIssued(d as never, 'o1', 'bajaj');
    expect(notifyUserWithChannels).toHaveBeenCalledWith({
      clientId: 'bajaj',
      userId: 'u1',
      eventKey: 'VOUCHER_ISSUED',
      recipientPhone: '9000000001',
      vars: { ownerName: 'Asha', amount: '₹500', program: 'Bajaj Loyalty', voucherName: 'Croma Gift Card', code: 'AMZ-1234' },
      subject: 'Your voucher code',
      body: 'Your Croma Gift Card code: AMZ-1234',
      url: '/partner/rewards/orders',
      event: 'VOUCHER_ISSUED',
    });
  });

  it('PIN → same VOUCHER_ISSUED event; {{5}} code = "<code> | PIN: <pin>" on ONE line; body names card no + PIN', async () => {
    const { deps: d, notifyUserWithChannels } = deps({ ...base, voucherCode: '6001 2200\t1234', voucherPin: ' 48\n29 ' });
    await notifyVoucherIssued(d as never, 'o1', 'bajaj');
    expect(notifyUserWithChannels).toHaveBeenCalledTimes(1); // one bell, one send
    const call = notifyUserWithChannels.mock.calls[0][0];
    expect(call.eventKey).toBe('VOUCHER_ISSUED');
    expect(call.vars.code).toBe('6001 2200 1234 | PIN: 48 29');
    expect(call.vars.code).not.toMatch(/[\n\t]| {4,}/);
    expect(call.vars).not.toHaveProperty('pin');
    expect(call.vars.program).toBe('Bajaj Loyalty'); // same programLabelFor value as today
    expect(call.body).toBe('Your Croma Gift Card card no: 6001 2200\t1234 · PIN: 48\n29');
  });

  it('the WhatsApp/SMS contract stays 5 vars; Deoleo default config for VOUCHER_ISSUED unchanged', () => {
    expect(VARIABLE_CONTRACTS.VOUCHER_ISSUED.whatsapp).toEqual(['ownerName', 'amount', 'program', 'voucherName', 'code']);
    expect(defaultConfig('deoleo').events.VOUCHER_ISSUED).toEqual({ mode: 'BOTH', whatsappTemplate: 'voucher_code', smsTemplateId: '' });
  });

  it('voucherCodeVar / whatsappSafeVar', () => {
    expect(voucherCodeVar('ABC', null)).toBe('ABC');
    expect(voucherCodeVar('ABC', '   ')).toBe('ABC');
    expect(voucherCodeVar(' A    B ', '1     2')).toBe('A B | PIN: 1 2');
    expect(whatsappSafeVar('a\r\n\tb    c')).toBe('a b c');
  });
});

describe('recordVoucherIssuedAudit — PIN never logged', () => {
  it('records only a masked marker for the PIN', async () => {
    const create = jest.fn().mockResolvedValue({});
    await recordVoucherIssuedAudit({ auditLog: { create } } as never, {
      actorId: 'a', orderId: 'o1', code: '6001220012345678', pin: '482913', path: 'X',
    });
    const meta = create.mock.calls[0][0].data.metadata;
    expect(meta.voucherPin).toBe('••••');
    expect(meta.voucherCode).toBe('••••5678');
    expect(JSON.stringify(meta)).not.toContain('482913');
  });
  it('no PIN → no voucherPin key (audit row unchanged)', async () => {
    const create = jest.fn().mockResolvedValue({});
    await recordVoucherIssuedAudit({ auditLog: { create } } as never, { actorId: 'a', orderId: 'o1', code: 'C', path: 'X' });
    expect(create.mock.calls[0][0].data.metadata).not.toHaveProperty('voucherPin');
  });
});

describe('bulk fulfilment sheet — optional Voucher PIN column', () => {
  it('the template carries "Voucher PIN" right after "Voucher Code", text-formatted', () => {
    expect(FULFILMENT_COLS.indexOf('Voucher PIN')).toBe(FULFILMENT_COLS.indexOf('Voucher Code') + 1);
    const buf = buildFulfilmentTemplateBuffer([{ orderNumber: 'RDM-1', reward: 'R', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' }]);
    const ws = XLSX.read(buf, { type: 'buffer', cellNF: true }).Sheets.Fulfilment;
    const col = FULFILMENT_COLS.indexOf('Voucher PIN');
    expect(ws[XLSX.utils.encode_cell({ r: 0, c: col })].v).toBe('Voucher PIN');
    expect(ws[XLSX.utils.encode_cell({ r: 1, c: col })].z).toBe('@');
  });
  it('parses the PIN; a sheet WITHOUT the column (downloaded earlier) still parses', () => {
    const sheet = (rows: unknown[][]) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'F');
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    };
    const withPin = parseFulfilmentUploadBuffer(sheet([
      ['Order Number', 'Voucher Code', 'Voucher PIN'], ['RDM-1', 'C-1', ' 0042 '],
    ]));
    expect(withPin.rows[0]).toMatchObject({ voucherCode: 'C-1', voucherPin: '0042' });
    const legacy = parseFulfilmentUploadBuffer(sheet([['Order Number', 'Voucher Code'], ['RDM-1', 'C-1']]));
    expect(legacy.rows[0].voucherPin).toBeUndefined();
    expect(legacy.rows[0].voucherCode).toBe('C-1');
  });
});

describe('vendor DTOs — voucherPin', () => {
  it('optional, trimmed, max 64 on both fulfilment and transition', async () => {
    const errs = async (cls: new () => object, o: Record<string, unknown>) =>
      validate(plainToInstance(cls, o)).then((e) => e.map((x) => x.property));
    expect(await errs(VendorFulfilmentDto, { voucherCode: 'C', voucherPin: '12' })).toEqual([]);
    expect(await errs(VendorFulfilmentDto, { voucherPin: 'x'.repeat(65) })).toEqual(['voucherPin']);
    expect(await errs(VendorTransitionDto, { toStatus: 'PROCESSING', voucherPin: 'x'.repeat(65) })).toEqual(['voucherPin']);
    expect((plainToInstance(VendorFulfilmentDto, { voucherPin: ' 7 ' }) as { voucherPin: string }).voucherPin).toBe('7');
  });
});
