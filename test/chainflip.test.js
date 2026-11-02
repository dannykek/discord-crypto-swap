import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainflipClient, ChainflipError, chainflipAsset, minimumPrice } from '../src/services/chainflip-client.js';
import { SwapClient } from '../src/services/swap-client.js';
import { OneClickClient } from '../src/services/oneclick-client.js';
import { classifyOperationalError } from '../src/services/error-classifier.js';

const btcAddress = 'bc1qujr7jlxeh4m20lldqh4fcsl63ff2ee6uk60g8r';
const evmAddress = '0xF0AE622e463fa757Cf72243569E18Be7Df1996cd';
const deposit = 'bc1qdepositaddressxxxxxxxxxxxxxxxxxxxxxxx';
const config = { chainflipBrokerApiKey: 'test-key', chainflipBrokerUrl: 'https://chainflip-broker.io', oneClickBaseUrl: 'https://1click.chaindefuser.com', oneClickJwt: 'test', fundingDeadlineMs: 3600000, slippageBps: 50 };
const originAsset = { assetId: 'nep141:btc.omft.near', blockchain: 'btc', symbol: 'BTC', decimals: 8, price: 78000 };
const destinationAsset = { assetId: 'nep141:eth-usdt', blockchain: 'eth', symbol: 'USDT', decimals: 6, contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', price: 1 };
const params = { originAsset, destinationAsset, amountBase: '2000000', recipient: evmAddress, refundTo: btcAddress, dry: true };
const assets = [
  { enabled: true, id: 'btc.btc', direction: 'both', ticker: 'BTC', network: 'Bitcoin', decimals: 8, minimalAmountNative: '40000' },
  { enabled: true, id: 'usdt.eth', direction: 'both', ticker: 'USDT', network: 'Ethereum', contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, minimalAmountNative: '20000000' },
  { enabled: true, id: 'usdt.tron', direction: 'both', ticker: 'USDT', network: 'Tron', contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, minimalAmountNative: '10000000' },
];
function quotes() {
  return [
    { type: 'dca', ingressAsset: 'btc.btc', egressAsset: 'usdt.eth', ingressAmountNative: '2000000', egressAmountNative: '1600000000', estimatedPrice: 80000 },
    { type: 'regular', ingressAsset: 'btc.btc', egressAsset: 'usdt.eth', ingressAmountNative: '2000000', egressAmountNative: '1555948603', estimatedPrice: 77799.5,
      estimatedDurationSeconds: 1014, lowLiquidityWarning: false, recommendedRetryDurationInBlocks: 300, recommendedLivePriceSlippageTolerancePercent: 0.75 },
  ];
}
const channel = { id: 42, address: deposit, issuedBlock: 1504251, network: 'Bitcoin', channelId: 107, sourceExpiryBlock: 850819, channelOpeningFee: 0, channelOpeningFeeNative: '0', destinationAddress: evmAddress, explorerUrl: 'https://scan.chainflip.io/channels/1504251-Bitcoin-107' };
function respond(body, status = 200) { return { ok: status < 400, status, json: async () => body }; }
function mockClient(responses) {
  const fetchImpl = vi.fn().mockImplementation(async () => responses.shift());
  return { client: new ChainflipClient(config, { fetchImpl }), fetchImpl };
}
function swap() {
  return { deposit_address: deposit, recipient: evmAddress, refund_to: btcAddress,
    executable_quote: { provider: 'chainflip', quote: { depositAddress: deposit },
      providerData: { sourceAsset: 'btc.btc', destinationAsset: 'usdt.eth', network: 'Bitcoin', originChain: 'btc', destinationChain: 'eth',
        originDecimals: 8, destinationDecimals: 6, originPrice: 78000, destinationPrice: 1,
        channel: { issuedBlock: 1504251, network: 'Bitcoin', channelId: 107, swapId: 42 } } } };
}
function status(state = 'completed', extra = {}) {
  return { id: 42, platform: 'chainflip', status: {
    state, sourceAsset: 'btc.btc', destinationAsset: 'usdt.eth', destinationAddress: evmAddress,
    depositChannel: { depositAddress: deposit, fillOrKillParams: { refundAddress: btcAddress, minimumPrice: '77410.5', retryDurationBlocks: 300 } },
    brokers: [{ account: 'cFbaas', commissionBps: 5 }],
    deposit: { amountNative: '2000000', transactionReference: 'btcdeposithash' },
    swapEgress: { amountNative: '1555000000', transactionReference: '0xpayout' },
    lastStateChainUpdateAt: 1762000000000, ...extra } };
}
afterEach(() => vi.restoreAllMocks());

describe('Chainflip asset mapping', () => {
  it('matches native and contract assets exactly, case-insensitively only on EVM', () => {
    expect(chainflipAsset(originAsset, assets, 'ingress')?.id).toBe('btc.btc');
    expect(chainflipAsset(destinationAsset, assets, 'egress')?.id).toBe('usdt.eth');
    expect(chainflipAsset({ ...destinationAsset, contractAddress: '0x0000000000000000000000000000000000000001' }, assets, 'egress')).toBeNull();
    expect(chainflipAsset({ ...destinationAsset, decimals: 18 }, assets, 'egress')).toBeNull();
    expect(chainflipAsset({ ...originAsset, symbol: 'WBTC' }, assets, 'ingress')).toBeNull();
  });
  it('excludes Tron, unsupported chains, disabled assets and wrong directions', () => {
    expect(chainflipAsset({ blockchain: 'tron', symbol: 'USDT', decimals: 6, contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }, assets, 'egress')).toBeNull();
    expect(chainflipAsset({ blockchain: 'bsc', symbol: 'BNB', decimals: 18 }, assets, 'ingress')).toBeNull();
    expect(chainflipAsset(originAsset, [{ ...assets[0], enabled: false }], 'ingress')).toBeNull();
    expect(chainflipAsset(originAsset, [{ ...assets[0], direction: 'egress' }], 'ingress')).toBeNull();
  });
  it('derives the minimum price from the estimated price and slippage without exponent notation', () => {
    expect(minimumPrice(80000, 50)).toBe('79600');
    expect(minimumPrice(0.0000128, 50)).toMatch(/^0\.0000127/);
  });
});

describe('Chainflip quotes and deposit channels', () => {
  it('previews the regular quote with zero commission and no deposit address', async () => {
    const { client, fetchImpl } = mockClient([respond({ assets }), respond(quotes())]);
    const result = await client.getQuote(params);
    expect(result).toMatchObject({ provider: 'chainflip', quote: { amountOut: '1555948603', minAmountOut: '1548168859', amountInFormatted: '0.02' } });
    expect(result.quote.depositAddress).toBeUndefined();
    const url = new URL(fetchImpl.mock.calls[1][0]);
    expect(url.pathname).toBe('/quotes-native');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ sourceAsset: 'btc.btc', destinationAsset: 'usdt.eth', amount: '2000000', commissionBps: '0' });
    expect(fetchImpl.mock.calls[1][1].headers['X-API-Key']).toBe('test-key');
    expect(url.search).not.toContain('test-key');
    expect(fetchImpl.mock.calls[1][1].signal).toBeDefined();
  });
  it('opens a channel that refunds to the origin wallet when the price cannot be met', async () => {
    const { client, fetchImpl } = mockClient([respond({ assets }), respond(quotes()), respond(channel)]);
    const result = await client.getQuote({ ...params, dry: false });
    expect(result.quote.depositAddress).toBe(deposit);
    expect(result.providerData.channel).toEqual({ issuedBlock: 1504251, network: 'Bitcoin', channelId: 107, swapId: 42 });
    const url = new URL(fetchImpl.mock.calls[2][0]);
    expect(url.pathname).toBe('/swap');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ destinationAddress: evmAddress, refundAddress: btcAddress, commissionBps: '0',
      minimumPrice: '77410.5025', retryDurationInBlocks: '300', livePriceSlippageTolerancePercent: '0.75' });
    expect(url.searchParams.has('numberOfChunks')).toBe(false);
  });
  it.each(['destination', 'network', 'address', 'block'])('rejects a channel with a mismatched %s', async field => {
    const response = { ...channel };
    if (field === 'destination') response.destinationAddress = btcAddress;
    if (field === 'network') response.network = 'Ethereum';
    if (field === 'address') delete response.address;
    if (field === 'block') response.issuedBlock = 'abc';
    const { client } = mockClient([respond({ assets }), respond(quotes()), respond(response)]);
    await expect(client.getQuote({ ...params, dry: false })).rejects.toMatchObject({ code: 'CHAINFLIP_INVALID_RESPONSE' });
  });
  it.each(['asset', 'amount', 'output'])('rejects a quote with a mismatched %s', async field => {
    const response = quotes();
    if (field === 'asset') response[1].egressAsset = 'usdc.eth';
    if (field === 'amount') response[1].ingressAmountNative = '1';
    if (field === 'output') response[1].egressAmountNative = '0';
    const { client } = mockClient([respond({ assets }), respond(response)]);
    await expect(client.getQuote(params)).rejects.toMatchObject({ code: 'CHAINFLIP_INVALID_RESPONSE' });
  });
  it('treats DCA-only and low-liquidity quotes as no route', async () => {
    const { client } = mockClient([respond({ assets }), respond([quotes()[0]]), respond([{ ...quotes()[1], lowLiquidityWarning: true }])]);
    await expect(client.getQuote(params)).rejects.toMatchObject({ code: 'NO_LIQUIDITY_ROUTE' });
    await expect(client.getQuote(params)).rejects.toMatchObject({ code: 'NO_LIQUIDITY_ROUTE' });
  });
  it('rejects amounts below the broker minimum before requesting a quote', async () => {
    const { client, fetchImpl } = mockClient([respond({ assets })]);
    await expect(client.getQuote({ ...params, amountBase: '39999' })).rejects.toMatchObject({ code: 'AMOUNT_TOO_LOW' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('maps broker errors without leaking the key', async () => {
    const { client } = mockClient([respond({ title: 'test-key' }, 401)]);
    const error = await client.getAssets().catch(value => value);
    expect(error).toMatchObject({ name: 'ChainflipError', code: 'CHAINFLIP_AUTHENTICATION', status: 401 });
    expect(error.message).not.toContain('test-key');
    expect(classifyOperationalError(error).source).toBe('chainflip');
  });
  it('is disabled without an API key', async () => {
    const client = new ChainflipClient({ ...config, chainflipBrokerApiKey: null });
    expect(client.enabled).toBe(false);
    await expect(client.getQuote(params)).rejects.toBeInstanceOf(ChainflipError);
  });
});

describe('Chainflip lifecycle', () => {
  it('completes only with deposit, payout amount and payout transaction', async () => {
    const { client, fetchImpl } = mockClient([respond(status())]);
    const response = await client.getExecutionStatus(swap());
    expect(response).toMatchObject({ provider: 'chainflip', status: 'SUCCESS', requiresAttention: false,
      swapDetails: { depositedAmount: '2000000', amountOut: '1555000000', amountOutFormatted: '1555', amountInUsd: '1560.00000000' } });
    expect(response.swapDetails.destinationChainTxHashes[0].hash).toBe('0xpayout');
    expect(Object.fromEntries(new URL(fetchImpl.mock.calls[0][0]).searchParams)).toMatchObject({ issuedBlock: '1504251', network: 'Bitcoin', channelId: '107' });
  });
  it('keeps unfunded and not-yet-recorded channels pending', async () => {
    const { client } = mockClient([respond(status('waiting', { deposit: undefined, swapEgress: undefined })), respond({ code: 'swap_pending' }, 404)]);
    expect((await client.getExecutionStatus(swap())).status).toBe('PENDING_DEPOSIT');
    expect((await client.getExecutionStatus(swap())).status).toBe('PENDING_DEPOSIT');
  });
  it('reports a refund only after the refund transaction exists', async () => {
    const { client } = mockClient([respond(status('completed', { swapEgress: undefined, refundEgress: { amountNative: '1990000', transactionReference: 'btcrefund' } }))]);
    const response = await client.getExecutionStatus(swap());
    expect(response.status).toBe('REFUNDED');
    expect(response.swapDetails.refundTxHashes).toHaveLength(1);
    expect(response.swapDetails.destinationChainTxHashes).toEqual([]);
  });
  it('keeps failures under tracking with a review notice', async () => {
    const { client } = mockClient([respond(status('failed', { swapEgress: undefined }))]);
    expect(await client.getExecutionStatus(swap())).toMatchObject({ status: 'PROCESSING', requiresAttention: true });
  });
  it.each(['recipient', 'deposit', 'refund', 'asset', 'commission', 'payout'])('rejects mismatched settlement %s', async field => {
    const response = status();
    if (field === 'recipient') response.status.destinationAddress = btcAddress;
    if (field === 'deposit') response.status.depositChannel.depositAddress = evmAddress;
    if (field === 'refund') response.status.depositChannel.fillOrKillParams.refundAddress = evmAddress;
    if (field === 'asset') response.status.destinationAsset = 'usdc.eth';
    if (field === 'commission') response.status.brokers.push({ account: 'cFother', commissionBps: 25 });
    if (field === 'payout') delete response.status.swapEgress.transactionReference;
    const { client } = mockClient([respond(response)]);
    await expect(client.getExecutionStatus(swap())).rejects.toMatchObject({ code: 'CHAINFLIP_INVALID_RESPONSE' });
  });
});

describe('Three-way competing quotes', () => {
  function compete(near, relay, chainflip) {
    const client = new SwapClient({ ...config, relayApiKey: 'relay-key' });
    const spy = (target, value, provider) => {
      if (value instanceof Error) target.mockRejectedValue(value); else target.mockResolvedValue({ provider, quote: { amountOut: value } });
    };
    spy(vi.spyOn(OneClickClient.prototype, 'getVerifiedQuote'), near, undefined);
    spy(vi.spyOn(client.relay, 'getQuote'), relay, 'relay');
    const cf = vi.spyOn(client.chainflip, 'getQuote');
    spy(cf, chainflip, 'chainflip');
    return { client, cf };
  }
  it.each([['100', '101', '102', 'chainflip'], ['100', '102', '102', 'relay'], ['102', '101', '102', undefined], ['100', new Error('x'), '101', 'chainflip']])(
    'selects the highest exact net output (NEAR %s, Relay %s, Chainflip %s)', async (near, relay, chainflip, provider) => {
      expect((await compete(near, relay, chainflip).client.getVerifiedQuote(params)).provider).toBe(provider);
    });
  it('can use Chainflip when NEAR and Relay are unavailable', async () => {
    const { client } = compete(new Error('offline'), new Error('offline'), '100');
    expect((await client.getVerifiedQuote(params)).provider).toBe('chainflip');
  });
  it('keeps the confirmed provider pinned to Chainflip', async () => {
    const { client, cf } = compete('200', '200', '100');
    await client.getVerifiedQuote({ ...params, dry: false, provider: 'chainflip' });
    expect(cf).toHaveBeenCalledWith(expect.objectContaining({ dry: false, provider: 'chainflip' }));
    expect(OneClickClient.prototype.getVerifiedQuote).not.toHaveBeenCalled();
  });
  it('routes status and deposit submission for Chainflip swaps', async () => {
    const client = new SwapClient(config);
    const statusSpy = vi.spyOn(client.chainflip, 'getExecutionStatus').mockResolvedValue({ status: 'PENDING_DEPOSIT' });
    await client.getExecutionStatus(swap());
    expect(statusSpy).toHaveBeenCalledOnce();
    expect(() => client.submitDepositTransaction(swap(), 'hash')).toThrow(ChainflipError);
  });
});
