import { describe, expect, it } from 'vitest';
import { MsEdgeTTS } from '../src/vendor/msedge-tts/MsEdgeTTS.ts';

// Official vector from readest PR #6751 (TS port of rany2/edge-tts PR #492).
// If Microsoft rotates EDGE_API_TOKEN the vector must be recaptured as well.
describe('MsEdgeTTS Sec-MS-GEC v2', () => {
  it('v2 token matches the Edge capture', async () => {
    // 2026-10-13T10:40:00Z, exactly a 5-minute window start
    expect(await MsEdgeTTS.generateSecMsGec(MsEdgeTTS.TRUSTED_CLIENT_TOKEN, 1791888000 * 1000)).toBe(
      '492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876',
    );
  });

  it('synth URL advertises Sec-MS-GEC-Version 2', async () => {
    expect(await MsEdgeTTS.getSynthUrl()).toContain('Sec-MS-GEC-Version=2-');
  });
});
