/**
 * Inline media for the fixture transport, so the inbox's image, document and
 * audio renderers can be reviewed without an API, a storage bucket or a network.
 *
 * `data:` URLs rather than a placeholder host: a fixture that points at
 * something unreachable renders a broken image, which is exactly the state the
 * media pipeline's `failed` branch is supposed to mean — and a reviewer cannot
 * tell the two apart. These load.
 *
 * Everything here is deterministic. Nothing is generated from a clock or a
 * random source, because the fixture layer has to produce identical markup on
 * the server and in the browser.
 */

/** A labelled rectangle, drawn rather than fetched. */
function svgDataUrl(label: string, background: string, foreground: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" role="img">` +
    `<rect width="320" height="240" fill="${background}"/>` +
    `<text x="160" y="128" font-family="sans-serif" font-size="22" fill="${foreground}" ` +
    `text-anchor="middle">${label}</text></svg>`;

  return `data:image/svg+xml;base64,${base64(svg)}`;
}

export const MOCK_IMAGE_URL = svgDataUrl('Invoice photo', '#0e7346', '#ffffff');
export const MOCK_STICKER_URL = svgDataUrl('Sticker', '#f1f5f9', '#0f172a');
export const MOCK_DOCUMENT_URL = `data:text/plain;base64,${base64(
  'Mock invoice. The fixture transport serves this in place of a stored PDF.',
)}`;

/**
 * A fraction of a second of silence, as a real WAV.
 *
 * Built here rather than pasted as a kilobyte of base64: the header is the
 * interesting part, and a blob nobody can read is a blob nobody can fix.
 */
export const MOCK_AUDIO_URL = `data:audio/wav;base64,${silentWav()}`;

function silentWav(): string {
  const sampleRate = 8_000;
  const sampleCount = 400;
  const headerBytes = 44;
  const buffer = new ArrayBuffer(headerBytes + sampleCount);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate: 8-bit mono
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, sampleCount, true);

  // 128 is the zero point for unsigned 8-bit PCM; 0 would be a loud click.
  for (let offset = 0; offset < sampleCount; offset += 1) {
    view.setUint8(headerBytes + offset, 128);
  }

  return base64FromBytes(new Uint8Array(buffer));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function base64(value: string): string {
  return base64FromBytes(new TextEncoder().encode(value));
}

/**
 * `btoa` over a byte array. Node has `Buffer`, but this module is evaluated by
 * the same bundler that serves the browser, and `btoa` is the API both have.
 */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}
