import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {createHash} from "node:crypto"

const compressorSource = await readFile(new URL("../vendor/ha-mr/compress.js", import.meta.url), "utf8")
const alphabetsSource = await readFile(new URL("../vendor/ha-mr/alphabets.js", import.meta.url), "utf8")
const compressorModule = `data:text/javascript;base64,${Buffer.from(compressorSource).toString("base64")}`
const alphabetsModule = `data:text/javascript;base64,${Buffer.from(alphabetsSource).toString("base64")}`
const source = (await readFile(new URL("../js/ha_mr_link.js", import.meta.url), "utf8"))
  .replace('"../vendor/ha-mr/compress.js"', JSON.stringify(compressorModule))
  .replace('"../vendor/ha-mr/alphabets.js"', JSON.stringify(alphabetsModule))
const HaMRLink = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default
const {compress, decompress} = await import(compressorModule)
const {outputAlphabetASCII} = await import(alphabetsModule)

class Element {
  constructor(values = {}) {
    Object.assign(this, {listeners: [], attributes: new Map(), dataset: {}, hidden: false, value: "", checked: false, classes: new Set()}, values)
    this.classList = {toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)}
  }
  addEventListener(type, callback, capture = false) { this.listeners.push({type, callback, capture}) }
  removeEventListener(type, callback, capture = false) { this.listeners = this.listeners.filter(item => !(item.type === type && item.callback === callback && item.capture === capture)) }
  setAttribute(name, value) { this.attributes.set(name, value) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  removeAttribute(name) { this.attributes.delete(name) }
  matches(selector) { return selector === 'input[type="checkbox"][name="qr[ha_mr]"]' && this.type === "checkbox" && this.name === "qr[ha_mr]" }
  dispatchEvent(event) {
    Object.defineProperty(event, "target", {value: this, configurable: true})
    const path = []
    for (let element = this; element; element = element.parent) path.push(element)
    for (const element of path.slice().reverse()) {
      for (const item of element.listeners.filter(item => item.type === event.type && item.capture)) item.callback(event)
    }
    for (const element of path) {
      for (const item of element.listeners.filter(item => item.type === event.type && !item.capture)) item.callback(event)
    }
    return !event.defaultPrevented
  }
}

function fixture(input = "https://openqr.my", enabled = false) {
  const window = new Element()
  const form = new Element({parent: window})
  const fields = {
    payload: new Element({parent: form, name: "qr[payload]", value: input}),
    unchecked: new Element({parent: form, type: "hidden", name: "qr[ha_mr]", value: "false"}),
    checkbox: new Element({parent: form, type: "checkbox", name: "qr[ha_mr]", checked: enabled}),
    derived: new Element({parent: form, name: "qr[ha_mr_url]", value: "stale compressed URL"}),
    output: new Element(),
    link: new Element(),
    status: new Element(),
  }
  form.querySelector = selector => ({
    '[name="qr[payload]"]': fields.payload,
    '[name="qr[ha_mr]"]': fields.unchecked,
    'input[type="checkbox"][name="qr[ha_mr]"]': fields.checkbox,
    '[name="qr[ha_mr_url]"]': fields.derived,
    "[data-ha-mr-output]": fields.output,
    "[data-ha-mr-result]": fields.link,
    "[data-ha-mr-status]": fields.status,
  })[selector]
  const hook = {...HaMRLink, el: form}
  hook.mounted()
  return {window, form, fields, hook}
}

test("vendored source and MIT license match the pinned upstream bytes", async () => {
  for (const [name, expected] of Object.entries({
    "compress.js": "9ab28d9fa0bf40425536d4bcc9826c92d8da6b78525bafb79259cc7cec8a006f",
    "alphabets.js": "c5dd0dee3b3d87c75ef780371d86df8229c2905d3e20f60bada225b0a644f3b0",
    "LICENSE": "eebfa35f45827f51435ff2af40ac079ada228291eda1d24a3e443b91432c56e5",
  })) {
    const bytes = await readFile(new URL(`../vendor/ha-mr/${name}`, import.meta.url))
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, name)
  }
})

