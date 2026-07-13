// tsup/esbuild explicitly strips a bundled "use client" directive (it can
// only trust the directive when it's the sole statement of a whole output
// file, which a multi-module bundle isn't) — so it's added back here, after
// tsup has already finished, directly on the emitted files. Needed for
// Next.js to treat dist/client/* as a Client Component boundary.
import { readFileSync, writeFileSync } from 'node:fs'

const files = ['dist/client/index.js', 'dist/client/index.cjs']

for (const file of files) {
  const contents = readFileSync(file, 'utf8')
  if (contents.startsWith('"use client"')) continue
  writeFileSync(file, `"use client";\n${contents}`)
}
