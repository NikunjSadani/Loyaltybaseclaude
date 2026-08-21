// Unit tests for SetNotificationTemplatesDto under the GLOBAL ValidationPipe config.
//
// The load-bearing test: reproduce main.ts's pipe ({ whitelist, forbidNonWhitelisted, transform,
// enableImplicitConversion }) and PROVE a real events payload is NOT stripped — the exact failure
// (a bare nested object emptied by whitelist:true) that 400'd every TDS-statutory save.
// Run: npx jest src/notification-templates/dto/notification-templates.dto.spec.ts

import 'reflect-metadata'; // polyfill Reflect.* for the class-transformer @Type decorator
import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { SetNotificationTemplatesDto } from './notification-templates.dto';

// EXACTLY the global pipe from main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const meta: ArgumentMetadata = { type: 'body', metatype: SetNotificationTemplatesDto, data: '' };

describe('SetNotificationTemplatesDto under the global whitelist pipe', () => {
  it('KEEPS the nested events payload (NOT stripped by whitelist:true)', async () => {
    const body = {
      masterSms: true,
      masterWhatsapp: true,
      events: {
        KYC_SUBMITTED: { mode: 'BOTH', whatsappTemplate: 'wa_tpl', smsTemplateId: 'SMS1' },
        PAYOUT_CREDITED: { mode: 'SMS', smsTemplateId: 'SMS2' },
      },
    };
    const out = (await pipe.transform(body, meta)) as SetNotificationTemplatesDto;
    // The whole nested structure must survive — this is the regression guard.
    expect(out.events).toBeDefined();
    expect(out.events!.KYC_SUBMITTED).toEqual({ mode: 'BOTH', whatsappTemplate: 'wa_tpl', smsTemplateId: 'SMS1' });
    expect(out.events!.PAYOUT_CREDITED).toEqual({ mode: 'SMS', smsTemplateId: 'SMS2' });
    expect(out.masterSms).toBe(true);
    expect(out.masterWhatsapp).toBe(true);
  });

  it('accepts a masters-only body (events optional)', async () => {
    const out = (await pipe.transform({ masterSms: false, masterWhatsapp: true }, meta)) as SetNotificationTemplatesDto;
    expect(out.masterSms).toBe(false);
    expect(out.masterWhatsapp).toBe(true);
    expect(out.events).toBeUndefined();
  });

  it('REJECTS an unknown event key via forbidNonWhitelisted', async () => {
    const body = { masterSms: false, masterWhatsapp: false, events: { NOT_AN_EVENT: { mode: 'SMS' } } };
    await expect(pipe.transform(body, meta)).rejects.toThrow();
  });

  it('REJECTS an invalid mode value', async () => {
    const body = { masterSms: false, masterWhatsapp: false, events: { KYC_SUBMITTED: { mode: 'LOUD' } } };
    await expect(pipe.transform(body, meta)).rejects.toThrow();
  });

  it('REJECTS an unknown property inside an event (forbidNonWhitelisted at the nested level)', async () => {
    const body = { masterSms: false, masterWhatsapp: false, events: { KYC_SUBMITTED: { mode: 'SMS', foo: 'bar' } } };
    await expect(pipe.transform(body, meta)).rejects.toThrow();
  });

  // Note: non-boolean master rejection is asserted in the service spec via
  // validateNotificationTemplatesInput (coercion-free) — the pipe path is left to the DTO's
  // @IsBoolean but not tested here to avoid depending on class-transformer's implicit-conversion
  // rules for boolean coercion.

  it('REJECTS an over-long template string (@MaxLength)', async () => {
    const body = {
      masterSms: false,
      masterWhatsapp: false,
      events: { KYC_SUBMITTED: { mode: 'WHATSAPP', whatsappTemplate: 'x'.repeat(201) } },
    };
    await expect(pipe.transform(body, meta)).rejects.toThrow();
  });

  it('REJECTS a top-level unknown property', async () => {
    await expect(
      pipe.transform({ masterSms: false, masterWhatsapp: false, bogus: 1 }, meta),
    ).rejects.toThrow();
  });
});
