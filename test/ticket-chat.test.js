import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

describe('ticket chat input', () => {
  it('accepts USD, receiving address, and refund address as three owner messages', async () => {
    const origin = {
      assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8,
      price: '100', priceUpdatedAt: new Date().toISOString(),
    };
    const destination = {
      assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18,
      price: '2000', priceUpdatedAt: new Date().toISOString(),
    };
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'USD_AMOUNT',
      state_data: { originAssetId: 'ltc', destinationAssetId: 'eth' },
    };
    const updates = [];
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      saveUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain, address) => address),
      updateTicketFlowIfStep: async (id, expected, next, data) => {
        if (ticket.step !== expected) return null;
        ticket.step = next;
        ticket.state_data = JSON.parse(JSON.stringify(data));
        updates.push({ id, expected, next, data: JSON.parse(JSON.stringify(data)) });
        return ticket;
      },
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    service.renderProgress = vi.fn();
    service.createPreviewFromChat = vi.fn();

    await service.handleMessage(message('$25'));
    expect(updates.at(-1)).toMatchObject({
      next: 'RECIPIENT_ADDRESS',
      data: { amountUsdRequested: '25.00', amountBase: '25000000', amountDisplay: '0.25' },
    });

    const recipient = `0x${'a'.repeat(40)}`;
    await service.handleMessage(message(recipient));
    expect(updates.at(-1)).toMatchObject({ next: 'REFUND_ADDRESS', data: { recipient } });

    const validLtc = 'LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE';
    await service.handleMessage(message(validLtc));
    expect(updates.at(-1)).toMatchObject({ next: 'QUOTE_LOADING', data: { refundTo: validLtc } });
    expect(service.createPreviewFromChat).toHaveBeenCalledOnce();
  });

  it.each(['USDT', 'USDC'])('uses the exact %s token amount instead of converting USD', async (symbol) => {
    const origin = {
      assetId: 'usdt-bsc', symbol, blockchain: 'bsc', decimals: 18,
      price: '0.9992040304', priceUpdatedAt: new Date().toISOString(),
    };
    const destination = {
      assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8,
      price: '100', priceUpdatedAt: new Date().toISOString(),
    };
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'USD_AMOUNT',
      state_data: { originAssetId: 'usdt-bsc', destinationAssetId: 'ltc' },
    };
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      updateTicketFlowIfStep: async (id, expected, next, data) => {
        if (ticket.step !== expected) return null;
        ticket.step = next;
        ticket.state_data = JSON.parse(JSON.stringify(data));
        return ticket;
      },
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    service.renderProgress = vi.fn();

    await service.handleMessage(message(`1040 ${symbol}`));

    expect(ticket.state_data).toMatchObject({
      amountUsdRequested: '1039.17',
      amountBase: '1040000000000000000000',
      amountDisplay: '1040',
    });
  });

  it('reuses a valid address only from completed swaps when the owner types yes', async () => {
    const origin = { assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8 };
    const destination = { assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18 };
    const recipient = `0x${'b'.repeat(40)}`;
    const refundTo = 'LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE';
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'RECIPIENT_ADDRESS',
      state_data: { originAssetId: 'ltc', destinationAssetId: 'eth' },
    };
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain, side) => (
        blockchain === 'eth' && side === 'recipient' ? recipient : blockchain === 'ltc' && side === 'refund' ? refundTo : null
      )),
      saveUserChainAddress: vi.fn().mockImplementation(async (guildId, userId, blockchain, address) => address),
      updateTicketFlowIfStep: async (id, expected, next, data) => {
        if (ticket.step !== expected) return null;
        ticket.step = next;
        ticket.state_data = JSON.parse(JSON.stringify(data));
        return ticket;
      },
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    service.renderProgress = vi.fn();
    service.createPreviewFromChat = vi.fn();

    await service.handleMessage(message('yes'));
    expect(ticket.state_data).toMatchObject({ recipient, rememberedRefundAddress: refundTo });

    await service.handleMessage(message('YES'));
    expect(ticket.state_data).toMatchObject({ refundTo });
    expect(service.createPreviewFromChat).toHaveBeenCalledOnce();
    expect(repositories.saveUserChainAddress).not.toHaveBeenCalled();
    expect(repositories.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'eth', 'recipient');
    expect(repositories.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'ltc', 'refund');
  });

  it('asks for an address when yes is entered without a saved address', async () => {
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'RECIPIENT_ADDRESS',
      state_data: { destinationAssetId: 'eth' },
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      saveUserChainAddress: vi.fn(),
    };
    const service = makeService({
      repositories,
      assets: [{ assetId: 'eth', symbol: 'ETH', blockchain: 'eth', decimals: 18 }],
    });
    const reply = vi.fn().mockResolvedValue(undefined);

    await service.handleMessage(message('yes', reply));

    expect(reply.mock.calls[0][0].content).toContain('do not have a saved address');
    expect(repositories.saveUserChainAddress).not.toHaveBeenCalled();
  });

  it('hydrates saved addresses for tickets already waiting on an address after restart', async () => {
    const repositories = { getUserChainAddress: vi.fn().mockResolvedValue('So11111111111111111111111111111111111111112') };
    const service = makeService({
      repositories,
      assets: [{ assetId: 'sol', symbol: 'SOL', blockchain: 'sol', decimals: 9 }],
    });
    const ticket = {
      guild_id: 'guild', user_id: 'owner', step: 'RECIPIENT_ADDRESS',
      state_data: { destinationAssetId: 'sol' },
    };

    await expect(service.withRememberedAddress(ticket)).resolves.toMatchObject({
      state_data: { rememberedRecipientAddress: 'So11111111111111111111111111111111111111112' },
    });
    expect(repositories.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'sol', 'recipient');
  });

  it('never offers a cached amount from an abandoned ticket as an address', async () => {
    const repos = {
      getUserChainAddress: vi.fn().mockResolvedValue(null),
    };
    const service = makeService({
      repositories: repos,
      assets: [{ assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8 }],
    });
    const ticket = {
      guild_id: 'guild', user_id: 'owner', step: 'RECIPIENT_ADDRESS',
      state_data: { destinationAssetId: 'ltc', rememberedRecipientAddress: '100' },
    };
    const updated = await service.withRememberedAddress(ticket);
    expect(updated.state_data).not.toHaveProperty('rememberedRecipientAddress');
    const reply = vi.fn().mockResolvedValue(undefined);
    const openTicket = { ...ticket, id: 'ticket', state: 'OPEN', channel_id: 'channel' };
    repos.getOpenTicketByChannel = vi.fn().mockResolvedValue(openTicket);
    repos.touchTicket = vi.fn().mockResolvedValue(openTicket);
    await service.handleMessage(message('yes', reply));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('completed swap'),
    }));
    expect(repos.getUserChainAddress).toHaveBeenCalledWith('guild', 'owner', 'ltc', 'recipient');
  });

  it('rejects a numeric Litecoin address and keeps the user on the address step', async () => {
    const origin = { assetId: 'usdt', symbol: 'USDT', blockchain: 'bsc', decimals: 18 };
    const destination = { assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8 };
    const ticket = {
      id: 'ticket', guild_id: 'guild', channel_id: 'channel', user_id: 'owner',
      state: 'OPEN', step: 'RECIPIENT_ADDRESS',
      state_data: { originAssetId: 'usdt', destinationAssetId: 'ltc' },
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getUserChainAddress: vi.fn().mockResolvedValue(null),
      updateTicketFlowIfStep: vi.fn(),
    };
    const service = makeService({ repositories, assets: [origin, destination] });
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.handleMessage(message('100', reply));
    expect(ticket.step).toBe('RECIPIENT_ADDRESS');
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('valid Litecoin address'),
    }));
    expect(repositories.updateTicketFlowIfStep).not.toHaveBeenCalled();
  });

  it('rejects malformed USD without logging the message contents', async () => {
    const logger = { warn: vi.fn() };
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'USD_AMOUNT',
      state_data: { originAssetId: 'ltc', destinationAssetId: 'eth' },
    };
    const repositories = {
      getOpenTicketByChannel: async () => ticket,
      touchTicket: vi.fn().mockResolvedValue(ticket),
      updateTicketFlowIfStep: vi.fn(),
    };
    const service = makeService({
      repositories,
      logger,
      assets: [{
        assetId: 'ltc', symbol: 'LTC', blockchain: 'ltc', decimals: 8,
        price: '100', priceUpdatedAt: new Date().toISOString(),
      }],
    });
    const reply = vi.fn().mockResolvedValue(undefined);
    await service.handleMessage(message('$9.99 PRIVATE', reply));
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0][0].content).toContain('at most two decimal places');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE');
    expect(repositories.updateTicketFlowIfStep).not.toHaveBeenCalled();
    expect(repositories.touchTicket).toHaveBeenCalledWith('ticket');
  });

  it('submits an owner-pasted transaction ID and immediately refreshes tracking', async () => {
    const transactionId = 'a'.repeat(64);
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const swap = {
      id: 'swap', ticket_id: 'ticket', status: 'PENDING_DEPOSIT', executable_quote: { quote: {} },
      origin_asset_id: 'usdt-bsc', deposit_address: 'deposit-address', deposit_memo: null, deposit_tx_hash: null,
    };
    const saved = { ...swap, deposit_tx_hash: transactionId };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue(swap),
      saveDepositTransactionHash: vi.fn().mockResolvedValue(saved),
    };
    const oneClick = {
      submitDepositTransaction: vi.fn().mockResolvedValue({ status: 'KNOWN_DEPOSIT_TX' }),
      safeErrorLogFields: vi.fn().mockReturnValue({ errorCode: 'NONE' }),
    };
    const health = { oneClickAuthentication: false };
    const service = makeService({ repositories, oneClick, health, assets: [{ assetId: 'usdt-bsc', blockchain: 'bsc' }] });
    service.renderProgress = vi.fn().mockResolvedValue(undefined);
    const statusWorker = { refreshSwap: vi.fn().mockResolvedValue(saved) };
    service.setStatusWorker(statusWorker);
    const reply = vi.fn().mockResolvedValue(undefined);

    await service.handleMessage(message(transactionId, reply));

    expect(oneClick.submitDepositTransaction).toHaveBeenCalledWith(swap, transactionId);
    expect(repositories.saveDepositTransactionHash).toHaveBeenCalledWith('ticket', transactionId);
    expect(service.renderProgress).toHaveBeenCalledWith('ticket');
    expect(statusWorker.refreshSwap).toHaveBeenCalledWith(saved, { announce: true, rethrow: false });
    expect(reply.mock.calls[0][0].content).toContain('Transaction ID submitted');
    expect(health.oneClickAuthentication).toBe(true);
  });

  it('silently ignores non-transaction chat in an active ticket without contacting the provider', async () => {
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue({
        status: 'PENDING_DEPOSIT', executable_quote: { quote: {} }, deposit_tx_hash: null,
      }),
      saveDepositTransactionHash: vi.fn(),
    };
    const oneClick = { submitDepositTransaction: vi.fn() };
    const service = makeService({ repositories, oneClick });
    const reply = vi.fn().mockResolvedValue(undefined);

    const handled = await service.handleMessage(message('I sent it', reply));

    expect(oneClick.submitDepositTransaction).not.toHaveBeenCalled();
    expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
    expect(repositories.touchTicket).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it.each([
    ['BNB Chain wallet address', 'bsc', '0xB533aF4881f450C90e3339E84FC4a91fA381a790', false],
    ['Ethereum wallet address', 'eth', `0x${'a'.repeat(40)}`, false],
    ['BNB Chain transaction hash', 'bsc', `0x${'a'.repeat(64)}`, true],
    ['BNB Chain transaction hash without prefix', 'bsc', 'a'.repeat(64), true],
    ['truncated EVM hash', 'bsc', `0x${'a'.repeat(63)}`, false],
    ['wrong-network Solana signature on BNB', 'bsc', '4ReKprwf3WdLHRrzp4ctPWNBsQDPL3VZz3zMmoZfcGJMJCHh5Vq937mPdyxhCbw54wNnA6hZ7KfNpQdpt13yY7A9', false],
    ['Litecoin transaction ID', 'ltc', 'b'.repeat(64), true],
    ['Bitcoin receiving address', 'btc', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', false],
    ['Solana wallet address', 'sol', '3arZgfuKrZ1e8Rh1GCd7jB63tbeTk8YnfdM3XZ57f81V', false],
    ['Solana transaction signature', 'sol', '4ReKprwf3WdLHRrzp4ctPWNBsQDPL3VZz3zMmoZfcGJMJCHh5Vq937mPdyxhCbw54wNnA6hZ7KfNpQdpt13yY7A9', true],
    ['Aptos account/tx hash ambiguity', 'aptos', `0x${'a'.repeat(64)}`, false],
    ['unresolved sending network', null, 'a'.repeat(64), false],
    ['non-transaction chat', 'bsc', 'I just sent my deposit', false],
  ])('%s is %s: only valid sending-chain tx hashes trigger the provider', async (_description, blockchain, input, accepted) => {
    const assetId = 'input-asset';
    const ticket = { id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {} };
    const swap = {
      id: 'swap', ticket_id: 'ticket', status: 'PENDING_DEPOSIT', origin_asset_id: assetId,
      executable_quote: { quote: {} }, deposit_address: 'deposit', deposit_tx_hash: null,
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue(swap),
      touchTicket: vi.fn().mockResolvedValue(undefined),
      saveDepositTransactionHash: vi.fn().mockResolvedValue({ ...swap, deposit_tx_hash: input }),
    };
    const oneClick = { submitDepositTransaction: vi.fn().mockResolvedValue(undefined) };
    const service = makeService({
      repositories,
      oneClick,
      assets: blockchain ? [{ assetId, blockchain }] : [],
    });
    service.renderProgress = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const handled = await service.handleMessage(message(input, reply));
    if (accepted) {
      expect(handled).toBe(true);
      expect(oneClick.submitDepositTransaction).toHaveBeenCalledOnce();
      expect(oneClick.submitDepositTransaction).toHaveBeenCalledWith(swap, input);
      expect(repositories.saveDepositTransactionHash).toHaveBeenCalledWith('ticket', input);
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0][0].content).toContain('Transaction ID submitted');
    } else {
      expect(handled).toBe(false);
      expect(oneClick.submitDepositTransaction).not.toHaveBeenCalled();
      expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
      expect(repositories.touchTicket).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    }
  });

  it('stops treating chat messages as transaction submissions after one is saved', async () => {
    const transactionId = 'a'.repeat(64);
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue({
        status: 'PENDING_DEPOSIT', executable_quote: { quote: {} }, deposit_tx_hash: transactionId,
      }),
      saveDepositTransactionHash: vi.fn(),
    };
    const oneClick = { submitDepositTransaction: vi.fn() };
    const service = makeService({ repositories, oneClick });
    const reply = vi.fn().mockResolvedValue(undefined);

    const handled = await service.handleMessage(message('b'.repeat(64), reply));

    expect(oneClick.submitDepositTransaction).not.toHaveBeenCalled();
    expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
    expect(repositories.touchTicket).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it('silently ignores a transaction ID that the provider cannot match', async () => {
    const transactionId = 'a'.repeat(64);
    const ticket = {
      id: 'ticket', channel_id: 'channel', user_id: 'owner', state: 'OPEN', step: 'ACTIVE', state_data: {},
    };
    const repositories = {
      getOpenTicketByChannel: vi.fn().mockResolvedValue(ticket),
      touchTicket: vi.fn().mockResolvedValue(ticket),
      getSwapByTicket: vi.fn().mockResolvedValue({
        status: 'PENDING_DEPOSIT', executable_quote: { quote: {} }, origin_asset_id: 'ltc', deposit_tx_hash: null,
      }),
      saveDepositTransactionHash: vi.fn(),
    };
    const oneClick = {
      submitDepositTransaction: vi.fn().mockRejectedValue(new Error('not matched')),
      classifyError: vi.fn().mockReturnValue({ code: 'DEPOSIT_TX_REJECTED', userMessage: 'Invalid transaction ID.' }),
      safeErrorLogFields: vi.fn().mockReturnValue({ errorCode: 'DEPOSIT_TX_REJECTED' }),
    };
    const service = makeService({ repositories, oneClick, assets: [{ assetId: 'ltc', blockchain: 'ltc' }] });
    const reply = vi.fn().mockResolvedValue(undefined);

    const handled = await service.handleMessage(message(transactionId, reply));

    expect(oneClick.submitDepositTransaction).toHaveBeenCalledWith(expect.anything(), transactionId);
    expect(repositories.saveDepositTransactionHash).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it('returns amount and liquidity quote failures to the USD step without clearing addresses', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const error = Object.assign(new Error('too high'), { status: 400 });
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: {},
      emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(error),
        classifyError: () => ({ code: 'AMOUNT_TOO_HIGH', status: 400, userMessage: 'Enter a smaller amount.' }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_HIGH' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const data = {
      originAssetId: 'ltc', destinationAssetId: 'usdt', amountBase: '1', amountDisplay: '1',
      amountUsdRequested: '25.00', recipient: 'recipient', refundTo: 'refund',
    };

    await service.createPreviewFromChat('ticket', data, sourceMessage);

    expect(repositories.updateTicketFlowIfStep).toHaveBeenCalledWith('ticket', 'QUOTE_LOADING', 'USD_AMOUNT', data);
    expect(data).toMatchObject({ recipient: 'recipient', refundTo: 'refund' });
  });

  it('suggests another network or retrying later when no solver is available', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const sol = { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const error = Object.assign(new Error('no route'), { status: 400 });
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination, sol].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: {
        getAssetsForCoin: (coin) => ({ LTC: [origin], USDT: [destination], SOL: [sol] })[coin] ?? [],
      },
      emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(error),
        getFixedFloatIndicativeQuote: vi.fn().mockResolvedValue({ amountInUsd: '100', amountOutUsd: '98.75' }),
        classifyError: () => ({
          code: 'NO_LIQUIDITY_ROUTE',
          status: 400,
          userMessage: 'No solvers are available for this swap right now.',
        }),
        safeErrorLogFields: () => ({ errorCode: 'NO_LIQUIDITY_ROUTE' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const data = {
      originAssetId: origin.assetId,
      destinationAssetId: destination.assetId,
      amountBase: '100000000',
      amountDisplay: '1',
      amountUsdRequested: '100.00',
      recipient: 'recipient',
      refundTo: 'refund',
    };

    const result = await service.createPreviewFromChat('ticket', data, sourceMessage);

    expect(result.userMessage).toBe(
      'No exchange provider has an available quote for LTC → USDT on BNB Chain right now. Try another amount or ask to be notified.',
    );
    expect(sourceMessage.reply).toHaveBeenCalledWith(expect.objectContaining({ content: result.userMessage }));
    const buttons = sourceMessage.reply.mock.calls[0][0].components[0].toJSON().components;
    expect(buttons.map(button => button.custom_id)).toEqual(['t:ticket:watch-exact']);
    expect(buttons[0]).toMatchObject({ label: 'Notify me when available', style: 2 });
  });

  it('automatically selects a verified backup when the main provider minimum is too high', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      savePreview: vi.fn().mockResolvedValue({ id: 'preview' }),
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn(),
    };
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const getVerifiedQuote = vi.fn()
      .mockRejectedValueOnce(new Error('minimum is $1000'))
      .mockResolvedValueOnce({
        provider: 'fixedfloat',
        quoteRequest: { backupConsent: true },
        quote: { amountOut: '198000000000000000000', amountIn: '400000000', amountOutFormatted: '198' },
      });
    const service = new TicketService({
      client: {}, repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] }, emojis: {},
      oneClick: {
        getVerifiedQuote,
        getFixedFloatOffer: vi.fn().mockResolvedValue({ quote: { amountOut: '198000000000000000000' }, minimum: null }),
        classifyError: () => ({ code: 'AMOUNT_TOO_LOW', status: 400, userMessage: 'Too low', routeLimit: { kind: 'minimum', usd: '1000', display: '$1,000.00' } }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_LOW' }),
      },
      config: { slippageBps: 50, previewTtlMs: 300000 }, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const data = {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId,
      amountBase: '400000000', amountDisplay: '4', amountUsdRequested: '200.00',
      recipient: 'recipient', refundTo: 'refund',
    };

    const result = await service.createPreviewFromChat('ticket', data, sourceMessage);

    expect(result).toEqual({ ok: true });
    expect(getVerifiedQuote).toHaveBeenCalledTimes(2);
    expect(getVerifiedQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({
      provider: 'fixedfloat', backupConsent: true, dry: true, amountBase: '400000000',
      recipient: 'recipient', refundTo: 'refund',
    }));
    expect(repositories.savePreview.mock.calls[0][0].dryQuote).toMatchObject({
      provider: 'fixedfloat', quoteRequest: { backupConsent: true },
    });
    expect(repositories.updateTicketFlowIfStep).toHaveBeenCalledWith('ticket', 'QUOTE_LOADING', 'PREVIEW', data);
    expect(data.backupConsent).toBe(true);
    expect(sourceMessage.reply).not.toHaveBeenCalled();
    expect(repositories.recordTicketError).not.toHaveBeenCalled();
  });

  it('also tries verified backup automatically when the primary route has no liquidity', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const getVerifiedQuote = vi.fn()
      .mockRejectedValueOnce(new Error('no liquidity'))
      .mockResolvedValueOnce({ provider: 'fixedfloat', quoteRequest: { backupConsent: true }, quote: { amountOut: '1000' } });
    const savePreview = vi.fn().mockResolvedValue({ id: 'preview' });
    const service = new TicketService({
      client: {},
      repositories: { savePreview, updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }), recordTicketError: vi.fn() },
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: {}, emojis: {},
      oneClick: {
        getVerifiedQuote,
        getFixedFloatOffer: vi.fn().mockResolvedValue(null),
        classifyError: () => ({ code: 'NO_LIQUIDITY_ROUTE', userMessage: 'No route', status: 400 }),
        safeErrorLogFields: () => ({ errorCode: 'NO_LIQUIDITY_ROUTE' }),
      },
      config: { previewTtlMs: 300000 }, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const result = await service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId, amountBase: '100000000',
      recipient: 'recipient', refundTo: 'refund',
    }, { reply: vi.fn() });
    expect(result).toEqual({ ok: true });
    expect(getVerifiedQuote).toHaveBeenCalledTimes(2);
    expect(savePreview.mock.calls[0][0].dryQuote.provider).toBe('fixedfloat');
  });

  it('keeps the normal minimum message when FixedFloat also rejects the amount', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const service = new TicketService({
      client: {}, repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] }, emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(new Error('minimum is $1000')),
        canUseFixedFloat: vi.fn().mockResolvedValue(false),
        classifyError: () => ({ code: 'AMOUNT_TOO_LOW', status: 400, userMessage: 'The amount is below the minimum available for this route.' }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_LOW' }),
      },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();

    const result = await service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId,
      amountBase: '400000000', amountDisplay: '4', amountUsdRequested: '200.00',
      recipient: 'recipient', refundTo: 'refund',
    }, sourceMessage);

    expect(result.userMessage).toBe('Swap amount is too low for this route. Enter a larger amount to continue.');
    expect(result.userPayload).toEqual({ content: result.userMessage });
  });

  it('moves the ticket off the loading step even when reporting the failure fails', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const updateTicketFlowIfStep = vi.fn().mockResolvedValue({ id: 'ticket' });
    const service = new TicketService({
      client: {},
      repositories: { updateTicketFlowIfStep, recordTicketError: vi.fn().mockRejectedValue(new Error('database hiccup')) },
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] }, emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(new Error('offline')),
        classifyError: vi.fn(() => { throw new Error('classifier bug'); }),
        safeErrorLogFields: () => ({}),
      },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();

    await expect(service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId, amountBase: '1', recipient: 'r', refundTo: 'f',
    }, null)).rejects.toThrow('classifier bug');
    expect(updateTicketFlowIfStep).toHaveBeenCalledWith('ticket', 'QUOTE_LOADING', 'REFUND_ADDRESS', expect.any(Object));
  });

  it('shows both the main and backup minimums when the amount is below both', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const service = new TicketService({
      client: {},
      repositories: { updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }), recordTicketError: vi.fn().mockResolvedValue(undefined) },
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] }, emojis: {},
      oneClick: {
        getVerifiedQuote: vi.fn().mockRejectedValue(new Error('minimum is $1000')),
        getFixedFloatOffer: vi.fn().mockResolvedValue({ quote: null, minimum: { amountFormatted: '0.2', amountUsd: '11.05' } }),
        classifyError: () => ({ code: 'AMOUNT_TOO_LOW', status: 400, userMessage: 'too low', routeLimit: { kind: 'minimum', display: '$1,000.00' } }),
        safeErrorLogFields: () => ({ errorCode: 'AMOUNT_TOO_LOW' }),
      },
      config: {}, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();

    const result = await service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId,
      amountBase: '1000000', amountDisplay: '0.01', amountUsdRequested: '0.55', recipient: 'recipient', refundTo: 'refund',
    }, { reply: vi.fn().mockResolvedValue(undefined) });

    expect(result.userMessage).toBe('Swap amount is too low. Minimum currently reported for this route: $11.05. Enter a larger amount to continue.');
    expect(result.userPayload.components).toBeUndefined();
  });

  it.each([['998', 'fixedfloat'], ['1000', 'relay']])(
    'automatically selects the greatest verified received amount (main=%s, winner=%s)',
    async (mainAmountOut, winner) => {
      const origin = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
      const destination = { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
      const savePreview = vi.fn().mockResolvedValue({ id: 'preview' });
      const getVerifiedQuote = vi.fn()
        .mockResolvedValueOnce({ provider: 'relay', quote: { amountOut: mainAmountOut } })
        .mockResolvedValueOnce({ provider: 'fixedfloat', quoteRequest: { backupConsent: true }, quote: { amountOut: '999' } });
      const service = new TicketService({
        client: {},
        repositories: { savePreview, updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }) },
        catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
        coinPolicy: { getAssetsForCoin: () => [] }, emojis: {},
        oneClick: { getVerifiedQuote, fixedFloat: { enabled: true } },
        config: { slippageBps: 50, previewTtlMs: 600000 }, health: {}, logger: { warn: vi.fn() },
      });
      service.renderProgress = vi.fn();
      const data = {
        originAssetId: origin.assetId, destinationAssetId: destination.assetId,
        amountBase: '100', amountDisplay: '100', recipient: 'recipient', refundTo: 'refund',
      };

      await expect(service.createPreviewFromChat('ticket', data, null)).resolves.toEqual({ ok: true });

      const dryQuote = savePreview.mock.calls[0][0].dryQuote;
      expect(dryQuote.provider).toBe(winner);
      expect(dryQuote.backupOffer).toBeUndefined();
      expect(data.backupConsent).toBe(winner === 'fixedfloat');
      expect(getVerifiedQuote).toHaveBeenCalledTimes(2);
      expect(getVerifiedQuote).toHaveBeenNthCalledWith(2, expect.objectContaining({
        provider: 'fixedfloat', backupConsent: true, dry: true,
      }));
    },
  );

  it('stays with a valid main quote when backup quote verification fails', async () => {
    const origin = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const destination = { assetId: 'sol', blockchain: 'sol', symbol: 'SOL', decimals: 9 };
    const savePreview = vi.fn().mockResolvedValue({ id: 'preview' });
    const getVerifiedQuote = vi.fn()
      .mockResolvedValueOnce({ provider: 'relay', quote: { amountOut: '1000' } })
      .mockRejectedValueOnce(new Error('Backup unavailable'));
    const service = new TicketService({
      client: {},
      repositories: { savePreview, updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }) },
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: {}, emojis: {},
      oneClick: {
        getVerifiedQuote, fixedFloat: { enabled: true },
        classifyError: () => ({ code: 'NO_LIQUIDITY_ROUTE' }),
      },
      config: { previewTtlMs: 300000 }, health: {}, logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();
    const data = {
      originAssetId: origin.assetId, destinationAssetId: destination.assetId,
      amountBase: '100', amountDisplay: '100', recipient: 'recipient', refundTo: 'refund',
      backupConsent: true, // stale preview selection must be ignored
    };
    await expect(service.createPreviewFromChat('ticket', data, null)).resolves.toEqual({ ok: true });
    expect(savePreview.mock.calls[0][0].dryQuote.provider).toBe('relay');
    expect(data.backupConsent).toBe(false);
  });

  it('rechecks all providers after a stale backup choice and can offer route notifications', async () => {
    const origin = { assetId: 'ltc', blockchain: 'ltc', symbol: 'LTC', decimals: 8 };
    const destination = { assetId: 'usdt-bsc', blockchain: 'bsc', symbol: 'USDT', decimals: 18 };
    const repositories = {
      updateTicketFlowIfStep: vi.fn().mockResolvedValue({ id: 'ticket' }),
      recordTicketError: vi.fn().mockResolvedValue(undefined),
    };
    const sourceMessage = { reply: vi.fn().mockResolvedValue(undefined) };
    const getVerifiedQuote = vi.fn().mockRejectedValue(new Error('FixedFloat does not support this route'));
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: { getAsset: (id) => [origin, destination].find((asset) => asset.assetId === id) ?? null },
      coinPolicy: { getAssetsForCoin: () => [] },
      emojis: {},
      oneClick: {
        getVerifiedQuote,
        classifyError: () => ({ code: 'NO_LIQUIDITY_ROUTE', status: null, userMessage: 'FixedFloat does not support this route.' }),
        safeErrorLogFields: () => ({ errorCode: 'NO_LIQUIDITY_ROUTE' }),
      },
      config: {},
      health: {},
      logger: { warn: vi.fn() },
    });
    service.renderProgress = vi.fn();

    const result = await service.createPreviewFromChat('ticket', {
      originAssetId: origin.assetId,
      destinationAssetId: destination.assetId,
      amountBase: '100000000',
      amountDisplay: '1',
      amountUsdRequested: '100.00',
      recipient: 'recipient',
      refundTo: 'refund',
      backupConsent: true,
    }, sourceMessage);

    expect(getVerifiedQuote).toHaveBeenCalledWith(expect.objectContaining({ provider: 'fixedfloat', backupConsent: true }));
    expect(result.userMessage).toBe('No exchange provider has an available quote for LTC → USDT on BNB Chain right now. Try another amount or ask to be notified.');
    expect(result.userPayload).toMatchObject({ content: result.userMessage });
    expect(result.userPayload.components[0].toJSON().components[0].custom_id).toBe('t:ticket:watch-exact');
  });
});

function makeService({
  repositories,
  assets = [],
  logger = { warn: () => {} },
  oneClick = {},
  health = {},
}) {
  return new TicketService({
    client: {},
    repositories,
    catalogue: { getAsset: (id) => assets.find((asset) => asset.assetId === id) ?? null },
    coinPolicy: {},
    emojis: {},
    oneClick,
    config: {},
    health,
    logger,
  });
}

function message(content, reply = vi.fn().mockResolvedValue(undefined)) {
  return {
    guildId: 'guild',
    channelId: 'channel',
    author: { id: 'owner', bot: false },
    content,
    webhookId: null,
    reply,
  };
}