test("official examples preserve the destination protocol and exact compressed tokens", () => {
  for (const [input, token, target] of [
    ["youtube.com", "CH", "http://youtube.com"],
    ["http://youtube.com", "CH", "http://youtube.com"],
    ["https://youtube.com", "SH", "https://youtube.com"],
    ["openqr.my", "vYfd[;no", "http://openqr.my"],
    ["https://openqr.my", ".uod[;no", "https://openqr.my"],
  ]) {
    assert.equal(compress(input, outputAlphabetASCII), token)
    assert.equal(decompress(token, outputAlphabetASCII), target)
  }
})

test("upstream URL normalization remains unchanged for paths, queries, and international domains", () => {
  for (const [input, target] of [
    ["HTTPS://EXAMPLE.COM:443/a/../B//C/?flag&x=1#Frag", "https://example.com/B/C/?flag=&x=1#Frag"],
    ["https://\u4f8b\u5b50.\u6d4b\u8bd5/a b", "https://xn--fsqu00a.xn--0zwm56d/a%20b"],
    ["https://example.com/a%2Fb?flag", "https://example.com/a%2fb?flag="],
  ]) {
    assert.equal(decompress(compress(input, outputAlphabetASCII), outputAlphabetASCII), target)
  }
})

test("unchecked compression preserves literal input and clears stale derived state", () => {
  const scope = fixture("  https://openqr.my\n")
  assert.equal(scope.fields.payload.value, "  https://openqr.my\n")
  assert.equal(scope.fields.derived.value, "")
  assert.equal(scope.fields.output.hidden, true)
  assert.equal(scope.fields.link.hidden, true)
  assert.equal(scope.fields.link.getAttribute("href"), null)
  scope.hook.destroyed()
})

test("capture handlers update the whole form before LiveView input, change, and submit serialization", () => {
  const scope = fixture()
  const serialized = []
  for (const type of ["input", "change", "submit"]) {
    scope.window.addEventListener(type, event => serialized.push({event: event.type, payload: scope.fields.payload.value, enabled: scope.fields.checkbox.checked, compressed: scope.fields.derived.value}))
  }
  scope.fields.checkbox.checked = true
  scope.fields.checkbox.dispatchEvent(new Event("input"))
  scope.fields.payload.value = "youtube.com"
  scope.fields.payload.dispatchEvent(new Event("input"))
  assert.equal(scope.fields.status.textContent, "Output is 28% smaller than the input")
  assert.equal(scope.fields.status.classes.has("text-success"), true)
  scope.fields.payload.value = "openqr.my"
  scope.fields.payload.dispatchEvent(new Event("change"))
  assert.equal(scope.fields.status.textContent, "Output is 55% larger than the input")
  assert.equal(scope.fields.status.classes.has("text-error"), true)
  scope.fields.payload.value = "https://youtube.com"
  scope.form.dispatchEvent(new Event("submit", {cancelable: true}))
  assert.deepEqual(serialized, [
    {event: "input", payload: "https://openqr.my", enabled: true, compressed: "https://ha.mr#.uod[;no"},
    {event: "input", payload: "youtube.com", enabled: true, compressed: "https://ha.mr#CH"},
    {event: "change", payload: "openqr.my", enabled: true, compressed: "https://ha.mr#vYfd[;no"},
    {event: "submit", payload: "https://youtube.com", enabled: true, compressed: "https://ha.mr#SH"},
  ])
  assert.equal(scope.fields.unchecked.value, "false")
  assert.equal(scope.fields.link.getAttribute("href"), "https://ha.mr#SH")
  scope.hook.destroyed()
})

test("same-length and much-larger statuses use the official symbol ratio", () => {
  const scope = fixture("https://example.com/a%2Fb?flag", true)
  assert.equal(scope.fields.status.textContent, "Output is the same length as the input")
  assert.equal(scope.fields.status.classes.has("text-subcontent"), true)
  scope.fields.payload.value = "i"
  scope.fields.payload.dispatchEvent(new Event("input"))
  assert.equal(scope.fields.status.textContent, "Output is much larger than the input")
  assert.equal(scope.fields.output.dataset.haMrState, "larger")
  scope.hook.destroyed()
})

