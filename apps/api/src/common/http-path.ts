/**
 * The request path with its query string removed.
 *
 * A query string is the one part of a URL that routinely carries a token, a
 * signature or a phone number, and none of those belong in a log line, a metric
 * label or an error-tracker event.
 */
export function pathWithoutQuery(url: string): string {
  const queryStart = url.indexOf('?');

  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Replaces a request URL embedded in a message with its query-stripped form.
 *
 * Nest builds its routing 404 as `Cannot GET <originalUrl>`, so an unmatched route
 * carrying a token in the query string would put that token straight into the log
 * line and into the response body. Stripping it at the one place messages are
 * turned into output beats hoping no caller ever puts a secret in a query string.
 */
export function withoutEmbeddedQuery(message: string, url: string): string {
  return url.includes('?') ? message.replaceAll(url, pathWithoutQuery(url)) : message;
}
