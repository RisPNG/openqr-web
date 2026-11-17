const designFields = [
  {name: "qr[body_shape]", key: "body"},
  {name: "qr[eye_frame]", key: "frame"},
  {name: "qr[eye_ball]", key: "ball"},
]

const QRShowcase = {
  mounted() {
    this.disposed = false
    this.ready = false
    this.current = {body: this.el.dataset.body, frame: this.el.dataset.frame, ball: this.el.dataset.ball}
    this.buttons = Array.from(this.el.querySelectorAll("[data-showcase-version]"))
    this.canvases = this.buttons.map(button => button.querySelector("[data-showcase-canvas]"))
    this.status = this.el.querySelector("[data-showcase-status]")
    this.retry = this.el.querySelector("[data-showcase-retry]")
    this.skipped = this.el.querySelector("[data-showcase-skipped]")
    this.skipSummary = this.el.querySelector("[data-showcase-skip-summary]")
    this.skipList = this.el.querySelector("[data-showcase-skip-list]")
    this.form = document.querySelector("#qr-options")
    this.planes = new Map()
    this.batches = new Map()
    this.windows = new Map()
    this.onChange = event => {
      const field = designFields.find(field => field.name === event.target.name)
      if (!field || !event.target.checked || event.target.disabled || !this.form.contains(event.target)) return
      if (this.ready) {
        const styles = Object.fromEntries(designFields.map(field => [field.key, this.form.querySelector(`input[name="${field.name}"]:checked`).value]))
        this.renderDesign(styles)
      }
    }
    this.onInspect = event => {
      const button = event.target.closest("[data-showcase-version]")
      if (!button) return
      if (!this.ready || button.disabled) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      for (const field of designFields) button.setAttribute(`phx-value-${field.key}`, this.current[field.key])
    }
    this.onRetry = () => this.loadCatalog()
    document.addEventListener("change", this.onChange)
    this.el.addEventListener("click", this.onInspect, true)
    this.retry.addEventListener("click", this.onRetry)
    this.loadCatalog()
  },

  updated() {
    for (const button of this.buttons) button.setAttribute("aria-pressed", String(button.dataset.showcaseVersion === this.el.dataset.selectedVersion))
  },

  async loadCatalog() {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.ready = false
    this.status.dataset.ready = "false"
    document.dispatchEvent(new CustomEvent("qr-showcase-ready"))
    this.retry.hidden = true
    this.status.hidden = false
    this.status.textContent = "Loading all design previews..."
    this.el.setAttribute("aria-busy", "true")
    for (const button of this.buttons) button.disabled = true
    this.planes.clear()
    this.windows.clear()
    this.batches.clear()
    try {
      const response = await fetch(`${this.el.dataset.baseUrl}/catalog.json`, {signal: controller.signal, cache: "no-cache"})
      if (!response.ok) throw new Error("The default preview catalog has not been prepared.")
      const catalog = await response.json()
      if (catalog.schema !== 1 || catalog.complete !== true || catalog.payload !== "https://openqr.my" || !Array.isArray(catalog.shards) || !catalog.shards.length) throw new Error("The default preview catalog is incomplete.")
      let loaded = 0
      const shards = [...catalog.shards]
      await Promise.all(Array.from({length: Math.min(2, shards.length)}, async () => {
        while (shards.length && !controller.signal.aborted) {
          const shard = shards.shift()
          if (!/^[a-f0-9]{64}\.bin$/.test(shard.name) || shard.name !== `${shard.sha256}.bin`) throw new Error("The default preview catalog is invalid.")
          const response = await fetch(`${this.el.dataset.baseUrl}/${shard.name}`, {signal: controller.signal, cache: "force-cache"})
          if (!response.ok) throw new Error("Some default previews could not be loaded.")
          const buffer = await response.arrayBuffer()
          if (this.disposed || controller.signal.aborted) return
          if (buffer.byteLength !== shard.raw_bytes) throw new Error("Some default preview data is incomplete.")
          const digest = await crypto.subtle.digest("SHA-256", buffer)
          if (this.disposed || controller.signal.aborted) return
          if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") !== shard.raw_sha256) throw new Error("Some default preview data is damaged.")
          this.installShard(buffer)
          loaded++
          this.status.textContent = `Loading all design previews... ${Math.round(loaded / catalog.shards.length * 100)}%`
        }
      }))
      if (this.disposed || controller.signal.aborted) return
      if (this.batches.size !== catalog.combinations) throw new Error("The default preview catalog is incomplete.")
      for (const batch of this.batches.values()) {
        for (const refs of batch) {
          if (refs === null) continue
          const body = this.planes.get(refs[0])
          const windows = this.windows.get(refs[0])
          if (!body || !windows || windows.length !== 4) throw new Error("The default preview catalog is incomplete.")
          for (let corner = 0; corner < 4; corner++) {
            const patch = this.planes.get(refs[corner + 1])
            const [x, y, width, height] = windows[corner]
            if (!patch || patch.width !== width || patch.height !== height || x < 0 || y < 0 || x + width > body.width || y + height > body.height) throw new Error("The default preview catalog is invalid.")
          }
        }
      }
      this.ready = true
      this.status.dataset.ready = "true"
      document.dispatchEvent(new CustomEvent("qr-showcase-ready", {detail: {bodies: catalog.bodies}}))
      this.pushEvent("showcase-ready", {catalog_id: catalog.id})
      const styles = Object.fromEntries(designFields.map(field => [field.key, this.form.querySelector(`input[name="${field.name}"]:checked`).value]))
      this.renderDesign(styles)
    } catch (error) {
      if (this.disposed || this.controller !== controller) return
      controller.abort()
      this.ready = false
      this.planes.clear()
      this.windows.clear()
      this.batches.clear()
      this.el.setAttribute("aria-busy", "false")
      this.status.hidden = false
      this.status.textContent = `${error.message} You can still generate your own QR code.`
      this.retry.hidden = false
      document.dispatchEvent(new CustomEvent("qr-showcase-ready"))
    }
  },

  installShard(buffer) {
    const bytes = new Uint8Array(buffer)
    const view = new DataView(buffer)
    if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "OQR1") throw new Error("The default preview data is invalid.")
    const start = 8 + view.getUint32(4, true)
    if (start > bytes.length) throw new Error("The default preview data is incomplete.")
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, start)))
    for (const plane of header.planes) {
      if (!Number.isSafeInteger(plane.id) || plane.id < 0 || this.planes.has(plane.id) || !Number.isSafeInteger(plane.width) || !Number.isSafeInteger(plane.height) || plane.width <= 0 || plane.height <= 0 || plane.length !== plane.width * plane.height || !Number.isSafeInteger(plane.offset) || plane.offset < 0 || start + plane.offset + plane.length > bytes.length) throw new Error("The default preview data is invalid.")
      this.planes.set(plane.id, {...plane, pixels: bytes.subarray(start + plane.offset, start + plane.offset + plane.length)})
    }
    for (const [body, windows] of Object.entries(header.windows)) this.windows.set(Number(body), windows)
    for (const combination of header.combinations) {
      const key = `${header.body}/${combination.frame}/${combination.ball}`
      if (this.batches.has(key) || combination.versions.length !== 40 || !combination.versions.every(refs => refs === null || Array.isArray(refs) && refs.length === 5 && refs.every(id => Number.isSafeInteger(id) && id >= 0))) throw new Error("The default preview catalog is invalid.")
      this.batches.set(key, combination.versions)
    }
  },

  renderDesign(styles) {
    this.current = styles
    const batch = this.batches.get(`${styles.body}/${styles.frame}/${styles.ball}`)
    const skipped = []
    for (const [index, button] of this.buttons.entries()) {
      const version = Number(button.dataset.showcaseVersion)
      const refs = batch?.[version - 1]
      const canvas = this.canvases[index]
      const unavailable = button.querySelector("[data-showcase-unavailable]")
      for (const field of designFields) button.setAttribute(`phx-value-${field.key}`, styles[field.key])
      if (!refs) {
        canvas.hidden = true
        button.disabled = true
        unavailable.hidden = false
        button.title = "No verified preview is available for this design and version."
        skipped.push(version)
        continue
      }
      const body = this.planes.get(refs[0])
      const image = new ImageData(body.width, body.height)
      for (let pixel = 0; pixel < body.pixels.length; pixel++) {
        const target = pixel * 4
        image.data[target] = image.data[target + 1] = image.data[target + 2] = body.pixels[pixel]
        image.data[target + 3] = 255
      }
      const windows = this.windows.get(refs[0])
      for (let corner = 0; corner < 4; corner++) {
        const patch = this.planes.get(refs[corner + 1])
        const [left, top, width, height] = windows[corner]
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const target = ((top + y) * body.width + left + x) * 4
            image.data[target] = image.data[target + 1] = image.data[target + 2] = patch.pixels[y * width + x]
          }
        }
      }
      canvas.width = body.width
      canvas.height = body.height
      canvas.getContext("2d").putImageData(image, 0, 0)
      canvas.hidden = false
      unavailable.hidden = true
      button.disabled = false
      button.removeAttribute("title")
    }
    this.skipList.replaceChildren()
    for (const version of skipped) {
      const item = document.createElement("li")
      item.textContent = `Version ${version}: No verified preview is available for this design.`
      this.skipList.appendChild(item)
    }
    this.skipped.hidden = skipped.length === 0
    this.skipSummary.textContent = `${skipped.length} versions unavailable`
    this.status.hidden = true
    this.el.setAttribute("aria-busy", "false")
    this.updated()
  },

  destroyed() {
    this.disposed = true
    this.ready = false
    this.controller?.abort()
    document.removeEventListener("change", this.onChange)
    this.el.removeEventListener("click", this.onInspect, true)
    this.retry.removeEventListener("click", this.onRetry)
    this.planes.clear()
    this.windows.clear()
    this.batches.clear()
    for (const canvas of this.canvases) {
      canvas.width = canvas.height = 0
    }
    this.canvases = []
    this.status.dataset.ready = "removed"
    document.dispatchEvent(new CustomEvent("qr-showcase-ready"))
  },
}

