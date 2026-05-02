const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')

function githubRequest(method, url, token, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const headers = {
      'User-Agent': 'ZenithMacros-Release',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    }
    if (body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    if (body) headers['Content-Length'] = Buffer.byteLength(body)

    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: `${u.pathname}${u.search}`,
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const isJson = (res.headers['content-type'] || '').includes('application/json')
          const parsed = isJson && raw ? JSON.parse(raw) : raw
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
            reject(new Error(`${method} ${url} failed (${res.statusCode}): ${msg}`))
            return
          }
          resolve(parsed)
        })
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function createLatestYml(version, artifactName, exePath) {
  const buf = fs.readFileSync(exePath)
  const sha512 = crypto.createHash('sha512').update(buf).digest('base64')
  const size = fs.statSync(exePath).size
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${artifactName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
}

async function main() {
  const token = process.env.GH_TOKEN
  if (!token) {
    throw new Error('GH_TOKEN is required for post-release publishing.')
  }

  const root = path.resolve(__dirname, '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  const owner = pkg.build?.publish?.owner
  const repo = pkg.build?.publish?.repo
  if (!owner || !repo) {
    throw new Error('Missing build.publish owner/repo in package.json')
  }

  const artifactName = `ZenithMacros-${version}.exe`
  const exePath = path.join(root, 'dist', artifactName)
  if (!fs.existsSync(exePath)) {
    throw new Error(`Artifact not found: ${exePath}`)
  }

  const latestYmlPath = path.join(root, 'dist', 'latest.yml')
  const latestYml = createLatestYml(version, artifactName, exePath)
  fs.writeFileSync(latestYmlPath, latestYml, 'utf8')
  console.log(`[post-release] wrote ${latestYmlPath}`)

  const tag = `v${version}`
  const release = await githubRequest(
    'GET',
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
    token
  )

  const releaseId = release.id
  await githubRequest(
    'PATCH',
    `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}`,
    token,
    JSON.stringify({
      draft: false,
      prerelease: false,
      make_latest: 'true',
    })
  )
  console.log(`[post-release] finalized release ${tag}`)

  const assets = Array.isArray(release.assets) ? release.assets : []
  const existingLatest = assets.find((a) => a?.name === 'latest.yml')
  if (existingLatest?.id) {
    await githubRequest(
      'DELETE',
      `https://api.github.com/repos/${owner}/${repo}/releases/assets/${existingLatest.id}`,
      token
    )
    console.log('[post-release] removed old latest.yml asset')
  }

  const uploadBase = String(release.upload_url || '').replace(/\{.*\}$/, '')
  if (!uploadBase) throw new Error('Missing upload_url on release response')
  const latestBuf = fs.readFileSync(latestYmlPath)
  await githubRequest(
    'POST',
    `${uploadBase}?name=${encodeURIComponent('latest.yml')}`,
    token,
    latestBuf,
    { 'Content-Type': 'text/yaml' }
  )
  console.log('[post-release] uploaded latest.yml asset')
}

main().catch((err) => {
  console.error('[post-release] failed:', err.message || err)
  process.exit(1)
})
