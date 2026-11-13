import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { networkLabel, OTHER_COIN_KEY } from './coin-policy.js';
import { formatUsd, fromBaseUnits, parseUsdAmount, quoteAppFeeBps,
  quotedNetworkAndSpreadFeeDisplay, toBaseUnits, tokenAmountUsd, usdToBaseUnits } from '../utils/amounts.js';

const LAVENDER = 0x9892E8;
const SELECTION_LIFETIME = 10 * 60_000;
const QUOTE_LIFETIME = 60_000;
const MAX_PRICE_AGE_MS = 30 * 60_000;
// Public examples are used ONLY to request dry quotes. They never become deposit
// instructions; the real receiving and refund addresses are supplied in the ticket.
const PROBE = Object.freeze({
  eth: '0x1111111111111111111111111111111111111111',
  bsc: '0x1111111111111111111111111111111111111111',
  arb: '0x1111111111111111111111111111111111111111',
  base: '0x1111111111111111111111111111111111111111',
  op: '0x1111111111111111111111111111111111111111',
  pol: '0x1111111111111111111111111111111111111111',
  avax: '0x1111111111111111111111111111111111111111',
  btc: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  ltc: 'LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE',
  sol: '11111111111111111111111111111111',
  tron: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
});

function key(interaction) { return String(interaction.guildId) + ':' + interaction.user.id; }
function cid(flow, action) { return 'price:' + flow.nonce + ':' + action; }
function fresh(interaction) {
  return { nonce: randomUUID().replaceAll('-', '').slice(0, 12), startedAt: Date.now(),
    userId: interaction.user.id, guildId: interaction.guildId, step: 'ORIGIN_COIN' };
}
function safe(value) { return String(value ?? '').replace(/[\r\n]/g, ' ').slice(0, 100); }
function row(flow, actions) {
  return new ActionRowBuilder().addComponents(actions.map(([action, label, style, emoji]) => {
    const button = new ButtonBuilder().setCustomId(cid(flow, action)).setLabel(label).setStyle(style);
    if (emoji) button.setEmoji(emoji);
    return button;
  }));
}
function coinMenu(flow, policy, receiving, other) {
  const exclude = receiving ? flow.originAssetId : null;
  const coins = other ? policy.getOtherCoins(exclude) : policy.getFeaturedCoins(exclude);
  const options = coins.map(coin => new StringSelectMenuOptionBuilder()
    .setLabel(coin.key).setValue(coin.key)
    .setDescription((coin.name + ' • ' + policy.getAssetsForCoin(coin.key, exclude).length + ' network(s)').slice(0, 100)));
  if (!other && policy.hasOtherCoins(exclude)) options.push(new StringSelectMenuOptionBuilder()
    .setLabel('Other coins').setValue(OTHER_COIN_KEY).setDescription('Additional supported coins'));
  const action = (receiving ? 'destination' : 'origin') + (other ? '-other' : '-coin');
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(cid(flow, action)).setPlaceholder(receiving ? 'Choose the coin you want to receive' : 'Choose the coin you are sending')
    .addOptions(options));
}
function networkMenu(flow, policy, receiving) {
  const coin = receiving ? flow.destinationCoin : flow.originCoin;
  const assets = policy.getAssetsForCoin(coin, receiving ? flow.originAssetId : null);
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(cid(flow, receiving ? 'destination-network' : 'origin-network'))
    .setPlaceholder('Choose the ' + coin + ' network')
    .addOptions(assets.map(asset => new StringSelectMenuOptionBuilder()
      .setLabel(networkLabel(asset.blockchain)).setValue(asset.assetId)
      .setDescription((coin + ' on ' + networkLabel(asset.blockchain)).slice(0, 100)))));
}
function render(flow, service) {
  const policy = service.coinPolicy;
  const origin = service.catalogue.getAsset?.(flow.originAssetId);
  const destination = service.catalogue.getAsset?.(flow.destinationAssetId);
  const embed = new EmbedBuilder().setTitle('💱 Check a price').setColor(LAVENDER);
  const controls = [];
  const reset = ['restart', 'Start over', ButtonStyle.Secondary];
  const pair = origin && destination
    ? '**' + safe(origin.symbol) + ' on ' + safe(networkLabel(origin.blockchain))
      + ' → ' + safe(destination.symbol) + ' on ' + safe(networkLabel(destination.blockchain)) + '**\n\n'
    : '';

  if (flow.step === 'ORIGIN_COIN' || flow.step === 'ORIGIN_OTHER') {
    embed.setDescription('Pick the coin you want to send.');
    controls.push(coinMenu(flow, policy, false, flow.step === 'ORIGIN_OTHER'));
    if (flow.step === 'ORIGIN_OTHER') controls.push(row(flow, [reset]));
  } else if (flow.step === 'ORIGIN_NETWORK' || flow.step === 'DESTINATION_NETWORK') {
    const receiving = flow.step === 'DESTINATION_NETWORK';
    const coin = receiving ? flow.destinationCoin : flow.originCoin;
    embed.setDescription(receiving
      ? 'Which network do you want to receive **' + safe(coin) + '** on?'
      : 'Which **' + safe(coin) + '** network are your funds on?');
    controls.push(networkMenu(flow, policy, receiving), row(flow, [reset]));
  } else if (flow.step === 'DESTINATION_COIN' || flow.step === 'DESTINATION_OTHER') {
    embed.setDescription('Sending **' + safe(origin?.symbol) + ' on '
      + safe(networkLabel(origin?.blockchain)) + '**. Pick the coin you want to receive.');
    controls.push(coinMenu(flow, policy, true, flow.step === 'DESTINATION_OTHER'), row(flow, [reset]));
  } else if (flow.step === 'AMOUNT') {
    const stable = ['USDT', 'USDC'].includes(origin?.symbol);
    embed.setDescription(pair + 'Press **Enter amount** to see a fresh live price.\n'
      + (stable ? 'Enter the token amount in **' + origin.symbol + '**.' : 'Enter your swap amount in **USD**.')
      + (flow.error ? '\n\n⚠️ ' + safe(flow.error) : ''));
    controls.push(row(flow, [['amount', 'Enter amount', ButtonStyle.Primary], reset]));
  } else if (flow.step === 'QUOTING' || flow.step === 'OPENING') {
    embed.setDescription(flow.step === 'QUOTING'
      ? 'Checking available providers and calculating your live price…'
      : 'Creating your private swap ticket…');
  } else if (flow.step === 'EXPIRED') {
    embed.setColor(0xD9B45A).setDescription('⏳ **This quote expired.**\n\nStart over to select coins and check a new price. No funds have moved.');
    controls.push(row(flow, [reset]));
  } else if (flow.step === 'QUOTED') {
    const quote = flow.quote.quote;
    const expires = Math.floor(flow.expiresAt / 1000);
    const fee = quotedNetworkAndSpreadFeeDisplay(quote, quoteAppFeeBps(flow.quote));
    embed.setColor(0xD9B45A)
      .setDescription(pair + 'Quoted just now • **expires <t:' + expires + ':R>**\n'
        + 'This is an estimate, not a locked rate. Your ticket will request a new quote after you enter addresses.')
      .addFields(
        { name: 'You send', value: safe(quote.amountInFormatted ?? flow.amountDisplay) + ' ' + safe(origin.symbol)
          + '\n≈ ' + formatUsd(quote.amountInUsd ?? flow.amountUsdRequested), inline: true },
        { name: 'You receive', value: '~' + safe(quote.amountOutFormatted) + ' ' + safe(destination.symbol)
          + '\n' + (quote.amountOutUsd ? '≈ ' + formatUsd(quote.amountOutUsd) : 'USD value unavailable'), inline: true },
        { name: 'Estimated network + spread cost', value: fee, inline: true },
      )
      .setFooter({ text: 'Prices can change • No deposit instructions are created during a price check' });
    controls.push(row(flow, [
      ['open-ticket', 'Open ticket for this swap', ButtonStyle.Success, '🎟️'],
      ['change-amount', 'Change amount', ButtonStyle.Secondary], reset,
    ]));
  }
  return { embeds: [embed], components: controls, allowedMentions: { parse: [] } };
}
function amountModal(flow, defaultAmount) {
  const field = new TextInputBuilder().setCustomId('amount').setLabel('Amount to exchange')
    .setPlaceholder('25').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true);
  if (defaultAmount) field.setValue(defaultAmount);
  return new ModalBuilder().setTitle('Check a live swap price').setCustomId(cid(flow, 'amount-submit'))
    .addComponents(new ActionRowBuilder().addComponents(field));
}
function amountSnapshot(raw, origin) {
  const stable = ['USDT', 'USDC'].includes(origin.symbol);
  const amount = stable
    ? String(raw).trim().replace(/^\$\s*/, '').replace(new RegExp('\\s*(?:' + origin.symbol + '|USD|\\$)$', 'i'), '').trim()
    : parseUsdAmount(raw);
  const age = new Date(origin.priceUpdatedAt).getTime();
  if (!origin.price || !Number.isFinite(age) || Date.now() - age > MAX_PRICE_AGE_MS) {
    throw new Error('The latest coin price is unavailable.');
  }
  const base = stable ? toBaseUnits(amount, origin.decimals) : usdToBaseUnits(amount, String(origin.price), origin.decimals);
  if (BigInt(base) <= 0n) throw new Error('Amount must be positive.');
  return { amountBase: base, amountDisplay: fromBaseUnits(base, origin.decimals),
    amountUsdRequested: stable ? tokenAmountUsd(amount, String(origin.price)) : amount,
    conversionPriceUsd: String(origin.price), conversionPriceAt: new Date(age).toISOString() };
}
export class PriceCheckFlow {
  constructor(ticketService) { this.service = ticketService; this.sessions = new Map(); }

