import test from "node:test"
import assert from "node:assert/strict"
import {createHash, webcrypto} from "node:crypto"
import {readFile} from "node:fs/promises"
import {gzipSync} from "node:zlib"
import vm from "node:vm"

const source = await readFile(new URL("../js/qr_showcase.js", import.meta.url), "utf8")
const initialStyles = {body: "square", frame: "follow-body", ball: "follow-body"}
const fields = {body: "body_shape", frame: "eye_frame", ball: "eye_ball"}
const choices = {body: ["square", "circle"], frame: ["follow-body", "square", "circle"], ball: ["follow-body", "square", "circle"]}
const squareGray = [255, 11, 12, 255, 21, 22, 23, 24, 31, 32, 33, 34, 255, 41, 42, 255]
const expectedGray = [5, 11, 12, 63, 21, 22, 23, 24, 31, 32, 33, 34, 127, 41, 42, 219]

function encodeShard(header, pixels) {
  const json = Buffer.from(JSON.stringify(header))
  const prefix = Buffer.alloc(8)
  prefix.write("OQR1")
  prefix.writeUInt32LE(json.length, 4)
  return Buffer.concat([prefix, json, pixels])
}

function catalogFixture(options = {}) {
  const bodies = options.bodies || choices.body
  const allPairs = choices.frame.flatMap(frame => choices.ball.map(ball => [frame, ball]))
  const shards = bodies.map((body, bodyIndex) => {
    const base = bodyIndex * 6
    const gray = squareGray.map(value => value === 255 ? value : value + bodyIndex * 10)
    const even = [...gray]
    even[5] = 99 + bodyIndex * 10
    const pixels = Buffer.from([...gray, ...even, 5, 63, 127, 219])
    const planes = [
      {id: base, width: 4, height: 4, offset: 0, length: 16},
      {id: base + 1, width: 4, height: 4, offset: 16, length: 16},
      ...Array.from({length: 4}, (_, index) => ({id: base + index + 2, width: 1, height: 1, offset: 32 + index, length: 1})),
    ]
    const pairs = (options.pairs?.[body] || allPairs).toSorted((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]))
    const combinations = allPairs.map(([frame, ball]) => {
      const reliable = pairs.some(pair => pair[0] === frame && pair[1] === ball)
      const accepted = reliable ? 40 : options.partial?.[body] ?? 0
      return {frame, ball, reliable, versions: Array.from({length: 40}, (_, index) => index < accepted ? [base + index % 2, base + 2, base + 3, base + 4, base + 5] : null)}
    })
    const windows = [[0, 0, 1, 1], [3, 0, 1, 1], [0, 3, 1, 1], [3, 3, 1, 1]]
    const header = {body, planes, windows: {[base]: windows, [base + 1]: windows}, combinations}
    const raw = encodeShard(header, pixels)
    const compressed = gzipSync(raw)
    const sha256 = createHash("sha256").update(compressed).digest("hex")
    const descriptor = {name: `${sha256}.bin`, sha256, raw_sha256: createHash("sha256").update(raw).digest("hex"), bytes: compressed.length, raw_bytes: raw.length}
    const available = combinations.reduce((count, combination) => count + combination.versions.filter(Boolean).length, 0)
    const skipped = combinations.length * 40 - available
    return {header, pixels, raw, descriptor, body: {id: body, available, skipped, retired: skipped > available || pairs.length === 0, reliable_combinations: pairs.length, pairs}}
  })
  const catalog = {schema: 1, complete: true, payload: "https://openqr.my", combinations: bodies.length * allPairs.length, shards: shards.map(shard => shard.descriptor), bodies: shards.map(shard => shard.body)}
  catalog.id = createHash("sha256").update(JSON.stringify(catalog)).digest("hex")
  return {
    catalog, shards,
    repack(index) {
      const shard = shards[index]
      shard.raw = encodeShard(shard.header, shard.pixels)
      shard.descriptor.raw_bytes = shard.raw.length
      shard.descriptor.raw_sha256 = createHash("sha256").update(shard.raw).digest("hex")
    },
  }
}

class BrowserEvent {
  constructor(type, options = {}) { Object.assign(this, {type, bubbles: options.bubbles ?? true, defaultPrevented: false, stopped: false, immediate: false, detail: options.detail}) }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.stopped = true }
  stopImmediatePropagation() { this.stopped = this.immediate = true }
}

