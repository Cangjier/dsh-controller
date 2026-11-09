/**
 * Check an offline package against its own manifest — with no dependencies at all.
 *
 * This is the one command that answers "are these the bytes we shipped?" on a machine that has
 * nothing installed but Node: it re-hashes every delivered file, compares the result with
 * `manifest.json`, cross-checks `SHA256SUMS.txt` against the manifest so neither can silently drift
 * from the other, and confirms the plugin package still declares itself coherently.
 *
 * It is deliberately independent of the plugin's own test suite: that suite proves the plugin
 * behaves, this proves the *copy* is the one that was packed. Run both (the rebuild script runs the
 * former as part of packing).
 *
 * Usage, from anywhere inside the package:
 *   node verify-offline.mjs
 *   node verify-offline.mjs --dir C:\Users\Admin\Desktop\dsh-controller-offline
 *   node verify-offline.mjs --strict      # any file not covered by the manifest fails the check
 *   node verify-offline.mjs --json        # machine-readable result on stdout
 *
 * Exit code 0 = every check passed; 1 = at least one check failed; 2 = the package could not be read.
 *
 * @module verify-offline
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files that are part of the package but intentionally outside the manifest. */
const UNCOVERED_OK = new Set(['manifest.json'])

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)

/** @param {string} name - Flag name (without dashes). @returns {boolean} Whether it was passed. */
function flag(name) {
  return argv.includes(`--${name}`)
}

