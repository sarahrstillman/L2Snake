import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserProvider, Contract, Eip1193Provider, JsonRpcProvider, ethers } from 'ethers'
import abiJson from '../abi/SnakeLeaderboard.json'

const abi = (abiJson as { abi: any[] }).abi

const POOL_ADDRESS = import.meta.env.VITE_POOL_ADDRESS as string
const PUBLIC_RPC = (import.meta.env.VITE_PUBLIC_RPC as string) || 'https://sepolia.base.org'
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:8787'
function useProviders() {
  const [wallet, setWallet] = useState<BrowserProvider | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const rpc = useMemo(() => new JsonRpcProvider(PUBLIC_RPC), [])

  const connect = useCallback(async () => {
    const eth = (window as any).ethereum as Eip1193Provider | undefined
    if (!eth) throw new Error('No injected wallet found (MetaMask)')
    const browser = new BrowserProvider(eth)
    await browser.send('eth_requestAccounts', [])
    const signer = await browser.getSigner()
    setWallet(browser)
    setAccount(await signer.getAddress())
  }, [])

  return { wallet, account, rpc, connect }
}

function usePool(rpc: JsonRpcProvider) {
  const pool = useMemo(() => new Contract(POOL_ADDRESS, abi, rpc), [rpc])
  return pool
}

function toHex32(bytes: Uint8Array) { return ethers.hexlify(bytes) }

// Simple Snake implementation (unchanged core gameplay)
type Vec = { x: number, y: number }
const GRID = 20

type SnakeGameProps = {
  onBeginRun: () => Promise<boolean>
  onGameOver: (score: number, runHash: string, payload?: any) => void
  canStart: boolean
  starting: boolean
  sessionId: string | null
  seed: string | null
  submittingScore: boolean
  score: number
  setScore: React.Dispatch<React.SetStateAction<number>>
}

