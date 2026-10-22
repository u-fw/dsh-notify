// Inspect an Electron asar archive without the asar package: list entries, grep
// their text, or print one entry.
//
// Layout: [u32 = 4][u32 = headerPickleSize][u32 = headerPickleSize - 4][u32 = jsonSize][json][blobs]
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const archivePath = argv[0]
if (!archivePath) {
  console.error('usage: node list-asar.mjs <archive.asar> [--filter RE] [--grep RE] [--extract PATH] [--max N]')
  process.exit(1)
}

const valueOf = (flag) => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

const handle = readFileSync(archivePath)
const jsonSize = handle.readUInt32LE(12)
const header = JSON.parse(handle.toString('utf8', 16, 16 + jsonSize))
const blobsStart = 16 + jsonSize

const rows = []
const walk = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files) walk(entry, path)
    else rows.push({ path, size: entry.size, offset: Number(entry.offset) })
  }
}
walk(header, '')

const readEntry = (row) => handle.toString('utf8', blobsStart + row.offset, blobsStart + row.offset + row.size)

const extractPath = valueOf('--extract')
if (extractPath !== undefined) {
  const row = rows.find((entry) => entry.path === extractPath)
  if (!row) {
    console.error(`not found: ${extractPath}`)
    process.exit(1)
  }
  process.stdout.write(readEntry(row))
  process.exit(0)
}

const filter = valueOf('--filter')
const grep = valueOf('--grep')
const max = Number(valueOf('--max') ?? 120)

let candidates = filter === undefined ? rows : rows.filter((row) => new RegExp(filter, 'i').test(row.path))

if (grep === undefined) {
  console.log(`total entries: ${rows.length}, matching: ${candidates.length}`)
  for (const row of candidates.slice(0, max)) console.log(`${String(row.size).padStart(9)}  ${row.path}`)
  process.exit(0)
}

const pattern = new RegExp(grep, 'gi')
let hits = 0
const limit = Number(valueOf('--max') ?? 400)
for (const row of candidates) {
  if (row.size > 8_000_000) continue
  let text
  try {
    text = readEntry(row)
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0
    if (!pattern.test(line)) continue
    hits += 1
    if (hits > limit) {
      console.log(`... truncated at ${limit} hits`)
      process.exit(0)
    }
    console.log(`${row.path}:${index + 1}: ${line.trim().slice(0, 300)}`)
  }
}
console.log(`--- ${hits} matching lines`)