  async handle(interaction) {
    if (interaction.customId === 'panel:check-price') {
      if (!interaction.guildId || !this.service.guildConfigs.has(interaction.guildId)) {
        await this.service.privateReply(interaction, 'This panel belongs to another server.'); return true;
      }
      if (!this.service.health.isReady()) {
        await this.service.privateReply(interaction, 'Live quotes are temporarily unavailable.'); return true;
      }
      for (const [sessionKey, state] of this.sessions) {
        if (Date.now() - state.startedAt > SELECTION_LIFETIME) this.sessions.delete(sessionKey);
      }
      const flow = fresh(interaction);
      this.sessions.set(key(interaction), flow);
      await interaction.reply({ ...render(flow, this.service), flags: MessageFlags.Ephemeral });
      return true;
    }
    const match = /^price:([a-f0-9]{12}):([a-z-]+)$/.exec(interaction.customId ?? '');
    if (!match) return false;
    const flow = this.sessions.get(key(interaction));
    if (!flow || flow.nonce !== match[1] || flow.userId !== interaction.user.id || flow.guildId !== interaction.guildId) {
      await this.service.privateReply(interaction, 'That price check is no longer active. Start another one from the panel.');
      return true;
    }
    const action = match[2];
    if (action === 'restart' && interaction.isButton?.()) {
      const next = fresh(interaction);
      this.sessions.set(key(interaction), next);
      await interaction.update(render(next, this.service)); return true;
    }
    if (Date.now() - flow.startedAt >= SELECTION_LIFETIME
      || (flow.step === 'QUOTED' && Date.now() >= flow.expiresAt)) {
      flow.step = 'EXPIRED';
      if (interaction.isModalSubmit?.()) {
        await this.service.privateReply(interaction, 'This quote has expired. Click Start over on your price check.');
      } else await interaction.update(render(flow, this.service));
      return true;
    }
    if (['QUOTING', 'OPENING', 'EXPIRED'].includes(flow.step)) {
      await this.service.privateReply(interaction, 'This control is no longer active. Start over for a new quote.');
      return true;
    }
    try { await this.step(interaction, flow, action); }
    catch (error) {
      this.service.logger?.warn?.({ errorName: error.name, action, operation: 'price_check' }, 'Price check interaction failed');
      await this.service.privateReply(interaction, 'Could not process this price check. Please start over.');
    }
    return true;
  }

