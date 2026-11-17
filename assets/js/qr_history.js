let database

function openHistory() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("openqr-downloads", 1)
    let failed = false
    request.onupgradeneeded = () => request.result.createObjectStore("downloads", {keyPath: "id"})
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
    this.status = this.el.querySelector("[data-history-status]")
    this.list = this.el.querySelector("[data-history-list]")
    this.clear = this.el.querySelector("[data-history-clear]")
    this.onHistoryChange = () => this.renderHistory()
    this.onClick = async event => {
      const remove = event.target.closest("[data-history-remove]")
      const clear = event.target.closest("[data-history-clear]")
      const link = event.target.closest("[data-history-download]")
      try {
        if (link && !event.defaultPrevented) {
          await saveDownload(this.entries.get(link.dataset.id))
        } else if (remove || clear) {
          const db = await openHistory()
          await new Promise((resolve, reject) => {
            const transaction = db.transaction("downloads", "readwrite")
            const store = transaction.objectStore("downloads")
            if (remove) store.delete(remove.dataset.id)
            else store.clear()
            transaction.oncomplete = resolve
            transaction.onabort = () => reject(transaction.error)
          })
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
        const transaction = db.transaction("downloads", "readonly")
        const request = transaction.objectStore("downloads").getAll()
        transaction.oncomplete = () => resolve(request.result)
        transaction.onabort = () => reject(transaction.error)
      })
      if (this.disposed || sequence !== this.sequence) return
      for (const url of this.urls) URL.revokeObjectURL(url)
      this.urls = []
      this.entries = new Map(entries.map(entry => [entry.id, entry]))
      this.list.replaceChildren()
      this.clear.disabled = entries.length === 0
      this.status.textContent = entries.length ? `${entries.length} saved ${entries.length === 1 ? "download" : "downloads"}.` : "No downloads yet."
      for (const entry of entries.sort((a, b) => b.downloadedAt - a.downloadedAt)) {
        const card = this.el.querySelector("[data-history-entry]").content.cloneNode(true)
        const url = URL.createObjectURL(entry.artifact)
        this.urls.push(url)
        const image = card.querySelector("[data-history-image]")
        image.src = url
        image.alt = `Downloaded QR version ${entry.version}`
        card.querySelector("[data-history-title]").textContent = `Version ${entry.version} · ${entry.name.split(".").at(-1).toUpperCase()}`
        card.querySelector("[data-history-payload]").textContent = entry.payload
        const date = card.querySelector("[data-history-date]")
        date.dateTime = new Date(entry.downloadedAt).toISOString()
        date.textContent = new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}).format(entry.downloadedAt)
        const link = card.querySelector("[data-history-download]")
        link.href = url
        link.download = entry.name
        link.dataset.id = entry.id
        card.querySelector("[data-history-remove]").dataset.id = entry.id
        this.list.appendChild(card)
      }
    } catch {
      if (!this.disposed && sequence === this.sequence) this.status.textContent = "History is unavailable in this browser. Downloads still work."
    }
  },
  destroyed() {
    this.disposed = true
    this.sequence++
    document.removeEventListener("openqr:history-changed", this.onHistoryChange)
    this.el.removeEventListener("click", this.onClick)
    for (const url of this.urls) URL.revokeObjectURL(url)
  },
}
