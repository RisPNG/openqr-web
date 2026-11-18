import {saveScans} from "./qr_history"
import {websiteUrl} from "./qr_links.js"

const QRScanner = {
  mounted() {
    this.disposed = false
    this.generation = 0
    this.requestId = 0
    this.cameraStarting = false
    this.video = this.el.querySelector("[data-scan-video]")
    this.file = this.el.querySelector("[data-scan-file]")
    this.preview = this.el.querySelector("[data-scan-preview]")
    this.start = this.el.querySelector("[data-scan-start]")
    this.stop = this.el.querySelector("[data-scan-stop]")
    this.status = this.el.querySelector("[data-scan-status]")
    this.announcement = this.el.querySelector("[data-scan-announcement]")
    this.historyWarning = this.el.querySelector("[data-scan-history-warning]")
    this.results = this.el.querySelector("[data-scan-results]")
    this.canvas = document.createElement("canvas")
    this.lastResults = ""
    this.seenScans = new Set()
    this.historyRetryAt = 0

    this.onStart = () => this.startCamera()
    this.onStop = () => {
      this.stopScanning()
      this.status.textContent = "Camera stopped."
    }
    this.onFile = () => this.scanFile(this.file.files[0])
    this.onVisibility = () => {
      if (document.hidden) {
        this.stopScanning()
        this.status.textContent = "Scanner paused while this page is hidden."
      }
    }
    this.onTrackEnded = () => {
      this.stopScanning()
      this.status.textContent = "The camera stopped. Select Start camera to try again."
    }
    this.start.addEventListener("click", this.onStart)
    this.stop.addEventListener("click", this.onStop)
    this.file.addEventListener("change", this.onFile)
    document.addEventListener("visibilitychange", this.onVisibility)

    if (!globalThis.Worker || !globalThis.WebAssembly) {
      this.start.disabled = true
      this.file.disabled = true
      this.status.textContent = "This browser cannot run the scanner. Try a current browser."
    } else if (!navigator.mediaDevices?.getUserMedia) {
      this.start.disabled = true
      this.status.textContent = "Camera access requires a supported browser with HTTPS or localhost. You can still scan an image."
    }
  },

  async startCamera() {
    if (this.disposed || document.hidden || this.cameraStarting || this.stream) return
    this.stopScanning()
    this.scanSource = "camera"
    const generation = this.generation
    this.cameraStarting = true
    this.start.disabled = true
    this.stop.hidden = false
    this.status.textContent = "Waiting for camera access..."
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: {ideal: "environment"},
          width: {ideal: 1600},
          height: {ideal: 1200},
        },
      })
      if (this.disposed || generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      this.stream = stream
      for (const track of stream.getVideoTracks()) track.addEventListener("ended", this.onTrackEnded)
      this.video.srcObject = stream
      this.video.hidden = false
      await this.video.play()
      if (this.disposed || generation !== this.generation) return
      this.start.hidden = true
      this.status.textContent = "Point the camera at a QR code."
      this.scanFrame(generation)
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.stopScanning()
      if (error.name === "NotAllowedError" || error.name === "SecurityError") this.status.textContent = "Camera access was not allowed. Check browser permissions or choose an image."
      else if (error.name === "NotFoundError" || error.name === "OverconstrainedError") this.status.textContent = "No camera is available. Connect a camera or choose an image."
      else if (error.name === "NotReadableError") this.status.textContent = "The camera is busy or could not be opened. Close other camera apps and try again."
      else this.status.textContent = "The camera could not be started. Try again or choose an image."
    } finally {
      this.cameraStarting = false
      if (!this.disposed) this.start.disabled = false
    }
  },

  async scanFrame(generation) {
    if (this.disposed || generation !== this.generation || !this.stream) return
    try {
      if (this.video.readyState >= 2 && this.video.videoWidth && this.video.videoHeight) {
        const results = await this.decodeImage(this.video, this.video.videoWidth, this.video.videoHeight, 1600)
        if (this.disposed || generation !== this.generation) return
        if (results.length) {
          this.renderResults(results)
          this.status.textContent = `Found ${results.length} QR ${results.length === 1 ? "code" : "codes"}. Scanning continues.`
        }
      }
      this.frameTimer = setTimeout(() => this.scanFrame(generation), 150)
    } catch {
      if (this.disposed || generation !== this.generation) return
      this.stopScanning()
      this.status.textContent = "The scanner could not read camera frames. Try again or choose an image."
    }
  },

  async scanFile(file) {
    if (this.disposed || document.hidden) return
    this.preview.width = this.preview.height = 0
    this.preview.hidden = true
    this.announcement.textContent = ""
    if (!file && this.scanSource !== "file") return
    this.stopScanning()
    this.scanSource = file ? "file" : null
    const generation = this.generation
    this.results.replaceChildren()
    this.lastResults = ""
    if (!file) {
      this.status.textContent = "Ready to scan."
      return
    }
    if (file.size > 25 * 1024 * 1024) {
      this.status.textContent = "Choose an image smaller than 25 MB."
      return
    }
    this.status.textContent = "Reading image..."
    const image = new Image()
    const url = URL.createObjectURL(file)
    this.fileImage = image
    try {
      image.src = url
      await image.decode()
      if (this.disposed || generation !== this.generation) return
      if (image.naturalWidth * image.naturalHeight > 64_000_000) {
        this.status.textContent = "This image is too large. Resize it below 64 megapixels and try again."
        return
      }
      const results = await this.decodeImage(image, image.naturalWidth, image.naturalHeight, 2560, this.preview)
      if (this.disposed || generation !== this.generation) return
      this.renderResults(results)
      this.status.textContent = results.length > 1
        ? `Found ${results.length} QR codes.`
        : results.length ? "" : "No QR code found. Try a clearer image with the whole code visible."
      if (results.length === 1) this.announcement.textContent = "QR code read."
    } catch {
      if (!this.disposed && generation === this.generation) this.status.textContent = "This image could not be scanned. Choose another image or try the camera."
    } finally {
      image.removeAttribute("src")
      URL.revokeObjectURL(url)
      if (this.fileImage === image) this.fileImage = null
      if (generation === this.generation) this.canvas.width = this.canvas.height = 0
    }
  },

  decodeImage(image, width, height, maximumEdge, preview = null) {
    const scale = Math.min(1, maximumEdge / Math.max(width, height))
    this.canvas.width = Math.max(1, Math.round(width * scale))
    this.canvas.height = Math.max(1, Math.round(height * scale))
    const context = this.canvas.getContext("2d", {willReadFrequently: true})
    context.drawImage(image, 0, 0, this.canvas.width, this.canvas.height)
    if (preview) {
      const thumbnailScale = Math.min(1, 320 / Math.max(this.canvas.width, this.canvas.height))
      preview.width = Math.max(1, Math.round(this.canvas.width * thumbnailScale))
      preview.height = Math.max(1, Math.round(this.canvas.height * thumbnailScale))
      preview.getContext("2d").drawImage(this.canvas, 0, 0, preview.width, preview.height)
      preview.hidden = false
    }
    const pixels = context.getImageData(0, 0, this.canvas.width, this.canvas.height)
    if (!this.worker) {
      const worker = new Worker(this.el.dataset.workerUrl, {type: "module"})
      this.worker = worker
      worker.onmessage = ({data}) => {
        if (this.worker !== worker || data.id !== this.pendingDecode?.id) return
        const pending = this.pendingDecode
        this.pendingDecode = null
        if (data.error) pending.reject(new Error(data.error))
        else pending.resolve(data.results)
      }
      worker.onerror = () => {
        if (this.worker !== worker) return
        worker.terminate()
        this.worker = null
        this.pendingDecode?.reject(new Error("Scanner worker failed"))
        this.pendingDecode = null
      }
    }
    return new Promise((resolve, reject) => {
      const id = ++this.requestId
      this.pendingDecode = {id, resolve, reject}
      this.worker.postMessage({id, width: pixels.width, height: pixels.height, buffer: pixels.data.buffer}, [pixels.data.buffer])
    })
  },

  renderResults(results) {
    if (Date.now() >= this.historyRetryAt) {
      const newScans = results.filter(({text}) => {
        if (this.seenScans.has(text)) return false
        this.seenScans.add(text)
        return true
      })
      if (newScans.length) {
        const generation = this.generation
        saveScans(newScans).then(() => {
          if (generation === this.generation) this.historyWarning.textContent = ""
        }).catch(() => {
          if (generation !== this.generation) return
          for (const {text} of newScans) this.seenScans.delete(text)
          this.historyRetryAt = Date.now() + 2000
          this.historyWarning.textContent = "QR content was read, but could not be saved to history."
        })
      }
    }
    const serialized = JSON.stringify([this.scanSource, results])
    if (serialized === this.lastResults) return
    this.lastResults = serialized
    this.results.replaceChildren()
    for (const [index, result] of results.entries()) {
      const card = document.createElement("article")
      card.className = "grid gap-3 rounded-2xl inset-surface p-4"
      const heading = document.createElement("h3")
      heading.className = "text-sm font-semibold"
      heading.textContent = this.scanSource === "file" && results.length === 1 ? "QR code" : `QR code ${index + 1}`
      const text = document.createElement("pre")
      text.className = "whitespace-pre-wrap break-all text-sm leading-6"
      text.textContent = result.text
      const actions = document.createElement("div")
      actions.className = "grid grid-cols-[max-content_max-content] gap-2"
      const copy = document.createElement("button")
      copy.type = "button"
      copy.className = "rounded-lg border border-outline bg-primary px-3 py-2 text-sm font-medium"
      copy.textContent = "Copy"
      copy.addEventListener("click", async () => {
        const generation = this.generation
        try {
          await navigator.clipboard.writeText(result.text)
          if (!this.disposed && generation === this.generation) this.status.textContent = "Copied QR content."
        } catch {
          if (!this.disposed && generation === this.generation) this.status.textContent = "Copy was unavailable. Select and copy the text above."
        }
      })
      actions.appendChild(copy)
      const href = websiteUrl(result.text)
      if (href) {
        const open = document.createElement("a")
        open.href = href
        open.target = "_blank"
        open.rel = "noopener noreferrer"
        open.className = copy.className
        open.textContent = "Open link"
        actions.appendChild(open)
      }
      card.append(heading, text, actions)
      this.results.appendChild(card)
    }
  },

  stopScanning() {
    this.generation++
    this.seenScans.clear()
    this.historyRetryAt = 0
    this.historyWarning.textContent = ""
    clearTimeout(this.frameTimer)
    this.frameTimer = null
    this.worker?.terminate()
    this.worker = null
    this.pendingDecode?.reject(new DOMException("Scan canceled", "AbortError"))
    this.pendingDecode = null
    this.fileImage?.removeAttribute("src")
    this.fileImage = null
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.removeEventListener("ended", this.onTrackEnded)
        track.stop()
      }
    }
    this.stream = null
    this.video.pause()
    this.video.srcObject = null
    this.video.hidden = true
    this.canvas.width = this.canvas.height = 0
    this.start.hidden = false
    this.stop.hidden = true
  },

  destroyed() {
    this.disposed = true
    this.stopScanning()
    this.preview.width = this.preview.height = 0
    this.start.removeEventListener("click", this.onStart)
    this.stop.removeEventListener("click", this.onStop)
    this.file.removeEventListener("change", this.onFile)
    document.removeEventListener("visibilitychange", this.onVisibility)
  },
}

export default QRScanner