/** @param {string} name - Option name (without dashes). @returns {string|null} The value, or null. */
function option(name) {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return null
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

const strict = flag('strict')
const asJson = flag('json')

/**
 * Walk up from a starting directory looking for a package root: the directory that holds
 * `manifest.json` beside the plugin directory it describes.
 * @param {string} start - Absolute directory to search from.
 * @returns {string} The package root.
 */
function findPackageRoot(start) {
  let current = resolve(start)
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(current, 'manifest.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`No manifest.json found in ${start} or any of its parent directories. Pass --dir.`)
}

/**
 * @param {string} file - Absolute path.
 * @returns {string} Lowercase hex SHA-256.
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/**
 * Every regular file under a root, as package-relative POSIX paths.
 * @param {string} root - Absolute directory.
 * @param {string} [prefix] - Accumulated relative prefix.
 * @returns {string[]} Relative paths.
 */
function listFiles(root, prefix = '') {
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const checks = []
/** @param {string} name - Check name. @param {boolean} ok - Result. @param {string} detail - Evidence. */
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
}

function main() {
  const dirOption = option('dir')
  const root = dirOption === null ? findPackageRoot(HERE) : resolve(dirOption)

  const manifestPath = join(root, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`No manifest.json in ${root}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  const pluginDir = manifest.pluginDir ?? manifest.pluginName
  const pluginPath = join(root, pluginDir)

  check('manifest readable', true, `${manifest.name} ${manifest.version}, created ${manifest.createdAt}`)
  check('plugin directory present', existsSync(join(pluginPath, 'index.mjs')), pluginPath)

  // --- every file the manifest claims -----------------------------------------------------------------
  const missing = []
  const sizeMismatch = []
  const hashMismatch = []
  const covered = new Set()

  for (const entry of manifest.files ?? []) {
    const full = join(root, entry.path.split('/').join(sep))
    covered.add(entry.path)
    if (!existsSync(full)) {
      missing.push(entry.path)
      continue
    }
    const size = statSync(full).size
    if (size !== entry.bytes) {
      sizeMismatch.push(`${entry.path} (manifest ${entry.bytes}, disk ${size})`)
      continue
    }
    const hash = sha256(full)
    if (hash !== entry.sha256) hashMismatch.push(`${entry.path}\n      manifest ${entry.sha256}\n      disk     ${hash}`)
  }

  check(`all ${(manifest.files ?? []).length} manifest files exist`, missing.length === 0, missing.length === 0 ? 'no missing file' : `missing: ${missing.join(', ')}`)
  check('every size matches', sizeMismatch.length === 0, sizeMismatch.length === 0 ? 'all sizes agree' : sizeMismatch.join('; '))
  check('every SHA-256 matches', hashMismatch.length === 0, hashMismatch.length === 0 ? 'all hashes agree' : hashMismatch.join('; '))

  // --- nothing extra, nothing uncovered ---------------------------------------------------------------
  const onDisk = listFiles(root)
  const uncovered = onDisk.filter((file) => {
    if (covered.has(file)) return false
    if (UNCOVERED_OK.has(file)) return false
    if (file.endsWith('.7z') || file.endsWith('.7z.tmp')) return false
    return true
  })
  check('no files outside the manifest', uncovered.length === 0 || !strict, uncovered.length === 0 ? 'every file is covered' : `${uncovered.length} not covered${strict ? '' : ' (pass --strict to fail on this)'}: ${uncovered.join(', ')}`)

  // --- SHA256SUMS.txt must agree with the manifest ----------------------------------------------------
  const sumsPath = join(root, 'SHA256SUMS.txt')
  if (!existsSync(sumsPath)) {
    check('SHA256SUMS.txt present', false, `not found: ${sumsPath}`)
  } else {
    /** @type {Map<string, string>} */
    const sums = new Map()
    for (const line of readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(trimmed)
      if (match) sums.set(match[2].trim(), match[1])
    }
    const fromManifest = new Map((manifest.files ?? []).map((entry) => [entry.path, entry.sha256]))
    const disagree = []
    for (const [path, hash] of fromManifest) {
      // The sums file cannot list its own hash - that is the same circularity as a manifest hashing
      // itself - so it is the one manifest entry that must NOT appear inside it.
      if (path === 'SHA256SUMS.txt') continue
      if (!sums.has(path)) disagree.push(`${path} missing from SHA256SUMS.txt`)
      else if (sums.get(path) !== hash) disagree.push(`${path} differs between manifest.json and SHA256SUMS.txt`)
    }
    for (const path of sums.keys()) {
      if (!fromManifest.has(path)) disagree.push(`${path} listed in SHA256SUMS.txt but not in manifest.json`)
    }
    if (sums.size !== fromManifest.size - 1) {
      disagree.push(`SHA256SUMS.txt lists ${sums.size} files, the manifest ${fromManifest.size} (expected exactly one fewer: itself)`)
    }
    check(`SHA256SUMS.txt agrees with the manifest (${sums.size} entries)`, disagree.length === 0, disagree.length === 0 ? 'both list the same hashes, except the sums file itself' : disagree.join('; '))
  }

  // --- the recorded archive, if one was written ------------------------------------------------------
  if (manifest.archive === undefined || manifest.archive === null) {
    check('single-file archive', true, 'none recorded in the manifest (built with -NoArchive, or 7-Zip was not available)')
  } else {
    const archivePath = join(root, manifest.archive.path)
    if (!existsSync(archivePath)) {
      check('the recorded archive is present', false, `not found: ${archivePath}`)
    } else {
      const size = statSync(archivePath).size
      const sizeOk = size === manifest.archive.bytes
      // The archive contains manifest.json, so it cannot be covered by a hash recorded inside that
      // manifest. Size is checkable; the entry count is what the packaging step actually observed.
      check('the recorded archive is present', true, `${manifest.archive.path}, ${size} bytes`)
      check('the archive size matches what the build recorded', sizeOk, sizeOk ? `${size} bytes, as recorded` : `manifest says ${manifest.archive.bytes}, disk says ${size}`)
      check('the manifest records an archive digest', typeof manifest.archive.sha256 === 'string' && /^[0-9a-f]{64}$/.test(manifest.archive.sha256), manifest.archive.sha256 ?? 'missing')
    }
  }

  // --- the plugin package still describes itself ------------------------------------------------------
  const packagePath = join(pluginPath, 'package.json')
  if (!existsSync(packagePath)) {
    check('plugin package.json present', false, `not found: ${packagePath}`)
  } else {
    const meta = JSON.parse(readFileSync(packagePath, 'utf8'))
    check('plugin package.json parses', true, `${meta.name}@${meta.version}`)
    check('package name is the one the bundle patch names', meta.name === manifest.pluginName, meta.name === manifest.pluginName ? meta.name : `package.json says ${meta.name}, the patch and the directory say ${manifest.pluginName}`)
    check('package name matches the directory name', pluginDir === meta.name, pluginDir === meta.name ? pluginDir : `directory ${pluginDir}, package ${meta.name}`)

    const declared = meta.files ?? []
    const absent = declared.filter((entry) => !existsSync(join(pluginPath, entry)))
    check(`every name in package.json "files" is present (${declared.length})`, absent.length === 0, absent.length === 0 ? declared.join(', ') : `missing: ${absent.join(', ')}`)

    const entryPoint = meta.exports?.['.']
    check('the "." export points at a real file', typeof entryPoint === 'string' && existsSync(join(pluginPath, entryPoint)), `${entryPoint} -> ${typeof entryPoint === 'string' && existsSync(join(pluginPath, entryPoint)) ? 'present' : 'MISSING'}`)

    // The plugin imports nothing but node: builtins. If a bare specifier ever appears, the offline
    // claim stops being true, so it is worth failing on here rather than on the target machine.
    const importers = ['index.mjs', 'selftest.mjs', ...listFiles(join(pluginPath, 'src')).map((file) => `src/${file}`), ...listFiles(join(pluginPath, 'scripts')).map((file) => `scripts/${file}`)].filter((file) => file.endsWith('.mjs'))
    const bareSpecifiers = new Set()
    for (const file of importers) {
      const text = readFileSync(join(pluginPath, file.split('/').join(sep)), 'utf8')
      // `from '...'` covers static imports and re-exports (including a multi-line import list, which
      // this codebase uses); `import('...')` covers the dynamic ones. A specifier that is neither
      // relative nor a node: builtin would mean the package needs a node_modules after all.
      for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1]
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) bareSpecifiers.add(specifier)
      }
      for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) bareSpecifiers.add(specifier)
      }
    }
    check('no bare import specifiers in the plugin source', bareSpecifiers.size === 0, bareSpecifiers.size === 0 ? `${importers.length} modules import only ./ and node: builtins` : `would need node_modules: ${[...bareSpecifiers].join(', ')}`)
  }

  // --- report -----------------------------------------------------------------------------------------
  const failed = checks.filter((entry) => !entry.ok)
  if (asJson) {
    process.stdout.write(JSON.stringify({ root, manifest: { name: manifest.name, version: manifest.version, createdAt: manifest.createdAt }, passed: failed.length === 0, checks }, null, 2) + '\n')
  } else {
    const width = Math.max(...checks.map((entry) => entry.name.length))
    process.stdout.write(`package: ${root}\n`)
    process.stdout.write(`content: ${manifest.name} ${manifest.version}, packed ${manifest.createdAt}, ${(manifest.files ?? []).length} files / ${manifest.totals?.bytes ?? '?'} bytes\n\n`)
    for (const entry of checks) {
      process.stdout.write(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name.padEnd(width)}  ${entry.detail}\n`)
    }
    process.stdout.write(`\n${failed.length === 0 ? 'VERIFIED' : `FAILED (${failed.length} of ${checks.length} checks)`}\n`)
  }
  return failed.length === 0 ? 0 : 1
}

try {
  process.exitCode = main()
} catch (error) {
  if (asJson) process.stdout.write(JSON.stringify({ passed: false, error: String(error?.message ?? error) }, null, 2) + '\n')
  else process.stderr.write(`cannot verify: ${error?.message ?? error}\n`)
  process.exitCode = 2
}
