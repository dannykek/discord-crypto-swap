import { OneClickClient } from './oneclick-client.js';
import { ChangeNowClient, ChangeNowError } from './changenow-client.js';
import { ChangellyClient } from './changelly-client.js';
import { FixedFloatClient } from './fixedfloat-client.js';
import { RelayClient, RelayError } from './relay-client.js';
import { ChainflipClient, ChainflipError } from './chainflip-client.js';

function bestQuote(quotes) {
  return quotes.reduce((best, quote) => (quote && (!best || BigInt(quote.quote.amountOut) > BigInt(best.quote.amountOut)) ? quote : best), null);
}

export class SwapClient extends OneClickClient {
  constructor(config, options) {
    super(config);
    this.changeNow = new ChangeNowClient(config, options);
    this.changelly = new ChangellyClient(config, options);
    this.fixedFloat = new FixedFloatClient(config, options);
    this.relay = new RelayClient(config, options);
    this.chainflip = new ChainflipClient(config, options);
  }

  async getVerifiedQuote(parameters) {
    if (parameters.provider === 'relay') return this.relay.getQuote(parameters);
    if (parameters.provider === 'chainflip') return this.chainflip.getQuote(parameters);
    if (parameters.provider === 'fixedfloat') return this.fixedFloat.getQuote(parameters);
    // Execution stays with the provider explicitly shown in the preview.
    if (!parameters.dry && parameters.provider === 'changenow') return this.changeNow.getQuote(parameters);
    if (!parameters.dry && parameters.provider === 'changelly') return this.changelly.getQuote(parameters);
    // Compare net output in destination atomic units, never rounded dollar
    // values or advertised fee percentages. Confirmation stays pinned.
    // Ties keep the earlier provider: NEAR, then Relay, then Chainflip.
    const competing = parameters.dry ? [this.relay, this.chainflip].filter(client => client.enabled)
      .map(client => client.getQuote(parameters).then(value => value, () => null)) : [];
    try {
      const primary = await super.getVerifiedQuote(parameters);
      return bestQuote([primary, ...await Promise.all(competing)]);
    } catch (error) {
      const classification = this.classifyError(error, { operation: 'preview_quote' });
      const alternative = bestQuote(await Promise.all(competing));
      // A primary signature/parameter failure must never be masked by routing.
      if (classification.source === 'security') throw error;
      if (alternative) return alternative;
      const fallbacks = [this.changelly, this.changeNow].filter(client => client.enabled);
      if (!fallbacks.length || classification.source !== 'oneclick' || classification.code !== 'NO_LIQUIDITY_ROUTE') throw error;
      if (!parameters.dry) {
        throw new ChangeNowError('CHANGENOW_REFRESH_REQUIRED', '1Click has no route now. Refresh the preview to review a fallback provider before confirming.');
      }
      for (const client of fallbacks) {
        try { return await client.getQuote(parameters); }
        catch (fallbackError) {
          if (fallbackError.code !== 'NO_LIQUIDITY_ROUTE' || client === fallbacks.at(-1)) throw fallbackError;
        }
      }
    }
  }

  canUseFixedFloat(parameters) {
    return this.fixedFloat.canQuote(parameters);
  }

  getFixedFloatIndicativeQuote(parameters) {
    return this.fixedFloat.getIndicativeQuote(parameters);
  }

  getFixedFloatOffer(parameters) {
    return this.fixedFloat.getBackupOffer(parameters);
  }

  getExecutionStatus(swap) {
    if (swap.executable_quote?.provider === 'relay') return this.relay.getExecutionStatus(swap);
    if (swap.executable_quote?.provider === 'chainflip') return this.chainflip.getExecutionStatus(swap);
    if (swap.executable_quote?.provider === 'fixedfloat') return this.fixedFloat.getExecutionStatus(swap);
    if (swap.executable_quote?.provider === 'changelly') return this.changelly.getExecutionStatus(swap);
    return swap.executable_quote?.provider === 'changenow'
      ? this.changeNow.getExecutionStatus(swap) : super.getExecutionStatus(swap);
  }

  chooseFixedFloatRecovery(swap, choice) {
    return this.fixedFloat.chooseRecovery(swap, choice);
  }

  submitDepositTransaction(swap, txHash) {
    if (swap.executable_quote?.provider === 'relay') throw new RelayError('RELAY_AUTOMATIC_DETECTION', 'Deposits are detected automatically. Use Check status after sending.');
    if (swap.executable_quote?.provider === 'chainflip') throw new ChainflipError('CHAINFLIP_AUTOMATIC_DETECTION', 'Deposits are detected automatically. Use Check status after sending.');
    if (['changenow', 'changelly', 'fixedfloat'].includes(swap.executable_quote?.provider)) {
      throw new ChangeNowError('CHANGENOW_AUTOMATIC_DETECTION', 'This provider detects deposits automatically. Use Check status after sending.');
    }
    return super.submitDepositTransaction(swap, txHash);
  }
}
