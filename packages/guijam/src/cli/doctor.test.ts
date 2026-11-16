import { describe, expect, it } from 'vitest';
import { nodeSupported } from './doctor.js';

describe('nodeSupported', () => {
  it('matches ^20.19.0 || >=22.12.0', () => {
    expect(nodeSupported('v20.19.0')).toBe(true);
    expect(nodeSupported('20.18.3')).toBe(false);
    expect(nodeSupported('21.7.3')).toBe(false);
    expect(nodeSupported('22.11.0')).toBe(false);
    expect(nodeSupported('22.12.0')).toBe(true);
    expect(nodeSupported('24.3.0')).toBe(true);
  });
});
