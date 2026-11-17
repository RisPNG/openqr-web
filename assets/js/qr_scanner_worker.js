/*! QR reader dependency licenses: /licenses/qr-scanner.txt */
import {prepareZXingModule, purgeZXingModule, readBarcodes} from "zxing-wasm/reader"
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm"

let ready
let decoding = Promise.resolve()

self.onmessage = ({data}) => {
  decoding = decoding.then(async () => {
    try {
      ready ||= prepareZXingModule({
        overrides: {locateFile: () => wasmUrl},
        fireImmediately: true,
      })
      await ready
      const image = {
        data: new Uint8ClampedArray(data.buffer),
        width: data.width,
        height: data.height,
      }
      const results = []
      for (const binarizer of ["LocalAverage", "GlobalHistogram"]) {
        const decoded = await readBarcodes(image, {
          formats: ["QRCode"],
          textMode: "Plain",
          tryHarder: true,
          tryRotate: true,
          tryInvert: true,
          binarizer,
        })
        for (const result of decoded) {
          if (!result.isValid) continue
          const points = Object.values(result.position)
          const left = Math.min(...points.map(point => point.x))
          const right = Math.max(...points.map(point => point.x))
          const top = Math.min(...points.map(point => point.y))
          const bottom = Math.max(...points.map(point => point.y))
          const duplicate = results.some(previous => {
            const overlapWidth = Math.max(0, Math.min(right, previous.right) - Math.max(left, previous.left))
            const overlapHeight = Math.max(0, Math.min(bottom, previous.bottom) - Math.max(top, previous.top))
            const smallerArea = Math.min((right - left) * (bottom - top), (previous.right - previous.left) * (previous.bottom - previous.top))
            return previous.text === result.text && overlapWidth * overlapHeight > smallerArea / 2
          })
          if (!duplicate) results.push({text: result.text, format: result.format, left, right, top, bottom})
        }
      }
      self.postMessage({id: data.id, results: results.map(({text, format}) => ({text, format}))})
    } catch {
      purgeZXingModule()
      ready = null
      self.postMessage({id: data.id, error: "The QR decoder could not read this image."})
    }
  })
}
