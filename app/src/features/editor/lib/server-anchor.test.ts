import { describe, expect, it } from 'vitest';

import { toServerAnchor } from './server-anchor';

describe('toServerAnchor', () => {
  it('passes a consistent anchor through', () => {
    expect(toServerAnchor({ quote: 'abc', prefix: 'x', suffix: 'y', start: 4, end: 7 })).toEqual({
      quote: 'abc',
      prefix: 'x',
      suffix: 'y',
      start: 4,
      end: 7,
    });
  });

  it('is nothing when the quote is empty: the server answers 422 to an empty quote', () => {
    expect(toServerAnchor({ quote: '', start: 0, end: 0 })).toBeNull();
    expect(toServerAnchor({ start: 0, end: 3 })).toBeNull();
    expect(toServerAnchor(null)).toBeNull();
    expect(toServerAnchor(undefined)).toBeNull();
  });

  it('counts the quote in code points, as the server does', () => {
    expect(toServerAnchor({ quote: '𝒫𝒫', start: 1, end: 3 })).toMatchObject({ start: 1, end: 3 });
    // 2 code points but a UTF-16 length of 4: end - start of 4 is wrong.
    expect(toServerAnchor({ quote: '𝒫𝒫', start: 1, end: 5 })).toMatchObject({
      start: null,
      end: null,
    });
  });

  it('drops offsets that do not fit the quote, both or neither, keeping the quote for the server to find', () => {
    expect(toServerAnchor({ quote: 'abc', start: 1, end: 9 })).toEqual({
      quote: 'abc',
      prefix: '',
      suffix: '',
      start: null,
      end: null,
    });
    expect(toServerAnchor({ quote: 'abc', start: 1 })).toMatchObject({ start: null, end: null });
    expect(toServerAnchor({ quote: 'abc', start: null, end: null })).toMatchObject({
      start: null,
      end: null,
    });
  });

  it('keeps the offsets of a single-line quote that spans exactly its length', () => {
    expect(toServerAnchor({ quote: 'abc', start: 4, end: 7 })).toMatchObject({ start: 4, end: 7 });
  });

  it('drops offsets that do not match the quote length', () => {
    expect(toServerAnchor({ quote: 'abc', start: 4, end: 9 })).toMatchObject({
      start: null,
      end: null,
    });
  });

  it('turns line breaks into CR LF and drops the offsets for a CR LF section', () => {
    const anchor = toServerAnchor(
      { quote: 'a\nb', prefix: 'x\n', suffix: '\ny', start: 4, end: 7 },
      { crlf: true },
    );
    expect(anchor).toEqual({
      quote: 'a\r\nb',
      prefix: 'x\r\n',
      suffix: '\r\ny',
      start: null,
      end: null,
    });
  });

  it('returns null for an empty quote', () => {
    expect(toServerAnchor({ quote: '', start: 0, end: 0 })).toBeNull();
  });

  it('sends only the fields the server allows', () => {
    const anchor = toServerAnchor({ quote: 'abc', start: 0, end: 3, extra: 1 } as never);
    expect(Object.keys(anchor!).sort()).toEqual(['end', 'prefix', 'quote', 'start', 'suffix']);
  });
});
