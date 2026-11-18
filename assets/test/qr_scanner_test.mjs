import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import vm from "node:vm"

const source = (await readFile(new URL("../js/qr_scanner.js", import.meta.url), "utf8"))
  .replace(/^import \{saveScans\} from .*\n/m, "const saveScans = results => globalThis.saveScans(results)\n")
const QRScanner = (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default
const workerSource = (await readFile(new URL("../js/qr_scanner_worker.js", import.meta.url), "utf8")).replace(/^import .*\n/gm, "")

class Element {
  constructor(tagName = "div") {
    Object.assign(this, {tagName, children: [], listeners: new Map(), hidden: false, disabled: false, value: "", textContent: "", dataset: {}})
  }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]) }
  removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)) }
  async emit(name) { await Promise.all((this.listeners.get(name) || []).map(callback => callback({target: this}))) }
  appendChild(child) { this.children.push(child) }
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
  set innerHTML(_value) { assert.fail("QR payloads must be rendered as text") }
}

async function withScanner(options, run) {
  const names = ["document", "navigator", "Worker", "Image", "saveScans", "setTimeout", "clearTimeout"]
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const document = new Element()
  document.hidden = false
  const elements = Object.fromEntries(["video", "file", "preview", "start", "stop", "status", "announcement", "history-warning", "results"].map(name => [name, new Element(name)]))
  elements.preview.hidden = true
  elements.preview.getContext = () => ({
    drawImage(input) { elements.preview.source = input },
  })
  const video = elements.video
  Object.assign(video, {readyState: 2, videoWidth: options.width || 320, videoHeight: options.height || 240, play: async () => {}, pause() {}, srcObject: null})
  const track = new Element()
  track.stopped = 0
  track.stop = () => { track.stopped++ }
  const stream = {getTracks: () => [track], getVideoTracks: () => [track]}
  const workers = []
  const mediaRequests = []
  const timers = new Map()
  const copies = []
  const savedScans = []
  const images = []
  const urls = new Map()
  const created = []
  const revoked = []
  let timerId = 0
  const canvas = new Element("canvas")
  canvas.width = canvas.height = 0
  canvas.getContext = () => ({
    drawImage(image) { canvas.source = image },
    getImageData: () => ({width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(canvas.width * canvas.height * 4)}),
  })
  document.createElement = tag => tag === "canvas" ? canvas : new Element(tag)
  const browser = {
    document,
    navigator: {
      mediaDevices: {
        getUserMedia(constraints) {
          mediaRequests.push(constraints)
          return options.media?.promise || Promise.resolve(stream)
        },
      },
      clipboard: {writeText: async text => { copies.push(text) }},
    },
    Worker: class {
      constructor(url, config) {
        Object.assign(this, {url, config, messages: [], terminated: false})
        workers.push(this)
      }
      postMessage(data, transfer) { this.messages.push(structuredClone(data, {transfer})) }
      terminate() { this.terminated = true }
      respond(results, id = this.messages.at(-1).id) { this.onmessage({data: {id, results}}) }
    },
    Image: class {
      constructor() { this.src = ""; this.decodeCalls = 0; images.push(this) }
      set src(value) {
        this.source = value
        if (!value) return
        this.file = urls.get(value)
        this.naturalWidth = this.file.width || 10
        this.naturalHeight = this.file.height || 10
      }
      get src() { return this.source }
      decode() { this.decodeCalls++; return this.file.decoding?.promise || Promise.resolve() }
      removeAttribute(name) { assert.equal(name, "src"); this.src = "" }
    },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
    saveScans: async results => {
      savedScans.push(results.map(({text}) => text))
      await options.saveScans?.()
    },
  }
  URL.createObjectURL = file => {
    const url = `blob:image-${created.length + 1}`
    urls.set(url, file)
    created.push(url)
    return url
  }
  URL.revokeObjectURL = url => { revoked.push(url); urls.delete(url) }
  for (const [name, value] of Object.entries(browser)) Object.defineProperty(globalThis, name, {configurable: true, value})
  const hook = {
    ...QRScanner,
    el: {
      dataset: {workerUrl: "/assets/qr-scanner-worker.js"},
      querySelector: selector => elements[selector.match(/data-scan-([\w-]+)/)[1]],
    },
    pushEvent() { assert.fail("Decoded data must stay in the browser") },
  }
  try {
    hook.mounted()
    await run({hook, elements, document, workers, mediaRequests, timers, stream, track, copies, savedScans, canvas, images, created, revoked})
  } finally {
    hook.destroyed()
    await new Promise(setImmediate)
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

test("opening Scan does not request camera access or create a decoder worker", async () => {
  await withScanner({}, async ({hook, elements, workers, mediaRequests, document}) => {
    assert.equal(mediaRequests.length, 0)
    assert.equal(workers.length, 0)
    assert.equal(elements.video.srcObject, null)
    hook.destroyed()
    for (const element of [document, elements.start, elements.stop, elements.file]) {
      assert.ok([...element.listeners.values()].every(listeners => listeners.length === 0))
    }
  })
})

test("pending camera starts are serialized and late permission results are released after hiding", async () => {
  const media = Promise.withResolvers()
  await withScanner({media}, async ({hook, document, stream, track, mediaRequests, workers, elements}) => {
    const starting = hook.startCamera()
    await hook.startCamera()
    assert.equal(mediaRequests.length, 1)
    assert.equal(elements.start.disabled, true)
    document.hidden = true
    await document.emit("visibilitychange")
    media.resolve(stream)
    await starting
    assert.equal(track.stopped, 1)
    assert.equal(workers.length, 0)
    assert.equal(elements.video.srcObject, null)
    assert.equal(elements.start.disabled, false)
    document.hidden = false
    await document.emit("visibilitychange")
    assert.equal(mediaRequests.length, 1)
  })
})

test("camera frames are bounded and backpressured, results stay safe, and hidden pages release the camera", async () => {
  await withScanner({width: 4000, height: 3000}, async ({hook, document, workers, timers, track, elements, copies, savedScans}) => {
    await hook.startCamera()
    const worker = workers[0]
    assert.deepEqual(worker.config, {type: "module"})
    assert.equal(worker.messages.length, 1)
    assert.equal(worker.messages[0].width, 1600)
    assert.equal(worker.messages[0].height, 1200)
    assert.equal(timers.size, 0)
    const payloads = ["<img src=x onerror=alert(1)>", "javascript:alert(1)", "https://openqr.my/path"]
    worker.respond(payloads.map(text => ({text, format: "QRCodeModel2"})))
    await new Promise(setImmediate)
    assert.equal(timers.size, 1)
    assert.deepEqual(savedScans, [payloads])
    assert.equal(elements.results.children.length, 3)
    for (const [index, card] of elements.results.children.entries()) assert.equal(card.children[1].textContent, payloads[index])
    assert.equal(elements.results.children[0].children[2].children.length, 1)
    assert.equal(elements.results.children[1].children[2].children.length, 1)
    const link = elements.results.children[2].children[2].children[1]
    assert.equal(link.href, payloads[2])
    assert.equal(link.rel, "noopener noreferrer")
    await elements.results.children[0].children[2].children[0].emit("click")
    assert.deepEqual(copies, [payloads[0]])
    const [id, nextFrame] = [...timers.entries()][0]
    timers.delete(id)
    nextFrame()
    assert.equal(worker.messages.length, 2)
    worker.respond([...payloads].reverse().map(text => ({text, format: "QRCodeModel2"})))
    await new Promise(setImmediate)
    assert.deepEqual(savedScans, [payloads])
    const [thirdId, thirdFrame] = [...timers.entries()][0]
    timers.delete(thirdId)
    thirdFrame()
    document.hidden = true
    await document.emit("visibilitychange")
    worker.respond([{text: "late result", format: "QRCodeModel2"}])
    await new Promise(setImmediate)
    assert.equal(track.stopped, 1)
    assert.equal(worker.terminated, true)
    assert.equal(timers.size, 0)
    assert.equal(elements.video.srcObject, null)
    assert.equal(elements.results.children[0].children[1].textContent, payloads.at(-1))
    assert.deepEqual(savedScans, [payloads])
  })
})

test("a new file cancels old decoding, releases image URLs, and an empty image gives useful feedback", async () => {
  await withScanner({}, async ({hook, workers, elements, canvas, images, created, revoked}) => {
    const first = {size: 1024, width: 6000, height: 3000}
    elements.file.value = "C:\\fakepath\\first.png"
    const firstScan = hook.scanFile(first)
    await new Promise(setImmediate)
    assert.equal(workers[0].messages[0].width, 2560)
    assert.equal(workers[0].messages[0].height, 1280)
    assert.equal(elements.preview.hidden, false)
    assert.deepEqual([elements.preview.width, elements.preview.height], [320, 160])
    assert.equal(elements.preview.source, canvas)
    assert.equal(elements.file.value, "C:\\fakepath\\first.png")
    const secondScan = hook.scanFile({size: 1024, width: 10, height: 10})
    await new Promise(setImmediate)
    assert.equal(workers[0].terminated, true)
    workers[0].respond([{text: "stale", format: "QRCodeModel2"}])
    workers[1].respond([])
    await Promise.all([firstScan, secondScan])
    assert.equal(elements.results.children.length, 0)
    assert.match(elements.status.textContent, /No QR code found/)
    assert.ok(images.every(image => image.src === ""))
    assert.deepEqual(revoked, created)
    assert.equal(canvas.width, 0)
    assert.equal(canvas.height, 0)
    assert.equal(elements.preview.hidden, false)
    assert.deepEqual([elements.preview.width, elements.preview.height], [10, 10])
    elements.file.files = []
    await elements.file.emit("change")
    assert.equal(elements.preview.hidden, true)
    assert.equal(elements.preview.width, 0)
    assert.equal(elements.status.textContent, "Ready to scan.")
  })
})

test("retained result cards report copy failures after the camera stops", async () => {
  await withScanner({}, async ({hook, workers, elements}) => {
    const fileScan = hook.scanFile({size: 1024})
    await new Promise(setImmediate)
    workers[0].respond([])
    await fileScan
    assert.equal(elements.preview.hidden, false)
    await hook.startCamera()
    workers[1].respond([{text: "retained payload", format: "QRCodeModel2"}])
    await new Promise(setImmediate)
    hook.onStop()
    elements.file.files = []
    await elements.file.emit("change")
    assert.equal(elements.preview.hidden, true)
    assert.equal(elements.status.textContent, "Camera stopped.")
    assert.equal(elements.results.children[0].children[0].textContent, "QR code 1")
    navigator.clipboard.writeText = async () => { throw new DOMException("Clipboard blocked", "NotAllowedError") }
    const copy = elements.results.children[0].children[2].children[0]
    await copy.emit("click")
    assert.match(elements.status.textContent, /Copy was unavailable/)
    assert.equal(elements.results.children[0].children[1].textContent, "retained payload")
  })
})

test("camera scan history can recover from a temporarily blocked store without retrying every frame", async t => {
  let now = 10000
  let blocked = true
  t.mock.method(Date, "now", () => now)
  await withScanner({saveScans() { if (blocked) throw new Error("History upgrade blocked") }}, async ({hook, elements, workers, timers, savedScans}) => {
    await hook.startCamera()
    const readings = [{text: "Retain after retry", format: "QRCodeModel2"}]
    const worker = workers[0]
    worker.respond(readings)
    await new Promise(setImmediate)
    assert.match(elements["history-warning"].textContent, /could not be saved/)

    const [id, nextFrame] = [...timers.entries()][0]
    timers.delete(id)
    now += 150
    nextFrame()
    worker.respond(readings)
    await new Promise(setImmediate)
    assert.equal(savedScans.length, 1)
    assert.match(elements["history-warning"].textContent, /could not be saved/)

    const [retryId, retryFrame] = [...timers.entries()][0]
    timers.delete(retryId)
    now += 2000
    blocked = false
    retryFrame()
    worker.respond(readings)
    await new Promise(setImmediate)
    assert.deepEqual(savedScans, [[readings[0].text], [readings[0].text]])
    assert.equal(elements["history-warning"].textContent, "")
  })
})

test("oversized files are rejected and image decoding completing after removal cannot create a worker", async () => {
  const decoding = Promise.withResolvers()
  await withScanner({}, async ({hook, workers, elements, images, created, revoked}) => {
    await hook.scanFile({size: 26 * 1024 * 1024})
    assert.match(elements.status.textContent, /25 MB/)
    assert.equal(workers.length, 0)
    assert.equal(created.length, 0)
    const pending = hook.scanFile({size: 100, decoding})
    hook.destroyed()
    assert.equal(images[0].src, "")
    decoding.resolve()
    await pending
    assert.deepEqual(revoked, created)
    assert.equal(workers.length, 0)
  })
})

test("single PNG and SVG results show a bounded local preview without a visible result count", async () => {
  await withScanner({}, async ({hook, workers, images, created, revoked, canvas, elements, savedScans}) => {
    const png = new File([await readFile(new URL("fixtures/openqr-rounded-v4.png", import.meta.url))], "qr.png", {type: "image/png"})
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>'], "qr.svg", {type: "image/svg+xml"})
    for (const file of [png, svg]) {
      const scan = hook.scanFile(file)
      await new Promise(setImmediate)
      const image = images.at(-1)
      assert.equal(image.file, file)
      assert.equal(image.decodeCalls, 1)
      assert.equal(canvas.source, image)
      workers.at(-1).respond([{text: "https://openqr.my", format: "QRCode"}])
      await scan
      assert.equal(image.src, "")
      assert.equal(elements.preview.hidden, false)
      assert.equal(elements.status.textContent, "")
      assert.equal(elements.announcement.textContent, "QR code read.")
      assert.equal(elements.results.children[0].children[0].textContent, "QR code")
      assert.equal(elements.results.children[0].children[1].textContent, "https://openqr.my")
    }
    assert.deepEqual(revoked, created)
    assert.deepEqual(savedScans, [["https://openqr.my"], ["https://openqr.my"]])
  })
})

test("native image decode failures release the URL and show an error without starting a worker", async () => {
  const decoding = Promise.withResolvers()
  await withScanner({}, async ({hook, workers, images, created, revoked, elements}) => {
    const scan = hook.scanFile({size: 100, decoding})
    decoding.reject(new DOMException("Invalid image", "EncodingError"))
    await scan
    assert.match(elements.status.textContent, /could not be scanned/)
    assert.equal(workers.length, 0)
    assert.equal(images[0].src, "")
    assert.deepEqual(revoked, created)
  })
})

test("camera track loss stops scanning instead of decoding stale frames", async () => {
  await withScanner({}, async ({hook, track, workers, timers, elements}) => {
    await hook.startCamera()
    await track.emit("ended")
    await new Promise(setImmediate)
    assert.equal(track.stopped, 1)
    assert.equal(workers[0].terminated, true)
    assert.equal(timers.size, 0)
    assert.match(elements.status.textContent, /camera stopped/)
  })
})

function workerHarness(dependencies) {
  const responses = []
  const waiting = []
  const self = {postMessage(data) {
    const value = structuredClone(data)
    if (waiting.length) waiting.shift()(value)
    else responses.push(value)
  }}
  vm.runInNewContext(workerSource, {...dependencies, self, Uint8ClampedArray, wasmUrl: "/assets/zxing_reader-test.wasm"})
  return {
    send(data) { self.onmessage({data}) },
    next() { return responses.length ? Promise.resolve(responses.shift()) : new Promise(resolve => waiting.push(resolve)) },
  }
}

test("worker initializes once, serializes decode work, and returns valid local payloads only", async () => {
  const ready = Promise.withResolvers()
  const first = Promise.withResolvers()
  let preparations = 0
  let reads = 0
  const binarizers = []
  const worker = workerHarness({
    prepareZXingModule(options) {
      preparations++
      assert.equal(options.overrides.locateFile(), "/assets/zxing_reader-test.wasm")
      return ready.promise
    },
    purgeZXingModule() {},
    async readBarcodes(input, options) {
      reads++
      assert.deepEqual([...options.formats], ["QRCode"])
      assert.equal(options.textMode, "Plain")
      assert.equal(options.tryInvert, true)
      assert.equal(input.data.length, 4)
      binarizers.push(options.binarizer)
      if (reads === 1) await first.promise
      return [{isValid: true, text: `code ${input.data[0]}`, format: "QRCodeModel2", bytes: [42], position: {topLeft: {x: 0, y: 0}, topRight: {x: 20, y: 0}, bottomRight: {x: 20, y: 20}, bottomLeft: {x: 0, y: 20}}}, {isValid: false, text: "invalid"}]
    },
  })
  worker.send({id: 1, width: 1, height: 1, buffer: new Uint8ClampedArray([1, 0, 0, 0]).buffer})
  worker.send({id: 2, width: 1, height: 1, buffer: new Uint8ClampedArray([2, 0, 0, 0]).buffer})
  await new Promise(setImmediate)
  assert.equal(reads, 0)
  ready.resolve()
  await new Promise(setImmediate)
  assert.equal(reads, 1)
  first.resolve()
  assert.deepEqual(await worker.next(), {id: 1, results: [{text: "code 1", format: "QRCodeModel2"}]})
  assert.deepEqual(await worker.next(), {id: 2, results: [{text: "code 2", format: "QRCodeModel2"}]})
  assert.equal(preparations, 1)
  assert.deepEqual(binarizers, ["LocalAverage", "GlobalHistogram", "LocalAverage", "GlobalHistogram"])
})

test("both binarizers contribute symbols without duplicating overlapping results or merging separate equal payloads", async () => {
  const position = x => ({topLeft: {x, y: 0}, topRight: {x: x + 20, y: 0}, bottomRight: {x: x + 20, y: 20}, bottomLeft: {x, y: 20}})
  const worker = workerHarness({
    prepareZXingModule: async () => {},
    purgeZXingModule() {},
    async readBarcodes(_input, options) {
      return options.binarizer === "LocalAverage"
        ? [{isValid: true, text: "repeated", format: "QRCodeModel2", position: position(0)}]
        : [{isValid: true, text: "repeated", format: "QRCodeModel2", position: position(1)}, {isValid: true, text: "repeated", format: "QRCodeModel2", position: position(40)}, {isValid: true, text: "styled", format: "QRCodeModel2", position: position(80)}]
    },
  })
  worker.send({id: 1, width: 1, height: 1, buffer: new ArrayBuffer(4)})
  const result = await worker.next()
  assert.deepEqual(result.results.map(item => item.text), ["repeated", "repeated", "styled"])
})

test("OpenQR's rounded native export decodes with the verifier's global binarizer through the shipped WASM", async () => {
  const reader = await import("zxing-wasm/reader")
  const wasmBinary = await readFile(new URL(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm")))
  const image = new Blob([await readFile(new URL("fixtures/openqr-rounded-v4.png", import.meta.url))])
  await reader.prepareZXingModule({overrides: {wasmBinary}, fireImmediately: true})
  try {
    const global = await reader.readBarcodes(image, {formats: ["QRCode"], textMode: "Plain", binarizer: "GlobalHistogram"})
    assert.deepEqual(global.map(result => result.text), ["https://openqr.my"])
  } finally {
    reader.purgeZXingModule()
  }
})

test("the worker decodes multiple generated QR symbols with rotation and inversion through the shipped WASM", async () => {
  const reader = await import("zxing-wasm/reader")
  const writer = await import("zxing-wasm/writer")
  const readerBytes = await readFile(new URL(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm")))
  const writerBytes = await readFile(new URL(import.meta.resolve("zxing-wasm/writer/zxing_writer.wasm")))
  await writer.prepareZXingModule({overrides: {wasmBinary: writerBytes}, fireImmediately: true})
  const payloads = ["https://openqr.my", "line one\nline two"]
  const symbols = []
  for (const payload of payloads) {
    const result = await writer.writeBarcode(payload, {format: "QRCode"})
    assert.equal(result.error, "")
    symbols.push(result.symbol)
  }
  const scale = 4
  const tile = (Math.max(...symbols.map(symbol => symbol.width)) + 8) * scale
  const width = tile * 2 + 16
  const height = tile
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (const [index, symbol] of symbols.entries()) {
    const offset = index * (tile + 16)
    for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
      const sourceX = Math.floor(x / scale) - 4
      const sourceY = Math.floor(y / scale) - 4
      const sx = index ? sourceY : sourceX
      const sy = index ? symbol.height - 1 - sourceX : sourceY
      let value = sx >= 0 && sy >= 0 && sx < symbol.width && sy < symbol.height ? symbol.data[sy * symbol.width + sx] : 255
      if (index) value = 255 - value
      const position = (y * width + offset + x) * 4
      data[position] = data[position + 1] = data[position + 2] = value
    }
  }
  const worker = workerHarness({
    ...reader,
    prepareZXingModule: options => reader.prepareZXingModule({...options, overrides: {...options.overrides, wasmBinary: readerBytes}}),
  })
  try {
    worker.send({id: 1, width, height, buffer: data.buffer})
    const result = await worker.next()
    assert.equal(result.error, undefined)
    assert.deepEqual(result.results.map(item => item.text).sort(), [...payloads].sort())
    worker.send({id: 2, width: 64, height: 64, buffer: new Uint8ClampedArray(64 * 64 * 4).fill(255).buffer})
    assert.deepEqual(await worker.next(), {id: 2, results: []})
  } finally {
    reader.purgeZXingModule()
    writer.purgeZXingModule()
  }
})