class Element {
  constructor(tagName = "div", dataset = {}, mutation = () => {}) {
    Object.assign(this, {tagName, dataset, parentElement: null, children: [], attributes: new Map(), listeners: new Map(), hidden: false, textContent: "", value: "", _disabled: false, checked: false, mutation})
    const classes = new Set()
    this.classList = {contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)}
  }
  get disabled() { return this._disabled }
  set disabled(value) {
    if (this._disabled === Boolean(value)) return
    this._disabled = Boolean(value)
    if (value) this.attributes.set("disabled", "")
    else this.attributes.delete("disabled")
    this.mutation(this, "disabled")
  }
  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1)
    const tag = selector.match(/^[a-z]+/)?.[0]
    if (tag && tag !== this.tagName) return false
    if (selector.endsWith(":checked") && !this.checked) return false
    for (const match of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
      const [_, name, expected] = match
      const key = name.startsWith("data-") ? name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) : null
      const actual = key ? this.dataset[key] : this[name] ?? this.getAttribute(name)
      if (expected === undefined ? actual == null || actual === false : String(actual) !== expected) return false
    }
    return true
  }
  closest(selector) { for (let element = this; element; element = element.parentElement) if (element.matches(selector)) return element; return null }
  contains(other) { for (let element = other; element; element = element.parentElement) if (element === this) return true; return false }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
    if (name === "disabled") this.disabled = true
    if (name === "checked") { this.checked = true; this.mutation(this, name) }
    if (name === "hidden") this.hidden = true
  }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  removeAttribute(name) {
    this.attributes.delete(name)
    if (name === "disabled") this.disabled = false
    if (name === "checked") { this.checked = false; this.mutation(this, name) }
    if (name === "hidden") this.hidden = false
  }
  appendChild(child) { this.children.push(child); child.parentElement = this; this.mutation(child, "childList"); return child }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child) }
  addEventListener(name, callback, capture = false) { this.listeners.set(name, [...(this.listeners.get(name) || []), {callback, capture: Boolean(capture)}]) }
  removeEventListener(name, callback, capture = false) { this.listeners.set(name, (this.listeners.get(name) || []).filter(listener => listener.callback !== callback || listener.capture !== Boolean(capture))) }
  dispatchEvent(event) {
    event.target = this
    const path = []
    for (let element = this; element; element = element.parentElement) path.push(element)
    for (const [elements, capture] of [[path.toReversed(), true], [event.bubbles ? path : [this], false]]) {
      for (const element of elements) {
        for (const listener of element.listeners.get(event.type) || []) {
          if (listener.capture === capture) listener.callback(event)
          if (event.immediate) break
        }
        if (event.stopped) return !event.defaultPrevented
      }
    }
    return !event.defaultPrevented
  }
  emit(type, target = this) { const event = new BrowserEvent(type); target.dispatchEvent(event); return event }
  set innerHTML(_value) { assert.fail("Preview messages must be rendered as text") }
}

class Canvas extends Element {
  constructor(mutation) { super("canvas", {showcaseCanvas: ""}, mutation); this.pixels = []; this.draws = 0; this._width = this._height = 0 }
  get width() { return this._width }
  set width(value) { this._width = value; this.pixels = [] }
  get height() { return this._height }
  set height(value) { this._height = value; this.pixels = [] }
  getContext(type) {
    assert.equal(type, "2d")
    return {putImageData: (image, x, y) => {
      assert.equal(x, 0)
      assert.equal(y, 0)
      assert.equal(image.width, this.width)
      assert.equal(image.height, this.height)
      this.pixels = Array.from(image.data)
      this.draws++
    }}
  }
}

async function settle() { await new Promise(setImmediate); await new Promise(setImmediate) }

async function until(condition, message = "Expected asynchronous catalog update") {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) { if (condition()) return; await settle() }
  assert.fail(message)
}

