// Minimal anti-cheat server: session, heartbeats, verify-run
import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import { Wallet, keccak256, toUtf8Bytes, AbiCoder, getBytes, verifyMessage } from 'ethers'
import Redis from 'ioredis'
import cors from 'cors'
import rateLimit from 'express-rate-limit'

// ---- Heartbeat validation helpers ----
const cfg = {
  minBeats: Number(process.env.HB_MIN_BEATS ?? 3),
  minMs: Number(process.env.HB_MIN_MS ?? 150),
  maxMs: Number(process.env.HB_MAX_MS ?? 1200),
};

// Convert timestamps → deltas if needed; pass deltas through unchanged.
function toIntervals(beats) {
  const arr = Array.isArray(beats) ? beats.map(Number).filter(Number.isFinite) : [];
  if (arr.length <= 1) return [];
  const strictlyInc = arr.every((v, i) => i === 0 || v > arr[i - 1]);
  const looksLikeTimestamps = strictlyInc && Math.max(...arr) > 5000; // ms
  if (!looksLikeTimestamps) return arr; // already deltas
  const deltas = [];
  for (let i = 1; i < arr.length; i++) deltas.push(arr[i] - arr[i - 1]);
  return deltas;
}

function validateRun(beatsRaw) {
  const deltas = toIntervals(beatsRaw);
  if (deltas.length < cfg.minBeats) {
    return { ok: false, error: 'too few beats', min: cfg.minBeats, saw: deltas.length };
  }
  const bad = deltas.filter(d => d < cfg.minMs || d > cfg.maxMs);
  if (bad.length) {
    return { ok: false, error: 'bad cadence', minMs: cfg.minMs, maxMs: cfg.maxMs, deltas };
  }
  return { ok: true, deltas };
}

// ---- /helpers ----

const app = express()
app.set('trust proxy', 1)
// CORS first so preflight gets handled even if body parsing fails
const corsMw = cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' })
app.use(corsMw)
app.options('*', corsMw)
app.use(express.json({ limit: '1mb' }))

const SERVER_PK = process.env.SERVER_PK
if (!SERVER_PK) {
  console.warn('[server] Missing SERVER_PK env; generate one and set it for signatures')
}
const signer = SERVER_PK ? new Wallet(SERVER_PK) : Wallet.createRandom()
console.log('[server] Signer:', signer.address)

// Optional Redis session store
const REDIS_URL = process.env.REDIS_URL
let redis = null
if (REDIS_URL) {
  try { redis = new Redis(REDIS_URL) } catch (e) { console.warn('[server] Redis init failed:', e?.message || e) }
}

const SESSIONS = new Map()

async function sessSet(id, obj, ttlSec = 3600) {
  if (redis) {
    await redis.set(`sess:${id}`, JSON.stringify(obj), 'EX', ttlSec)
  } else {
    SESSIONS.set(id, obj)
  }
}
async function sessGet(id) {
  if (redis) {
    const s = await redis.get(`sess:${id}`)
    return s ? JSON.parse(s) : null
  }
  return SESSIONS.get(id) || null
}
async function sessAppendBeat(id, beat) {
  const s = await sessGet(id)
  if (!s) return null
  s.beats.push(beat)
  await sessSet(id, s)
  return s
}