  async step(interaction, flow, action) {
    const policy = this.service.coinPolicy;
    const choice = interaction.isStringSelectMenu?.() ? interaction.values?.[0] : null;
    if (action === 'origin-coin' || action === 'origin-other') {
      if (!choice || flow.step !== (action === 'origin-other' ? 'ORIGIN_OTHER' : 'ORIGIN_COIN')) return this.stale(interaction);
      if (choice === OTHER_COIN_KEY) flow.step = 'ORIGIN_OTHER';
      else {
        const coin = policy.getCoin(choice), assets = coin && policy.getAssetsForCoin(choice);
        if (!assets?.length || coin.group !== (action === 'origin-other' ? 'other' : 'featured')) return this.stale(interaction);
        Object.assign(flow, { originCoin: coin.key, originAssetId: null, destinationCoin: null, destinationAssetId: null });
        if (assets.length === 1) { flow.originAssetId = assets[0].assetId; flow.step = 'DESTINATION_COIN'; }
        else flow.step = 'ORIGIN_NETWORK';
      }
    } else if (action === 'origin-network') {
      if (!choice || flow.step !== 'ORIGIN_NETWORK') return this.stale(interaction);
      const asset = policy.getAssetsForCoin(flow.originCoin).find(a => a.assetId === choice);
      if (!asset) return this.stale(interaction);
      flow.originAssetId = asset.assetId; flow.step = 'DESTINATION_COIN';
    } else if (action === 'destination-coin' || action === 'destination-other') {
      if (!choice || flow.step !== (action === 'destination-other' ? 'DESTINATION_OTHER' : 'DESTINATION_COIN')) return this.stale(interaction);
      if (choice === OTHER_COIN_KEY) flow.step = 'DESTINATION_OTHER';
      else {
        const coin = policy.getCoin(choice), assets = coin && policy.getAssetsForCoin(choice, flow.originAssetId);
        if (!assets?.length || coin.group !== (action === 'destination-other' ? 'other' : 'featured')) return this.stale(interaction);
        flow.destinationCoin = coin.key;
        if (assets.length === 1) { flow.destinationAssetId = assets[0].assetId; flow.step = 'AMOUNT'; }
        else { flow.destinationAssetId = null; flow.step = 'DESTINATION_NETWORK'; }
      }
    } else if (action === 'destination-network') {
      if (!choice || flow.step !== 'DESTINATION_NETWORK') return this.stale(interaction);
      const asset = policy.getAssetsForCoin(flow.destinationCoin, flow.originAssetId).find(a => a.assetId === choice);
      if (!asset) return this.stale(interaction);
      flow.destinationAssetId = asset.assetId; flow.step = 'AMOUNT';
    } else if (action === 'amount' || action === 'change-amount') {
      if (!interaction.isButton?.() || (flow.step !== 'AMOUNT'
        && !(flow.step === 'QUOTED' && action === 'change-amount'))) return this.stale(interaction);
      await interaction.showModal(amountModal(flow, flow.amountInput)); return;
    } else if (action === 'amount-submit') {
      if (!interaction.isModalSubmit?.() || !['AMOUNT', 'QUOTED'].includes(flow.step)) return this.stale(interaction);
      await interaction.deferUpdate();
      flow.step = 'QUOTING'; flow.quote = null; flow.expiresAt = null; flow.error = null;
      await interaction.editReply(render(flow, this.service));
      await this.quote(interaction, flow, interaction.fields.getTextInputValue('amount'));
      return;
    } else if (action === 'open-ticket') {
      if (!interaction.isButton?.() || flow.step !== 'QUOTED') return this.stale(interaction);
      const origin = policy.getAssetsForCoin(flow.originCoin).find(a => a.assetId === flow.originAssetId);
      const destination = policy.getAssetsForCoin(flow.destinationCoin, flow.originAssetId)
        .find(a => a.assetId === flow.destinationAssetId);
      if (!origin || !destination || Date.now() >= flow.expiresAt) {
        flow.step = 'EXPIRED'; await interaction.update(render(flow, this.service)); return;
      }
      const data = {
        originCoin: flow.originCoin, originCoinGroup: policy.getCoin(flow.originCoin).group,
        originAssetId: origin.assetId, originNetworkAutoSelected: policy.getAssetsForCoin(flow.originCoin).length === 1,
        destinationCoin: flow.destinationCoin, destinationCoinGroup: policy.getCoin(flow.destinationCoin).group,
        destinationAssetId: destination.assetId,
        destinationNetworkAutoSelected: policy.getAssetsForCoin(flow.destinationCoin, origin.assetId).length === 1,
        amountBase: flow.amountBase, amountDisplay: flow.amountDisplay,
        amountUsdRequested: flow.amountUsdRequested,
        conversionPriceUsd: flow.conversionPriceUsd, conversionPriceAt: flow.conversionPriceAt,
      };
      flow.step = 'OPENING';
      this.sessions.delete(key(interaction));
      await this.service.startTicket(interaction, data);
      return;
    } else return this.stale(interaction);
    await interaction.update(render(flow, this.service));
  }

