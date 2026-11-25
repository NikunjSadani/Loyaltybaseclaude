import { BadRequestException, ConflictException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(e: unknown) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as never;
  new AllExceptionsFilter().catch(e, host);
  return { status: (status.mock.calls as unknown[][])[0][0], body: (json.mock.calls as unknown[][])[0][0] };
}

describe('AllExceptionsFilter', () => {
  it('keeps the standard envelope for every ordinary exception (no details key)', () => {
    expect(run(new BadRequestException('nope'))).toEqual({ status: 400, body: { success: false, error: 'nope' } });
    expect(run(new ConflictException({ message: 'held', heldBlocking: [1] }))).toEqual({
      status: 409,
      body: { success: false, error: 'held' },
    });
  });

  it('passes an opt-in `details` object through (the credits confirm missingAcknowledgements)', () => {
    const e = new BadRequestException({ message: 'tick first', details: { missingAcknowledgements: ['ROUNDED'] } });
    expect(run(e)).toEqual({
      status: 400,
      body: { success: false, error: 'tick first', details: { missingAcknowledgements: ['ROUNDED'] } },
    });
  });
});
