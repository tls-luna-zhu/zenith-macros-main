#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkgPath = path.join(root, 'package.json')
const outPath = path.join(root, 'renderer', 'build-metadata.json')

function sha256FileHex(filePath) {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function shortGitSha() {
  try {
    return String(execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }))
      .trim()
  } catch (_) {
    return 'nogit'
  }
}

function generateWatermark(version) {
  const forced = String(process.env.ZENITH_BUILD_WATERMARK || '').trim()
  if (forced) return forced
  const stamp = Date.now().toString(36)
  const rnd = crypto.randomBytes(3).toString('hex')
  return `zen-${version}-${shortGitSha()}-${stamp}-${rnd}`
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const version = String(pkg.version || '0.0.0')
  const watermark = generateWatermark(version)
  const targets = [
    'macros/engine.js',
    'macros/input.js',
    'macros/triggerbot.js',
    'renderer/index.html'
  ]

  const criticalHashes = {}
  for (const rel of targets) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing integrity target: ${rel}`)
    }
    criticalHashes[rel] = sha256FileHex(abs)
  }

  const payload = {
    version,
    watermark,
    generatedAt: new Date().toISOString(),
    criticalHashes
  }

  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`[build-metadata] wrote ${outPath}`)
}

main()
