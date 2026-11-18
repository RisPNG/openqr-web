export function websiteUrl(payload) {
  const input = payload.trim()
  const absolute = /^https?:\/\//i.test(input)
  const authority = input.replace(/^https?:\/\//i, "").split(/[/?#]/, 1)[0]
  if (!authority || /[\s\\\x00-\x1f\x7f]/.test(input) || (!absolute && authority.endsWith(":"))) return null

  try {
    const url = new URL(absolute ? input : `https://${input}`)
    if (url.username || url.password) return null
    if (!absolute && !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:[a-z]{2,}|xn--[a-z\d-]+)\.?$/i.test(url.hostname)) return null
    return url.href
  } catch {
    return null
  }
}
