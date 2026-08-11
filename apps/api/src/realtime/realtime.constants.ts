/**
 * Where the Socket.IO server sits on the API's own origin.
 *
 * Not Socket.IO's default `/socket.io`, and under `/realtime` rather than
 * `/api`: everything below `/api` is versioned by URI (`configureApp`), and a
 * transport endpoint that is not a REST resource has no business inheriting a
 * resource version. It also keeps the WebSocket upgrade outside the prefix
 * ADR 0002 decision 3 routes through the Next.js rewrite — the socket connects
 * to `REALTIME_URL` directly, which is the whole reason the handshake carries a
 * ticket instead of a cookie.
 *
 * Named once here because three places have to agree: the gateway, the adapter
 * that builds the server, and the console client that connects to it.
 */
export const REALTIME_PATH = '/realtime';
