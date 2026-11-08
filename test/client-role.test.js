import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

const GUILD_ID = '1394554081246449807';
const ROLE_ID = '1565185132921618532';

function fixture({ alreadyHasRole = false, addError = null } = {}) {
  const add = vi.fn(async () => { if (addError) throw addError; });
  const member = { roles: { cache: { has: vi.fn().mockReturnValue(alreadyHasRole) }, add } };
  const memberFetch = vi.fn().mockResolvedValue(member);
  const guildFetch = vi.fn().mockResolvedValue({ members: { fetch: memberFetch } });
  const logger = { warn: vi.fn(), info: vi.fn() };
  const service = new TicketService({
    client: { guilds: { fetch: guildFetch } },
    repositories: {}, catalogue: {}, coinPolicy: {}, emojis: {},
    oneClick: {}, qrService: {}, health: {}, logger,
    config: { guildId: GUILD_ID, clientRoleId: ROLE_ID },
  });
  const swap = {
    id: 'swap', guild_id: GUILD_ID, user_id: '123456789012345678',
    status: 'SUCCESS', executable_quote: { provider: 'oneclick' },
  };
  return { service, swap, add, memberFetch, guildFetch, logger };
}

describe('successful crypto swap Client role', () => {
  it('awards the role after confirmed SUCCESS', async () => {
    const { service, swap, add, memberFetch } = fixture();
    expect(await service.assignClientRoleForCompletedSwap(swap)).toBe(true);
    expect(memberFetch).toHaveBeenCalledWith({ user: swap.user_id, force: true });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(ROLE_ID, 'Completed a crypto swap');
  });

  it('does nothing for a member who already has the role', async () => {
    const { service, swap, add } = fixture({ alreadyHasRole: true });
    expect(await service.assignClientRoleForCompletedSwap(swap)).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['PENDING_DEPOSIT', 'PROCESSING', 'REFUNDED', 'FAILED', 'TRACKING_STALE'])(
    'does nothing for status %s', async (status) => {
      const { service, swap, guildFetch } = fixture();
      expect(await service.assignClientRoleForCompletedSwap({ ...swap, status })).toBe(false);
      expect(guildFetch).not.toHaveBeenCalled();
    },
  );

  it('does nothing for a swap from another server or without an executable quote', async () => {
    const { service, swap, guildFetch } = fixture();
    expect(await service.assignClientRoleForCompletedSwap({ ...swap, guild_id: '223456789012345678' })).toBe(false);
    expect(await service.assignClientRoleForCompletedSwap({ ...swap, executable_quote: null })).toBe(false);
    expect(guildFetch).not.toHaveBeenCalled();
  });

  it('logs a missing-permissions error without interrupting swap processing', async () => {
    const { service, swap, logger } = fixture({
      addError: Object.assign(new Error('Missing Permissions'), { code: 50013 }),
    });
    expect(await service.assignClientRoleForCompletedSwap(swap)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 50013, roleId: ROLE_ID, userId: swap.user_id,
    }), expect.stringContaining('Could not award Client role'));
  });
});
