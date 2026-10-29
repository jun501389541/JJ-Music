import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
const { createLanHttpClient } = await import('./dlna/lan-http-client.js')

test('bounded device HTTP transport preserves errors and refuses redirects and oversized bodies', async () => {
  const server = createServer((req,res) => {
    if(req.url === '/redirect') {res.writeHead(302,{Location:'http://example.com'});res.end()}
    else if(req.url === '/large') res.end(Buffer.alloc(524289))
    else {res.writeHead(500);res.end('fault')}
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  // Test-only loopback policy; production must use createLanPolicy.
  const client = createLanHttpClient({url: value => new URL(`http://127.0.0.1:${server.address().port}${value}`)})
  try {
    const response = await client('/fault')
    assert.equal(response.status,500);assert.equal(response.body.toString(),'fault')
    await assert.rejects(client('/redirect'),/redirect refused/)
    await assert.rejects(client('/large'),/too large/)
    await assert.rejects(client('/fault',{signal:AbortSignal.abort()}))
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
