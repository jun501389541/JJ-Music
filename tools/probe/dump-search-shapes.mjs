/** Dump the exact item shape of each reachable search endpoint. */
const TARGETS = [
  {
    name: 'kuwo-mobile',
    url: 'http://search.kuwo.cn/r.s?all=%E5%91%A8%E6%9D%B0%E4%BC%A6&ft=music&itemset=web_2013&client=kt&pn=0&rn=2&rformat=json&encoding=utf8'
  },
  {
    name: 'tencent',
    url: 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=2&w=%E5%91%A8%E6%9D%B0%E4%BC%A6&format=json&cr=1&new_json=1'
  },
  {
    name: 'netease',
    url: 'https://music.163.com/api/search/get/web?s=%E5%91%A8%E6%9D%B0%E4%BC%A6&type=1&offset=0&limit=2'
  }
]

/** kuwo returns pseudo-JSON with single quotes and unquoted keys. */
function repairKuwo(text) {
  // Replace single-quoted strings with double-quoted ones.
  let out = text.replace(/'/g, '"')
  // Quote bare keys.
  out = out.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
  return out
}

for (const { name, url } of TARGETS) {
  console.log(`\n${'='.repeat(70)}\n### ${name}\n${'='.repeat(70)}`)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Referer: 'https://y.qq.com/',
        Cookie: 'appver=8.9.1;'
      }
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      try {
        parsed = JSON.parse(repairKuwo(text))
      } catch (e) {
        console.log(`  !! JSON parse failed: ${e.message}`)
        console.log(text.slice(0, 400))
        continue
      }
    }

    const list =
      parsed?.abslist ??
      parsed?.data?.song?.list ??
      parsed?.result?.songs ??
      parsed?.data?.list ??
      null

    console.log(`  top keys: ${JSON.stringify(Object.keys(parsed).slice(0, 12))}`)
    if (Array.isArray(list)) {
      console.log(`  list length: ${list.length}`)
      console.log(`  first item keys:\n    ${JSON.stringify(Object.keys(list[0] ?? {}), null, 0)}`)
      console.log(`  first item:\n${JSON.stringify(list[0], null, 2).slice(0, 1800)}`)
    } else {
      console.log(`  !! no list found. shape:\n${JSON.stringify(parsed, null, 2).slice(0, 1200)}`)
    }
  } catch (error) {
    console.log(`  ERR ${error.message}`)
  }
}
