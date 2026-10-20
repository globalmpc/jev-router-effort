/**
 * The proxies listen on loopback only, but a web page can still reach them: a cross-site
 * POST carries an Origin header, and a DNS-rebinding page keeps its own Host. The CLIs send
 * neither, so both are refused before the request can spend the user's Jev key.
 */
export function rejectForeign(req, res, port) {
  const host = req.headers.host ?? "";
  if (req.headers.origin === undefined && (host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return false;
  res.writeHead(403, { "content-type": "text/plain" }).end("jev-router: request refused\n");
  return true;
}