test("invalid checked inputs clear the old URL without preventing form validation", () => {
  const scope = fixture("youtube.com", true)
  const serialized = []
  scope.window.addEventListener("input", () => serialized.push(scope.fields.derived.value))
  for (const input of ["ftp://example.com/a", "https://user:password@example.com", "http://", ""]) {
    scope.fields.payload.value = input
    const event = new Event("input", {cancelable: true})
    scope.fields.payload.dispatchEvent(event)
    assert.equal(event.defaultPrevented, false)
    assert.equal(scope.fields.derived.value, "")
    assert.equal(scope.fields.link.getAttribute("href"), null)
    assert.equal(scope.fields.link.hidden, true)
    assert.equal(scope.fields.output.hidden, true)
    assert.equal(scope.fields.output.dataset.haMrState, "invalid")
    assert.equal(scope.fields.status.classes.has("text-error"), true)
    assert.match(scope.fields.status.textContent, /Enter a (valid HTTP or HTTPS URL without credentials|URL to compress)\./)
  }
  assert.deepEqual(serialized, ["", "", "", ""])
  scope.hook.destroyed()
})

test("checkbox state survives replaced form controls and unchecking restores the literal path", () => {
  const scope = fixture("https://openqr.my", true)
  scope.fields.checkbox = new Element({parent: scope.form, type: "checkbox", name: "qr[ha_mr]", checked: false})
  scope.fields.derived = new Element({parent: scope.form, name: "qr[ha_mr_url]"})
  scope.hook.updated()
  assert.equal(scope.fields.checkbox.checked, true)
  assert.equal(scope.fields.derived.value, "https://ha.mr#.uod[;no")
  scope.fields.checkbox.checked = false
  scope.fields.checkbox.dispatchEvent(new Event("change"))
  assert.equal(scope.fields.derived.value, "")
  assert.equal(scope.fields.output.hidden, true)
  scope.fields.checkbox.checked = true
  scope.hook.updated()
  assert.equal(scope.fields.checkbox.checked, false)
  assert.equal(scope.fields.payload.value, "https://openqr.my")
  scope.hook.destroyed()
})

test("bare addresses with ports compress the same destination that was validated", () => {
  for (const input of ["example.com:8080/a", "localhost:3000", "ftp:21"]) {
    const scope = fixture(input, true)
    const token = scope.fields.derived.value.slice("https://ha.mr#".length)
    assert.equal(new URL(decompress(token, outputAlphabetASCII)).href, new URL("http://" + input).href)
    assert.equal(scope.fields.output.hidden, false)
    assert.equal(scope.fields.payload.value, input)
    scope.hook.destroyed()
  }
})

test("a protocol inside a bare address query is not mistaken for its scheme", () => {
  const input = "example.com/?redirect=https://example.org/"
  const scope = fixture(input, true)
  const token = scope.fields.derived.value.slice("https://ha.mr#".length)
  assert.equal(new URL(decompress(token, outputAlphabetASCII)).href, new URL("http://" + input).href)
  assert.equal(scope.fields.output.hidden, false)
  assert.equal(scope.fields.payload.value, input)
  scope.hook.destroyed()
})

test("validated root paths, trailing slashes, dot segments, and protocols survive compression", () => {
  for (const [input, target] of [
    ["example.com", "http://example.com/"],
    ["http://example.com/", "http://example.com/"],
    ["https://example.com/a/../b/", "https://example.com/b/"],
    ["https://example.com/a/./b?x=1", "https://example.com/a/b?x=1"],
    ["HTTP://EXAMPLE.COM:80/path", "http://example.com/path"],
    ["HTTPS://EXAMPLE.COM:443/", "https://example.com/"],
  ]) {
    const scope = fixture(input, true)
    const token = scope.fields.derived.value.slice("https://ha.mr#".length)
    const decoded = new URL(decompress(token, outputAlphabetASCII))
    assert.equal(decoded.href, target)
    assert.equal(decoded.protocol, new URL(target).protocol)
    assert.equal(scope.fields.payload.value, input)
    scope.hook.destroyed()
  }
})

test("compression performs no network requests and releases form listeners", t => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error("Compression must stay local") }
  t.after(() => { globalThis.fetch = originalFetch })
  const scope = fixture("https://youtube.com", true)
  assert.equal(scope.fields.derived.value, "https://ha.mr#SH")
  assert.equal(scope.form.listeners.length, 3)
  scope.hook.destroyed()
  assert.equal(scope.form.listeners.length, 0)
})
