import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserProvider, Contract, Eip1193Provider, JsonRpcProvider, ethers } from 'ethers'
import abi from '../abi/DailyPrizePool.json'

const POOL_ADDRESS = import.meta.env.VITE_POOL_ADDRESS as string
const PUBLIC_RPC = (import.meta.env.VITE_PUBLIC_RPC as string) || 'https://sepolia.base.org'
const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) || 'http://localhost:8787'
const MAX_CONTINUES = 3

type RoundState = {
  roundId: number
  enterClosesAt: number
  revealClosesAt: number
  entryFeeWei: bigint
  finalized: boolean
}

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

function nowSec() { return Math.floor(Date.now() / 1000) }

function calcRoundId(epochLength: number, ts: number) {
  return Math.floor(ts / epochLength)
}

function toHex32(bytes: Uint8Array) { return ethers.hexlify(bytes) }

// Simple Snake implementation
type Vec = { x: number, y: number }
const GRID = 20

function SnakeGame({ onGameOver, onRequestContinue, continueFeeWei, onClaim, canStart, entering, frozen, sessionId, seed, preparing, continuesUsed, continuesLimit }: { onGameOver: (score: number, runHash: string, payload: any) => void, onRequestContinue: () => Promise<boolean>, continueFeeWei: bigint, onClaim: () => Promise<void>, canStart: boolean, entering: boolean, frozen: boolean, sessionId: string | null, seed: string | null, preparing: boolean, continuesUsed: number, continuesLimit: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const controlsRef = useRef<HTMLDivElement | null>(null)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const [score, setScore] = useState(0)
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
  // Multiple continues allowed; track only in-flight guard
  const continueInFlightRef = useRef<boolean>(false)
  // Temporary invulnerability frames after continue
  const shieldFramesRef = useRef<number>(0)
  // Simple run-state gate for the loop
  type GameState = 'idle' | 'running' | 'awaiting-continue' | 'ended'
  const stateRef = useRef<GameState>('idle')
  // Short cooldown after resume to ignore new continue prompts
  const resumeCooldownUntilRef = useRef<number>(0)
  const [awaitingContinue, setAwaitingContinue] = useState(false)

  const reset = () => {
    setScore(0)
    dirRef.current = { x: 1, y: 0 }
    snakeRef.current = [{ x: 5, y: 10 }]
    foodRef.current = { x: 10, y: 10 }
    inputsRef.current = []
    frameRef.current = 0
    tickMsRef.current = baseTickMs
  }

  // Seeded RNG (mulberry32)
  const rngRef = useRef<(() => number) | null>(null)
  useEffect(() => {
    if (!seed) { rngRef.current = null; return }
    // seed is hex string (0x...)
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

  const step = () => {
    if (!runningRef.current) return
    if (stateRef.current !== 'running') return
    frameRef.current += 1
    const ctx = canvasRef.current!.getContext('2d')!
    const head = { ...snakeRef.current[0] }
    head.x += dirRef.current.x
    head.y += dirRef.current.y
    // collisions (with short shield after continue)
    const outOfBounds = head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID
    const intoSelf = snakeRef.current.some((s, i) => i > 0 && s.x === head.x && s.y === head.y)
    if (shieldFramesRef.current > 0) {
      shieldFramesRef.current -= 1
    } else if (outOfBounds || intoSelf) {
      // If we're within the cooldown window after a resume, ignore this collision
      if (performance.now() < resumeCooldownUntilRef.current) {
        // Nudge shield one more frame to avoid immediate re-trigger
        shieldFramesRef.current = Math.max(shieldFramesRef.current, 1)
      } else {
      if (continueFeeWei > 0n) {
        // pause and ask parent to pay continue (guard against multiple prompts)
        if (continueInFlightRef.current) return
        continueInFlightRef.current = true
        // stop current RAF so no overlapping steps while awaiting wallet
        if (loopRef.current != null) {
          cancelAnimationFrame(loopRef.current)
          loopRef.current = null
        }
        setRunning(false)
        runningRef.current = false
        stateRef.current = 'awaiting-continue'
        setAwaitingContinue(true)
        ;(async () => {
          const ok = await onRequestContinue()
          continueInFlightRef.current = false
          if (ok) {
            resetAfterContinue()
            // allow a paint before resuming
            await new Promise(requestAnimationFrame)
            setRunning(true)
            runningRef.current = true
            stateRef.current = 'running'
            // Set a 1s cooldown to prevent immediate re-prompt
            resumeCooldownUntilRef.current = performance.now() + 1000
            // restart guarded loop
            if (loopRef.current == null) {
              loopRef.current = requestAnimationFrame(loop)
            }
            setAwaitingContinue(false)
          } else {
            end()
            setAwaitingContinue(false)
          }
        })()
        return
      }
      end(); return
      }
    }
    snakeRef.current.unshift(head)
    if (head.x === foodRef.current.x && head.y === foodRef.current.y) {
      setScore((s) => {
        const next = s + 1
        // increase speed slightly on each food
        tickMsRef.current = Math.max(minTickMs, baseTickMs - next * 10)
        return next
      })
      placeFood()
    } else {
      snakeRef.current.pop()
    }
    // render
    ctx.clearRect(0, 0, GRID * cellSize, GRID * cellSize)
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, GRID * cellSize, GRID * cellSize)
    ctx.fillStyle = '#4ade80'
    const segSize = Math.max(cellSize - 2, 1)
    snakeRef.current.forEach(seg => ctx.fillRect(seg.x * cellSize, seg.y * cellSize, segSize, segSize))
    ctx.fillStyle = '#f59e0b'
    ctx.fillRect(foodRef.current.x * cellSize, foodRef.current.y * cellSize, segSize, segSize)
  }

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

  const start = () => {
    reset()
    setRunning(true)
    runningRef.current = true
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    lastTickRef.current = performance.now()
    tickMsRef.current = baseTickMs
    // focus canvas to ensure keys are captured consistently
    canvasRef.current?.focus()
    stateRef.current = 'running'
    startLoop()
    // start heartbeats if we have a session
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
  }

  // Freeze handling: pause the game immediately when frozen
  useEffect(() => {
    if (!frozen) return
    if (hbTimerRef.current) { window.clearInterval(hbTimerRef.current); hbTimerRef.current = null }
    // cancel any pending continue prompt
    continueInFlightRef.current = false
    setAwaitingContinue(false)
    // stop the loop and pause state
    if (loopRef.current !== null) {
      cancelAnimationFrame(loopRef.current)
      loopRef.current = null
    }
    setRunning(false)
    runningRef.current = false
    stateRef.current = 'idle'
  }, [frozen])

  // Responsive sizing: fit board to available viewport from canvas position
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      const wrapper = wrapRef.current
      if (!canvas || !wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const margin = 16 // bottom padding
      const controlsH = controlsRef.current ? controlsRef.current.offsetHeight : 100
      const availW = Math.max(120, wrapper.clientWidth - 2) // -border
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

  const resetAfterContinue = () => {
    // Re-center the snake to a safe spot and reset direction
    const cx = Math.floor(GRID / 2)
    const cy = Math.floor(GRID / 2)
    snakeRef.current = [{ x: cx, y: cy }]
    dirRef.current = { x: 1, y: 0 }
    // Ensure food is not on the snake
    if (foodRef.current.x === cx && foodRef.current.y === cy) {
      placeFood()
    }
    // Fresh timing and a few safety frames
    frameRef.current = 0
    lastTickRef.current = performance.now()
    tickMsRef.current = baseTickMs
    shieldFramesRef.current = 12
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
        {awaitingContinue && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)', color: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
            <div style={{ background: '#111827', border: '1px solid #374151', borderRadius: 8, padding: 12, minWidth: 220, textAlign: 'center' }}>
              <div style={{ marginBottom: 6 }}>Waiting for wallet…</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Confirm the continue in MetaMask</div>
            </div>
          </div>
        )}
      </div>
      <div ref={controlsRef} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>Score: {score}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={start} disabled={running || !canStart}>{entering ? 'Entering…' : (preparing ? 'Preparing…' : 'Start')}</button>
          <button onClick={onClaim}>Claim (single‑winner)</button>
        </div>
        <div><b>Continue fee:</b> {ethers.formatEther(continueFeeWei)} ETH</div>
        <div><b>Continues used:</b> {continuesUsed} / {continuesLimit}</div>
      </div>
    </div>
  )
}

export default function App() {
  const { rpc, wallet, account, connect } = useProviders()
  const pool = usePool(rpc)
  const [epochLength, setEpochLength] = useState<number>(300)
  const [round, setRound] = useState<RoundState | null>(null)
  const [entryTx, setEntryTx] = useState<string | null>(null)
  const [revealTx, setRevealTx] = useState<string | null>(null)
  const [commitNonce, setCommitNonce] = useState<string | null>(null)
  const [enteredRoundId, setEnteredRoundId] = useState<number | null>(null)
  const [continueFeeWei, setContinueFeeWei] = useState<bigint>(0n)
  const [continueCount, setContinueCount] = useState<number>(0)
  const [isEntering, setIsEntering] = useState<boolean>(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [seed, setSeed] = useState<string | null>(null)
  const sessionReady = !!sessionId && !!seed
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [nowTick, setNowTick] = useState<number>(nowSec())
  const activeRoundId = enteredRoundId ?? round?.roundId ?? null

  // Load initial round state
  useEffect(() => {
    let mounted = true
    ;(async () => {
      const epoch = Number(await pool.epochLength())
      const now = nowSec()
      const rid = calcRoundId(epoch, now)
      const [enterClose, revealClose, feeWei] = await pool.expectedWindows(rid)
      const r = await pool.rounds(rid)
      if (!mounted) return
      setEpochLength(epoch)
      setRound({
        roundId: rid,
        enterClosesAt: Number(enterClose),
        revealClosesAt: Number(revealClose),
        entryFeeWei: BigInt(feeWei),
        finalized: r.finalized as boolean
      })
      if ((pool as any).continueFeeWei) {
        const cf = await (pool as any).continueFeeWei()
        setContinueFeeWei(BigInt(cf))
      }
    })().catch(console.error)
    return () => { mounted = false }
  }, [pool])

  // Intermission and controlled round advance
  const INTERMISSION_SECS = 15
  const COUNTDOWN_SECS = 10
  const [intermissionUntil, setIntermissionUntil] = useState<number | null>(null)
  const [nextRoundId, setNextRoundId] = useState<number | null>(null)

  // Start intermission when the current round's reveal window ends
  useEffect(() => {
    if (!round) return
    if (intermissionUntil != null) return
    // When reveal reaches 0, begin intermission timer
    if (nowTick >= round.revealClosesAt) {
      setIntermissionUntil(nowTick + INTERMISSION_SECS)
      setNextRoundId(round.roundId + 1)
    }
  }, [round, nowTick, intermissionUntil])

  // After intermission, load the next round
  useEffect(() => {
    if (intermissionUntil == null) return
    if (nowTick < intermissionUntil) return
    if (nextRoundId == null) return
    let cancelled = false
    ;(async () => {
      try {
        const [enterClose, revealClose, feeWei] = await pool.expectedWindows(nextRoundId)
        const r = await pool.rounds(nextRoundId)
        if (cancelled) return
        setRound({
          roundId: nextRoundId,
          enterClosesAt: Number(enterClose),
          revealClosesAt: Number(revealClose),
          entryFeeWei: BigInt(feeWei),
          finalized: r.finalized as boolean
        })
        if ((pool as any).continueFeeWei) {
          const cf = await (pool as any).continueFeeWei()
          if (!cancelled) setContinueFeeWei(BigInt(cf))
        }
        // Clear intermission and any prior round-specific client state
        setIntermissionUntil(null)
        setNextRoundId(null)
        setCommitNonce(null)
        setEnteredRoundId(null)
        setEntryTx(null)
        setRevealTx(null)
        setSessionId(null)
        setSeed(null)
        setContinueCount(0)
      } catch (e) {
        console.error(e)
      }
    })()
    return () => { cancelled = true }
  }, [intermissionUntil, nowTick, nextRoundId, pool])

  // 1-second ticker to keep countdown fresh
  useEffect(() => {
    const id = setInterval(() => setNowTick(nowSec()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!account || activeRoundId == null) {
      setContinueCount(0)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const used = await pool.continues(activeRoundId, account)
        if (!cancelled) setContinueCount(Number(used))
      } catch (e) {
        console.error(e)
      }
    })()
    return () => { cancelled = true }
  }, [pool, account, activeRoundId])

  const timeLeft = () => {
    if (!round) return { enter: 0, reveal: 0 }
    const now = nowTick
    return {
      enter: Math.max(0, round.enterClosesAt - now),
      reveal: Math.max(0, round.revealClosesAt - now),
    }
  }

  const onEnter = useCallback(async () => {
    if (!wallet || !account || !round) {
      alert('Connect your wallet first')
      return
    }
    const signer = await wallet.getSigner()
    const write = new Contract(POOL_ADDRESS, abi, signer)
    const nonce = toHex32(ethers.randomBytes(32))
    const commit = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint256'],
      [nonce, account, BigInt(round.roundId)]
    ))

    setIsEntering(true)
    try {
      const tx = await write.enterDaily(round.roundId, commit, { value: round.entryFeeWei })
      setEntryTx(tx.hash)

      // Kick off attestation session immediately so the game can start once mined
      if (!sessionId) {
        try {
          const resp = await fetch(`${SERVER_URL}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roundId: round.roundId, address: account })
          })
          if (resp.ok) {
            const j = await resp.json()
            setSessionId(j.sessionId)
            setSeed(j.seed)
          } else {
            throw new Error(`session request failed (${resp.status})`)
          }
        } catch (e) {
          // Fallback to a local session so gameplay still works offline
          const fallbackId = toHex32(ethers.randomBytes(32))
          setSessionId(fallbackId)
          setSeed(toHex32(ethers.randomBytes(32)))
          console.warn('Falling back to offline session:', e)
        }
      }

      const rcpt = await tx.wait()
      setCommitNonce(nonce)
      setEnteredRoundId(round.roundId)
      setEntryTx(rcpt?.hash ?? tx.hash)
      setContinueCount(0)
      localStorage.setItem(`nonce:${round.roundId}:${account.toLowerCase()}`, nonce)
    } catch (e: any) {
      alert(`Enter failed: ${e?.shortMessage || e?.message || e}`)
    } finally {
      setIsEntering(false)
    }
  }, [wallet, account, round, sessionId])

  const onGameOver = useCallback(async (score: number, runHash: string, payload?: any) => {
    if (!wallet || !account || !round) return
    const signer = await wallet.getSigner()
    const write = new Contract(POOL_ADDRESS, abi, signer)
    try {
      if (!(sessionId && payload?.inputs && payload?.beats)) {
        throw new Error('No attestation session. Please Enter round again to start a verified session.')
      }
      // Ask server to verify and attest
      const resp = await fetch(`${SERVER_URL}/verify-run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, roundId: round.roundId, address: account, score: Number(score), runHash, inputs: payload.inputs, beats: payload.beats })
      })
      if (!resp.ok) throw new Error('verification failed')
      const { timeDigest, attestSig, score: canonicalScore } = await resp.json()
      const usedScore = canonicalScore != null ? BigInt(canonicalScore) : BigInt(score)
      const p = { player: account, dayId: BigInt(round.roundId), sessionId, score: usedScore, runHash, timeDigest }
      const tx = await (write as any).revealWithAttestation(p, attestSig)
      const rcpt = await tx.wait()
      setRevealTx(rcpt?.hash ?? tx.hash)
    } catch (e:any) {
      alert(`Reveal failed: ${e?.shortMessage || e?.message || e}`)
    }
  }, [wallet, account, round, sessionId])

  const onRequestContinue = useCallback(async (): Promise<boolean> => {
    if (!wallet || !round || !account) return false
    if (continueFeeWei === 0n) return false
    const targetRoundId = enteredRoundId ?? round.roundId
    try {
      const usedBefore = Number(await pool.continues(targetRoundId, account))
      if (usedBefore >= MAX_CONTINUES) {
        alert(`Continue limit reached. You've used ${MAX_CONTINUES} continues this round.`)
        return false
      }

      const ok = window.confirm(`Continue for ${ethers.formatEther(continueFeeWei)} ETH?`)
      if (!ok) return false

      const signer = await wallet.getSigner()
      // Ensure user is on Base Sepolia (chainId 84532)
      const net = await signer.provider!.getNetwork()
      if (net.chainId !== 84532n) {
        alert('Please switch your wallet network to Base Sepolia (chainId 84532) and try again.')
        return false
      }
      // Prompt wallet confirmation
      console.log('Submitting payContinue tx. Check your wallet to confirm...')
      const write = new Contract(POOL_ADDRESS, abi, signer)
      const tx = await (write as any).payContinue(targetRoundId, { value: continueFeeWei })
      console.log('payContinue sent:', tx.hash)
      await tx.wait()

      try {
        const usedNow = Number(await pool.continues(targetRoundId, account))
        setContinueCount(usedNow)
      } catch {
        setContinueCount(Math.min(MAX_CONTINUES, usedBefore + 1))
      }
      return true
    } catch (e:any) {
      alert(`Continue failed: ${e?.shortMessage || e?.message || e}`)
      return false
    }
  }, [wallet, round, continueFeeWei, enteredRoundId, account, pool])

  

  const onClaim = useCallback(async () => {
    if (!wallet || !round) return
    const r = await pool.rounds(round.roundId)
    const amount = r.poolWei as bigint
    const signer = await wallet.getSigner()
    const write = new Contract(POOL_ADDRESS, abi, signer)
    try {
      const tx = await write.claim(round.roundId, amount, [])
      await tx.wait()
      alert('Claimed!')
    } catch (e:any) {
      alert(`Claim failed: ${e?.shortMessage || e?.message || e}`)
    }
  }, [wallet, pool, round])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', color: '#e5e7eb', background: '#0b1020', minHeight: '100vh' }}>
      <div ref={containerRef} style={{ maxWidth: 960, margin: '0 auto', padding: 16 }}>
        <h1>Token Snake — 5‑Minute Prize Rounds</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <button onClick={connect}>{account ? `Connected: ${account.slice(0,6)}...${account.slice(-4)}` : 'Connect Wallet'}</button>
          <span>Pool: {POOL_ADDRESS.slice(0, 6)}…{POOL_ADDRESS.slice(-4)}</span>
        </div>

        {round && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
            <div>
              <div><b>Entry fee:</b> {ethers.formatEther(round.entryFeeWei)} ETH</div>
              {(() => {
                const tl = timeLeft();
                const fmt = (s: number) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
                const toUTC = (ts: number) => new Date(ts * 1000).toUTCString();
                return (
                  <>
                    <div><b>Round ends in:</b> {fmt(tl.reveal)}</div>
                    <div><b>Round ends (UTC):</b> {toUTC(round.revealClosesAt)}</div>
                  </>
                );
              })()}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={onEnter} disabled={!account || timeLeft().enter <= 0 || intermissionUntil != null}>Enter Round</button>
              {entryTx && <a href={`https://sepolia.basescan.org/tx/${entryTx}`} target="_blank">entry tx</a>}
              {revealTx && <a href={`https://sepolia.basescan.org/tx/${revealTx}`} target="_blank">reveal tx</a>}
            </div>
          </div>
        )}
        <SnakeGame onGameOver={onGameOver} onRequestContinue={onRequestContinue} continueFeeWei={continueFeeWei} onClaim={onClaim} canStart={!!commitNonce && enteredRoundId === round?.roundId && sessionReady && !isEntering && intermissionUntil == null} entering={isEntering} frozen={!!round && nowTick >= round.revealClosesAt} sessionId={sessionId} seed={seed} preparing={!sessionReady} continuesUsed={continueCount} continuesLimit={MAX_CONTINUES} />

        {intermissionUntil != null && (
          <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.65)', zIndex: 1000 }}>
            <div style={{ textAlign: 'center', color: '#e5e7eb' }}>
              <div style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Next round in…</div>
              {(() => {
                const remain = Math.max(0, intermissionUntil - nowTick)
                const lead = INTERMISSION_SECS - COUNTDOWN_SECS // 5s lead-in
                const showCountdown = remain <= COUNTDOWN_SECS
                const num = Math.max(0, Math.ceil(remain))
                return (
                  <div style={{ fontSize: 96, fontWeight: 800, letterSpacing: 2, lineHeight: 1 }}>
                    {showCountdown ? num : ''}
                  </div>
                )
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
