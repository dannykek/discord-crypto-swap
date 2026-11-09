import { readFile } from 'node:fs/promises';
import pngjs from 'pngjs';

const { PNG } = pngjs;
const WIDTH = 448;
const HEIGHT = 116;
const COIN_LOGOS = new Set([
  'btc', 'eth', 'sol', 'ltc', 'usdt', 'usdc', 'bnb', 'pol', 'avax',
  'doge', 'xrp', 'trx', 'sui', 'ada', 'bch', 'zec', 'xlm', 'apt', 'near', 'ton',
]);
const CHAIN_BADGES = Object.freeze({
  btc: 'btc', eth: 'eth', sol: 'sol', ltc: 'ltc', bsc: 'bnb',
  pol: 'pol', avax: 'avax', doge: 'doge', tron: 'trx', xrp: 'xrp',
  near: 'near', sui: 'sui', ton: 'ton', stellar: 'xlm', cardano: 'ada',
});
const logoCache = new Map();

function drawPixel(png, x, y, color) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const offset = (y * png.width + x) * 4;
  const alpha = (color[3] ?? 255) / 255;
  const previous = png.data[offset + 3] / 255;
  const combined = alpha + previous * (1 - alpha);
  if (!combined) return;
  for (let i = 0; i < 3; i++) {
    png.data[offset + i] = Math.round((color[i] * alpha + png.data[offset + i] * previous * (1 - alpha)) / combined);
  }
  png.data[offset + 3] = Math.round(combined * 255);
}

function circle(png, centerX, centerY, radius, color) {
  for (let y = Math.max(0, Math.floor(centerY - radius)); y <= Math.min(png.height - 1, Math.ceil(centerY + radius)); y++) {
    for (let x = Math.max(0, Math.floor(centerX - radius)); x <= Math.min(png.width - 1, Math.ceil(centerX + radius)); x++) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2) drawPixel(png, x, y, color);
    }
  }
}

function line(png, fromX, fromY, toX, toY, thickness, color) {
  const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY)) * 2;
  for (let i = 0; i <= steps; i++) {
    const ratio = i / Math.max(steps, 1);
    circle(png, fromX + (toX - fromX) * ratio, fromY + (toY - fromY) * ratio, thickness / 2, color);
  }
}

function background(png) {
  const radius = 17;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const cornerX = Math.max(radius - x, x - (WIDTH - radius - 1), 0);
      const cornerY = Math.max(radius - y, y - (HEIGHT - radius - 1), 0);
      if (cornerX ** 2 + cornerY ** 2 > radius ** 2) continue;
      const border = x <= 1 || y <= 1 || x >= WIDTH - 2 || y >= HEIGHT - 2
        || cornerX ** 2 + cornerY ** 2 >= (radius - 1.6) ** 2;
      if (border) drawPixel(png, x, y, [76, 105, 129, 180]);
      else drawPixel(png, x, y, [
        18 + Math.round(6 * x / WIDTH),
        25 + Math.round(12 * x / WIDTH),
        41 + Math.round(8 * x / WIDTH),
        255,
      ]);
    }
  }
  // Subtle mint and lavender details match the bot's dark Discord theme.
  line(png, 18, 2, 124, 2, 2, [103, 235, 196, 175]);
  line(png, WIDTH - 118, HEIGHT - 3, WIDTH - 18, HEIGHT - 3, 2, [171, 144, 246, 125]);
}

async function getLogo(key) {
  if (!key || !COIN_LOGOS.has(key)) return null;
  if (!logoCache.has(key)) {
    const file = readFile(new URL(`../assets/token-logos/${key}.b64`, import.meta.url), 'utf8')
      .then((contents) => PNG.sync.read(Buffer.from(contents.trim(), 'base64')))
      .catch(() => null);
    logoCache.set(key, file);
  }
  return logoCache.get(key);
}

function putLogo(png, source, centerX, centerY, radius) {
  if (!source) {
    circle(png, centerX, centerY, radius, [101, 116, 160, 255]);
    circle(png, centerX, centerY, radius * 0.52, [215, 228, 245, 220]);
    return;
  }
  const diameter = radius * 2;
  for (let y = 0; y < diameter; y++) {
    for (let x = 0; x < diameter; x++) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      if (dx * dx + dy * dy > radius * radius) continue;
      const sx = Math.min(source.width - 1, Math.floor(x / diameter * source.width));
      const sy = Math.min(source.height - 1, Math.floor(y / diameter * source.height));
      const offset = (sy * source.width + sx) * 4;
      drawPixel(png, centerX - radius + x, centerY - radius + y, [
        source.data[offset], source.data[offset + 1], source.data[offset + 2], source.data[offset + 3],
      ]);
    }
  }
}

function tokenLogoKey(asset) {
  const symbol = String(asset?.symbol ?? '').toLowerCase();
  return COIN_LOGOS.has(symbol) ? symbol : null;
}

async function putCoin(png, asset, centerX) {
  const centerY = 53;
  circle(png, centerX, centerY + 3, 46, [0, 0, 0, 62]);
  circle(png, centerX, centerY, 43, [62, 76, 108, 255]);
  circle(png, centerX, centerY, 40, [17, 25, 39, 255]);
  putLogo(png, await getLogo(tokenLogoKey(asset)), centerX, centerY, 35);

  // A small network logo overlaps the bottom-left of each asset logo.
  const badgeX = centerX - 29;
  const badgeY = centerY + 29;
  circle(png, badgeX, badgeY, 17, [20, 28, 42, 255]);
  circle(png, badgeX, badgeY, 15, [134, 162, 178, 255]);
  circle(png, badgeX, badgeY, 12.6, [24, 34, 49, 255]);
  putLogo(png, await getLogo(CHAIN_BADGES[asset?.blockchain]), badgeX, badgeY, 12);
}

export async function createCompletionRoutePng(origin, destination) {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  background(png);
  await Promise.all([putCoin(png, origin, 94), putCoin(png, destination, 354)]);
  // Clean, narrow arrow between the two actual token images.
  circle(png, 224, 57, 30, [37, 51, 68, 245]);
  line(png, 205, 57, 243, 57, 5, [118, 241, 195, 255]);
  line(png, 233, 47, 244, 57, 5, [118, 241, 195, 255]);
  line(png, 233, 67, 244, 57, 5, [118, 241, 195, 255]);
  return PNG.sync.write(png);
}
