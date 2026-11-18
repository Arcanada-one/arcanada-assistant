import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

test('accepted-risk.yml records picomatch GHSA as devdep', () => {
  const yml = fs.readFileSync('accepted-risk.yml', 'utf8')
  assert.match(yml, /GHSA-fc5q-39xc-vjpf/)
  assert.match(yml, /scope:\s*devdep/)
})

test('ci.yml audit-dev uses the accepted-risk wrapper', () => {
  const yml = fs.readFileSync('.github/workflows/ci.yml', 'utf8')
  assert.match(yml, /audit-dev-with-accepted-risk\.mjs/)
})
