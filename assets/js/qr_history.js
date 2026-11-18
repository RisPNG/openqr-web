import {websiteUrl} from "./qr_links.js"

let database
let historyWrite = Promise.resolve()
const entryStores = ["downloads", "scans"]
const scanStores = ["scans", "scanSources"]

function openHistory() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("openqr-downloads", 3)
    let failed = false
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) request.result.createObjectStore("downloads", {keyPath: "id"})
      const scans = event.oldVersion < 2
        ? request.result.createObjectStore("scans", {keyPath: "payload"})
        : request.transaction.objectStore("scans")
      scans.createIndex("sourceId", "sourceId")
      request.result.createObjectStore("scanSources", {keyPath: "id", autoIncrement: true})
    }
    request.onblocked = () => {
      failed = true
      reject(new Error("Close other OpenQR tabs to enable history."))
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      if (failed) return request.result.close()
      request.result.onversionchange = () => {
        request.result.close()
        database = undefined
      }
      resolve(request.result)
    }
  }).catch(error => {
    database = undefined
    throw error
  })
  return database
}

function updateHistory(mutate) {
  const write = historyWrite.then(openHistory).then(mutate).then(() => {
    document.dispatchEvent(new Event("openqr:history-changed"))
  })
  historyWrite = write.catch(() => {})
  return write
}

export function saveDownload(entry) {
  const downloadedAt = Date.now()
  return updateHistory(async db => {
    const digest = await crypto.subtle.digest("SHA-256", await entry.artifact.arrayBuffer())
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("downloads", "readwrite")
      transaction.objectStore("downloads").put({...entry, id: `${entry.name}:${hash}`, downloadedAt})
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
    })
  })
}

export async function saveScans(results, capturedImage) {
  if (results.length === 0) return
  const scannedAt = Date.now()
  const capture = Promise.resolve(capturedImage).catch(() => null)
  return updateHistory(async db => {
    const image = await capture
    if (!image) throw new Error("Scan image could not be saved")
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(scanStores, "readwrite")
      const scans = transaction.objectStore("scans")
      const source = transaction.objectStore("scanSources").add({image})
      source.onsuccess = () => {
        for (const payload of new Set(results.map(result => result.text))) {
          const previous = scans.get(payload)
          scans.put({payload, scannedAt, sourceId: source.result})
          previous.onsuccess = () => deleteUnusedScanSource(transaction, previous.result?.sourceId)
        }
      }
      transaction.oncomplete = resolve
      transaction.onabort = () => reject(transaction.error)
    })
  })
}

async function loadScanSource(sourceId) {
  const db = await openHistory()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("scanSources", "readonly")
    const source = transaction.objectStore("scanSources").get(sourceId)
    transaction.oncomplete = () => resolve(source.result?.image)
    transaction.onabort = () => reject(transaction.error)
  })
}

function deleteUnusedScanSource(transaction, sourceId) {
  if (sourceId === undefined) return
  const references = transaction.objectStore("scans").index("sourceId").count(sourceId)
  references.onsuccess = () => {
    if (references.result === 0) transaction.objectStore("scanSources").delete(sourceId)
  }
}

export const QRDownloads = {
  mounted() {
    this.downloads = new Map()
    this.onDownload = event => {
      const link = event.target.closest("a[data-download-content]")
      if (!link || event.defaultPrevented || !this.downloads.has(link)) return
      saveDownload({
        artifact: this.downloads.get(link).artifact,
        name: link.download,
        payload: this.el.dataset.payload,
        version: Number(this.el.dataset.version),
      }).catch(() => {
        if (!this.disposed) this.el.querySelector("[data-download-status]").textContent = "Download started, but browser history could not be saved. Check available storage or browser privacy settings."
      })
    }
    this.el.addEventListener("click", this.onDownload)
    this.updated()
  },
  updated() {
    for (const {url} of this.downloads.values()) URL.revokeObjectURL(url)
    this.downloads.clear()
    for (const link of this.el.querySelectorAll("a[data-download-content]")) {
      const bytes = Uint8Array.from(atob(link.dataset.downloadContent), character => character.charCodeAt(0))
      const artifact = new Blob([bytes], {type: link.dataset.downloadType})
      const url = URL.createObjectURL(artifact)
      link.href = url
      this.downloads.set(link, {artifact, url})
    }
  },
  destroyed() {
    this.disposed = true
    this.el.removeEventListener("click", this.onDownload)
    for (const {url} of this.downloads.values()) URL.revokeObjectURL(url)
    this.downloads.clear()
  },
}