async function withShowcase(options, run) {
  const pack = options.pack || catalogFixture()
  const observers = []
  const mutation = (target, attributeName) => {
    for (const observer of observers) {
      if (!observer.target?.contains(target) || attributeName !== "childList" && !observer.options.attributeFilter.includes(attributeName)) continue
      observer.records.push({target, attributeName})
      if (observer.queued) continue
      observer.queued = true
      queueMicrotask(() => {
        observer.queued = false
        const records = observer.takeRecords()
        if (observer.target && records.length) observer.callback(records)
      })
    }
  }
  const element = (tag, dataset = {}) => new Element(tag, dataset, mutation)
  const document = element("document")
  document.createElement = element
  const form = document.appendChild(element("form"))
  form.id = "qr-options"
  const design = form.appendChild(element("div", {reliability: JSON.stringify(options.initialBodies || pack.catalog.bodies)}))
  design.id = "qr-design-options"
  const styles = options.styles || initialStyles
  const radios = []
  const groups = {}
  for (const [axis, values] of Object.entries({...choices, body: pack.catalog.bodies.map(body => body.id)})) {
    const group = design.appendChild(element("fieldset"))
    group.disabled = true
    groups[axis] = group
    for (const value of values) {
      const label = group.appendChild(element("label"))
      const radio = label.appendChild(element("input"))
      Object.assign(radio, {type: "radio", name: `qr[${fields[axis]}]`, value, checked: value === styles[axis]})
      radios.push(radio)
    }
  }
  const modes = ["mosaic", "picture"].map(value => Object.assign(form.appendChild(element("input")), {type: "radio", name: "qr[mode]", value, checked: value === "mosaic"}))
  const root = document.appendChild(element("div", {...styles, baseUrl: "/qr-defaults/test", selectedVersion: ""}))
  root.id = "qr-showcase"
  const elements = Object.fromEntries(["status", "retry", "skipped", "skip-summary", "skip-list"].map(name => [name, root.appendChild(element(name === "retry" ? "button" : "div", {[`showcase${name.replace(/(^|-)([a-z])/g, (_, _prefix, letter) => letter.toUpperCase())}`]: ""}))]))
  const buttons = []
  for (let version = 1; version <= 40; version++) {
    const button = root.appendChild(element("button", {showcaseVersion: String(version)}))
    button.appendChild(new Canvas(mutation))
    button.appendChild(element("span", {showcaseUnavailable: ""}))
    buttons.push(button)
  }
  const requests = []
  const digests = []
  let holdDigests = Boolean(options.holdDigests)
  const context = vm.createContext({
    document, AbortController, DOMException, TextEncoder, TextDecoder, Event: BrowserEvent, CustomEvent: BrowserEvent,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; observers.push(this) }
      observe(target, options) { this.target = target; this.options = options }
      takeRecords() { return this.records.splice(0) }
      disconnect() { this.target = null; this.records = [] }
    },
    ImageData: class { constructor(width, height) { Object.assign(this, {width, height, data: new Uint8ClampedArray(width * height * 4)}) } },
    crypto: {subtle: {digest: (algorithm, bytes) => {
      const result = webcrypto.subtle.digest(algorithm, bytes)
      if (!holdDigests) return result
      const pending = Promise.withResolvers()
      digests.push({resolve: async () => pending.resolve(await result)})
      return pending.promise
    }}},
    fetch: (url, config) => {
      const pending = Promise.withResolvers()
      const request = {url, config, ...pending, settled: false, aborted: false}
      requests.push(request)
      config.signal.addEventListener("abort", () => {
        request.aborted = true
        if (!options.ignoreAbort && !request.settled) pending.reject(new DOMException("Request canceled", "AbortError"))
      })
      if (options.auto !== false) queueMicrotask(() => fixture.respond(request))
      return pending.promise
    },
  })
  vm.runInContext(source.replace(/export default QRShowcase\s*;?/, "globalThis.QRShowcase = QRShowcase\n").replace(/export (const|let) QRDesign/, "$1 QRDesign").replace(/export\s*\{\s*QRDesign\s*\}\s*;?/, "") + "\nif (typeof QRDesign !== 'undefined') globalThis.QRDesign = QRDesign", context)
  assert.ok(context.QRDesign, "The persistent design hook must own reliability filtering and control gating")
  const pushed = []
  const hook = {...context.QRShowcase, el: root, pushEvent(event, payload) { pushed.push({event, payload: {...payload}}) }}
  const designHook = {...context.QRDesign, el: design}
  const fixture = {
    pack, hook, designHook, document, form, design, root, elements, radios, groups, buttons, requests, observers, digests, pushed,
    radio(axis, value) { return radios.find(input => input.name === `qr[${fields[axis]}]` && input.value === value) },
    selected() { return Object.fromEntries(Object.entries(fields).map(([axis, field]) => [axis, radios.find(input => input.name === `qr[${field}]` && input.checked)?.value])) },
    visible(input) { for (let current = input; current; current = current.parentElement) if (current.hidden || current.classList.contains("hidden")) return false; return true },
    disabled(input) { return input.disabled || Boolean(input.closest("fieldset")?.disabled) },
    change(axis, value) {
      const input = this.radio(axis, value)
      assert.ok(input, `Missing ${axis} choice ${value}`)
      assert.equal(this.disabled(input), false, `The ${axis} choice ${value} must be enabled`)
      for (const radio of radios.filter(radio => radio.name === input.name)) radio.checked = radio === input
      return document.emit("change", input)
    },
    mode(value) { for (const input of modes) input.checked = input.value === value; document.emit("change", modes.find(input => input.checked)) },
    respond(request, response) {
      if (request.settled) return
      request.settled = true
      if (response) { request.resolve(response); return }
      if (options.failure?.(request.url)) { request.resolve(new Response("Unavailable", {status: 404})); return }
      if (request.url.endsWith("catalog.json")) request.resolve(new Response(JSON.stringify(pack.catalog)))
      else {
        const shard = pack.shards.find(shard => request.url.endsWith(`/${shard.descriptor.name}`))
        request.resolve(shard ? new Response(shard.raw) : new Response("Not found", {status: 404}))
      }
    },
    async ready() { await until(() => hook.ready || !elements.retry.hidden, elements.status.textContent); assert.equal(hook.ready, true, elements.status.textContent) },
    removeShowcase() { root.remove(); if (!hook.disposed) hook.destroyed() },
    releaseDigests() { holdDigests = false; return Promise.all(digests.splice(0).map(digest => digest.resolve())) },
  }
  try { designHook.mounted(); hook.mounted(); await run(fixture) }
  finally { fixture.removeShowcase(); designHook.destroyed(); await fixture.releaseDigests(); await settle() }
}

