import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TicketService } from '../src/services/ticket-service.js';

const environment = {
  DISCORD_TOKEN: 'discord-token-with-enough-characters',
  DISCORD_GUILD_ID: '123456789012345678',
  PANEL_CHANNEL_ID: '123456789012345679',
  TICKET_CATEGORY_ID: '123456789012345680',
  COMPLETED_DEALS_CHANNEL_ID: '123456789012345681',
  TRANSCRIPT_CHANNEL_ID: '123456789012345682',
  VOUCH_CHANNEL_ID: '123456789012345683',
  ONECLICK_JWT: 'oneclick-jwt-with-enough-characters',
  DATABASE_URL: 'postgresql://localhost/swapbot',
};

describe('Discord configuration through environment IDs', () => {
  it('reads every destination channel from the environment', () => {
    const config = loadConfig(environment);
    expect(config.guilds).toEqual([{
      guildId: environment.DISCORD_GUILD_ID,
      panelChannelId: environment.PANEL_CHANNEL_ID,
      ticketCategoryId: environment.TICKET_CATEGORY_ID,
      completedDealsChannelId: environment.COMPLETED_DEALS_CHANNEL_ID,
      transcriptChannelId: environment.TRANSCRIPT_CHANNEL_ID,
      vouchChannelId: environment.VOUCH_CHANNEL_ID,
    }]);
  });

  it('unregisters obsolete /setup while retaining /stats and /leaderboard', async () => {
    const deleteSetup = vi.fn().mockResolvedValue(undefined);
    const globalCommands = [{ name: 'setup', delete: deleteSetup }];
    const createdCommands = [];
    const guild = {
      id: environment.DISCORD_GUILD_ID,
      commands: {
        fetch: vi.fn().mockResolvedValue([]),
        create: vi.fn(async (command) => createdCommands.push(command.name)),
      },
    };
    const client = {
      application: { commands: { fetch: vi.fn().mockResolvedValue(globalCommands) } },
      guilds: { fetch: vi.fn().mockResolvedValue(guild) },
    };
    const service = new TicketService({
      client,
      repositories: {},
      catalogue: {},
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: loadConfig(environment),
      health: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await service.initializeCommands();
    expect(deleteSetup).toHaveBeenCalledOnce();
    expect(createdCommands).toEqual(['stats', 'leaderboard']);
  });
});
