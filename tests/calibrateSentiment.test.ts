import { describe, it, expect } from 'vitest';
import { calibrateSentimentLabel, SENTIMENT_CONFIDENCE_FLOOR } from '@/offscreen/calibrateSentiment';

describe('calibrateSentimentLabel', () => {
  it('keeps a confident positive/negative prediction', () => {
    expect(calibrateSentimentLabel('positive', 0.92)).toBe('positive');
    expect(calibrateSentimentLabel('negative', 0.81)).toBe('negative');
  });

  it('pulls a low-confidence prediction back to neutral', () => {
    expect(calibrateSentimentLabel('positive', 0.4)).toBe('neutral');
    expect(calibrateSentimentLabel('negative', SENTIMENT_CONFIDENCE_FLOOR - 0.01)).toBe('neutral');
  });

  it('passes neutral / unknown labels through as neutral', () => {
    expect(calibrateSentimentLabel('neutral', 0.99)).toBe('neutral');
    expect(calibrateSentimentLabel('label_2', 0.99)).toBe('neutral');
  });

  it('treats the floor as inclusive', () => {
    expect(calibrateSentimentLabel('positive', SENTIMENT_CONFIDENCE_FLOOR)).toBe('positive');
  });
});
