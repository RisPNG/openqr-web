import test from "node:test"
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import {registerHooks} from "node:module"
import {prepareZXingModule, readBarcodes} from "zxing-wasm/reader"

const previewModule = new URL("../js/qr_history_preview.js", import.meta.url)
const writerWasm = import.meta.resolve("zxing-wasm/writer/zxing_writer.wasm")
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === writerWasm) {
      const wasmUrl = `data:application/wasm;base64,${readFileSync(new URL(url)).toString("base64")}`
      return {format: "module", shortCircuit: true, source: `export default ${JSON.stringify(wasmUrl)}`}
    }
    return nextLoad(url, url === previewModule.href ? {...context, format: "module"} : context)
  },
})
const {scanPreview} = await import(previewModule)
hooks.deregister()

test("scan history previews encode the scanned text verbatim", async () => {
  const wasmBinary = readFileSync(new URL(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm")))
  prepareZXingModule({overrides: {wasmBinary}})

  const payloads = ["lego.com", " <img src=x onerror=alert(1)>\n\u4f60\u597d \u{1f680}\0 "]
  for (const payload of payloads) {
    const preview = await scanPreview(payload)
    assert.equal(preview.type, "image/png")
    const results = await readBarcodes(preview, {formats: ["QRCode"], textMode: "Plain"})
    assert.deepEqual(results.filter(result => result.isValid).map(result => result.text), [payload])
  }
})

test("a payload the writer cannot encode does not return a misleading preview", async () => {
  await assert.rejects(scanPreview("a".repeat(4000)))
  assert.ok(await scanPreview("lego.com") instanceof Blob)
})
