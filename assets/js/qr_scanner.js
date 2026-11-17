const QRScanner = {
  mounted() {
    this.disposed = false
    this.generation = 0
    this.requestId = 0
    this.cameraStarting = false
    this.video = this.el.querySelector("[data-scan-video]")
    this.file = this.el.querySelector("[data-scan-file]")
    this.start = this.el.querySelector("[data-scan-start]")
    this.stop = this.el.querySelector("[data-scan-stop]")
    this.status = this.el.querySelector("[data-scan-status]")
    this.results = this.el.querySelector("[data-scan-results]")
    this.canvas = document.createElement("canvas")
    this.lastResults = ""

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
    if (!file || this.disposed || document.hidden) return
    this.stopScanning()
    const generation = this.generation
    this.results.replaceChildren()
    this.lastResults = ""
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
      const results = await this.decodeImage(image, image.naturalWidth, image.naturalHeight, 2560)
      if (this.disposed || generation !== this.generation) return
      this.renderResults(results)
      this.status.textContent = results.length
        ? `Found ${results.length} QR ${results.length === 1 ? "code" : "codes"}.`
        : "No QR code found. Try a clearer image with the whole code visible."
    } catch {
      if (!this.disposed && generation === this.generation) this.status.textContent = "This image could not be scanned. Choose another image or try the camera."
    } finally {
      image.removeAttribute("src")
      URL.revokeObjectURL(url)
      if (this.fileImage === image) this.fileImage = null
      if (generation === this.generation) this.canvas.width = this.canvas.height = 0
    }
  },

  decodeImage(image, width, height, maximumEdge) {
    const scale = Math.min(1, maximumEdge / Math.max(width, height))
    this.canvas.width = Math.max(1, Math.round(width * scale))
    this.canvas.height = Math.max(1, Math.round(height * scale))
    const context = this.canvas.getContext("2d", {willReadFrequently: true})
    context.drawImage(image, 0, 0, this.canvas.width, this.canvas.height)
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
    const serialized = JSON.stringify(results)
    if (serialized === this.lastResults) return
    this.lastResults = serialized
    this.results.replaceChildren()
    for (const [index, result] of results.entries()) {
      const card = document.createElement("article")
      card.className = "grid gap-3 rounded-2xl inset-surface p-4"
      const heading = document.createElement("h3")
      heading.className = "text-sm font-semibold"
      heading.textContent = `QR code ${index + 1}`
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
      if (/^https?:\/\//i.test(result.text)) {
        try {
          const url = new URL(result.text)
          if (url.protocol === "http:" || url.protocol === "https:") {
            const open = document.createElement("a")
            open.href = url.href
            open.target = "_blank"
            open.rel = "noopener noreferrer"
            open.className = copy.className
            open.textContent = "Open link"
            actions.appendChild(open)
          }
        } catch {
          // A payload can start like a URL without being a valid link.
        }
      }
      card.append(heading, text, actions)
      this.results.appendChild(card)
    }
  },

  stopScanning() {
    this.generation++
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
    this.start.removeEventListener("click", this.onStart)
    this.stop.removeEventListener("click", this.onStop)
    this.file.removeEventListener("change", this.onFile)
    document.removeEventListener("visibilitychange", this.onVisibility)
  },
}

export default QRScanner