test("all shards must load and pass integrity checks before any shape or version can be used", async () => {
  await withShowcase({auto: false}, async fixture => {
    const {hook, radios, buttons, requests, root, elements} = fixture
    assert.equal(requests.length, 1)
    assert.equal(requests[0].config.cache, "no-cache")
    assert.ok(radios.every(input => fixture.disabled(input)))
    assert.ok(buttons.every(button => button.disabled))
    assert.equal(root.emit("click", buttons[0]).stopped, true)
    fixture.respond(requests[0])
    await until(() => requests.length === 3)
    assert.ok(requests.slice(1).every(request => request.config.cache === "force-cache"))
    fixture.respond(requests[1])
    await until(() => hook.planes.size > 0)
    assert.equal(hook.ready, false)
    assert.ok(radios.every(input => fixture.disabled(input)))
    assert.ok(buttons.every(button => button.disabled))
    assert.equal(elements.status.hidden, false)
    fixture.respond(requests[2])
    await fixture.ready()
    assert.ok(radios.every(input => !fixture.disabled(input)))
    assert.ok(buttons.every(button => !button.disabled))
    assert.equal(elements.status.dataset.ready, "true")
    assert.equal(root.getAttribute("aria-busy"), "false")
  })
})

test("known grayscale samples compose into exact opaque RGBA for every current preview", async () => {
  await withShowcase({}, async fixture => {
    await fixture.ready()
    for (const [index, button] of fixture.buttons.entries()) {
      const expected = [...expectedGray]
      if (index % 2) expected[5] = 99
      const canvas = button.querySelector("[data-showcase-canvas]")
      assert.equal(canvas.width, 4)
      assert.equal(canvas.height, 4)
      assert.deepEqual(canvas.pixels, expected.flatMap(value => [value, value, value, 255]))
      assert.equal(canvas.hidden, false)
      assert.equal(button.querySelector("[data-showcase-unavailable]").hidden, true)
    }
  })
})

test("the first choice of any preloaded design and later choices make zero additional requests", async () => {
  await withShowcase({}, async fixture => {
    await fixture.ready()
    const count = fixture.requests.length
    const event = fixture.change("body", "circle")
    assert.equal(event.defaultPrevented, false)
    assert.equal(event.stopped, false)
    assert.equal(fixture.hook.current.body, "circle")
    const expected = expectedGray.map((value, index) => [0, 3, 12, 15].includes(index) ? value : value + 10)
    assert.deepEqual(fixture.buttons[0].querySelector("[data-showcase-canvas]").pixels, expected.flatMap(value => [value, value, value, 255]))
    for (const [axis, values] of Object.entries(choices)) for (const value of values) fixture.change(axis, value)
    await settle()
    assert.equal(fixture.requests.length, count)
  })
})

test("draft text and checkbox edits leave the showcase unchanged while picture mode disables shape controls", async () => {
  await withShowcase({}, async fixture => {
    await fixture.ready()
    const canvas = fixture.buttons[0].querySelector("[data-showcase-canvas]")
    const before = [...canvas.pixels]
    const count = fixture.requests.length
    for (const [tag, name] of [["textarea", "payload"], ["input", "vary_url"], ["input", "auto_brand"], ["input", "ha_mr"]]) {
      const input = fixture.form.appendChild(new Element(tag))
      Object.assign(input, {name: `qr[${name}]`, checked: true, value: "https://example.com"})
      assert.equal(fixture.document.emit("change", input).defaultPrevented, false)
    }
    fixture.mode("picture")
    assert.ok(fixture.radios.every(input => fixture.disabled(input)))
    fixture.mode("mosaic")
    assert.ok(fixture.radios.every(input => !fixture.disabled(input)))
    assert.deepEqual(canvas.pixels, before)
    assert.equal(fixture.requests.length, count)
  })
})

