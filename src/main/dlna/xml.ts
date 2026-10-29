import { SaxesParser } from 'saxes'

export interface XmlNode { name: string; namespace: string; text: string; children: XmlNode[] }
/** No DTDs, custom entities or external resolution; limits apply while parsing. */
export function parseXml(input: string | Buffer): XmlNode {
  if (Buffer.byteLength(input) > 512 * 1024) throw new Error('DLNA XML size limit')
  const xml = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('DLNA XML declarations refused')
  const stack: XmlNode[] = []
  let root: XmlNode | undefined, count = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw new Error('DLNA XML DTD refused') })
  parser.on('error', () => { throw new Error('Invalid DLNA XML') })
  parser.on('opentag', tag => {
    if (++count > 20000 || stack.length >= 64) throw new Error('DLNA XML complexity limit')
    const node: XmlNode = {name:tag.local, namespace:tag.uri, text:'', children:[]}
    if (stack.length) stack[stack.length - 1].children.push(node)
    else root = node
    stack.push(node)
  })
  const text = (value: string) => {
    if (++count > 20000) throw new Error('DLNA XML complexity limit')
    if (stack.length) stack[stack.length - 1].text += value
  }
  parser.on('comment', () => { if (++count > 20000) throw new Error('DLNA XML complexity limit') })
  parser.on('text', text); parser.on('cdata', text)
  parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
  if (!root) throw new Error('Empty DLNA XML')
  return root
}
export function child(node: XmlNode, name: string): XmlNode | undefined { return node.children.find(n => n.name === name) }
export function value(node: XmlNode, name: string): string { return child(node, name)?.text.trim() ?? '' }
export function escapeXml(value: string | number): string {
  const text = String(value)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Invalid XML text')
  return text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!))
}
