import { fromBaseUnits } from '../utils/amounts.js';
import { transactionExplorerUrl } from './transaction-explorer.js';

// Tron stays off until Chainflip's reported Tron incident is officially resolved.
const NETWORKS = { btc: 'Bitcoin', eth: 'Ethereum', arb: 'Arbitrum', sol: 'Solana' };
const NATIVE = { btc: 'BTC', eth: 'ETH', arb: 'ETH', sol: 'SOL' };
const STATES = { waiting: 'PENDING_DEPOSIT', receiving: 'KNOWN_DEPOSIT_TX', swapping: 'PROCESSING', sending: 'PROCESSING', sent: 'PROCESSING', completed: 'SUCCESS', failed: 'PROCESSING' };
// The hosted broker adds a 5 bps operating fee. Anything above it means a
// partner commission was charged, which this bot never requests.
const MAX_BROKER_BPS = 5;
const MAX_RETRY_BLOCKS = 14_400;
const PENDING = Symbol('pending');

export class ChainflipError extends Error {
  constructor(code, message = 'The swap service could not complete this request. Please refresh or try again later.', status = null) {
    super(message);
    this.name = 'ChainflipError';
    this.code = code;
    this.status = status;
  }
}

function invalid() { throw new ChainflipError('CHAINFLIP_INVALID_RESPONSE', 'The swap details failed verification. Do not send another deposit; tracking will retry.'); }
function atomic(value) { return typeof value === 'string' && /^\d+$/.test(value); }
function validAddress(value) { return typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\s`<>]/u.test(value) && ![...value].some(char => char.codePointAt(0) < 32); }
function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && (/^0x/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);
}
function blockNumber(value) { return Number.isSafeInteger(value) && value >= 0; }
function usd(amountBase, decimals, price) { const n = Number(fromBaseUnits(amountBase, decimals)) * Number(price); return Number.isFinite(n) && n > 0 ? n.toFixed(8) : null; }
function sameContract(a, b, blockchain) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return ['eth', 'arb'].includes(blockchain) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function chainflipAsset(asset, assets, side) {
  const network = NETWORKS[asset?.blockchain];
  if (!network || !Array.isArray(assets)) return null;
  const matches = assets.filter(item => item?.enabled === true && item.network === network && item.decimals === asset.decimals
    && [side, 'both'].includes(item.direction)
    && (asset.contractAddress ? sameContract(item.contractAddress, asset.contractAddress, asset.blockchain)
      : !item.contractAddress && asset.symbol === NATIVE[asset.blockchain] && item.ticker === asset.symbol));
  return matches.length === 1 && typeof matches[0].id === 'string' ? matches[0] : null;
}

// Chainflip's minimum price is in whole destination units per whole source unit.
export function minimumPrice(estimatedPrice, slippageBps) {
  const value = Number(estimatedPrice) * (10_000 - slippageBps) / 10_000;
  if (!Number.isFinite(value) || value <= 0) invalid();
  // Twelve significant digits avoids exponents and floating-point noise.
  const decimals = Math.min(20, Math.max(0, 11 - Math.floor(Math.log10(value))));
  const text = value.toFixed(decimals);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

export class ChainflipClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.assets = null;
    this.assetsAt = 0;
  }

  get enabled() { return Boolean(this.config.chainflipBrokerApiKey); }

  async request(path, params = {}) {
    if (!this.enabled) throw new ChainflipError('CHAINFLIP_UNAVAILABLE');
    const url = new URL(path, this.config.chainflipBrokerUrl ?? 'https://chainflip-broker.io');
    for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetch(url, {
        headers: { Accept: 'application/json', 'X-API-Key': this.config.chainflipBrokerApiKey },
        signal: globalThis.AbortSignal.timeout(15_000), redirect: 'error',
      });
    } catch { throw new ChainflipError('CHAINFLIP_UNAVAILABLE'); }
    const data = await response.json().catch(() => null);
    if (response.status === 404 && data?.code === 'swap_pending') return PENDING;
    if (!response.ok) throw new ChainflipError(errorCode(response.status, data), undefined, response.status);
    if (!data || typeof data !== 'object') invalid();
    return data;
  }

  async getAssets() {
    if (this.assets && Date.now() - this.assetsAt < 300_000) return this.assets;
    const data = await this.request('/assets');
    if (!Array.isArray(data.assets)) invalid();
    this.assets = data.assets;
    this.assetsAt = Date.now();
    return this.assets;
  }

  async getQuote(parameters) {
    const { originAsset, destinationAsset, amountBase, recipient, refundTo, dry } = parameters;
    const assets = await this.getAssets();
    const source = chainflipAsset(originAsset, assets, 'ingress'), target = chainflipAsset(destinationAsset, assets, 'egress');
    if (!source || !target || source.id === target.id) throw new ChainflipError('NO_LIQUIDITY_ROUTE');
    if (!validAddress(recipient) || !validAddress(refundTo)) throw new ChainflipError('INVALID_WALLET_ADDRESS');
    if (atomic(source.minimalAmountNative) && BigInt(amountBase) < BigInt(source.minimalAmountNative)) throw new ChainflipError('AMOUNT_TOO_LOW');
    const quotes = await this.request('/quotes-native', { sourceAsset: source.id, destinationAsset: target.id, amount: amountBase, commissionBps: 0 });
    if (!Array.isArray(quotes)) invalid();
    // DCA quotes split the deposit over many minutes; only immediate swaps are offered.
    const quote = quotes.find(item => item?.type === 'regular');
    if (!quote || quote.lowLiquidityWarning === true) throw new ChainflipError('NO_LIQUIDITY_ROUTE');
    if (quote.ingressAsset !== source.id || quote.egressAsset !== target.id || quote.ingressAmountNative !== amountBase
      || !atomic(quote.egressAmountNative) || BigInt(quote.egressAmountNative) <= 0n || !(Number(quote.estimatedPrice) > 0)) invalid();
    const slippageBps = this.config.slippageBps;
    const amountOut = quote.egressAmountNative;
    const minAmountOut = (BigInt(amountOut) * BigInt(10_000 - slippageBps) / 10_000n).toString();
    const createdAt = Date.now();
    // Channels stay open about a day, so the bot's shorter funding window governs.
    const deadline = new Date(createdAt + this.config.fundingDeadlineMs).toISOString();
    const result = {
      provider: 'chainflip',
      providerData: { sourceAsset: source.id, destinationAsset: target.id, network: source.network,
        originChain: originAsset.blockchain, destinationChain: destinationAsset.blockchain,
        originDecimals: originAsset.decimals, destinationDecimals: destinationAsset.decimals,
        originPrice: originAsset.price ?? null, destinationPrice: destinationAsset.price ?? null, createdAt },
      quoteRequest: { dry, originAsset: originAsset.assetId, destinationAsset: destinationAsset.assetId, amount: amountBase, recipient, refundTo, deadline, appFees: [] },
      quote: { amountIn: amountBase, amountInFormatted: fromBaseUnits(amountBase, originAsset.decimals), amountInUsd: usd(amountBase, originAsset.decimals, originAsset.price),
        amountOut, amountOutFormatted: fromBaseUnits(amountOut, destinationAsset.decimals), amountOutUsd: usd(amountOut, destinationAsset.decimals, destinationAsset.price),
        minAmountOut, minAmountOutFormatted: fromBaseUnits(minAmountOut, destinationAsset.decimals),
        deadline, timeEstimate: quote.estimatedDurationSeconds },
    };
    if (dry) return result;

    const retryBlocks = Number.isSafeInteger(quote.recommendedRetryDurationInBlocks) && quote.recommendedRetryDurationInBlocks > 0
      ? Math.min(quote.recommendedRetryDurationInBlocks, MAX_RETRY_BLOCKS) : 150;
    // A swap below the minimum price retries for retryBlocks, then refunds to the origin wallet.
    const channel = await this.request('/swap', {
      sourceAsset: source.id, destinationAsset: target.id, destinationAddress: recipient, refundAddress: refundTo, commissionBps: 0,
      minimumPrice: minimumPrice(quote.estimatedPrice, slippageBps), retryDurationInBlocks: retryBlocks,
      livePriceSlippageTolerancePercent: quote.recommendedLivePriceSlippageTolerancePercent ?? undefined,
    });
    if (channel.destinationAddress !== recipient || channel.network !== source.network || !validAddress(channel.address)
      || !blockNumber(channel.issuedBlock) || !blockNumber(channel.channelId)) invalid();
    result.providerData.channel = { issuedBlock: channel.issuedBlock, network: channel.network, channelId: channel.channelId, swapId: channel.id ?? null };
    result.quote.depositAddress = channel.address;
    return result;
  }

  async getExecutionStatus(swap) {
    const stored = swap.executable_quote, info = stored?.providerData, channel = info?.channel;
    if (stored?.provider !== 'chainflip' || !channel || stored.quote.depositAddress !== swap.deposit_address) invalid();
    const data = await this.request('/status-by-deposit-channel', { issuedBlock: channel.issuedBlock, network: channel.network, channelId: channel.channelId });
    if (data === PENDING) return { provider: 'chainflip', status: 'PENDING_DEPOSIT', updatedAt: new Date().toISOString(), swapDetails: {} };
    const status = data.status;
    const fillOrKill = status?.fillOrKillParams ?? status?.depositChannel?.fillOrKillParams;
    const brokerBps = (status?.brokers ?? []).reduce((sum, broker) => sum + Number(broker?.commissionBps ?? NaN), 0);
    if (!status || status.sourceAsset !== info.sourceAsset || status.destinationAsset !== info.destinationAsset
      || !sameAddress(status.destinationAddress, swap.recipient) || !sameAddress(status.depositChannel?.depositAddress, swap.deposit_address)
      || !sameAddress(fillOrKill?.refundAddress, swap.refund_to) || !(brokerBps <= MAX_BROKER_BPS)) invalid();
    let result = STATES[status.state];
    if (!result) throw new ChainflipError('CHAINFLIP_UNKNOWN_STATUS');

    const details = {};
    const { deposit, swapEgress, refundEgress } = status;
    if (deposit?.amountNative != null) {
      if (!atomic(deposit.amountNative)) invalid();
      details.depositedAmount = deposit.amountNative;
      details.amountInFormatted = fromBaseUnits(deposit.amountNative, info.originDecimals);
      details.amountInUsd = usd(deposit.amountNative, info.originDecimals, info.originPrice);
    }
    if (swapEgress?.amountNative != null) {
      if (!atomic(swapEgress.amountNative)) invalid();
      details.amountOut = swapEgress.amountNative;
      details.amountOutFormatted = fromBaseUnits(swapEgress.amountNative, info.destinationDecimals);
      details.amountOutUsd = usd(swapEgress.amountNative, info.destinationDecimals, info.destinationPrice);
    }
    details.originChainTxHashes = txDetails(info.originChain, deposit?.transactionReference);
    details.destinationChainTxHashes = txDetails(info.destinationChain, swapEgress?.transactionReference);
    details.refundTxHashes = txDetails(info.originChain, refundEgress?.transactionReference);

    const refundedOnly = !swapEgress && details.refundTxHashes.length > 0;
    if (refundedOnly && ['sent', 'completed'].includes(status.state)) result = 'REFUNDED';
    else if (result === 'SUCCESS' && (!details.depositedAmount || BigInt(details.depositedAmount) <= 0n
      || !details.amountOut || BigInt(details.amountOut) <= 0n || !details.destinationChainTxHashes.length)) invalid();
    const requiresAttention = status.state === 'failed' || Boolean(deposit?.failure || swapEgress?.failure || refundEgress?.failure);
    return { provider: 'chainflip', status: result, providerStatus: status.state, requiresAttention,
      updatedAt: new Date(status.lastStateChainUpdateAt ?? Date.now()).toISOString(), swapDetails: details };
  }
}

function errorCode(status, data) {
  if (status === 401) return 'CHAINFLIP_AUTHENTICATION';
  if (status === 403 || data?.code === 'insufficient_liquidity') return 'NO_LIQUIDITY_ROUTE';
  if (status === 429) return 'CHAINFLIP_RATE_LIMITED';
  if (status === 400 && data?.errors?.minimalAmountNative) return 'AMOUNT_TOO_LOW';
  if (status === 400) return 'CHAINFLIP_REQUEST_REJECTED';
  return 'CHAINFLIP_UNAVAILABLE';
}

function txDetails(chain, hash) {
  return validAddress(hash) ? [{ hash, explorerUrl: transactionExplorerUrl(chain, hash) ?? undefined }] : [];
}
