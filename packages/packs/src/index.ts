/**
 * The pack registry.
 *
 * Two packs today and the second one is the point: `platform` is not marketing
 * and needed no change to anything outside this directory to exist, which is
 * the Part 10 claim made falsifiable. If adding it had required touching the
 * gate, the world model or the reasoning tiers, the seam would not be one.
 */
export * from './types.js';
export * from './marketing-ca.js';
export * from './platform.js';

import type { DomainPack } from './types.js';
import { marketingCanada } from './marketing-ca.js';
import { platform } from './platform.js';

export const PACKS: readonly DomainPack[] = [marketingCanada, platform];

export const DEFAULT_PACK_ID = marketingCanada.id;

/** By id, or undefined. Never a silent fallback to the default: running the
 *  wrong domain quietly is worse than not running. */
export const packById = (id: string): DomainPack | undefined =>
  PACKS.find((p) => p.id === id);
