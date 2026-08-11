import { pathWithoutQuery, withoutEmbeddedQuery } from './http-path';

describe('pathWithoutQuery', () => {
  it('leaves a path with no query string alone', () => {
    expect(pathWithoutQuery('/api/contacts')).toBe('/api/contacts');
  });

  it('drops the query string', () => {
    expect(pathWithoutQuery('/api/contacts?token=secret&page=2')).toBe('/api/contacts');
  });

  it('drops an empty query string', () => {
    expect(pathWithoutQuery('/api/contacts?')).toBe('/api/contacts');
  });
});

describe('withoutEmbeddedQuery', () => {
  it('strips the query string out of a framework message that embeds the URL', () => {
    const url = '/api/nope?token=secret';

    expect(withoutEmbeddedQuery(`Cannot GET ${url}`, url)).toBe('Cannot GET /api/nope');
  });

  it('leaves a message alone when the URL carries no query string', () => {
    expect(withoutEmbeddedQuery('Cannot GET /api/nope', '/api/nope')).toBe('Cannot GET /api/nope');
  });

  it('leaves a message that does not contain the URL alone', () => {
    expect(withoutEmbeddedQuery('Contact not found', '/api/contacts/7?token=secret')).toBe(
      'Contact not found',
    );
  });
});
