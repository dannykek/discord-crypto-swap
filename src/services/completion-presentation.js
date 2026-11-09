import { completedSwapAmountUsd, formatUsd } from '../utils/amounts.js';

export const VOUCH_TARGET_ID = '1412664174042943518';

const NETWORK_NAMES = Object.freeze({
  eth: 'ERC 20',
  bsc: 'BEP 20',
  sol: 'SPL',
  tron: 'TRC 20',
  arb: 'Arbitrum',
  base: 'Base',
  op: 'Optimism',
  pol: 'Polygon',
  avax: 'Avalanche',
});
const NATIVE_CHAIN = Object.freeze({
  BTC: 'btc', LTC: 'ltc', ETH: 'eth', SOL: 'sol', BNB: 'bsc',
  DOGE: 'doge', AVAX: 'avax', POL: 'pol', XRP: 'xrp', TRX: 'tron',
  NEAR: 'near', ADA: 'cardano', TON: 'ton', SUI: 'sui',
});

export function vouchAssetLabel(asset) {
  const symbol = String(asset?.symbol ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 18);
  if (!symbol) return 'UNKNOWN';
  const chain = String(asset?.blockchain ?? '').toLowerCase();
  const label = NETWORK_NAMES[chain];
  if (!label) return symbol;
  if (['USDT', 'USDC'].includes(symbol) || (NATIVE_CHAIN[symbol] && NATIVE_CHAIN[symbol] !== chain)) {
    return `${symbol} ${label}`;
  }
  return symbol;
}

export function completionVouchText(swap, origin, destination) {
  if (swap?.status !== 'SUCCESS') throw new Error('Vouches are only offered for confirmed successful swaps.');
  const details = swap.last_status_response?.swapDetails ?? {};
  const amountUsd = details.depositedAmountUsd ?? details.amountInUsd ?? completedSwapAmountUsd(swap);
  const formattedAmount = formatUsd(amountUsd);
  if (formattedAmount === '$0.00') throw new Error('Completed swap USD amount is unavailable.');
  const conciseAmount = formattedAmount.endsWith('.00') ? formattedAmount.slice(0, -3) : formattedAmount;
  return `Vouch <@${VOUCH_TARGET_ID}> ${conciseAmount} (${vouchAssetLabel(origin)} → ${vouchAssetLabel(destination)})`;
}
