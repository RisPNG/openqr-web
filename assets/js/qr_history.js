import {websiteUrl} from "./qr_links.js"

let database
const historyStores = ["downloads", "scans"]

function openHistory() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("openqr-downloads", 2)
    let failed = false
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) request.result.createObjectStore("downloads", {keyPath: "id"})
      request.result.createObjectStore("scans", {keyPath: "payload"})
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

export async function saveDownload(entry) {
  const digest = await crypto.subtle.digest("SHA-256", await entry.artifact.arrayBuffer())
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
  const db = await openHistory()
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("downloads", "readwrite")
    transaction.objectStore("downloads").put({...entry, id: `${entry.name}:${hash}`, downloadedAt: Date.now()})
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error)
  })
  document.dispatchEvent(new Event("openqr:history-changed"))
}

export async function saveScans(results) {
  if (results.length === 0) return
  const db = await openHistory()
  const scannedAt = Date.now()
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("scans", "readwrite")
    const store = transaction.objectStore("scans")
    for (const payload of new Set(results.map(result => result.text))) {
      store.put({payload, scannedAt})
    }
    transaction.oncomplete = resolve
    transaction.onabort = () => reject(transaction.error)
  })
  document.dispatchEvent(new Event("openqr:history-changed"))
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
    this.entries = new WeakMap()
    this.status = this.el.querySelector("[data-history-status]")
    this.list = this.el.querySelector("[data-history-list]")
    this.clear = this.el.querySelector("[data-history-clear]")
    this.previewObserver = new IntersectionObserver(observations => {
      if (this.disposed) return
      for (const {target, isIntersecting} of observations) {
        if (!isIntersecting || !this.list.contains(target)) continue
        this.previewObserver.unobserve(target)
        const {payload} = this.entries.get(target.closest("[data-history-card]"))
        import("./qr_history_preview.js").then(({scanPreview}) => {
          if (!this.disposed && this.list.contains(target)) return scanPreview(payload)
        }).then(blob => {
          if (!blob || this.disposed || !this.list.contains(target)) return
          const url = URL.createObjectURL(blob)
          this.urls.push(url)
          target.src = url
        }).catch(() => {
          if (!this.disposed && this.list.contains(target)) {
            target.parentElement.querySelector("[data-history-preview-error]").hidden = false
          }
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
          const db = await openHistory()
          await new Promise((resolve, reject) => {
            const stores = remove ? [entry.artifact ? "downloads" : "scans"] : historyStores
            const transaction = db.transaction(stores, "readwrite")
            if (remove) transaction.objectStore(stores[0]).delete(entry.id ?? entry.payload)
            else for (const store of stores) transaction.objectStore(store).clear()
            transaction.oncomplete = resolve
            transaction.onabort = () => reject(transaction.error)
          })
          if (remove && document.activeElement === remove) {
            this.removedIndex = Array.prototype.indexOf.call(this.list.children, card)
          }
          document.dispatchEvent(new Event("openqr:history-changed"))
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
        const transaction = db.transaction(historyStores, "readonly")
        const requests = historyStores.map(store => transaction.objectStore(store).getAll())
        transaction.oncomplete = () => resolve(requests.flatMap(request => request.result))
        transaction.onabort = () => reject(transaction.error)
      })
      if (this.disposed || sequence !== this.sequence) return
      this.previewObserver.disconnect()
      for (const url of this.urls) URL.revokeObjectURL(url)
      this.urls = []
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
          image.alt = "QR code for scanned text"
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
        if (!entry.artifact) this.previewObserver.observe(image)
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
