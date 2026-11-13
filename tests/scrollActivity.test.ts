import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isScrollActive, trackScrollActivity } from '../src/web/lib/scrollActivity.js';

describe('updates wait until scrolling is idle', () => {
  let target: EventTarget;
  let dispose: () => void;
  let idle: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    target = new EventTarget();
    idle = vi.fn();
    dispose = trackScrollActivity(idle, target);
  });
  afterEach(() => { dispose(); vi.useRealTimers(); });

  it('waits through consecutive wheel and momentum scroll events', () => {
    target.dispatchEvent(new Event('wheel'));
    expect(isScrollActive()).toBe(true);
    vi.advanceTimersByTime(150);
    target.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(150);
    expect(idle).not.toHaveBeenCalled();
    expect(isScrollActive()).toBe(true);
    vi.advanceTimersByTime(50);
    expect(isScrollActive()).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('does not flush while a finger is held or while inertia continues', () => {
    target.dispatchEvent(new Event('touchstart'));
    vi.advanceTimersByTime(1000);
    expect(isScrollActive()).toBe(true);
    expect(idle).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('touchend'));
    vi.advanceTimersByTime(150);
    target.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(199);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('cleans up pending timers and event handlers', () => {
    target.dispatchEvent(new Event('touchstart'));
    dispose();
    target.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1000);
    expect(isScrollActive()).toBe(false);
    expect(idle).not.toHaveBeenCalled();
  });
});
