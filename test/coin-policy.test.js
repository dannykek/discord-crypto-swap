import { describe, expect, it } from 'vitest';
import { CoinPolicy } from '../src/services/coin-policy.js';

const pinnedAssets = [
  entry('BTC', 'btc', 'nep141:btc.omft.near'),
  entry('ETH', 'eth', 'nep141:eth.omft.near'),
  entry('ETH', 'arb', 'nep141:arb.omft.near'),
  entry('SOL', 'sol', 'nep141:sol.omft.near'),
  entry('LTC', 'ltc', 'nep141:ltc.omft.near'),
  entry('USDT', 'eth', 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near'),
  entry('USDC', 'eth', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'),
  entry('USDT', 'bsc', 'nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near'),
  entry('USDC', 'bsc', 'nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near'),
  entry('BNB', 'bsc', 'nep141:bnb.omdep.near'),
  entry('POL', 'pol', 'nep245:v2_1.omni.hot.tg:137_11111111111111111111'),
  entry('DOGE', 'doge', 'nep141:doge.omft.near'),
];

describe('curated coin policy', () => {
  it('keeps featured ordering and exposes only pinned live assets', () => {
    const policy = makePolicy(pinnedAssets);
    expect(policy.getFeaturedCoins().map((coin) => coin.key)).toEqual(['BTC', 'ETH', 'SOL', 'LTC', 'USDT', 'USDC', 'BNB', 'POL']);
    expect(policy.getAssetsForCoin('ETH').map((asset) => asset.blockchain)).toEqual(['eth', 'arb']);
    expect(policy.getAssetsForCoin('LTC')).toHaveLength(1);
    expect(policy.getAssetsForCoin('USDT').map((asset) => asset.blockchain)).toEqual(['eth', 'bsc']);
    expect(policy.getAssetsForCoin('USDC').map((asset) => asset.blockchain)).toEqual(['eth', 'bsc']);
    expect(policy.getAssetsForCoin('BNB').map((asset) => asset.assetId)).toEqual(['nep141:bnb.omdep.near']);
  });

  it('accepts active BNB Chain assets and never exposes deprecated lookalikes', () => {
    const oldAssets = [
      entry('USDT', 'bsc', 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g'),
      entry('USDC', 'bsc', 'nep245:v2_1.omni.hot.tg:56_2w93GqMcEmQFDru84j3HZZWt557r'),
      entry('BNB', 'bsc', 'nep245:v2_1.omni.hot.tg:56_11111111111111111111'),
    ];
    const current = makePolicy([...pinnedAssets, ...oldAssets]);
    expect(current.getAssetsForCoin('USDT').filter((asset) => asset.blockchain === 'bsc').map((asset) => asset.assetId))
      .toEqual(['nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near']);
    expect(current.getAssetsForCoin('USDC').filter((asset) => asset.blockchain === 'bsc').map((asset) => asset.assetId))
      .toEqual(['nep141:bnb-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omdep.near']);
    expect(current.getAssetsForCoin('BNB').map((asset) => asset.assetId))
      .toEqual(['nep141:bnb.omdep.near']);

    const deprecatedOnly = makePolicy([...pinnedAssets.filter((asset) => asset.blockchain !== 'bsc'), ...oldAssets]);
    expect(deprecatedOnly.getAssetsForCoin('USDT').some((asset) => asset.blockchain === 'bsc')).toBe(false);
    expect(deprecatedOnly.getAssetsForCoin('USDC').some((asset) => asset.blockchain === 'bsc')).toBe(false);
    expect(deprecatedOnly.getAssetsForCoin('BNB')).toEqual([]);
  });

  it('fails closed for an unknown same-symbol asset and for pinned metadata mismatch', () => {
    const assets = [
      ...pinnedAssets.filter((asset) => asset.symbol !== 'BTC'),
      entry('BTC', 'aptos', 'attacker-controlled-btc'),
      entry('NOTBTC', 'btc', 'nep141:btc.omft.near'),
    ];
    const policy = makePolicy(assets);
    expect(policy.getAssetsForCoin('BTC')).toEqual([]);
    expect(policy.getFeaturedCoins().some((coin) => coin.key === 'BTC')).toBe(false);
  });

  it('allows a same-coin cross-network destination but removes the identical asset', () => {
    const policy = makePolicy(pinnedAssets);
    const origin = policy.getAssetsForCoin('ETH')[0];
    expect(policy.getAssetsForCoin('ETH', origin.assetId).map((asset) => asset.blockchain)).toEqual(['arb']);
    expect(policy.getAssetsForCoin('LTC', 'nep141:ltc.omft.near')).toEqual([]);
  });

  it('adds native NEAR only for one unambiguous official catalogue match', () => {
    const one = makePolicy([...pinnedAssets, entry('NEAR', 'near', 'future-native-near')]);
    expect(one.getOtherCoins().map((coin) => coin.key)).toContain('NEAR');

    const ambiguous = makePolicy([
      ...pinnedAssets,
      entry('NEAR', 'near', 'future-native-near-a'),
      entry('NEAR', 'near', 'future-native-near-b'),
    ]);
    expect(ambiguous.getOtherCoins().map((coin) => coin.key)).not.toContain('NEAR');
  });
});

function makePolicy(assets) {
  return new CoinPolicy({
    getAssets: () => assets,
    getAsset: (assetId) => assets.find((asset) => asset.assetId === assetId) ?? null,
  });
}

function entry(symbol, blockchain, assetId) {
  return { symbol, blockchain, assetId, decimals: 8 };
}
