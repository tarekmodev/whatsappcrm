import { CHUNKING } from './ai.constants';

/**
 * A knowledge-base document, split into the units retrieval ranks and the bot
 * cites (0010, chunking).
 *
 * **Paragraph-packed, not fixed token windows.** A tenant FAQ or policy is
 * authored in paragraphs and headings, so splitting on blank lines follows
 * boundaries the author already chose — and it needs no tokenizer at write time,
 * which keeps the indexer a pure function a unit test can call. Whole documents
 * as one chunk is rejected for the opposite reason: one 40 KB policy would
 * dominate every prompt and every rank.
 *
 * One paragraph of overlap carries into the next chunk, so a sentence answered
 * across a paragraph boundary is retrievable from either side.
 *
 * A single paragraph longer than `hardLimit` is split on whitespace. That is the
 * one place the author's own boundary is overridden, and it is rare — a wall of
 * text with no blank line in it. Splitting on whitespace rather than mid-word
 * keeps the trigram index useful.
 */
export function chunkDocument(content: string): string[] {
  const paragraphs = splitIntoParagraphs(content);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    // Packing this paragraph would overshoot, and there is already something to
    // emit — close the chunk first, then carry the overlap forward.
    if (current.length > 0 && currentLength + paragraph.length > CHUNKING.targetChars) {
      chunks.push(current.join('\n\n'));
      current = overlapFrom(current);
      currentLength = lengthOf(current);
    }

    current.push(paragraph);
    currentLength += paragraph.length;
  }

  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}

/**
 * What the chunk just emitted carries into the next one.
 *
 * **Nothing, when the emitted chunk was only the overlap itself.** A chunk of
 * one paragraph that carried that paragraph forward would emit it again at the
 * head of the next chunk, so every paragraph large enough to fill a chunk on its
 * own would be indexed twice and the second copy would drag an unrelated
 * paragraph in behind it. The overlap exists to bridge a boundary, and there is
 * no boundary to bridge inside a chunk that holds one thing.
 */
function overlapFrom(emitted: readonly string[]): string[] {
  return emitted.length > CHUNKING.overlapParagraphs
    ? emitted.slice(-CHUNKING.overlapParagraphs)
    : [];
}

/** Paragraph separator, and the join `chunkDocument` reassembles with. */
const PARAGRAPH_BREAK = /\n\s*\n/;

/**
 * Non-empty paragraphs, with any that is longer than the hard limit already
 * broken up — so the packer above only ever sees pieces it can fit.
 */
function splitIntoParagraphs(content: string): string[] {
  return content
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .flatMap((paragraph) =>
      paragraph.length <= CHUNKING.hardLimit ? [paragraph] : splitLongParagraph(paragraph),
    );
}

/**
 * A paragraph with no blank line in it, cut on whitespace at roughly the target
 * size.
 *
 * Greedy rather than balanced: the last piece may be short, which costs nothing
 * — a chunk is ranked on its own content, and an even split would only make the
 * arithmetic harder to follow.
 *
 * A single "word" longer than the target — a URL, a base64 blob pasted into a
 * policy — has no whitespace to cut on and is emitted whole rather than sliced
 * mid-token, which would make it match nothing.
 */
function splitLongParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  let current = '';

  for (const word of paragraph.split(/\s+/)) {
    if (current === '') {
      current = word;
      continue;
    }

    if (current.length + 1 + word.length > CHUNKING.targetChars) {
      pieces.push(current);
      current = word;
      continue;
    }

    current = `${current} ${word}`;
  }

  if (current !== '') {
    pieces.push(current);
  }

  return pieces;
}

/** The packed length of a chunk under construction, separators excluded. */
function lengthOf(paragraphs: readonly string[]): number {
  return paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
}
