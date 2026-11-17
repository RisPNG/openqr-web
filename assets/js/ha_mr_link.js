/*!
MIT License

Copyright (c) 2026 p2r3

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import {compress} from "../vendor/ha-mr/compress.js"
import {outputAlphabetASCII} from "../vendor/ha-mr/alphabets.js"

const HaMRLink = {
  mounted() {
    this.enabled = this.el.querySelector('input[type="checkbox"][name="qr[ha_mr]"]').checked
    this.onFormChange = event => {
      if (event.target.matches('input[type="checkbox"][name="qr[ha_mr]"]')) this.enabled = event.target.checked
      this.renderCompressedLink()
    }
    for (const type of ["input", "change", "submit"]) this.el.addEventListener(type, this.onFormChange, true)
    this.renderCompressedLink()
  },

  updated() {
    this.renderCompressedLink()
  },

  renderCompressedLink() {
    const payload = this.el.querySelector('[name="qr[payload]"]')
    const checkbox = this.el.querySelector('input[type="checkbox"][name="qr[ha_mr]"]')
    const derived = this.el.querySelector('[name="qr[ha_mr_url]"]')
    const output = this.el.querySelector("[data-ha-mr-output]")
    const link = this.el.querySelector("[data-ha-mr-result]")
    const status = this.el.querySelector("[data-ha-mr-status]")
    checkbox.checked = this.enabled
    derived.value = ""
    let state = "disabled"
    let message = ""
    let result = ""

    if (this.enabled) {
      const input = payload.value.trim()
      state = "invalid"
      try {
        const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : "http://" + input)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported URL")
        const compressed = compress(url.href, outputAlphabetASCII)
        const normalized = input.replace(/^https?:\/\//i, "")
        const ratio = (1 - (compressed.length + 6) / normalized.length) * 100
        result = "https://ha.mr#" + compressed
        derived.value = result
        state = ratio < 0 ? "larger" : ratio > 0 ? "smaller" : "same"
        if (ratio < -300) message = "Output is much larger than the input"
        else if (ratio < 0) message = `Output is ${Math.floor(-ratio)}% larger than the input`
        else if (ratio > 0) message = `Output is ${Math.ceil(ratio)}% smaller than the input`
        else message = "Output is the same length as the input"
      } catch {
        message = input ? "Enter a valid HTTP or HTTPS URL without credentials." : "Enter a URL to compress."
      }
    }

    output.hidden = !this.enabled || state === "invalid"
    output.dataset.haMrState = state
    link.hidden = !result
    link.textContent = result
    if (result) link.setAttribute("href", result)
    else link.removeAttribute("href")
    status.textContent = message
    status.classList.toggle("text-success", state === "smaller")
    status.classList.toggle("text-error", state === "larger" || state === "invalid")
    status.classList.toggle("text-subcontent", state === "same" || state === "disabled")
  },

  destroyed() {
    for (const type of ["input", "change", "submit"]) this.el.removeEventListener(type, this.onFormChange, true)
  },
}

export default HaMRLink