test("rapid shape changes and inspection carry one matching design before the original change bubbles", async () => {
  await withShowcase({}, async fixture => {
    await fixture.ready()
    const submitted = []
    fixture.form.addEventListener("change", () => submitted.push(fixture.selected()))
    fixture.change("body", "circle")
    fixture.change("frame", "square")
    fixture.change("ball", "circle")
    const expected = {body: "circle", frame: "square", ball: "circle"}
    assert.deepEqual(submitted.at(-1), expected)
    const button = fixture.buttons[0]
    button.setAttribute("phx-value-body", "stale")
    const event = fixture.root.emit("click", button.querySelector("[data-showcase-canvas]"))
    assert.equal(event.stopped, false)
    for (const [field, value] of Object.entries(expected)) assert.equal(button.getAttribute(`phx-value-${field}`), value)
    fixture.root.dataset.selectedVersion = "2"
    fixture.hook.updated()
    assert.equal(fixture.buttons[0].getAttribute("aria-pressed"), "false")
    assert.equal(fixture.buttons[1].getAttribute("aria-pressed"), "true")
  })
})

test("only complete reliable pairs are visible and body changes preserve frame before ball", async () => {
  const pack = catalogFixture({bodies: ["square", "circle", "rounded", "retired", "partial"], pairs: {square: [["follow-body", "follow-body"], ["square", "follow-body"], ["circle", "circle"]], circle: [["square", "square"], ["circle", "follow-body"]], rounded: [["circle", "circle"]], retired: [["follow-body", "follow-body"]], partial: []}, partial: {square: 39, circle: 39, rounded: 39, retired: 0, partial: 39}})
  await withShowcase({pack}, async fixture => {
    await fixture.ready()
    assert.equal(fixture.visible(fixture.radio("body", "retired")), false)
    assert.equal(fixture.visible(fixture.radio("body", "partial")), false)
    assert.equal(fixture.visible(fixture.radio("ball", "circle")), false)
    const submitted = []
    fixture.form.addEventListener("change", () => submitted.push(fixture.selected()))
    fixture.change("frame", "square")
    fixture.change("body", "circle")
    assert.deepEqual(fixture.selected(), {body: "circle", frame: "square", ball: "square"})
    assert.deepEqual(submitted.at(-1), fixture.selected())
    assert.equal(fixture.visible(fixture.radio("frame", "follow-body")), false)
    assert.equal(fixture.visible(fixture.radio("ball", "follow-body")), false)
    assert.equal(fixture.visible(fixture.radio("ball", "square")), true)
    fixture.change("frame", "circle")
    assert.deepEqual(fixture.selected(), {body: "circle", frame: "circle", ball: "follow-body"})
    fixture.change("body", "rounded")
    assert.deepEqual(fixture.selected(), {body: "rounded", frame: "circle", ball: "circle"})
    assert.ok(fixture.buttons.every(button => !button.disabled))
    assert.equal(fixture.elements.skipped.hidden, true)
  })
})

test("changing body keeps the exact pair or the current ball when its frame is unavailable", async () => {
  const pack = catalogFixture({pairs: {square: [["follow-body", "follow-body"], ["square", "square"]], circle: [["square", "square"], ["circle", "follow-body"]]}, partial: {square: 39, circle: 39}})
  await withShowcase({pack}, async fixture => {
    await fixture.ready()
    fixture.change("body", "circle")
    assert.deepEqual(fixture.selected(), {body: "circle", frame: "circle", ball: "follow-body"})
    fixture.change("frame", "square")
    fixture.change("body", "square")
    assert.deepEqual(fixture.selected(), {body: "square", frame: "square", ball: "square"})
  })
})

test("changing body selects the first lexical reliable pair when neither current eye choice fits", async () => {
  const pack = catalogFixture({pairs: {circle: [["square", "square"], ["circle", "circle"]]}, partial: {circle: 39}})
  await withShowcase({pack}, async fixture => {
    await fixture.ready()
    fixture.change("body", "circle")
    assert.deepEqual(fixture.selected(), {body: "circle", frame: "circle", ball: "circle"})
    assert.ok(fixture.buttons.every(button => !button.disabled))
  })
})

test("a shard can reference shared planes in another shard that finishes later", async () => {
  const pack = catalogFixture()
  const shared = pack.shards[1]
  shared.header.planes = []
  shared.header.windows = {}
  shared.pixels = Buffer.alloc(0)
  for (const combination of shared.header.combinations) {
    combination.versions = combination.versions.map((_, index) => [index % 2, 2, 3, 4, 5])
  }
  pack.repack(1)
  await withShowcase({pack, auto: false}, async fixture => {
    fixture.respond(fixture.requests[0])
    await until(() => fixture.requests.length === 3)
    fixture.respond(fixture.requests[2])
    await until(() => fixture.hook.batches.size > 0)
    assert.equal(fixture.hook.ready, false)
    fixture.respond(fixture.requests[1])
    await fixture.ready()
    fixture.change("body", "circle")
    assert.deepEqual(fixture.buttons[0].querySelector("[data-showcase-canvas]").pixels, expectedGray.flatMap(value => [value, value, value, 255]))
  })
})

