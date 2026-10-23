import { describe, expect, it } from 'vitest';
import { delegationLabel } from './publication-label';

describe('delegationLabel', () => {
  it('says nothing for a version a person approved exactly, or an older response without the field', () => {
    expect(delegationLabel({ authorization: 'human', via_client_name: null, via_client_name_is_unverified: false }, 'ada')).toBeNull();
    expect(delegationLabel(undefined, 'ada')).toBeNull();
  });
  it('names the client as unverified and the owner for a delegated version', () => {
    expect(delegationLabel({ authorization: 'delegated', via_client_name: 'Example Agent', via_client_name_is_unverified: true }, 'ada'))
      .toBe('Published by Example Agent (name reported by the application, not verified) for @ada without per-version review.');
  });
  it('falls back when the client or the owner handle is unknown', () => {
    expect(delegationLabel({ authorization: 'delegated', via_client_name: null, via_client_name_is_unverified: false }, null))
      .toBe('Published by an application for the owner without per-version review.');
  });
});
