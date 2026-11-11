/**
 * Voucher PIN (card number + PIN gift cards) — pure helpers: Hubble credential split, the manual
 * write guard, the member notification (one `voucher_code` template, single-line code var), the
 * masked audit, the bulk-sheet column, and the vendor DTO.
 */
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as XLSX from 'xlsx';
import { hubbleVoucherCredentials, isSalesViewer } from './rewards.service';
import {
  PinRaceResolvedError,
  canFillStoredVoucher,
  pinRaceIsIdempotent,
  planChannelWrite,
  planVoucherWrite,
  rethrowUnlessIdempotentPinRace,
  VOUCHER_CHANNEL_SWITCH_MESSAGE,
  withPinRaceRetry,
  VOUCHER_PIN_ALREADY_SAVED_MESSAGE,
  VOUCHER_PIN_NEEDS_CODE_MESSAGE,
  VOUCHER_PIN_STATUS_MESSAGE,
  VOUCHER_PIN_TOO_LONG_MESSAGE,
  VOUCHER_ALREADY_ISSUED_MESSAGE,
  HUBBLE_PROVIDER_MESSAGE,
} from './voucher-write-guard';
import {
  maskVoucherCodeForAudit,
  notifyVoucherIssued,
  recordVoucherIssuedAudit,
  voucherCodeVar,
  whatsappSafeVar,
} from './voucher-issuance';
import {
  buildFulfilmentTemplateBuffer,
  FULFILMENT_COLS,
  parseFulfilmentUploadBuffer,
  VOUCHER_CELL_NUMBER_MESSAGE,
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
  it('a different PIN on an issued code with a saved PIN → 400 (PIN-specific); the same PIN is a no-op', () => {
    const issued = { ...paid, voucherCode: 'C-1', voucherPin: '99' };
    expect(() => planVoucherWrite(issued, { voucherPin: '11' })).toThrow(VOUCHER_PIN_ALREADY_SAVED_MESSAGE);
    expect(() => planVoucherWrite(issued, { voucherCode: 'C-1', voucherPin: '11' })).toThrow(VOUCHER_PIN_ALREADY_SAVED_MESSAGE);
    expect(planVoucherWrite(issued, { voucherCode: 'C-1', voucherPin: '99' }).guard).toBeNull();
    expect(planVoucherWrite(issued, { voucherPin: ' 99 ' }).guard).toBeNull();
  });
  it('SET-ONCE: a code is stored and no PIN yet → the PIN may be added (with or without the same code)', () => {
    const updatedAt = new Date(Date.now() - 60_000);
    const issued = { ...paid, voucherCode: 'C-1', voucherPin: null, updatedAt };
    for (const input of [{ voucherPin: ' 42 ' }, { voucherCode: ' C-1 ', voucherPin: '42' }]) {
      const plan = planVoucherWrite(issued, input);
      expect(plan.data).toEqual({ voucherPin: '42' });
      expect(plan.addsPin).toBe(true);
      expect(plan.issuesNewCode).toBe(false);
      // The CAS pins the stored code, a still-null PIN and the row version → two writers can't both set it.
      expect(plan.guard).toEqual({
        AND: [
          { voucherCode: 'C-1' },
          { voucherPin: null },
          { status: { in: ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED'] } },
          { pointsDeducted: { gt: 0 } },
          { updatedAt },
        ],
      });
    }
  });
  it('SET-ONCE: allowed on a DELIVERED order; refused on a returned / refunded one', () => {
    const delivered = { ...paid, status: 'DELIVERED', voucherCode: 'C-1' };
    expect(planVoucherWrite(delivered, { voucherPin: '42' }).addsPin).toBe(true);
    expect(() => planVoucherWrite({ ...delivered, status: 'RETURNED' }, { voucherPin: '42' })).toThrow(VOUCHER_PIN_STATUS_MESSAGE);
    expect(() => planVoucherWrite({ ...delivered, pointsDeducted: 0 }, { voucherPin: '42' })).toThrow(VOUCHER_PIN_STATUS_MESSAGE);
  });
  it('SET-ONCE: a PIN with a DIFFERENT code / provider is still a code replace; a Hubble order stays integration-owned', () => {
    const issued = { ...paid, voucherCode: 'C-1', voucherProvider: 'Gifsy' };
    expect(() => planVoucherWrite(issued, { voucherCode: 'C-2', voucherPin: '42' })).toThrow(VOUCHER_ALREADY_ISSUED_MESSAGE);
    expect(() => planVoucherWrite(issued, { voucherProvider: 'Other', voucherPin: '42' })).toThrow(VOUCHER_ALREADY_ISSUED_MESSAGE);
    expect(() => planVoucherWrite({ ...issued, voucherProvider: 'Hubble' }, { voucherPin: '42' })).toThrow(HUBBLE_PROVIDER_MESSAGE);
  });
  it('a PIN longer than 64 → 400 (covers the bulk sheet, which skips the DTO); 64 is fine', () => {
    expect(() => planVoucherWrite(paid, { voucherCode: 'C-1', voucherPin: 'x'.repeat(65) })).toThrow(VOUCHER_PIN_TOO_LONG_MESSAGE);
    expect(planVoucherWrite(paid, { voucherCode: 'C-1', voucherPin: 'x'.repeat(64) }).data.voucherPin).toHaveLength(64);
  });
  it('B5: a provider may be set ONCE on a stored code whose provider is empty (with or without a PIN)', () => {
    const updatedAt = new Date(Date.now() - 60_000);
    const issued = { ...paid, voucherCode: 'C-1', updatedAt };
    const only = planVoucherWrite(issued, { voucherProvider: ' Croma ' });
    expect(only.data).toEqual({ voucherProvider: 'Croma' });
    expect(only).toMatchObject({ issuesNewCode: false, addsPin: false, setsProvider: true });
    expect(only.guard).toEqual({
      AND: [
        { voucherCode: 'C-1' },
        { voucherProvider: null },
        { status: { in: ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED'] } },
        { pointsDeducted: { gt: 0 } },
        { updatedAt },
      ],
    });
    const both = planVoucherWrite(issued, { voucherCode: 'C-1', voucherProvider: 'Croma', voucherPin: '42' });
    expect(both.data).toEqual({ voucherPin: '42', voucherProvider: 'Croma' });
    expect(both.addsPin).toBe(true);
    expect(both.guard!.AND).toEqual(expect.arrayContaining([{ voucherPin: null }, { voucherProvider: null }]));
    // A blank-string stored provider is pinned verbatim in the CAS.
    expect(planVoucherWrite({ ...issued, voucherProvider: '' }, { voucherProvider: 'Croma' }).guard!.AND)
      .toEqual(expect.arrayContaining([{ voucherProvider: '' }]));
    // Changing a SET provider stays a replace; 'Hubble' is never hand-set; refunded orders refuse.
    expect(() => planVoucherWrite({ ...issued, voucherProvider: 'Gifsy' }, { voucherProvider: 'Croma' })).toThrow(VOUCHER_ALREADY_ISSUED_MESSAGE);
    expect(() => planVoucherWrite(issued, { voucherProvider: 'Hubble' })).toThrow(BadRequestException);
    expect(() => planVoucherWrite({ ...issued, status: 'RETURNED' }, { voucherProvider: 'Croma' })).toThrow(BadRequestException);
  });
});

describe('pinRaceIsIdempotent (B4 — lost PIN CAS on a double submit)', () => {
  const read = { voucherCode: 'C-1' };
  it('identical PIN on the same code → idempotent; anything else → not', () => {
    const plan = { addsPin: true };
    expect(pinRaceIsIdempotent(plan, read, { voucherPin: ' 42 ' }, { voucherCode: 'C-1', voucherPin: '42' })).toBe(true);
    expect(pinRaceIsIdempotent(plan, read, { voucherCode: 'C-1', voucherPin: '42' }, { voucherCode: 'C-1', voucherPin: '42' })).toBe(true);
    expect(pinRaceIsIdempotent(plan, read, { voucherPin: '42' }, { voucherCode: 'C-1', voucherPin: '43' })).toBe(false);
    expect(pinRaceIsIdempotent(plan, read, { voucherPin: '42' }, { voucherCode: 'C-2', voucherPin: '42' })).toBe(false);
    expect(pinRaceIsIdempotent(plan, read, { voucherPin: '42' }, { voucherCode: null, voucherPin: null })).toBe(false);
    expect(pinRaceIsIdempotent(plan, read, { voucherPin: '42' }, null)).toBe(false);
    expect(pinRaceIsIdempotent({ addsPin: false }, read, { voucherPin: '42' }, { voucherCode: 'C-1', voucherPin: '42' })).toBe(false);
  });
  it('withPinRaceRetry runs once more ONLY on PinRaceResolvedError (a 409 if it ever escapes)', async () => {
    const run = jest.fn().mockRejectedValueOnce(new PinRaceResolvedError()).mockResolvedValueOnce('ok');
    await expect(withPinRaceRetry(run)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
    const other = jest.fn().mockRejectedValue(new ConflictException('x'));
    await expect(withPinRaceRetry(other)).rejects.toThrow('x');
    expect(other).toHaveBeenCalledTimes(1);
    expect(new PinRaceResolvedError()).toBeInstanceOf(ConflictException);
  });
  it('rethrowUnlessIdempotentPinRace: re-read errors keep the original 409', async () => {
    const e = new ConflictException('lost');
    await expect(
      rethrowUnlessIdempotentPinRace(e, { addsPin: true }, read, { voucherPin: '42' }, () => {
        throw new Error('db down');
      }),
    ).rejects.toBe(e);
    await expect(
      rethrowUnlessIdempotentPinRace(e, { addsPin: true }, read, { voucherPin: '42' }, async () => ({ voucherCode: 'C-1', voucherPin: '42' })),
    ).rejects.toBeInstanceOf(PinRaceResolvedError);
  });
});

describe('canFillStoredVoucher (F4 — the server-computed voucherFillable the UIs use)', () => {
  const base = { status: 'DELIVERED', voucherCode: 'C-1', voucherProvider: 'Croma', pointsDeducted: 10, redemptionMode: 'GIFT_CARD', metadata: {} };
  it('agrees with planVoucherWrite: true exactly when a PIN add would be accepted', () => {
    const cases = [
      base,
      { ...base, status: 'RETURNED' },
      { ...base, pointsDeducted: 0 },
      { ...base, voucherProvider: 'Hubble' },
      { ...base, metadata: { hubbleStatus: 'SUCCESS' } },
      { ...base, redemptionMode: 'UPI' },
      { ...base, voucherCode: null },
      { ...base, status: 'CONFIRMED' },
    ];
    for (const c of cases) {
      let accepted = true;
      try {
        accepted = planVoucherWrite({ ...c, voucherPin: null }, { voucherPin: '42' }).addsPin;
      } catch {
        accepted = false;
      }
      expect(canFillStoredVoucher(c)).toBe(accepted);
    }
    expect(canFillStoredVoucher(base)).toBe(true);
  });
});

describe('planChannelWrite (B7 — no physical channel while a code is stored)', () => {
  it('a stored code + a switch to a physical channel → 400; DIGITAL_VOUCHER / same channel / omitted → no-op', () => {
    const coded = { voucherCode: 'C-1', fulfilmentChannel: 'DIGITAL_VOUCHER' };
    for (const ch of ['GIFSY_WAREHOUSE', 'BRAND', 'FULFILLED_BY_AMAZON']) {
      expect(() => planChannelWrite(coded, ch)).toThrow(VOUCHER_CHANNEL_SWITCH_MESSAGE);
    }
    expect(() => planChannelWrite({ voucherCode: 'C-1', fulfilmentChannel: null }, 'BRAND')).toThrow(VOUCHER_CHANNEL_SWITCH_MESSAGE);
    expect(planChannelWrite(coded, 'DIGITAL_VOUCHER')).toBeNull();
    expect(planChannelWrite(coded, undefined)).toBeNull();
    // A legacy physical-channel order with a code re-sending its own channel is not a switch.
    expect(planChannelWrite({ voucherCode: 'C-1', fulfilmentChannel: 'BRAND' }, 'BRAND')).toBeNull();
  });
  it('no code → the switch carries a "still no code" claim', () => {
    expect(planChannelWrite({ voucherCode: null, fulfilmentChannel: 'DIGITAL_VOUCHER' }, 'BRAND')).toEqual({
      OR: [{ voucherCode: null }, { voucherCode: '' }],
    });
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
      // Only the failure-scrub hint is new; nothing the member receives (or any stored row) changes.
      secretValues: ['AMZ-1234'],
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
    // Bell / push / SMS body never carries the PIN.
    expect(call.body).toBe('Your Croma Gift Card voucher is ready — card no. and PIN are in My Orders.');
    expect(call.subject).toBe('Your voucher code');
    // Every PERSISTED copy of the vars uses the masked value.
    expect(call.maskedVars).toEqual({ code: '6001 2200 1234 | PIN: see My Orders' });
    expect(JSON.stringify(call.maskedVars)).not.toMatch(/48|29/);
    // B6: the stored / SMS value is plain ASCII (GSM-7 safe) — no bullets.
    expect(call.maskedVars.code).toMatch(/^[ -~]+$/);
    // Secrets for the failure-reason scrub: the combined value, the code and the PIN.
    expect(call.secretValues).toEqual([
      '6001 2200 1234 | PIN: 48 29', '6001 2200\t1234', '6001 2200 1234', '48\n29', '48 29',
    ]);
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
  it('mask: last 4 only for a 12+ char code; shorter codes fully masked', () => {
    expect(maskVoucherCodeForAudit('123456789012')).toBe('••••9012');
    expect(maskVoucherCodeForAudit('12345678901')).toBe('••••');
    expect(maskVoucherCodeForAudit('AMZ-1234')).toBe('••••');
    expect(maskVoucherCodeForAudit('')).toBe('••••');
  });
  it('a set-once PIN add is audited under its own event, PIN masked', async () => {
    const create = jest.fn().mockResolvedValue({});
    await recordVoucherIssuedAudit({ auditLog: { create } } as never, {
      actorId: 'a', orderId: 'o1', code: 'C-1', pin: '9911', path: 'X', event: 'VOUCHER_PIN_ADDED_MANUAL',
    });
    const meta = create.mock.calls[0][0].data.metadata;
    expect(meta).toMatchObject({ event: 'VOUCHER_PIN_ADDED_MANUAL', voucherCode: '••••', voucherPin: '••••' });
    expect(JSON.stringify(meta)).not.toContain('9911');
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
    // The Voucher Code column is text-formatted too (a 16-digit card number must not become 6.0E+15).
    expect(ws[XLSX.utils.encode_cell({ r: 1, c: FULFILMENT_COLS.indexOf('Voucher Code') })].z).toBe('@');
  });
  it('a Voucher Code / PIN cell stored as a NUMBER → row error (not applied); text cells parse', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Order Number', 'Voucher Code', 'Voucher PIN'],
      ['RDM-1', 6001220012345678, ''],
      ['RDM-2', 'C-2', 123],
      ['RDM-3', '0042', '0099'],
    ]), 'Fulfilment');
    const { rows } = parseFulfilmentUploadBuffer(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(rows[0]).toEqual({ rowIndex: 2, orderNumber: 'RDM-1', error: VOUCHER_CELL_NUMBER_MESSAGE });
    expect(rows[1]).toEqual({ rowIndex: 3, orderNumber: 'RDM-2', error: VOUCHER_CELL_NUMBER_MESSAGE });
    expect(rows[2]).toMatchObject({ orderNumber: 'RDM-3', voucherCode: '0042', voucherPin: '0099' });
    expect(rows[2].error).toBeUndefined();
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
