import { CHUNKING } from './ai.constants';
import { chunkDocument } from './chunk-document';

/**
 * Chunking decides what retrieval can find and what the bot can cite, so its
 * failure modes are quiet ones: a chunk that swallows a whole policy dominates
 * every rank, and a chunk cut mid-word matches nothing.
 */

/** A paragraph of a given length, so the packer's boundaries are checkable. */
function paragraph(length: number, marker: string): string {
  return marker.repeat(length);
}

describe('chunkDocument', () => {
  it('keeps a short document as one chunk', () => {
    expect(chunkDocument('Refunds are available within 30 days.')).toEqual([
      'Refunds are available within 30 days.',
    ]);
  });

  it('produces nothing for content with no text in it', () => {
    expect(chunkDocument('   \n\n  \n')).toEqual([]);
  });

  it('splits on the author’s own paragraph boundaries once the target is passed', () => {
    const chunks = chunkDocument(
      [paragraph(800, 'a'), paragraph(800, 'b'), paragraph(800, 'c')].join('\n\n'),
    );

    // Two of these do not fit together, so each is its own chunk — the split
    // follows the author's blank lines rather than a character count.
    expect(chunks).toEqual([paragraph(800, 'a'), paragraph(800, 'b'), paragraph(800, 'c')]);
  });

  it('carries one paragraph of overlap, so an answer spanning a boundary is findable', () => {
    const [first, second] = chunkDocument(
      [paragraph(500, 'a'), paragraph(500, 'b'), paragraph(500, 'c')].join('\n\n'),
    );

    // `a` and `b` pack together; `c` overshoots, so the chunk closes and `b`
    // opens the next one. An answer that straddles the b/c boundary is
    // retrievable from either side.
    expect(first).toBe([paragraph(500, 'a'), paragraph(500, 'b')].join('\n\n'));
    expect(second).toBe([paragraph(500, 'b'), paragraph(500, 'c')].join('\n\n'));
  });

  it('never carries a paragraph that was a chunk on its own, which would index it twice', () => {
    // The overlap bridges a boundary. A chunk holding one paragraph has no
    // boundary inside it, and carrying that paragraph forward would emit it
    // again at the head of the next chunk.
    const chunks = chunkDocument(
      [paragraph(800, 'a'), paragraph(800, 'b'), paragraph(800, 'c')].join('\n\n'),
    );

    expect(new Set(chunks).size).toBe(chunks.length);
  });

  it('splits a paragraph with no blank line in it rather than emitting a giant chunk', () => {
    const words = Array.from({ length: 800 }, (_, index) => `word${index}`).join(' ');
    const chunks = chunkDocument(words);

    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNKING.hardLimit);
    }
  });

  it('cuts a long paragraph on whitespace, never mid-word', () => {
    const words = Array.from({ length: 800 }, (_, index) => `word${index}`).join(' ');

    for (const chunk of chunkDocument(words)) {
      // Every piece is a whole set of tokens — a half-written `word4` would
      // match neither the full-text index nor the trigram one.
      expect(chunk.split(/\s+/).every((token) => /^word\d+$/.test(token))).toBe(true);
    }
  });

  it('emits an unsplittable token whole rather than slicing it', () => {
    // A pasted URL or a base64 blob has no whitespace to cut on. Slicing it
    // would produce fragments that match nothing at all.
    const blob = 'x'.repeat(CHUNKING.targetChars + 500);

    expect(chunkDocument(blob)).toEqual([blob]);
  });

  it('trims paragraphs, so leading indentation is not indexed as content', () => {
    expect(chunkDocument('   Refunds take 5 days.   ')).toEqual(['Refunds take 5 days.']);
  });
});
