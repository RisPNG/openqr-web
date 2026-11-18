import test from "node:test"
import assert from "node:assert/strict"
import {once} from "node:events"
import {IDBFactory} from "fake-indexeddb"

let sequence = 0

async function fixture() {
  globalThis.indexedDB = new IDBFactory()
  globalThis.document = new EventTarget()
  const url = new URL("../js/qr_history.js", import.meta.url)
  url.searchParams.set("test", ++sequence)
  const module = await import(url)
  const entry = {artifact: new Blob(["<svg>QR data</svg>"], {type: "image/svg+xml"}), name: "openqr-v4.svg", payload: "<script>alert('literal text')</script>", version: 4}
  return {...module, entry}
}

async function entries(store = "downloads") {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("openqr-downloads")
    request.onupgradeneeded = () => request.result.createObjectStore("downloads", {keyPath: "id"})
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const result = await new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readonly")
    const request = transaction.objectStore(store).getAll()
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error)
  })
  db.close()
  return result
}

async function until(condition) {
  for (let index = 0; index < 100; index++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail("Expected asynchronous history update")
}

test("download history persists exact bytes, deduplicates re-downloads, and keeps distinct formats", async () => {
  const {saveDownload, entry} = await fixture()
  let changes = 0
  document.addEventListener("openqr:history-changed", () => changes++)
  await saveDownload(entry)
  await saveDownload(entry)
  let saved = await entries()
  assert.equal(saved.length, 1)
  assert.equal(await saved[0].artifact.text(), await entry.artifact.text())
  assert.equal(saved[0].artifact.type, "image/svg+xml")
  assert.equal(saved[0].payload, entry.payload)
  assert.equal(saved[0].version, 4)
  assert.ok(saved[0].downloadedAt <= Date.now())
  await saveDownload({...entry, name: "openqr-v4.png", artifact: new Blob([new Uint8Array([1, 2, 3])], {type: "image/png"})})
  saved = await entries()
  assert.equal(saved.length, 2)
  assert.equal(changes, 3)
})

test("saving scans upgrades existing download history and only stores decoded text and time", async t => {
  const {saveScans, entry} = await fixture()
  const legacy = {...entry, id: "legacy-download", downloadedAt: 1}
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("openqr-downloads", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("downloads", {keyPath: "id"}).put(legacy)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
  let now = 2
  t.mock.method(Date, "now", () => now)
  await saveScans([{text: entry.payload, pixels: new Uint8Array([1, 2, 3])}, {text: "Another QR"}, {text: entry.payload}])
  now++
  await saveScans([{text: entry.payload}])
  const [download] = await entries()
  assert.equal(download.id, legacy.id)
  assert.equal(await download.artifact.text(), await entry.artifact.text())
  assert.deepEqual(await entries("scans"), [
    {payload: entry.payload, scannedAt: 3},
    {payload: "Another QR", scannedAt: 2},
  ])
})

test("opening and updating export previews never creates history; only a download click does", async () => {
  const {QRDownloads, entry} = await fixture()
  const root = new EventTarget()
  root.dataset = {payload: entry.payload, version: "4"}
  const notice = {textContent: ""}
  const link = {dataset: {downloadType: "image/svg+xml", downloadContent: Buffer.from(await entry.artifact.text()).toString("base64")}, download: entry.name}
  root.querySelectorAll = () => [link]
  root.querySelector = () => notice
  const hook = {...QRDownloads, el: root}
  hook.mounted()
  const firstURL = link.href
  hook.updated()
  assert.match(link.href, /^blob:/)
  await assert.rejects(fetch(firstURL))
  assert.equal((await entries()).length, 0)
  const click = new Event("click")
  Object.defineProperty(click, "target", {value: {closest: () => link}})
  const updated = once(document, "openqr:history-changed", {signal: AbortSignal.timeout(3000)})
  root.dispatchEvent(click)
  await updated
  assert.equal((await entries())[0].payload, entry.payload)
  const lastURL = link.href
  hook.destroyed()
  await assert.rejects(fetch(lastURL))
})

test("history storage failure leaves the export downloadable and reports the failure", async () => {
  const {QRDownloads, entry} = await fixture()
  globalThis.indexedDB = {open() {
    const request = {error: new Error("Storage denied")}
    queueMicrotask(() => request.onerror())
    return request
  }}
  const root = new EventTarget()
  root.dataset = {payload: entry.payload, version: "4"}
  const notice = {textContent: ""}
  const link = {dataset: {downloadType: "image/png", downloadContent: "AQID"}, download: "openqr-v4.png"}
  root.querySelectorAll = () => [link]
  root.querySelector = () => notice
  const hook = {...QRDownloads, el: root}
  hook.mounted()
  hook.onDownload({target: {closest: () => link}, defaultPrevented: false})
  await until(() => notice.textContent.includes("could not be saved"))
  assert.deepEqual(new Uint8Array(await (await fetch(link.href)).arrayBuffer()), new Uint8Array([1, 2, 3]))
  hook.destroyed()
})

test("history shows latest scans and downloads, supports copying, re-download, removal and clear", async t => {
  const {QRHistory, saveDownload, saveScans, entry} = await fixture()
  let now = 1
  t.mock.method(Date, "now", () => now)
  const scanned = "<b>Scanned literally</b>\nSecond line"
  await saveDownload(entry)
  now++
  await saveScans([{text: scanned}])
  now++
  await saveDownload({...entry, name: "openqr-v5.svg", version: 5})
  const copied = []
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {async writeText(value) {copied.push(value)}},
  })
  t.after(() => delete navigator.clipboard)
  const cards = []
  const previewImages = new Set()
  globalThis.IntersectionObserver = class {
    observe(image) {previewImages.add(image)}
    disconnect() {previewImages.clear()}
  }
  t.after(() => delete globalThis.IntersectionObserver)
  const list = {
    get children() {return cards.map(card => card.querySelector("[data-history-card]"))},
    replaceChildren() {cards.length = 0},
    appendChild(card) {cards.push(card)},
    querySelectorAll(selector) {return cards.map(card => card.querySelector(selector))},
  }
  const status = {textContent: ""}
  const clear = {disabled: true}
  const template = {content: {cloneNode() {
    const fields = new Map()
    for (const name of ["card", "image", "title", "payload", "date", "download", "copy", "open", "remove"]) {
      const selector = `[data-history-${name}]`
      fields.set(selector, {
        textContent: "",
        remove() {fields.delete(selector)},
        focus() {document.activeElement = this},
      })
    }
    return {querySelector: selector => fields.get(selector)}
  }}}
  const root = new EventTarget()
  root.querySelector = selector => ({"[data-history-list]": list, "[data-history-status]": status, "[data-history-clear]": clear, "[data-history-entry]": template})[selector]
  const hook = {...QRHistory, el: root}
  const click = (action, card) => hook.onClick({target: {closest(selector) {
    if (selector === `[data-history-${action}]`) return card ? card.querySelector(selector) : clear
    if (selector === "[data-history-card]") return card?.querySelector(selector)
    return null
  }}})
  hook.mounted()
  await until(() => cards.length === 3)
  assert.match(cards[0].querySelector("[data-history-title]").textContent, /Version 5/)
  assert.equal(cards[0].querySelector("[data-history-payload]").textContent, entry.payload)
  assert.equal(cards[1].querySelector("[data-history-title]").textContent, "Scanned QR code")
  assert.equal(cards[1].querySelector("[data-history-payload]").textContent, scanned)
  assert.ok(previewImages.has(cards[1].querySelector("[data-history-image]")))
  assert.equal(cards[1].querySelector("[data-history-open]"), undefined)
  assert.equal(cards[1].querySelector("[data-history-download]"), undefined)
  assert.equal(cards[0].querySelector("[data-history-open]"), undefined)
  assert.equal(clear.disabled, false)
  await click("copy", cards[1])
  assert.deepEqual(copied, [scanned])
  assert.equal(status.textContent, "Copied scanned text.")
  const firstDownload = cards[2]
  assert.equal(await (await fetch(firstDownload.querySelector("[data-history-download]").href)).text(), await entry.artifact.text())
  now++
  await click("download", firstDownload)
  await until(() => cards[0] !== firstDownload && cards[0].querySelector("[data-history-title]").textContent.includes("Version 4"))
  assert.equal((await entries()).length, 2)
  cards[2].querySelector("[data-history-remove]").focus()
  await click("remove", cards[2])
  await until(() => cards.length === 2)
  assert.equal(document.activeElement, cards[1].querySelector("[data-history-remove]"))
  assert.equal(status.textContent, "2 saved entries.")
  assert.equal((await entries("scans")).length, 0)
  await click("remove", cards[0])
  await until(() => cards.length === 1)
  assert.equal((await entries()).length, 1)
  now++
  await saveScans([{text: "lego.com"}])
  await until(() => cards.length === 2)
  assert.equal(cards[0].querySelector("[data-history-payload]").textContent, "lego.com")
  assert.equal(cards[0].querySelector("[data-history-open]").href, "https://lego.com/")
  await click("clear")
  await until(() => cards.length === 0)
  assert.equal((await entries()).length, 0)
  assert.equal((await entries("scans")).length, 0)
  assert.equal(clear.disabled, true)
  assert.equal(status.textContent, "No history yet.")
  hook.destroyed()
})
