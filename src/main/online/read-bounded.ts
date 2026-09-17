/** Enforce limits while streaming, including bodies without Content-Length. */
export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if(!response.ok || Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error(response.ok?'响应超过大小限制':`HTTP ${response.status}`)}
  const reader=response.body?.getReader()
  if(!reader)throw Error('响应为空')
  const chunks:Uint8Array[]=[];let size=0
  try {
    while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw Error('响应超过大小限制');chunks.push(next.value)}
    return Buffer.concat(chunks)
  } finally {await reader.cancel().catch(()=>undefined)}
}