test("LiveView disabled patches and newly inserted shape controls cannot bypass the loading gate", async () => {
  await withShowcase({auto: false}, async fixture => {
    const input = fixture.radio("body", "circle")
    input.disabled = false
    await settle()
    assert.equal(fixture.disabled(input), true)
    const added = new Element("input", {}, input.mutation)
    Object.assign(added, {type: "radio", name: "qr[body_shape]", value: "new-shape"})
    const label = input.closest("fieldset").appendChild(new Element("label", {}, input.mutation))
    label.appendChild(added)
    await settle()
    assert.equal(fixture.disabled(added), true)
    fixture.mode("picture")
    fixture.mode("mosaic")
    assert.ok(fixture.radios.every(radio => fixture.disabled(radio)))
  })
})

test("LiveView root attribute patches preserve readiness owned by the ignored status element", async () => {
  await withShowcase({}, async fixture => {
    await fixture.ready()
    const serverFields = new Set(["body", "frame", "ball", "baseUrl", "selectedVersion"])
    for (const key of Object.keys(fixture.root.dataset)) if (!serverFields.has(key)) delete fixture.root.dataset[key]
    const input = fixture.radio("body", "circle")
    input.disabled = true
    await settle()
    assert.equal(fixture.elements.status.dataset.ready, "true")
    assert.ok(fixture.radios.every(radio => !fixture.disabled(radio)))
    const count = fixture.requests.length
    fixture.change("body", "circle")
    assert.equal(fixture.hook.current.body, "circle")
    assert.ok(fixture.buttons.every(button => !button.disabled))
    assert.equal(fixture.requests.length, count)
  })
})

test("native fieldset disabling follows preload readiness, LiveView patches, and mode after gallery removal", async () => {
  await withShowcase({auto: false}, async fixture => {
    const groups = Object.values(fixture.groups)
    assert.equal(groups.length, Object.keys(fields).length)
    assert.ok(groups.every(group => group.disabled))
    assert.ok(fixture.radios.every(input => fixture.disabled(input)))
    fixture.respond(fixture.requests[0])
    await until(() => fixture.requests.length === 3)
    fixture.respond(fixture.requests[1])
    await until(() => fixture.hook.planes.size > 0)
    assert.ok(groups.every(group => group.disabled))
    fixture.respond(fixture.requests[2])
    await fixture.ready()
    assert.ok(groups.every(group => !group.disabled))
    assert.ok(fixture.radios.every(input => !fixture.disabled(input)))
    for (const group of groups) group.disabled = true
    await settle()
    assert.ok(groups.every(group => !group.disabled))
    fixture.change("body", "circle")
    assert.equal(fixture.hook.current.body, "circle")
    fixture.mode("picture")
    assert.ok(groups.every(group => group.disabled))
    assert.ok(fixture.radios.every(input => fixture.disabled(input)))
    fixture.removeShowcase()
    await settle()
    assert.ok(groups.every(group => group.disabled))
    fixture.mode("mosaic")
    assert.ok(groups.every(group => !group.disabled))
    assert.ok(fixture.radios.every(input => !fixture.disabled(input)))
    for (const group of groups) group.disabled = true
    await settle()
    assert.ok(groups.every(group => !group.disabled))
  })
})

test("missing, corrupt, incomplete, and invalid catalog data keep controls gated and offer retry", async t => {
  const failures = [
    ["missing catalog", pack => {}, url => url.endsWith("catalog.json")],
    ["missing shard", pack => {}, url => url.endsWith(".bin")],
    ["unfinished publication", pack => { pack.catalog.complete = false }],
    ["wrong payload", pack => { pack.catalog.payload = "https://example.com" }],
    ["incomplete catalog", pack => { pack.catalog.combinations++ }],
    ["truncated shard", pack => { pack.shards[0].raw = pack.shards[0].raw.subarray(0, -1) }],
    ["hash mismatch", pack => { pack.shards[0].raw = Buffer.from(pack.shards[0].raw); pack.shards[0].raw[pack.shards[0].raw.length - 1] ^= 1 }],
    ["invalid signature", pack => { pack.shards[0].raw.write("BAD1"); pack.shards[0].descriptor.raw_sha256 = createHash("sha256").update(pack.shards[0].raw).digest("hex") }],
    ["missing referenced plane", pack => { pack.shards[0].header.planes[0].id = 900; pack.repack(0) }],
    ["invalid patch dimensions", pack => { pack.shards[0].header.windows[0][0] = [0, 0, 2, 1]; pack.repack(0) }],
  ]
  for (const [name, change, failure] of failures) {
    await t.test(name, async () => {
      const pack = catalogFixture()
      change(pack)
      await withShowcase({pack, failure}, async fixture => {
        await until(() => fixture.elements.retry.hidden === false)
        await settle()
        assert.equal(fixture.hook.ready, false)
        assert.ok(fixture.radios.every(input => fixture.disabled(input)))
        assert.ok(fixture.buttons.every(button => button.disabled))
        assert.equal(fixture.hook.planes.size, 0)
        assert.equal(fixture.hook.batches.size, 0)
        assert.equal(fixture.pushed.length, 0)
        assert.equal(fixture.elements.status.hidden, false)
        assert.equal(fixture.root.emit("click", fixture.buttons[0]).stopped, true)
      })
    })
  }
})

