/**
 * A synthetic 音源 script used to verify a build can actually run sources.
 *
 * It exists so the check needs no private scripts: a packaged build can be
 * proven able to boot the forked host, satisfy the pre-flight validator,
 * advertise platforms and resolve a URL, without depending on anyone's imported
 * aggregator.
 *
 * The `marker` request is the point of the whole thing. Returning a fixed URL
 * would only prove the child process started; making it fetch first also
 * exercises `lx.request`, the Buffer semantics the LX API requires, and the
 * child's own network path -- which is the machinery that silently disappears
 * when the packaged host is not unpacked from the asar correctly.
 */
export const SYNTHETIC_SOURCE_NAME = '打包自检音源'

/**
 * The playback address the synthetic source hands back, minus the quality tier.
 *
 * Nobody fetches it. The request that proves the packaged host works is the
 * marker fetch inside the child, on loopback, which the harness watches.
 *
 * This one has to *look* public because main treats a script-supplied playback
 * address as attacker-chosen: a source could otherwise point the app at its own
 * localhost services or the cloud metadata address, so `isValidMusicUrl` refuses
 * loopback, private and link-local targets. Making the self-check hand back a
 * loopback URL would be asserting that the guard stays open.
 */
export const SYNTHETIC_PLAY_URL = 'https://jj-music-probe.invalid/probe-'

/** @param {Record<string, string>} markers URLs the harness serves and watches */
export function syntheticSource(baseUrl, markers = {}) {
  const sourceTable = Object.fromEntries(
    ['kw', 'kg', 'tx', 'wy', 'mg'].map((id) => [id, {
      name: id,
      type: 'music',
      actions: ['musicUrl'],
      // The full allow-listed set, so the quality ladder has something to walk.
      qualitys: ['128k', '320k', 'flac', 'flac24bit']
    }])
  )

  return `/*!
 * @name ${SYNTHETIC_SOURCE_NAME}
 * @description self-check source: fetches a marker, then resolves a URL
 * @version 1.0.0
 * @author jj-music packaged build check
 */
const { EVENT_NAMES, on, send, request } = globalThis.lx
const BASE = ${JSON.stringify(baseUrl)}
const MARKERS = ${JSON.stringify(markers)}

on(EVENT_NAMES.request, ({ source, action, info }) => {
  if (action !== 'musicUrl') return Promise.reject(new Error('自检音源只实现 musicUrl'))
  const marker = MARKERS[source] || MARKERS.default
  // The three-argument callback form, which is what the LX contract specifies
  // and what real scripts use. The documented "callable and thenable" return
  // from lx.request does not actually behave as a promise today, so chaining
  // then() here would be testing the wrong thing -- see the note in
  // tools/probe/clean-profile-sources.mjs.
  return new Promise((resolve, reject) => {
    request(BASE + '/marker/' + marker, { method: 'get' }, (error, response, body) => {
      if (error) return reject(error)
      const size = body ? Number(body.length) : 0
      // LX spells the status code as statusCode; checking the wrong field turns
      // a working host into a false failure.
      const code = response ? Number(response.statusCode) : 0
      // A zero-length body means the host's request plumbing did not really
      // deliver bytes, which is the failure this check exists to catch.
      if (!response || code !== 200 || size <= 0) {
        return reject(new Error('lx.request 未能取回标记内容 (statusCode=' + code + ' size=' + size + ')'))
      }
      resolve(${JSON.stringify(SYNTHETIC_PLAY_URL)} + info.type + '.mp3')
    })
  })
})

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: ${JSON.stringify(sourceTable)}
})
`
}
