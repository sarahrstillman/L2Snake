import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserProvider, Contract, Eip1193Provider, JsonRpcProvider, ethers } from 'ethers'
import abi from '../abi/DailyPrizePool.json'

const POOL_ADDRESS = import.meta.env.VITE_POOL_ADDRESS as string
const PUBLIC_RPC = (import.meta.env.VITE_PUBLIC_RPC as string) || 'https://sepolia.base.org'

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

function SnakeGame({ onGameOver, onRequestContinue, continueFeeWei, onClaim, canStart, entering }: { onGameOver: (score: number, runHash: string, inputStream: any[]) => void, onRequestContinue: () => Promise<boolean>, continueFeeWei: bigint, onClaim: () => Promise<void>, canStart: boolean, entering: boolean }) {
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

  const placeFood = () => {
    foodRef.current = {
      x: Math.floor(Math.random() * GRID),
      y: Math.floor(Math.random() * GRID)
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
    onGameOver(score, runHash, inputsRef.current)
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
  }

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
          <button onClick={start} disabled={running || !canStart}>{entering ? 'Entering…' : 'Start'}</button>
          <button onClick={onClaim}>Claim (single‑winner)</button>
        </div>
        <div><b>Continue fee:</b> {ethers.formatEther(continueFeeWei)} ETH</div>
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
  const [isEntering, setIsEntering] = useState<boolean>(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [nowTick, setNowTick] = useState<number>(nowSec())

  // Load round state
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

  // 1-second ticker to keep countdown fresh
  useEffect(() => {
    const id = setInterval(() => setNowTick(nowSec()), 1000)
    return () => clearInterval(id)
  }, [])

  const timeLeft = () => {
    if (!round) return { enter: 0, reveal: 0 }
    const now = nowTick
    return { enter: Math.max(0, round.enterClosesAt - now), reveal: Math.max(0, round.revealClosesAt - now) }
  }

  const onEnter = useCallback(async () => {
    if (!wallet || !account || !round) return alert('Connect wallet first')
    const signer = await wallet.getSigner()
    const write = new Contract(POOL_ADDRESS, abi, signer)
    const nonce = toHex32(ethers.randomBytes(32))
    const commit = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
      'bytes32','address','uint256'
    ], [nonce, account, BigInt(round.roundId)]))
    setIsEntering(true)
    const tx = await write.enterDaily(round.roundId, commit, { value: round.entryFeeWei })
    // Show the tx link immediately so it feels snappy
    setEntryTx(tx.hash)
    // After confirmation, persist nonce and keep the final hash
    const rcpt = await tx.wait()
    setCommitNonce(nonce)
    setEnteredRoundId(round.roundId)
    setEntryTx(rcpt?.hash ?? tx.hash)
    setIsEntering(false)
    // Store nonce locally per round
    localStorage.setItem(`nonce:${round.roundId}:${account.toLowerCase()}`, nonce)
  }, [wallet, account, round])

  const onGameOver = useCallback(async (score: number, runHash: string) => {
    if (!wallet || !account || !round) return
    const signer = await wallet.getSigner()
    const write = new Contract(POOL_ADDRESS, abi, signer)
    const nonce = commitNonce || localStorage.getItem(`nonce:${round.roundId}:${account.toLowerCase()}`)
    if (!nonce) {
      alert('No nonce found. Enter the round first.')
      return
    }
    const tx = await write.reveal(round.roundId, BigInt(score), runHash, nonce)
    const rcpt = await tx.wait()
    setRevealTx(rcpt?.hash ?? tx.hash)
  }, [wallet, account, round, commitNonce])

  const onRequestContinue = useCallback(async (): Promise<boolean> => {
    if (!wallet || !round) return false
    if (continueFeeWei === 0n) return false
    const ok = window.confirm(`Continue for ${ethers.formatEther(continueFeeWei)} ETH?`)
    if (!ok) return false
    try {
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
      const targetRoundId = enteredRoundId ?? round.roundId
      const tx = await (write as any).payContinue(targetRoundId, { value: continueFeeWei })
      console.log('payContinue sent:', tx.hash)
      await tx.wait()
      return true
    } catch (e:any) {
      alert(`Continue failed: ${e?.shortMessage || e?.message || e}`)
      return false
    }
  }, [wallet, round, continueFeeWei, enteredRoundId])

  

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
              <button onClick={onEnter} disabled={!account}>Enter Round</button>
              {entryTx && <a href={`https://sepolia.basescan.org/tx/${entryTx}`} target="_blank">entry tx</a>}
              {revealTx && <a href={`https://sepolia.basescan.org/tx/${revealTx}`} target="_blank">reveal tx</a>}
            </div>
          </div>
        )}
        <SnakeGame onGameOver={onGameOver} onRequestContinue={onRequestContinue} continueFeeWei={continueFeeWei} onClaim={onClaim} canStart={!!commitNonce && !isEntering} entering={isEntering} />
      </div>
    </div>
  )
}