test("retry replaces a failed load and enables the catalog only after the replacement is complete", async () => {
  await withShowcase({auto: false}, async fixture => {
    fixture.respond(fixture.requests[0], new Response("Unavailable", {status: 503}))
    await until(() => !fixture.elements.retry.hidden)
    assert.equal(fixture.pushed.length, 0)
    fixture.elements.retry.emit("click")
    assert.equal(fixture.requests.length, 2)
    assert.equal(fixture.requests[0].aborted, true)
    assert.ok(fixture.radios.every(input => fixture.disabled(input)))
    fixture.respond(fixture.requests[1])
    await until(() => fixture.requests.length === 4)
    for (const request of fixture.requests.slice(2)) fixture.respond(request)
    await fixture.ready()
    assert.equal(fixture.elements.retry.hidden, true)
    assert.ok(fixture.radios.every(input => !fixture.disabled(input)))
    assert.deepEqual(fixture.pushed, [{event: "showcase-ready", payload: {catalog_id: fixture.pack.catalog.id}}])
  })
})

test("late responses from an aborted earlier catalog cannot replace the successful retry", async () => {
  await withShowcase({auto: false, ignoreAbort: true}, async fixture => {
    fixture.hook.loadCatalog()
    fixture.respond(fixture.requests[1])
    await until(() => fixture.requests.length === 4)
    for (const request of fixture.requests.slice(2)) fixture.respond(request)
    await fixture.ready()
    const before = [...fixture.buttons[0].querySelector("[data-showcase-canvas]").pixels]
    fixture.respond(fixture.requests[0], new Response(JSON.stringify({...fixture.pack.catalog, complete: false})))
    await settle()
    assert.equal(fixture.hook.ready, true)
    assert.equal(fixture.elements.retry.hidden, true)
    assert.deepEqual(fixture.buttons[0].querySelector("[data-showcase-canvas]").pixels, before)
    assert.equal(fixture.requests.length, 4)
  })
})

test("teardown aborts pending downloads and releases gray planes and canvas surfaces", async () => {
  await withShowcase({auto: false}, async fixture => {
    fixture.respond(fixture.requests[0])
    await until(() => fixture.requests.length === 3)
    fixture.respond(fixture.requests[1])
    await until(() => fixture.hook.planes.size > 0)
    fixture.removeShowcase()
    assert.equal(fixture.requests[2].aborted, true)
    assert.equal(fixture.hook.planes.size, 0)
    assert.equal(fixture.hook.windows.size, 0)
    assert.equal(fixture.hook.batches.size, 0)
    assert.ok(fixture.buttons.every(button => {
      const canvas = button.querySelector("[data-showcase-canvas]")
      return canvas.width === 0 && canvas.height === 0
    }))
    await settle()
    assert.ok(fixture.radios.every(input => !fixture.disabled(input)))
  })
})

test("late integrity work cannot restore pixel memory or draw after showcase removal", async () => {
  await withShowcase({holdDigests: true}, async fixture => {
    await until(() => fixture.digests.length === 2)
    fixture.removeShowcase()
    await fixture.releaseDigests()
    await settle()
    assert.equal(fixture.hook.planes.size, 0)
    assert.equal(fixture.hook.windows.size, 0)
    assert.equal(fixture.hook.batches.size, 0)
    assert.ok(fixture.buttons.every(button => button.querySelector("[data-showcase-canvas]").draws === 0))
  })
})

test("teardown releases owned canvases after LiveView replaces their button children with generated images", async () => {
  await withShowcase({}, async fixture => {
    await fixture.ready()
    const canvases = fixture.buttons.map(button => button.querySelector("[data-showcase-canvas]"))
    for (const [index, button] of fixture.buttons.entries()) {
      canvases[index].remove()
      button.appendChild(new Element("img"))
      assert.equal(button.querySelector("[data-showcase-canvas]"), null)
    }
    assert.doesNotThrow(() => fixture.removeShowcase())
    assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0))
    assert.equal(fixture.hook.canvases.length, 0)
    assert.equal(fixture.hook.planes.size, 0)
    assert.equal(fixture.hook.windows.size, 0)
    assert.equal(fixture.hook.batches.size, 0)
    assert.equal(fixture.document.listeners.get("change").length, 0)
    assert.equal(fixture.root.listeners.get("click").length, 0)
    assert.equal(fixture.elements.retry.listeners.get("click").length, 0)
    assert.equal(fixture.designHook.disposed, false)
  })
})

