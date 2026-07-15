import { describe, expect, it } from "vitest"
import { zipSync, unzipSync, strToU8 } from "fflate"
import { renameZipEntries } from "./rename-zip"

describe("renameZipEntries", () => {
  it("rewrites entry names in order", async () => {
    const zipped = zipSync({
      "old-1.pdf": strToU8("%PDF-1"),
      "old-2.pdf": strToU8("%PDF-2"),
    })
    const blob = new Blob([zipped], { type: "application/zip" })
    const out = await renameZipEntries(blob, ["alpha.pdf", "beta.pdf"])
    const entries = unzipSync(new Uint8Array(await out.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(["alpha.pdf", "beta.pdf"])
    expect(new TextDecoder().decode(entries["alpha.pdf"])).toBe("%PDF-1")
  })

  it("keeps 10+ split parts in numeric order", async () => {
    const partCount = 12
    const zipped = zipSync(
      Object.fromEntries(
        Array.from({ length: partCount }, (_, index) => {
          const part = index + 1
          return [`old-${part}.pdf`, strToU8(`%PDF-${part}`)]
        }),
      ),
    )
    const names = Array.from({ length: partCount }, (_, index) => `new-${index + 1}.pdf`)
    const out = await renameZipEntries(new Blob([zipped], { type: "application/zip" }), names)
    const entries = unzipSync(new Uint8Array(await out.arrayBuffer()))

    for (let part = 1; part <= partCount; part++) {
      const key = `new-${part}.pdf`
      expect(new TextDecoder().decode(entries[key])).toBe(`%PDF-${part}`)
    }
  })
})
