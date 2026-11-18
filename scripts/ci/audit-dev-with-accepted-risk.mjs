#!/usr/bin/env node
/**
 * Run `pnpm audit --audit-level=high --json`, allow only GHSA ids listed as
 * scope:devdep in accepted-risk.yml, refuse any other high/critical finding.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import assert from 'node:assert/strict'

function loadAccepted() {
  const raw = fs.readFileSync('accepted-risk.yml', 'utf8')
  const ids = new Set()
  let cur = null
  for (const line of raw.split(/\r?\n/)) {
    const id = line.match(/^\s+-\s+id:\s+(\S+)/)
    if (id) {
      cur = { id: id[1], scope: null }
      continue
    }
    if (!cur) continue
    const scope = line.match(/^\s+scope:\s+(\S+)/)
    if (scope) {
      cur.scope = scope[1]
      if (cur.scope === 'devdep') ids.add(cur.id)
      cur = null
    }
  }
  return ids
}

const accepted = loadAccepted()
assert.ok(accepted.size > 0, 'accepted-risk.yml must list at least one devdep id')

const r = spawnSync('pnpm', ['audit', '--audit-level=high', '--json'], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
})
// pnpm audit exits 1 when findings exist; still parse stdout
let report
try {
  report = JSON.parse(r.stdout || '{}')
} catch (e) {
  console.error('pnpm audit did not return JSON')
  console.error(r.stdout)
  console.error(r.stderr)
  process.exit(r.status === 0 ? 2 : r.status)
}

const advisories = report.advisories || {}
const via = []
// pnpm v10 json: { advisories?: {}, metadata?, ... } or vulnerabilities map
const vulns = report.vulnerabilities || {}
const findings = []
if (Object.keys(advisories).length) {
  for (const adv of Object.values(advisories)) {
    const sev = String(adv.severity || '').toLowerCase()
    if (sev !== 'high' && sev !== 'critical') continue
    const ghsa = adv.github_advisory_id || adv.id || adv.url || ''
    findings.push({ id: String(ghsa), severity: sev, module: adv.module_name })
  }
} else if (Object.keys(vulns).length) {
  for (const [name, v] of Object.entries(vulns)) {
    const sev = String(v.severity || '').toLowerCase()
    if (sev !== 'high' && sev !== 'critical') continue
    const viaList = Array.isArray(v.via) ? v.via : []
    for (const item of viaList) {
      if (typeof item === 'object' && item) {
        const url = String(item.url || '')
        const m = url.match(/GHSA-[\w-]+/)
        findings.push({ id: m ? m[0] : String(item.source || item.title || name), severity: sev, module: name })
      }
    }
  }
}

const blocking = []
for (const f of findings) {
  const id = f.id.match(/GHSA-[\w-]+/)?.[0] || f.id
  if (!accepted.has(id)) blocking.push({ ...f, id })
}

if (blocking.length) {
  console.error('audit-dev gate failed: unaccepted high/critical findings:')
  for (const b of blocking) console.error(`- ${b.id} ${b.module} ${b.severity}`)
  process.exit(1)
}
console.log(`audit-dev gate ok: ${findings.length} high/critical finding(s) covered by accepted-risk.yml (${[...accepted].join(', ')})`)
process.exit(0)
