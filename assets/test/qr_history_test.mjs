import test from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {IDBFactory} from "fake-indexeddb"

const source = await readFile(new URL("../js/qr_history.js", import.meta.url), "utf8")
let sequence = 0

async function fixture() {
  globalThis.indexedDB = new IDBFactory()
  globalThis.document = new EventTarget()
  const module = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${++sequence}`).toString("base64")}`)
  const entry = {artifact: new Blob(["<svg>QR data</svg>"], {type: "image/svg+xml"}), name: "openqr-v4.svg", payload: "<script>alert('literal text')</script>", version: 4}
  return {...module, entry}
}

async function entries() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("openqr-downloads", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("downloads", {keyPath: "id"})
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const result = await new Promise((resolve, reject) => {
    const transaction = db.transaction("downloads", "readonly")
    const request = transaction.objectStore("downloads").getAll()
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
  root.dispatchEvent(click)
  await until(async () => (await entries()).length === 1)
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

test("history reloads downloaded artifacts, displays payload as text, supports re-download, removal and clear", async () => {
  const {QRHistory, saveDownload, entry} = await fixture()
  await saveDownload(entry)
  await saveDownload({...entry, name: "openqr-v5.svg", version: 5})
  const cards = []
  const list = {replaceChildren() {cards.length = 0}, appendChild(card) {cards.push(card)}}
  const status = {textContent: ""}
  const clear = {disabled: true}
  const template = {content: {cloneNode() {
    const fields = new Map()
    for (const name of ["image", "title", "payload", "date", "download", "remove"]) fields.set(`[data-history-${name}]`, {dataset: {}, textContent: ""})
    return {querySelector: selector => fields.get(selector)}
  }}}
  const root = new EventTarget()
  root.querySelector = selector => ({"[data-history-list]": list, "[data-history-status]": status, "[data-history-clear]": clear, "[data-history-entry]": template})[selector]
  const hook = {...QRHistory, el: root}
  hook.mounted()
  await until(() => cards.length === 2)
  assert.equal(cards[0].querySelector("[data-history-payload]").textContent, entry.payload)
  assert.equal(clear.disabled, false)
  const link = cards[0].querySelector("[data-history-download]")
  assert.equal(await (await fetch(link.href)).text(), await entry.artifact.text())
  await hook.onClick({target: {closest: selector => selector === "[data-history-download]" ? link : null}})
  assert.equal((await entries()).length, 2)
  await until(() => cards.length === 2)
  const remove = cards[0].querySelector("[data-history-remove]")
  await hook.onClick({target: {closest: selector => selector === "[data-history-remove]" ? remove : null}})
  await until(() => cards.length === 1)
  assert.equal((await entries()).length, 1)
  await hook.onClick({target: {closest: selector => selector === "[data-history-clear]" ? clear : null}})
  await until(() => cards.length === 0)
  assert.equal((await entries()).length, 0)
  assert.equal(clear.disabled, true)
  assert.equal(status.textContent, "No downloads yet.")
  hook.destroyed()
})
