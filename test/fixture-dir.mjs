// Builtin discovery parses the installed OMO bundles with the @babel/parser that
// omo-ai installs, resolved from the install root. Fixture installs therefore live
// under one directory whose node_modules holds a copy of that parser, borrowed
// from the omo-ai install OMO_BIN (exported by omo) points at.
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

let base

/** A fresh temp directory in which a fake OMO install resolves `@babel/parser`. */
export function fixtureDir(prefix) {
  if (base === undefined) {
    const omoBin = process.env.OMO_BIN
    if (!omoBin) throw new Error("builtin fixtures borrow omo-ai's @babel/parser: run the tests inside omo, or set OMO_BIN to omo-ai's bin/omo.js")
    const parser = dirname(createRequire(join(dirname(omoBin), "..", "package.json")).resolve("@babel/parser/package.json"))
    base = mkdtempSync(join(tmpdir(), "routing-omo-"))
    process.on("exit", () => rmSync(base, { recursive: true, force: true }))
    cpSync(parser, join(base, "node_modules", "@babel", "parser"), { recursive: true })
  }
  return mkdtempSync(join(base, prefix))
}