function SnakeGame({ onBeginRun, onGameOver, canStart, starting, sessionId, seed, submittingScore, score, setScore }: SnakeGameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef<HTMLDivElement | null>(null)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const [primed, setPrimed] = useState(false)
  const [cellSize, setCellSize] = useState<number>(20)
  const dirRef = useRef<Vec>({ x: 1, y: 0 })
  const snakeRef = useRef<Vec[]>([{ x: 5, y: 10 }])
  const foodRef = useRef<Vec>({ x: 10, y: 10 })
  const inputsRef = useRef<any[]>([])
  const frameRef = useRef(0)
  const loopRef = useRef<number | null>(null)
  const beatsRef = useRef<any[]>([])
  const hbTimerRef = useRef<number | null>(null)
  const hbCounterRef = useRef<number>(0)
  const baseTickMs = 140
  const minTickMs = 60
  const tickMsRef = useRef<number>(baseTickMs)
  type GameState = 'idle' | 'primed' | 'running' | 'ended'
  const stateRef = useRef<GameState>('idle')

  const reset = () => {
    setScore(0)
    dirRef.current = { x: 1, y: 0 }
    snakeRef.current = [{ x: 5, y: 10 }]
    foodRef.current = { x: 10, y: 10 }
    inputsRef.current = []
    frameRef.current = 0
    tickMsRef.current = baseTickMs
  }

  const rngRef = useRef<(() => number) | null>(null)
  useEffect(() => {
    if (!seed) { rngRef.current = null; return }
    const hex = seed.replace(/^0x/, '')
    let h = 0
    for (let i = 0; i < hex.length; i += 8) {
      h ^= parseInt(hex.slice(i, i + 8), 16) >>> 0
    }
    let t = h >>> 0
    rngRef.current = function() {
      t += 0x6D2B79F5
      let r = Math.imul(t ^ (t >>> 15), 1 | t)
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296
    }
  }, [seed])

  const placeFood = () => {
    const rnd = rngRef.current || Math.random
    foodRef.current = {
      x: Math.floor(rnd() * GRID),
      y: Math.floor(rnd() * GRID)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!running) return
      let handled = false
      let d = dirRef.current
      if ((e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') && d.y !== 1) { d = { x: 0, y: -1 }; handled = true }
      if ((e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') && d.y !== -1) { d = { x: 0, y: 1 }; handled = true }
      if ((e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') && d.x !== 1) { d = { x: -1, y: 0 }; handled = true }
      if ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && d.x !== -1) { d = { x: 1, y: 0 }; handled = true }
      if (handled) {
        e.preventDefault()
        dirRef.current = d
        inputsRef.current.push({ f: frameRef.current, key: e.key, d })
      }
    }
    window.addEventListener('keydown', onKey, { passive: false })
    return () => window.removeEventListener('keydown', onKey as any)
  }, [running])

  const end = () => {
    setRunning(false)
    runningRef.current = false
    if (loopRef.current) {
      cancelAnimationFrame(loopRef.current)
      loopRef.current = null
    }
    stateRef.current = 'ended'
    const runHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(inputsRef.current)))
    onGameOver(score, runHash, { inputs: inputsRef.current.slice(), beats: beatsRef.current.slice(), sessionId })
  }

  const step = () => {
    if (!runningRef.current) return
    if (stateRef.current !== 'running') return
    frameRef.current += 1
    const ctx = canvasRef.current!.getContext('2d')!
    const head = { ...snakeRef.current[0] }
    head.x += dirRef.current.x
    head.y += dirRef.current.y
    const outOfBounds = head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID
    const intoSelf = snakeRef.current.some((s, i) => i > 0 && s.x === head.x && s.y === head.y)
    if (outOfBounds || intoSelf) {
      end(); return
    }
    snakeRef.current.unshift(head)
    if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
      setScore((s) => {
        const next = s + 1
        tickMsRef.current = Math.max(minTickMs, baseTickMs - next * 10)
        return next
      })
      placeFood()
    } else {
      snakeRef.current.pop()
    }
    ctx.clearRect(0, 0, GRID * cellSize, GRID * cellSize)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, GRID * cellSize, GRID * cellSize)
    ctx.fillStyle = '#4ade80'
    const segSize = Math.max(cellSize - 2, 1)
    snakeRef.current.forEach(seg => ctx.fillRect(seg.x * cellSize, seg.y * cellSize, segSize, segSize))
    ctx.fillStyle = '#f59e0b'
    ctx.fillRect(foodRef.current.x * cellSize, foodRef.current.y * cellSize, segSize, segSize)
  }

  const lastTickRef = useRef<number>(0)
  const loop = (ts?: number) => {
    loopRef.current = requestAnimationFrame(loop)
    if (stateRef.current !== 'running') return
    const now = ts ?? performance.now()
    if (now - lastTickRef.current >= tickMsRef.current) {
      lastTickRef.current = now
      step()
    }
  }

  const startLoop = () => {
    if (loopRef.current !== null) return
    loopRef.current = requestAnimationFrame(loop)
  }

  const stopLoop = () => {
    if (loopRef.current !== null) {
      cancelAnimationFrame(loopRef.current)
      loopRef.current = null
    }
  }

  useEffect(() => () => stopLoop(), [])

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      const wrapper = wrapRef.current
      if (!canvas || !wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const margin = 16
      const controlsH = controlsRef.current ? controlsRef.current.offsetHeight : 100
      const availW = Math.max(120, wrapper.clientWidth - 2)
      const availH = Math.max(120, window.innerHeight - rect.top - margin - controlsH)
      const side = Math.floor(Math.min(availW, availH))
      const px = Math.max(8, Math.floor(side / GRID))
      setCellSize(px)
      canvas.width = GRID * px
      canvas.height = GRID * px
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    if (!sessionId) {
      if (hbTimerRef.current) { window.clearInterval(hbTimerRef.current); hbTimerRef.current = null }
      stopLoop()
      setRunning(false)
      runningRef.current = false
      stateRef.current = 'idle'
      setPrimed(false)
      return
    }
  }, [sessionId])

  useEffect(() => {
    if (hbTimerRef.current) { window.clearInterval(hbTimerRef.current); hbTimerRef.current = null }
    beatsRef.current = []
    hbCounterRef.current = 0
    if (sessionId) {
      hbTimerRef.current = window.setInterval(async () => {
        try {
          const i = ++hbCounterRef.current
          const resp = await fetch(`${SERVER_URL}/heartbeat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, i })
          })
          if (!resp.ok) return
          const hb = await resp.json()
          beatsRef.current.push(hb)
        } catch {}
      }, 300) as any
    }
    return () => {
      if (hbTimerRef.current) { window.clearInterval(hbTimerRef.current); hbTimerRef.current = null }
    }
  }, [sessionId])

  const handleStart = async () => {
    if (runningRef.current) return
    if (!primed) {
      const ok = await onBeginRun()
      if (ok) {
        setPrimed(true)
        stateRef.current = 'primed'
      }
      return
    }
    reset()
    setRunning(true)
    runningRef.current = true
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    lastTickRef.current = performance.now()
    tickMsRef.current = baseTickMs
    canvasRef.current?.focus()
    stateRef.current = 'running'
    setPrimed(false)
    startLoop()
  }

  return (
    <div ref={wrapRef} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative', width: `${GRID * cellSize}px`, height: `${GRID * cellSize}px` }}>
        <canvas
          ref={canvasRef}
          style={{
            border: '1px solid #333',
            width: `${GRID * cellSize}px`,
            height: `${GRID * cellSize}px`,
            display: 'block'
          }}
          tabIndex={0}
        />
      </div>
      <div ref={controlsRef} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>Score: {score}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleStart} disabled={!canStart || running || starting}>
            {starting ? 'Processing entry…' : running ? 'Running…' : primed ? 'Press Start' : 'Pay Entry'}
          </button>
        </div>
        {submittingScore && (
          <div style={{ fontSize: 12, opacity: 0.85, color: '#fbbf24' }}>Check MetaMask to confirm score submission so your run lands on the leaderboard.</div>
        )}
        <div style={{ fontSize: 12, opacity: 0.7 }}>When a run ends, a final wallet confirmation submits your score on-chain.</div>
        {primed && !running && !starting && (
          <div style={{ fontSize: 12, opacity: 0.8 }}>Entry paid — press Start when you&apos;re ready to play.</div>
        )}
      </div>
    </div>
  )
}

type LeaderboardRow = { player: string, score: bigint, sessionId: string, updatedAt: bigint }

type PlayerSummary = { bestScore: bigint, runs: bigint, bestRank: number }

export default function App() {
  const { rpc, wallet, account, connect } = useProviders()
  const pool = usePool(rpc)
  const [entryFeeWei, setEntryFeeWei] = useState<bigint>(0n)
  const [score, setScore] = useState<number>(0)
  const [startingRun, setStartingRun] = useState(false)
  const [session, setSession] = useState<{ id: string, seed: string } | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [seed, setSeed] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([])
  const [playerSummary, setPlayerSummary] = useState<PlayerSummary | null>(null)
  const [submittingScore, setSubmittingScore] = useState(false)

  const refreshConfig = useCallback(async () => {
    try {
      const [entryFee] = await Promise.all([
        pool.entryFeeWei()
      ])
      setEntryFeeWei(BigInt(entryFee))
    } catch (e) {
      console.error('config fetch failed', e)
    }
  }, [pool])

  const refreshLeaderboard = useCallback(async () => {
    try {
      const rows = await pool.getLeaderboard()
      const mapped = rows
        .map((r: any) => ({
          player: r.player,
          score: BigInt(r.score),
          sessionId: r.sessionId,
          updatedAt: BigInt(r.updatedAt ?? 0)
        }))
        .sort((a, b) => {
          if (a.score === b.score) {
            if (a.updatedAt === b.updatedAt) return 0
            return a.updatedAt > b.updatedAt ? -1 : 1
          }
          return a.score > b.score ? -1 : 1
        })
        .slice(0, 25)
      setLeaderboard(mapped)
    } catch (e) {
      console.error('leaderboard fetch failed', e)
    }
  }, [pool])

  const refreshPlayerSummary = useCallback(async (addr?: string | null) => {
    try {
      if (!addr) { setPlayerSummary(null); return }
      const stats = await pool.getPlayer(addr)
      setPlayerSummary({ bestScore: BigInt(stats.bestScore), runs: BigInt(stats.runs), bestRank: Number(stats.bestRank) })
    } catch (e) {
      console.error('player summary fetch failed', e)
    }
  }, [pool])

  useEffect(() => {
    refreshConfig()
    refreshLeaderboard()
  }, [refreshConfig, refreshLeaderboard])

  useEffect(() => {
    const id = setInterval(() => {
      refreshLeaderboard()
      refreshPlayerSummary(account)
    }, 1000)
    return () => clearInterval(id)
  }, [refreshLeaderboard, refreshPlayerSummary, account])

  useEffect(() => {
    refreshPlayerSummary(account)
  }, [account, refreshPlayerSummary])

  const ensureSession = useCallback(async () => {
    if (!account) throw new Error('Connect wallet')
    try {
      const resp = await fetch(`${SERVER_URL}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account })
      })
      if (!resp.ok) throw new Error(`session failed (${resp.status})`)
      const json = await resp.json()
      setSession(json)
      setSeed(json.seed)
      return json
    } catch (e) {
      console.error(e)
      throw e
    }
  }, [account])

  const onBeginRun = useCallback(async (): Promise<boolean> => {
    if (!wallet || !account) {
      alert('Connect your wallet first')
      return false
    }
    if (entryFeeWei === 0n) {
      alert('Entry fee not configured yet')
      return false
    }
    try {
      setStartingRun(true)
      const sess = await ensureSession()
      const signer = await wallet.getSigner()
      const write = new Contract(POOL_ADDRESS, abi, signer)
      const tx = await (write as any).startRun(sess.sessionId, { value: entryFeeWei })
      setActiveSessionId(sess.sessionId)
      setSeed(sess.seed)
      await tx.wait()
      return true
    } catch (e: any) {
      alert(`Start failed: ${e?.shortMessage || e?.message || e}`)
      return false
    } finally {
      setStartingRun(false)
    }
  }, [wallet, account, entryFeeWei, ensureSession])

  const onGameOver = useCallback(async (score: number, runHash: string, payload?: any) => {
    if (!wallet || !account || !activeSessionId) return
    try {
      setSubmittingScore(true)
      const signer = await wallet.getSigner()
      const write = new Contract(POOL_ADDRESS, abi, signer)
      if (!(payload?.inputs && payload?.beats)) {
        throw new Error('Missing gameplay transcripts. Please start a new run.')
      }
      console.log('[client] submitting run', {
        score,
        runHash,
        inputsLen: payload.inputs?.length
      })
      const resp = await fetch(`${SERVER_URL}/verify-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, address: account, score: Number(score), runHash, inputs: payload.inputs, beats: payload.beats })
      })
      if (!resp.ok) throw new Error('verification failed')
      const { timeDigest, attestSig, score: canonicalScore } = await resp.json()
      const finalScore = canonicalScore != null ? BigInt(canonicalScore) : BigInt(score)
      if (finalScore !== BigInt(score)) {
        console.log('[client] canonical score differs', { localScore: score, finalScore: finalScore.toString() })
      }
      setScore(Number(finalScore))
      const runPayload = { player: account, sessionId: activeSessionId, score: finalScore, runHash, timeDigest }
      const tx = await (write as any).submitScore(runPayload, attestSig)
      await tx.wait()
      await Promise.all([refreshLeaderboard(), refreshPlayerSummary(account)])
    } catch (e:any) {
      alert(`Submit failed: ${e?.shortMessage || e?.message || e}`)
    } finally {
      setActiveSessionId(null)
      setSeed(null)
      setSession(null)
      setSubmittingScore(false)
    }
  }, [wallet, account, activeSessionId, refreshLeaderboard, refreshPlayerSummary])

  const canStart = !!account && entryFeeWei > 0n

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', color: '#e5e7eb', background: '#0b1020', minHeight: '100vh' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: 16 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>Token Snake — Endless Leaderboard</h1>
            <div style={{ opacity: 0.7 }}>Pay {ethers.formatEther(entryFeeWei)} ETH to start. Each run records a single score.</div>
          </div>
          <button onClick={connect}>{account ? `Connected: ${account.slice(0,6)}...${account.slice(-4)}` : 'Connect Wallet'}</button>
        </header>

        <section style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <SnakeGame
            onBeginRun={onBeginRun}
            onGameOver={onGameOver}
            canStart={canStart}
            starting={startingRun}
            sessionId={activeSessionId}
            seed={seed}
            submittingScore={submittingScore}
            score={score}
            setScore={setScore}
          />

          <aside style={{ flex: '1 1 320px', background: '#111827', borderRadius: 12, padding: 16, border: '1px solid #1f2937' }}>
            <h2 style={{ marginBottom: 12 }}>Top 25 Scores</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Array.from({ length: 25 }, (_, idx) => {
                const row = leaderboard[idx] ?? null
                const isSelf = row && account && row.player.toLowerCase() === account.toLowerCase()
                return (
                  <div
                    key={row ? row.sessionId : `empty-${idx}`}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '6px 10px',
                      borderRadius: 8,
                      background: isSelf ? '#1d4ed8' : '#1f2937',
                      opacity: row ? 1 : 0.4
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{idx + 1}.</div>
                    <div style={{ flex: '1 1 auto', marginLeft: 8 }}>
                      {row ? `${row.player.slice(0, 6)}...${row.player.slice(-4)}` : '—'}
                    </div>
                    <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {row ? row.score.toString() : '—'}
                    </div>
                  </div>
                )
              })}
            </div>
            {playerSummary && (
              <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: '#0f172a', border: '1px solid #1e293b' }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>Your Stats</div>
                <div>Runs played: {playerSummary.runs.toString()}</div>
                <div>Personal best: {playerSummary.bestScore.toString()}</div>
                <div>Best leaderboard rank: {playerSummary.bestRank > 0 ? `#${playerSummary.bestRank}` : '—'}</div>
              </div>
            )}
          </aside>
        </section>
      </div>
    </div>
  )
}
