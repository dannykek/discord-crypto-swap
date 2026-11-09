import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import { createCompletionRoutePng } from '../src/services/completion-graphic.js';
import { completionVouchText, vouchAssetLabel } from '../src/services/completion-presentation.js';

const { PNG } = pngjs;

describe('completed swap presentation', () => {
  it('uses the exact vouch format and only offers it after confirmed success', () => {
    const swap = {
      status: 'SUCCESS',
      amount_usd_requested: '180',
      executable_quote: { quote: { amountInUsd: '180' } },
    };
    expect(completionVouchText(swap, { symbol: 'LTC', blockchain: 'ltc' }, { symbol: 'USDT', blockchain: 'bsc' }))
      .toBe('Vouch <@1412664174042943518> $180 (LTC → USDT BEP 20)');
    expect(vouchAssetLabel({ symbol: 'USDC', blockchain: 'eth' })).toBe('USDC ERC 20');
    expect(vouchAssetLabel({ symbol: 'SOL', blockchain: 'sol' })).toBe('SOL');
    expect(() => completionVouchText({ ...swap, status: 'PROCESSING' }, { symbol: 'LTC' }, { symbol: 'ETH' })).toThrow();
  });

  it('uses the observed deposited USD value rather than the initial estimate', () => {
    const swap = {
      status: 'SUCCESS',
      amount_usd_requested: '180',
      executable_quote: { quote: { amountInUsd: '180' } },
      last_status_response: { swapDetails: { depositedAmountUsd: '179.63' } },
    };
    expect(completionVouchText(swap, { symbol: 'SOL', blockchain: 'sol' }, { symbol: 'ETH', blockchain: 'eth' }))
      .toBe('Vouch <@1412664174042943518> $179.63 (SOL → ETH)');
  });

  it('renders a compact real PNG route graphic from bundled token and network logos', async () => {
    const graphic = await createCompletionRoutePng(
      { symbol: 'USDT', blockchain: 'bsc' },
      { symbol: 'LTC', blockchain: 'ltc' },
    );
    expect(graphic.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    const decoded = PNG.sync.read(graphic);
    expect(decoded.width).toBe(448);
    expect(decoded.height).toBe(116);
    expect(graphic.length).toBeGreaterThan(1500);
  });
});