export default QRShowcase

export const QRDesign = {
  mounted() {
    this.disposed = false
    this.bodies = JSON.parse(this.el.dataset.reliability)
    this.form = this.el.closest("form")
    this.current = Object.fromEntries(designFields.map(field => [field.key, this.form.querySelector(`input[name="${field.name}"]:checked`).value]))
    this.onChange = event => {
      const field = designFields.find(field => field.name === event.target.name)
      if (field && event.target.checked && !event.target.disabled) this.current[field.key] = event.target.value
      this.synchronizeDesign()
    }
    this.onReady = event => {
      if (event.detail?.bodies) this.bodies = event.detail.bodies
      this.synchronizeDesign()
    }
    this.form.addEventListener("change", this.onChange, true)
    document.addEventListener("qr-showcase-ready", this.onReady)
    this.observer = new MutationObserver(() => this.synchronizeDesign())
    this.observer.observe(this.el, {childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "checked"]})
    this.synchronizeDesign()
  },

  updated() {
    this.synchronizeDesign()
  },

  synchronizeDesign() {
    if (this.disposed) return
    const bodies = this.bodies.filter(body => !body.retired && body.pairs.length)
    if (bodies.length) {
      const body = bodies.find(body => body.id === this.current.body) || bodies[0]
      this.current.body = body.id
      const pair = body.pairs.find(([frame, ball]) => frame === this.current.frame && ball === this.current.ball)
        || body.pairs.find(([frame]) => frame === this.current.frame)
        || body.pairs.find(([, ball]) => ball === this.current.ball)
        || body.pairs[0]
      this.current.frame = pair[0]
      this.current.ball = pair[1]
    }
    const body = bodies.find(body => body.id === this.current.body)
    const showcase = document.querySelector("#qr-showcase")?.querySelector("[data-showcase-status]")
    const gated = showcase && !["true", "removed"].includes(showcase.dataset.ready)
    const disabled = Boolean(gated || this.form.querySelector('input[name="qr[mode]"][value="picture"]:checked'))
    for (const group of this.el.querySelectorAll("fieldset")) {
      if (group.disabled !== disabled) group.disabled = disabled
    }
    for (const field of designFields) {
      for (const input of this.el.querySelectorAll(`input[name="${field.name}"]`)) {
        const visible = !this.bodies.length || (field.key === "body" ? bodies.some(body => body.id === input.value)
          : field.key === "frame" ? Boolean(body?.pairs.some(([frame]) => frame === input.value))
          : Boolean(body?.pairs.some(([frame, ball]) => frame === this.current.frame && ball === input.value)))
        input.closest("label").hidden = !visible
        if (input.disabled !== (disabled || !visible)) input.disabled = disabled || !visible
        if (input.checked !== (input.value === this.current[field.key])) input.checked = input.value === this.current[field.key]
      }
    }
  },

  destroyed() {
    this.disposed = true
    this.observer.disconnect()
    this.form.removeEventListener("change", this.onChange, true)
    document.removeEventListener("qr-showcase-ready", this.onReady)
  },
}