  async quote(interaction, flow, input) {
    try {
      const origin = this.service.catalogue.getAsset(flow.originAssetId);
      const destination = this.service.catalogue.getAsset(flow.destinationAssetId);
      if (!origin || !destination) throw new Error('Asset no longer available');
      const values = amountSnapshot(input, origin);
      const refundTo = PROBE[origin.blockchain], recipient = PROBE[destination.blockchain];
      if (!refundTo || !recipient) throw new Error('Unsupported dry quote network');
      const request = { dry: true, originAsset: origin, destinationAsset: destination,
        amountBase: values.amountBase, recipient, refundTo };
      const [mainResult, backupResult] = await Promise.allSettled([
        this.service.oneClick.getVerifiedQuote(request),
        this.service.oneClick.fixedFloat?.enabled === false ? Promise.resolve(null)
          : this.service.oneClick.getVerifiedQuote({ ...request, provider: 'fixedfloat', backupConsent: true }),
      ]);
      const main = mainResult.status === 'fulfilled' ? mainResult.value : null;
      const backup = backupResult.status === 'fulfilled' && backupResult.value?.provider === 'fixedfloat'
        ? backupResult.value : null;
      if (mainResult.status === 'rejected') {
        const classified = this.service.oneClick.classifyError?.(mainResult.reason, { operation: 'preview_quote' });
        if (classified?.source === 'security'
          || (backup && !['AMOUNT_TOO_LOW', 'NO_LIQUIDITY_ROUTE'].includes(classified?.code))) throw mainResult.reason;
      }
      const quote = main && backup
        ? BigInt(backup.quote.amountOut) > BigInt(main.quote.amountOut) ? backup : main : main ?? backup;
      if (!quote?.quote?.amountOutFormatted || !/^\d+$/.test(String(quote.quote.amountOut))) throw new Error('No live quote');
      const providerDeadline = new Date(quote.quote.deadline ?? Date.now() + QUOTE_LIFETIME).getTime();
      const expiresAt = Math.min(Date.now() + QUOTE_LIFETIME, Number.isFinite(providerDeadline) ? providerDeadline : Infinity);
      if (expiresAt <= Date.now()) throw new Error('Expired provider quote');
      if (flow.step !== 'QUOTING') return;
      Object.assign(flow, values, { amountInput: input, quote, expiresAt, step: 'QUOTED' });
    } catch (error) {
      if (flow.step !== 'QUOTING') return;
      flow.step = 'AMOUNT';
      flow.error = 'No live quote is available for that amount and route. Try a different amount, or use a regular ticket.';
      this.service.logger?.warn?.({ errorName: error.name, operation: 'price_check_quote' }, 'Price check quote unavailable');
    }
    await interaction.editReply(render(flow, this.service));
  }
  async stale(interaction) {
    await this.service.privateReply(interaction, 'That control is outdated. Use the newest price-check controls, or Start over.');
  }
}
