import fs from "fs";
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import {Action, cleanUpNode, getCurrentProxy, getNodeList, listen, Node, redisGet, redisSet} from "./discovery";

const HTTPS_PORT = 443;
const HTTP_PORT = Number(process.env.PORT || 80);
const HTTP_IP = process.env.IP || '0.0.0.0';
const SOCKET_TIMEOUT = Number(process.env.SOCKET_TIMEOUT || 30000); // 30 seconds default socket timeout
const processIDKey = 'key_process_id'
const processIds: { [id: string]: httpProxy } = {}

http.globalAgent = new http.Agent({ keepAlive: true });
https.globalAgent = new https.Agent({ keepAlive: true });

async function getProxy(url: string) {
  let proxy: httpProxy | undefined;

  /**
   * Initialize proxy
   */
  const matchedProcessId = url.match(/\/([a-zA-Z0-9\-_]+)\/[a-zA-Z0-9\-_]+\?/);
  if (matchedProcessId && matchedProcessId[1]) {
    const processId = await redisGet(`${processIDKey}:${matchedProcessId[1]}`);
    if (processId) {
      proxy = processIds[processId]
    }
  }

  if (proxy) {
    console.debug("Room is at proxy", proxy);
    return proxy;

  } else {
    const processId = await getCurrentProxy();
    proxy = processIds[processId]
    console.debug("Using proxy", proxy, url);

    if (matchedProcessId && matchedProcessId[1]) {
      await redisSet(`${processIDKey}:${matchedProcessId[1]}`, processId)
    }

    return proxy;
  }
}

function register(node: Node) {
  // skip if already registered
  if (processIds[node.processId]) { return; }

  const [host, port] = node.address!.split(":");

  const proxy = httpProxy.createProxy({
    agent: http.globalAgent,
    target: { host, port },
    ws: true
  });

  proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
    /**
     * Prevent stale socket connections / memory-leaks
     */
    socket.on('timeout', () => {
      console.log("Socket timed out.");
      socket.end();
      socket.destroy();
    });
    socket.setTimeout(SOCKET_TIMEOUT);
  });

  proxy.on("error", (err, req, res) => {
    console.error(`Proxy error during: ${req.url}`);
    console.error(err.stack);

    console.warn(`node ${node.processId}/${node.address} failed, unregistering`);
    unregister(node);
    cleanUpNode(node).then(() => console.log(`cleaned up ${node.processId} presence`));

    reqHandler(req, res); // try again!
  });

  processIds[node.processId] = proxy;
}

function unregister(node: Node) {
  delete processIds[node.processId];
}

// listen for node additions and removals through Redis
listen((action: Action, node: Node) => {
  console.debug("LISTEN", action, node);
  if (action === 'add') {
    register(node);

  } else if (action == 'remove') {
    unregister(node);
  }
})

// query pre-existing nodes
getNodeList().
  then(nodes => nodes.forEach(node => register(node))).
  catch(err => console.error(err));

const reqHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  const proxy = await getProxy(req.url!);

  if (proxy) {
    proxy.web(req, res);

  } else {
    console.error("No proxy available!", processIds);
    res.statusCode = 503;
    res.end();
  }
};

const server = (process.env.SSL_KEY && process.env.SSL_CERT)
  // HTTPS
  ? https.createServer({
    key: fs.readFileSync(process.env.SSL_KEY, 'utf8'),
    cert: fs.readFileSync(process.env.SSL_CERT, 'utf8'),
  }, reqHandler)
  // HTTP
  : http.createServer(reqHandler);

server.on('error', (err) => {
  console.error(`Server error: ${err.stack}`);
});

server.on('upgrade', async (req, socket, head) => {
  const proxy = await getProxy(req.url!);

  if (proxy) {
    proxy.ws(req, socket, head);

  } else {
    console.error("No proxy available!", processIds);
  }
});

server.on('listening', () => console.debug("@colyseus/proxy listening at", JSON.stringify(server.address())));

/**
 * Create HTTP -> HTTPS redirection server.
 */
if (server instanceof https.Server) {
  server.listen(HTTPS_PORT, HTTP_IP);

  const httpServer = http.createServer((req, res) => {
    res.writeHead(301, { "Location": "https://" + req.headers['host']! + req.url });
    res.end();
  });
  httpServer.on('listening', () => console.debug("@colyseus/proxy http -> https listening at", 80));
  httpServer.listen(HTTP_PORT, HTTP_IP);

} else {
  server.listen(HTTP_PORT, HTTP_IP);
}
