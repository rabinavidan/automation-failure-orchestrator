import { describe, it, expect, afterEach } from 'vitest';
import {
  decideAlertStatus,
  maxSeverity,
  suppressionWindowMinutes,
} from '../services/alert-processor';

const t0 = new Date('2025-10-03T14:00:00Z');
const plus = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe('decideAlertStatus', () => {
  it('treats a first sighting as new', () => {
    expect(decideAlertStatus({ previousLastSeenAt: null, detectedAt: t0, windowMinutes: 60 })).toBe(
      'new'
    );
  });

  it('suppresses repeats inside the window', () => {
    expect(
      decideAlertStatus({ previousLastSeenAt: t0, detectedAt: plus(30), windowMinutes: 60 })
    ).toBe('suppressed');
    expect(
      decideAlertStatus({ previousLastSeenAt: t0, detectedAt: plus(60), windowMinutes: 60 })
    ).toBe('suppressed');
  });

  it('re-opens as new once the window has elapsed', () => {
    expect(
      decideAlertStatus({ previousLastSeenAt: t0, detectedAt: plus(61), windowMinutes: 60 })
    ).toBe('new');
  });

  it('suppresses late, out-of-order deliveries inside the window', () => {
    expect(
      decideAlertStatus({ previousLastSeenAt: t0, detectedAt: plus(-10), windowMinutes: 60 })
    ).toBe('suppressed');
  });

  it('never suppresses when the window is 0', () => {
    expect(decideAlertStatus({ previousLastSeenAt: t0, detectedAt: t0, windowMinutes: 0 })).toBe(
      'new'
    );
  });
});

describe('maxSeverity', () => {
  it('keeps the highest severity seen for a fingerprint', () => {
    expect(maxSeverity('low', 'critical')).toBe('critical');
    expect(maxSeverity('high', 'medium')).toBe('high');
    expect(maxSeverity('informational', 'informational')).toBe('informational');
  });
});

describe('suppressionWindowMinutes', () => {
  const original = process.env.ALERT_SUPPRESSION_WINDOW_MINUTES;
  afterEach(() => {
    if (original === undefined) delete process.env.ALERT_SUPPRESSION_WINDOW_MINUTES;
    else process.env.ALERT_SUPPRESSION_WINDOW_MINUTES = original;
  });

  it('defaults to 60 and honours valid overrides', () => {
    delete process.env.ALERT_SUPPRESSION_WINDOW_MINUTES;
    expect(suppressionWindowMinutes()).toBe(60);
    process.env.ALERT_SUPPRESSION_WINDOW_MINUTES = '15';
    expect(suppressionWindowMinutes()).toBe(15);
    process.env.ALERT_SUPPRESSION_WINDOW_MINUTES = '-5';
    expect(suppressionWindowMinutes()).toBe(60);
  });
});