export const QRHistory = {
  mounted() {
    this.sequence = 0
    this.urls = []
    this.sourcePreviews = new Map()
    this.entries = new WeakMap()
    this.status = this.el.querySelector("[data-history-status]")
    this.list = this.el.querySelector("[data-history-list]")
    this.clear = this.el.querySelector("[data-history-clear]")
    this.previewObserver = new IntersectionObserver(observations => {
      if (this.disposed) return
      for (const {target, isIntersecting} of observations) {
        if (!isIntersecting || !this.list.contains(target)) continue
        this.previewObserver.unobserve(target)
        const {sourceId} = this.entries.get(target.closest("[data-history-card]"))
        const previews = this.sourcePreviews
        if (!previews.has(sourceId)) {
          previews.set(sourceId, loadScanSource(sourceId).then(async source => {
            if (!source || this.disposed || previews !== this.sourcePreviews) return null
            const image = new Image()
            const originalUrl = URL.createObjectURL(source)
            try {
              image.src = originalUrl
              await image.decode()
              if (this.disposed || previews !== this.sourcePreviews) return null
              const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight))
              const canvas = document.createElement("canvas")
              canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
              canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
              canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height)
              const preview = await new Promise(resolve => canvas.toBlob(resolve))
              if (!preview || this.disposed || previews !== this.sourcePreviews) return null
              const url = URL.createObjectURL(preview)
              this.urls.push(url)
              return url
            } finally {
              URL.revokeObjectURL(originalUrl)
            }
          }).catch(() => null))
        }
        previews.get(sourceId).then(url => {
          if (this.disposed || !this.list.contains(target)) return
          if (url) target.src = url
          else target.parentElement.querySelector("[data-history-preview-error]").hidden = false
        })
      }
    })
    this.onHistoryChange = () => this.renderHistory()
    this.onClick = async event => {
      const remove = event.target.closest("[data-history-remove]")
      const clear = event.target.closest("[data-history-clear]")
      const link = event.target.closest("[data-history-download]")
      const copy = event.target.closest("[data-history-copy]")
      const card = event.target.closest("[data-history-card]")
      const entry = this.entries.get(card)
      if (copy) {
        try {
          await navigator.clipboard.writeText(entry.payload)
          if (!this.disposed) this.status.textContent = "Copied scanned text."
        } catch {
          if (!this.disposed) this.status.textContent = "Copy was unavailable. Select and copy the scanned text."
        }
        return
      }
      try {
        if (link && !event.defaultPrevented) {
          await saveDownload(entry)
        } else if (remove || clear) {
          await updateHistory(async db => {
            await new Promise((resolve, reject) => {
              const stores = remove ? (entry.artifact ? ["downloads"] : scanStores) : ["downloads", ...scanStores]
              const transaction = db.transaction(stores, "readwrite")
              if (!remove) {
                for (const store of stores) transaction.objectStore(store).clear()
              } else if (entry.artifact) {
                transaction.objectStore("downloads").delete(entry.id)
              } else {
                const scans = transaction.objectStore("scans")
                const saved = scans.get(entry.payload)
                scans.delete(entry.payload)
                saved.onsuccess = () => deleteUnusedScanSource(transaction, saved.result?.sourceId)
              }
              transaction.oncomplete = resolve
              transaction.onabort = () => reject(transaction.error)
            })
            if (remove && document.activeElement === remove) {
              this.removedIndex = Array.prototype.indexOf.call(this.list.children, card)
            }
          })
        }
      } catch {
        if (!this.disposed) this.status.textContent = "Browser history could not be updated. Check available storage or browser privacy settings."
      }
    }
    document.addEventListener("openqr:history-changed", this.onHistoryChange)
    this.el.addEventListener("click", this.onClick)
    this.renderHistory()
  },
  async renderHistory() {
    const sequence = ++this.sequence
    try {
      const db = await openHistory()
      const entries = await new Promise((resolve, reject) => {
        const transaction = db.transaction(entryStores, "readonly")
        const requests = entryStores.map(store => transaction.objectStore(store).getAll())
        transaction.oncomplete = () => resolve(requests.flatMap(request => request.result))
        transaction.onabort = () => reject(transaction.error)
      })
      if (this.disposed || sequence !== this.sequence) return
      this.previewObserver.disconnect()
      for (const url of this.urls) URL.revokeObjectURL(url)
      this.urls = []
      this.sourcePreviews = new Map()
      this.list.replaceChildren()
      this.clear.disabled = entries.length === 0
      this.status.textContent = entries.length
        ? `${entries.length} saved ${entries.length === 1 ? "entry" : "entries"}.`
        : "No history yet."
      entries.sort((a, b) => (b.downloadedAt ?? b.scannedAt) - (a.downloadedAt ?? a.scannedAt))
      const dateFormat = new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"})
      for (const entry of entries) {
        const card = this.el.querySelector("[data-history-entry]").content.cloneNode(true)
        this.entries.set(card.querySelector("[data-history-card]"), entry)
        const title = card.querySelector("[data-history-title]")
        const image = card.querySelector("[data-history-image]")
        const link = card.querySelector("[data-history-download]")
        const copy = card.querySelector("[data-history-copy]")
        const open = card.querySelector("[data-history-open]")
        if (entry.artifact) {
          const url = URL.createObjectURL(entry.artifact)
          this.urls.push(url)
          title.textContent = `Version ${entry.version} · ${entry.name.split(".").at(-1).toUpperCase()}`
          image.src = url
          image.alt = `Downloaded QR version ${entry.version}`
          link.href = url
          link.download = entry.name
          copy.remove()
          open.remove()
        } else {
          title.textContent = "Scanned QR code"
          if (entry.sourceId === undefined) image.parentElement.remove()
          else image.alt = "Image used for this scan"
          link.remove()
          const url = websiteUrl(entry.payload)
          if (url) open.href = url
          else open.remove()
        }
        card.querySelector("[data-history-payload]").textContent = entry.payload
        const recordedAt = entry.downloadedAt ?? entry.scannedAt
        const date = card.querySelector("[data-history-date]")
        date.dateTime = new Date(recordedAt).toISOString()
        date.textContent = dateFormat.format(recordedAt)
        this.list.appendChild(card)
        if (entry.sourceId !== undefined) this.previewObserver.observe(image)
      }
      if (this.removedIndex !== undefined) {
        const buttons = this.list.querySelectorAll("[data-history-remove]")
        const focus = buttons[Math.min(this.removedIndex, buttons.length - 1)] || this.status
        this.removedIndex = undefined
        focus.focus()
      }
    } catch {
      if (!this.disposed && sequence === this.sequence) this.status.textContent = "History is unavailable in this browser."
    }
  },
  destroyed() {
    this.disposed = true
    this.sequence++
    document.removeEventListener("openqr:history-changed", this.onHistoryChange)
    this.el.removeEventListener("click", this.onClick)
    this.previewObserver.disconnect()
    for (const url of this.urls) URL.revokeObjectURL(url)
  },
}