test("removing the showcase keeps reliable design filtering active for later generation", async () => {
  const pack = catalogFixture({pairs: {square: [["follow-body", "follow-body"]], circle: [["square", "square"]]}, partial: {square: 39, circle: 39}})
  await withShowcase({pack}, async fixture => {
    await fixture.ready()
    const count = fixture.requests.length
    fixture.removeShowcase()
    await settle()
    const submitted = []
    fixture.form.addEventListener("change", () => submitted.push(fixture.selected()))
    fixture.change("body", "circle")
    assert.deepEqual(fixture.selected(), {body: "circle", frame: "square", ball: "square"})
    assert.deepEqual(submitted.at(-1), fixture.selected())
    assert.equal(fixture.visible(fixture.radio("frame", "follow-body")), false)
    assert.equal(fixture.requests.length, count)
    fixture.mode("picture")
    assert.ok(fixture.radios.every(input => fixture.disabled(input)))
    fixture.mode("mosaic")
    assert.equal(fixture.disabled(fixture.radio("body", "circle")), false)
  })
})

test("a populated catalog with no reliable bodies keeps every shape hidden and disabled after loading and gallery removal", async () => {
  const pack = catalogFixture({pairs: {square: [], circle: []}, partial: {square: 39, circle: 39}})
  await withShowcase({pack}, async fixture => {
    await fixture.ready()
    assert.ok(fixture.radios.every(input => !fixture.visible(input) && fixture.disabled(input)))
    fixture.mode("picture")
    fixture.mode("mosaic")
    assert.ok(fixture.radios.every(input => !fixture.visible(input) && fixture.disabled(input)))
    fixture.removeShowcase()
    await settle()
    assert.ok(fixture.radios.every(input => !fixture.visible(input) && fixture.disabled(input)))
    for (const input of fixture.radios) input.disabled = false
    await settle()
    assert.ok(fixture.radios.every(input => !fixture.visible(input) && fixture.disabled(input)))
  })
})

test("a successful full load sends one readiness snapshot and later editor interactions send none", async () => {
  await withShowcase({auto: false}, async fixture => {
    assert.equal(fixture.pushed.length, 0)
    fixture.respond(fixture.requests[0])
    await until(() => fixture.requests.length === 3)
    fixture.respond(fixture.requests[1])
    await until(() => fixture.hook.planes.size > 0)
    assert.equal(fixture.pushed.length, 0)
    fixture.respond(fixture.requests[2])
    await fixture.ready()
    const expected = [{event: "showcase-ready", payload: {catalog_id: fixture.pack.catalog.id}}]
    assert.deepEqual(fixture.pushed, expected)
    fixture.change("body", "circle")
    fixture.change("frame", "square")
    fixture.change("ball", "circle")
    for (const name of ["payload", "vary_url", "auto_brand"]) {
      const input = fixture.form.appendChild(new Element("input"))
      Object.assign(input, {name: `qr[${name}]`, checked: true, value: "draft"})
      fixture.document.emit("change", input)
    }
    fixture.removeShowcase()
    await settle()
    assert.deepEqual(fixture.pushed, expected)
    assert.equal(fixture.requests.length, 3)
  })
})

test("fresh loaded reliability replaces retired choices from the initial page snapshot", async () => {
  const pack = catalogFixture()
  const initialBodies = pack.catalog.bodies.map(body => ({...body, retired: true, reliable_combinations: 0, pairs: []}))
  await withShowcase({pack, initialBodies, auto: false}, async fixture => {
    assert.ok(fixture.radios.every(input => !fixture.visible(input) && fixture.disabled(input)))
    fixture.respond(fixture.requests[0])
    await until(() => fixture.requests.length === 3)
    for (const request of fixture.requests.slice(1)) fixture.respond(request)
    await fixture.ready()
    assert.ok(fixture.radios.every(input => fixture.visible(input) && !fixture.disabled(input)))
    fixture.change("body", "circle")
    fixture.change("frame", "square")
    fixture.change("ball", "circle")
    assert.deepEqual(fixture.selected(), {body: "circle", frame: "square", ball: "circle"})
    assert.equal(fixture.pushed.length, 1)
    assert.equal(fixture.pushed[0].payload.catalog_id, pack.catalog.id)
  })
})
