import { describe, expect, it, vi } from 'vitest';
import { PriceCheckFlow } from '../src/services/price-check-flow.js';
import { TicketService } from '../src/services/ticket-service.js';
import { CoinPolicy } from '../src/services/coin-policy.js';

const SOURCE_ID = 'nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near';
const OTHER_SOURCE = 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near';
const DESTINATION_ID = 'nep141:ltc.omft.near';
const assets = [
  { assetId: SOURCE_ID, symbol: 'USDT', blockchain: 'bsc', price: '1', decimals: 18, priceUpdatedAt: new Date().toISOString() },
  { assetId: OTHER_SOURCE, symbol: 'USDT', blockchain: 'eth', price: '1', decimals: 6, priceUpdatedAt: new Date().toISOString() },
  { assetId: DESTINATION_ID, symbol: 'LTC', blockchain: 'ltc', price: '49', decimals: 8, priceUpdatedAt: new Date().toISOString() },
];
const catalogue = { getAsset: (id) => assets.find(a => a.assetId === id) ?? null, getAssets: () => assets };
const policy = new CoinPolicy(catalogue);
const quote = () => ({
  provider: 'oneclick',
  quoteRequest: { appFees: [] },
  quote: {
    amountIn: '1000000000000000000', amountInFormatted: '1',
    amountInUsd: '1.00', amountOut: '2030000',
    amountOutFormatted: '0.0203', amountOutUsd: '0.995',
    deadline: new Date(Date.now() + 300000).toISOString(),
  },
});
function setup() {
  const oneClick = { fixedFloat: { enabled: false }, getVerifiedQuote: vi.fn().mockImplementation(async () => quote()) };
  const service = {
    guildConfigs: new Map([['guild', {}]]),
    health: { isReady: () => true },
    coinPolicy: policy, catalogue, oneClick, logger: { warn: vi.fn() },
    privateReply: vi.fn().mockResolvedValue(undefined),
    startTicket: vi.fn().mockResolvedValue(undefined),
  };
  return { flow: new PriceCheckFlow(service), service };
}
function interaction(customId, type = 'button', value = null) {
  return {
    guildId: 'guild', user: { id: 'owner' }, customId,
    isButton: () => type === 'button',
    isStringSelectMenu: () => type === 'select',
    isModalSubmit: () => type === 'modal',
    values: type === 'select' ? [value] : [],
    fields: { getTextInputValue: () => value },
    reply: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}
async function runToAmount(flow) {
  const start = interaction('panel:check-price');
  await flow.handle(start);
  const session = flow.sessions.get('guild:owner');
  const id = action => 'price:' + session.nonce + ':' + action;
  await flow.handle(interaction(id('origin-coin'), 'select', 'USDT'));
  expect(session.step).toBe('ORIGIN_NETWORK');
  await flow.handle(interaction(id('origin-network'), 'select', SOURCE_ID));
  await flow.handle(interaction(id('destination-coin'), 'select', 'LTC'));
  expect(session.step).toBe('AMOUNT');
  return { session, id, start };
}

describe('private panel price checks', () => {
  it('shows network selectors and a non-executable quote, then carries the exact amount into a private ticket', async () => {
    const { flow, service } = setup();
    const { session, id, start } = await runToAmount(flow);
    expect(start.reply.mock.calls[0][0].flags).toBeDefined();
    const amountButton = interaction(id('amount'));
    await flow.handle(amountButton);
    expect(amountButton.showModal).toHaveBeenCalledOnce();
    const modal = interaction(id('amount-submit'), 'modal', '1');
    await flow.handle(modal);
    expect(modal.deferUpdate).toHaveBeenCalledOnce();
    expect(session.step).toBe('QUOTED');
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + 60000);
    expect(service.oneClick.getVerifiedQuote).toHaveBeenCalledOnce();
    expect(service.oneClick.getVerifiedQuote.mock.calls[0][0]).toMatchObject({
      dry: true, amountBase: '1000000000000000000',
      originAsset: { assetId: SOURCE_ID, blockchain: 'bsc' },
      destinationAsset: { assetId: DESTINATION_ID, blockchain: 'ltc' },
    });
    const payload = modal.editReply.mock.calls.at(-1)[0];
    const json = payload.embeds[0].toJSON();
    expect(JSON.stringify(json)).toContain('0.0203');
    expect(JSON.stringify(json)).toContain('Estimated network + spread cost');
    expect(JSON.stringify(json)).toContain('not a locked rate');
    expect(payload.components[0].toJSON().components.map(b => b.label)).toEqual([
      'Open ticket for this swap', 'Change amount', 'Start over',
    ]);
    expect(service.startTicket).not.toHaveBeenCalled();
    const open = interaction(id('open-ticket'));
    await flow.handle(open);
    expect(service.startTicket).toHaveBeenCalledOnce();
    const [receivedInteraction, preset] = service.startTicket.mock.calls[0];
    expect(receivedInteraction).toBe(open);
    expect(preset).toMatchObject({
      originCoin: 'USDT', originAssetId: SOURCE_ID, destinationCoin: 'LTC',
      destinationAssetId: DESTINATION_ID, amountBase: '1000000000000000000',
      amountDisplay: '1', amountUsdRequested: '1.00',
    });
    expect(preset).not.toHaveProperty('recipient');
    expect(preset).not.toHaveProperty('refundTo');
    expect(service.oneClick.getVerifiedQuote).toHaveBeenCalledTimes(1);
  });

  it('rejects expired quotes, forces restart, and never opens a ticket from the old controls', async () => {
    const { flow, service } = setup();
    const { session, id } = await runToAmount(flow);
    await flow.handle(interaction(id('amount-submit'), 'modal', '1'));
    session.expiresAt = Date.now() - 1;
    const open = interaction(id('open-ticket'));
    await flow.handle(open);
    expect(session.step).toBe('EXPIRED');
    expect(open.update.mock.calls[0][0].embeds[0].toJSON().description).toContain('quote expired');
    expect(service.startTicket).not.toHaveBeenCalled();
    const restart = interaction(id('restart'));
    await flow.handle(restart);
    expect(flow.sessions.get('guild:owner').step).toBe('ORIGIN_COIN');
    await flow.handle(interaction(id('open-ticket')));
    expect(service.privateReply).toHaveBeenCalled();
    expect(service.startTicket).not.toHaveBeenCalled();
  });

  it('allows changing only the amount, requests a fresh quote, and does not create deposit instructions', async () => {
    const { flow, service } = setup();
    const { session, id } = await runToAmount(flow);
    await flow.handle(interaction(id('amount-submit'), 'modal', '1'));
    const change = interaction(id('change-amount'));
    await flow.handle(change);
    expect(change.showModal).toHaveBeenCalledOnce();
    await flow.handle(interaction(id('amount-submit'), 'modal', '2'));
    expect(session.step).toBe('QUOTED');
    expect(session.amountDisplay).toBe('2');
    expect(service.oneClick.getVerifiedQuote).toHaveBeenCalledTimes(2);
    expect(service.oneClick.getVerifiedQuote.mock.calls[1][0].amountBase).toBe('2000000000000000000');
    expect(service.startTicket).not.toHaveBeenCalled();
  });

  it('rechecks completed-swap wallet history when the saved-address button is clicked', async () => {
    const ltcAddress = 'LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE';
    const bscRefund = '0x' + 'b'.repeat(40);
    const repositories = {
      getUserChainAddress: vi.fn().mockImplementation(async (_guild, _owner, network, side) =>
        network === 'ltc' && side === 'recipient' ? ltcAddress
          : network === 'bsc' && side === 'refund' ? bscRefund : null),
    };
    const service = new TicketService({
      client: {}, repositories, catalogue, coinPolicy: policy, emojis: {}, qrService: {}, oneClick: {},
      config: { guildId: 'guild' }, health: {}, logger: { warn: vi.fn() },
    });
    service.updateAndRender = vi.fn().mockResolvedValue({ id: 'ticket' });
    service.createPreviewFromChat = vi.fn().mockResolvedValue({ ok: true });
    const click = { isButton: () => true };
    const ticket = { id: 'ticket', guild_id: 'guild', user_id: 'owner', step: 'RECIPIENT_ADDRESS',
      state_data: { originAssetId: SOURCE_ID, destinationAssetId: DESTINATION_ID } };
    await service.routeTicketInteraction(click, ticket, 'use-saved-recipient');
    expect(service.updateAndRender).toHaveBeenCalledWith(click, 'ticket', 'REFUND_ADDRESS',
      expect.objectContaining({ recipient: ltcAddress, rememberedRefundAddress: bscRefund }),
      { expectedStep: 'RECIPIENT_ADDRESS' });
    expect(service.createPreviewFromChat).not.toHaveBeenCalled();
    const refundTicket = { ...ticket, step: 'REFUND_ADDRESS',
      state_data: { ...ticket.state_data, recipient: ltcAddress } };
    await service.routeTicketInteraction(click, refundTicket, 'use-saved-refund');
    expect(service.updateAndRender).toHaveBeenCalledWith(click, 'ticket', 'QUOTE_LOADING',
      expect.objectContaining({ refundTo: bscRefund }), { expectedStep: 'REFUND_ADDRESS' });
    expect(service.createPreviewFromChat).toHaveBeenCalledOnce();
    expect(repositories.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'ltc', 'recipient');
    expect(repositories.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'bsc', 'refund');
  });

  it('starts the actual ticket at receiving address with its prior completed-swap address available', async () => {
    const completedSavedAddress = 'LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE';
    const channel = { id: 'new-channel', send: vi.fn().mockResolvedValue({ id: 'msg' }), delete: vi.fn() };
    const guild = {
      id: 'guild', roles: { everyone: { id: 'everyone' } },
      channels: { fetch: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(channel) },
    };
    const repositories = {
      getOpenTicketsForUser: vi.fn().mockResolvedValue([]),
      reserveTicket: vi.fn().mockResolvedValue({ created: true }),
      completeTicketCreation: vi.fn().mockImplementation(async id =>
        ({ id, guild_id: 'guild', user_id: 'owner', channel_id: 'new-channel', state: 'OPEN',
          step: 'ORIGIN_COIN', state_data: {} })),
      updateTicketFlowIfStep: vi.fn().mockImplementation(async (id, expected, step, state_data) =>
        ({ id, guild_id: 'guild', user_id: 'owner', channel_id: 'new-channel',
          state: 'OPEN', step, state_data })),
      getUserChainAddress: vi.fn().mockResolvedValue(completedSavedAddress),
      setHeaderMessage: vi.fn(), setProgressMessage: vi.fn(),
      failTicketCreation: vi.fn(),
    };
    const service = new TicketService({
      client: { user: { id: 'bot' } }, repositories, catalogue, coinPolicy: policy,
      emojis: { get: () => '🪙' }, qrService: {}, oneClick: {},
      config: { guildId: 'guild', ticketCategoryId: 'category' },
      health: { isReady: () => true }, logger: { error: vi.fn() },
    });
    const invoker = {
      guildId: 'guild', guild, user: { id: 'owner', username: 'tester' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    await service.startTicket(invoker, {
      originCoin: 'USDT', originCoinGroup: 'featured', originAssetId: SOURCE_ID,
      destinationCoin: 'LTC', destinationCoinGroup: 'featured', destinationAssetId: DESTINATION_ID,
      amountBase: '1000000000000000000', amountDisplay: '1',
      amountUsdRequested: '1', conversionPriceUsd: '1',
      conversionPriceAt: new Date().toISOString(),
    });
    expect(repositories.updateTicketFlowIfStep).toHaveBeenCalledWith(
      expect.any(String), 'ORIGIN_COIN', 'RECIPIENT_ADDRESS', expect.objectContaining({
        amountBase: '1000000000000000000', destinationAssetId: DESTINATION_ID,
      }),
    );
    expect(channel.send).toHaveBeenCalledTimes(2);
    const rendered = channel.send.mock.calls[1][0].embeds[0].toJSON();
    expect(rendered.description).toContain('Receiving address');
    expect(rendered.description).toContain('completed swap');
    expect(rendered.description).toContain(completedSavedAddress);
    expect(channel.send.mock.calls[1][0].components[0].toJSON().components[0].custom_id)
      .toMatch(/use-saved-recipient$/);
    expect(invoker.editReply.mock.calls[0][0]).toContain('private swap ticket is ready');
    expect(repositories.failTicketCreation).not.toHaveBeenCalled();
  });
});
