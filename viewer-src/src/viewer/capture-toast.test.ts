// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CAPTURE_NOTICE_MS, createCaptureToast, type CaptureToast } from './capture-toast';

describe('capture toast', () => {
  let el: HTMLDivElement;
  let toast: CaptureToast;
  const action = () => el.querySelector<HTMLButtonElement>('.toast-action')!;
  const close = () => el.querySelector<HTMLButtonElement>('.toast-close')!;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    toast = createCaptureToast(el);
  });
  afterEach(() => vi.useRealTimers());

  test('starts hidden; a notice shows and fades after a few seconds', () => {
    expect(el.hidden).toBe(true);
    toast.notice('Xong');
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('Xong');
    expect(action().hidden).toBe(true);
    vi.advanceTimersByTime(CAPTURE_NOTICE_MS - 1);
    expect(el.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(el.hidden).toBe(true);
  });

  test('an offer stays until used; using it runs the action once and is not a discard', () => {
    const run = vi.fn();
    const discard = vi.fn();
    toast.offer('Video', { label: 'Tải video về', run, discard });
    vi.advanceTimersByTime(60_000);
    expect(el.hidden).toBe(false);
    expect(action().textContent).toBe('Tải video về');
    action().click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
    expect(el.hidden).toBe(true);
    action().click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('× discards the offer; a newer offer or notice discards the older one', () => {
    const a = vi.fn();
    const b = vi.fn();
    toast.offer('1', { label: 'x', run: () => {}, discard: a });
    close().click();
    expect(a).toHaveBeenCalledTimes(1);
    expect(el.hidden).toBe(true);
    toast.offer('2', { label: 'x', run: () => {}, discard: b });
    toast.notice('3');
    expect(b).toHaveBeenCalledTimes(1);
    toast.dispose();
    expect(el.hidden).toBe(true);
  });

  test('an action that offers again from its run keeps the toast open (one download per click)', () => {
    const second = vi.fn();
    toast.offer('2 file', {
      label: 'Tải 2',
      run: () => toast.offer('1 file', { label: 'Tải 1', run: second }),
    });
    action().click();
    expect(el.hidden).toBe(false);
    expect(action().textContent).toBe('Tải 1');
    action().click();
    expect(second).toHaveBeenCalledTimes(1);
    expect(el.hidden).toBe(true);
  });
});