// Deterministic RNG from hex seed
function makeRng(seedHex) {
  const hex = seedHex.replace(/^0x/, '')
  let h = 0
  for (let i = 0; i < hex.length; i += 8) {
    h ^= parseInt(hex.slice(i, i + 8), 16) >>> 0
  }
  let t = h >>> 0
  return function() {
    t += 0x6D2B79F5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function simulate(inputs, seedHex) {
  const GRID = 20
  const snake = [{ x: 5, y: 10 }]
  let dir = { x: 1, y: 0 }
  let food = { x: 10, y: 10 }
  const rng = makeRng(seedHex)
  let score = 0
  let frame = 0
  const ins = Array.isArray(inputs) ? inputs.slice().sort((a, b) => (a.f||0) - (b.f||0)) : []
  let idx = 0
  const collide = (h) => h.x < 0 || h.y < 0 || h.x >= GRID || h.y >= GRID || snake.some((s, i) => i > 0 && s.x === h.x && s.y === h.y)
  while (true) {
    while (idx < ins.length && (ins[idx].f|0) === frame) {
      const e = ins[idx]
      if (e && e.d && typeof e.d.x === 'number' && typeof e.d.y === 'number') {
        if (!(e.d.x === -dir.x && e.d.y === -dir.y)) {
          dir = { x: e.d.x|0, y: e.d.y|0 }
        }
      }
      idx++
    }
    frame++
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y }
    if (collide(head)) break
    snake.unshift(head)
    if (head.x === food.x && head.y === food.y) {
      score += 1
      food = { x: Math.floor(rng()*GRID), y: Math.floor(rng()*GRID) }
    } else {
      snake.pop()
    }
    if (frame > 10000) break
  }
  const runHash = keccak256(toUtf8Bytes(JSON.stringify(inputs || [])))
  return { score, runHash }
}

// Basic rate limits (tune as needed)
const sessionLimiter = rateLimit({ windowMs: 60_000, limit: 20 })
const heartbeatLimiter = rateLimit({ windowMs: 1_000, limit: 10 }) // ~10 req/sec/IP; client uses ~3/sec
const verifyLimiter = rateLimit({ windowMs: 60_000, limit: 60 })

// 1) Start session
app.post('/session', sessionLimiter, async (req, res) => {
  const { address } = req.body || {}
  const sessionId = keccak256(toUtf8Bytes(crypto.randomUUID()))
  const seed = keccak256(toUtf8Bytes(crypto.randomUUID()))
  await sessSet(sessionId, { seed, address: (address||'').toLowerCase(), beats: [] }, 3600)
  res.json({ sessionId, seed })
})

// 2) Heartbeat
app.post('/heartbeat', heartbeatLimiter, async (req, res) => {
  const { sessionId, i } = req.body || {}
  const s = await sessGet(sessionId)
  if (!s) return res.status(400).json({ error: 'bad session' })
  const now = Date.now()
  await sessAppendBeat(sessionId, { i, t: now })
  const msg = keccak256(toUtf8Bytes(`${sessionId}|${i}|${now}`))
  const sig = await signer.signMessage(getBytes(msg))
  res.json({ i, t: now, sig })
})

// 3) Verify run
app.post('/verify-run', verifyLimiter, async (req, res) => {
  try {
  const { sessionId, address, score, runHash, inputs, beats } = req.body || {}
  console.log('[verify-run request]', { sessionId, address, beats: Array.isArray(beats) ? beats.length : 0 });
  const s = await sessGet(sessionId)
  if (!s) {
    console.warn('[verify-run reject]', { reason: 'bad session', sessionId })
    return res.status(400).json({ error: 'bad session' })
  }
  if (!address || s.address !== String(address).toLowerCase()) {
    console.warn('[verify-run reject]', { reason: 'address mismatch', expected: s.address, got: address, sessionId })
    return res.status(400).json({ error: 'address mismatch' })
  }

    // Re-sim
    const sim = simulate(inputs, s.seed)
    if (sim.runHash !== runHash) {
      console.warn('[verify-run reject]', { reason: 'hash mismatch', runHash, simHash: sim.runHash, sessionId })
      return res.status(403).json({ error: 'mismatch' })
    }
    if (score != null && Number(sim.score) !== Number(score)) {
      console.warn('[verify-run warn]', { reason: 'score mismatch', score, simScore: sim.score, sessionId })
    }

    // Verify beats: monotonic and cadence bounds (env-tunable)
    const MIN_MS = Number(process.env.HB_MIN_MS ?? 150)
    const MAX_MS = Number(process.env.HB_MAX_MS ?? 1200)
    const MIN_BEATS = Number(process.env.HB_MIN_BEATS ?? 3)
    const ALLOW_UNSIG = process.env.HB_ALLOW_UNSIG === '1'

    let lastI = -1
    let lastT = 0
    const arr = Array.isArray(beats) ? beats : []

    if (arr.length < MIN_BEATS) {
      console.warn('[verify-run reject]', { reason: 'too few beats', min: MIN_BEATS, saw: arr.length, sessionId })
      return res.status(403).json({ error: 'too few beats', min: MIN_BEATS, saw: arr.length })
    }

    const intervals = []

    for (const b of arr) {
      const bi = Number(b?.i ?? 0)
      const bt = Number(b?.t ?? 0)
      if (!Number.isFinite(bi) || !Number.isFinite(bt)) {
        console.warn('[verify-run reject]', { reason: 'bad beat values', bi, bt, sessionId })
        return res.status(403).json({ error: 'bad beats' })
      }

      if (!ALLOW_UNSIG) {
        const msg = keccak256(toUtf8Bytes(`${sessionId}|${bi}|${bt}`))
        const who = verifyMessage(getBytes(msg), b.sig)
        if (who.toLowerCase() !== signer.address.toLowerCase()) {
          console.warn('[verify-run reject]', { reason: 'bad beat sig', sessionId, beat: b })
          return res.status(403).json({ error: 'bad beat sig' })
        }
      }

      if (bi <= lastI || bt <= lastT) {
        console.warn('[verify-run reject]', { reason: 'non-monotonic beats', lastI, lastT, bi, bt, sessionId })
        return res.status(403).json({ error: 'non-monotonic beats', lastI, lastT, bi, bt })
      }

      const dt = lastT === 0 ? 0 : bt - lastT
      if (lastT !== 0 && (dt < MIN_MS || dt > MAX_MS)) {
        console.warn('[verify-run reject]', { reason: 'bad cadence', dt, minMs: MIN_MS, maxMs: MAX_MS, sessionId })
        return res.status(403).json({ error: 'bad cadence', dt, minMs: MIN_MS, maxMs: MAX_MS })
      }

      if (lastT !== 0) intervals.push(dt)
      lastI = bi
      lastT = bt
    }

    const timeDigest = keccak256(toUtf8Bytes(JSON.stringify(intervals)))

    // Attest using canonical simulated score
    const canonicalScore = Number(sim.score)
    const abi = AbiCoder.defaultAbiCoder()
    const enc = abi.encode(['address','bytes32','uint64','bytes32','bytes32'], [address, sessionId, BigInt(canonicalScore), runHash, timeDigest])
    const digest = keccak256(getBytes(enc))
    const attestSig = await signer.signMessage(getBytes(digest))
    res.json({ timeDigest, attestSig, score: canonicalScore })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

const PORT = process.env.PORT || 8787
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/ready', async (_req, res) => {
  try {
    if (redis) {
      await redis.ping()
      res.json({ ok: true, redis: 'ok' })
    } else {
      res.json({ ok: true, redis: 'disabled' })
    }
  } catch (e) {
    res.status(500).json({ ok: false, redis: 'error' })
  }
})
app.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}`))
