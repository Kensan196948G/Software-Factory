import { describe, expect, it, vi } from 'vitest';
import { confirmInput } from '../../scripts/ops/confirm-input.js';
describe('explicit operator confirmation without silent exits', () => {
  it('reprompts on empty input instead of exiting or approving', async () => {
    const answers = ['', 'CF-SAVED'];
    const ask = vi.fn(async () => answers.shift()!);
    const print = vi.fn();
    expect(await confirmInput(ask, print, '確認', 'CF-SAVED')).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('確認文字が一致しません'));
  });
  it('does not accept explanation or a different token', async () => {
    const answers = ['CF-SAVED → Enter', 'APPLY', 'CF-SAVED'];
    const print = vi.fn();
    expect(await confirmInput(async () => answers.shift()!, print, '確認', 'CF-SAVED')).toBe(true);
    expect(print).toHaveBeenCalledTimes(2);
  });
  it('accepts surrounding whitespace only, not lowercase', async () => {
    const answers = ['apply', ' APPLY '];
    expect(
      await confirmInput(
        async () => answers.shift()!,
        () => undefined,
        '確認',
        'APPLY',
      ),
    ).toBe(true);
  });
  it('clearly reports cancellation without consent', async () => {
    const print = vi.fn();
    expect(await confirmInput(async () => 'CANCEL', print, '確認', 'APPLY')).toBe(false);
    expect(print).toHaveBeenCalledWith(expect.stringContaining('設定変更・再起動は行っていません'));
  });
  it('bounds retries and explains no change', async () => {
    const ask = vi.fn(async () => '');
    const print = vi.fn();
    expect(await confirmInput(ask, print, '確認', 'MAINTENANCE')).toBe(false);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(print).toHaveBeenLastCalledWith(expect.stringContaining('3回一致しなかった'));
  });
});
