import { buildFundStatement, type FundStatement } from './fund-statement.engine';
import type { FundInputs } from './fund-sources.loader';

/** The statement for loaded inputs — ONE definition shared by the screen, the Excel, the dashboard and the digest. */
export function statementOf(inputs: FundInputs): FundStatement {
  return buildFundStatement({
    items: inputs.items,
    entries: inputs.entries,
    rates: inputs.rates,
    extraReceivables: inputs.extraReceivables,
    rateChanges: inputs.rateChanges,
  });
}
