/*! QR preview dependency licenses: /licenses/qr-scanner.txt */
import {prepareZXingModule, writeBarcode} from "zxing-wasm/writer"
import wasmUrl from "zxing-wasm/writer/zxing_writer.wasm"

prepareZXingModule({overrides: {locateFile: () => wasmUrl}})

export async function scanPreview(payload) {
  const {image, error} = await writeBarcode(payload, {format: "QRCodeModel2", scale: -320})
  if (!image) throw new Error(error)
  return image
}
