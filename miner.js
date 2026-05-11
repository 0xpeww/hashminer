require("dotenv").config();

const { ethers }     = require("ethers");
const { execFile }   = require("child_process");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os             = require("os");
const fs             = require("fs");
const path           = require("path");

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════
const RPC_URL          = process.env.RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const GPU_BINARY       = process.env.GPU_BINARY   || path.join(__dirname, "miner_gpu");
const BATCH_SIZE       = process.env.BATCH_SIZE   || "67108864";   // 64M per GPU per batch
const NUM_CPU_CORES    = parseInt(process.env.CORES) || os.cpus().length;
const CPU_FALLBACK     = process.env.CPU_FALLBACK !== "false";
const LOG_FILE         = path.join(__dirname, "miner.log");

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

// ═══════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

function checkEnv() {
  if (!RPC_URL || !PRIVATE_KEY) { log("ERROR: Set RPC_URL dan PRIVATE_KEY di .env"); process.exit(1); }
  if (!PRIVATE_KEY.startsWith("0x")) { log("ERROR: PRIVATE_KEY harus 0x..."); process.exit(1); }
}

// ═══════════════════════════════════════════════════
// DETECT GPUs
// ═══════════════════════════════════════════════════
function detectGPUs() {
  return new Promise((resolve) => {
    if (!fs.existsSync(GPU_BINARY)) { resolve([]); return; }
    execFile("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"],
      { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) { resolve([]); return; }
        const gpus = stdout.trim().split("\n").map((line, i) => ({
          id: i,
          name: line.split(",")[0].trim()
        }));
        resolve(gpus);
      }
    );
  });
}

// ═══════════════════════════════════════════════════
// SINGLE GPU BATCH
// ═══════════════════════════════════════════════════
function gpuBatch(challenge, diffHex, startNonce, gpuId) {
  return new Promise((resolve, reject) => {
    execFile(
      GPU_BINARY,
      [challenge, diffHex, startNonce.toString(), BATCH_SIZE, gpuId.toString()],
      { timeout: 300_000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`GPU[${gpuId}] error: ${err.message}`));
        const out = stdout.trim();
        if (out.startsWith("FOUND")) {
          const p = out.split(" ");
          resolve({ found: true, nonce: p[1], hash: p[2], gpuId });
        } else {
          resolve({ found: false, gpuId });
        }
      }
    );
  });
}

// ═══════════════════════════════════════════════════
// MULTI-GPU MINING ROUND
// Semua GPU jalan paralel, masing-masing cari nonce
// di range nonce yang BERBEDA agar tidak overlap
// ═══════════════════════════════════════════════════
async function mineWithGPUs(challenge, diffHex, gpus) {
  const numGPUs  = gpus.length;
  const batch    = BigInt(BATCH_SIZE);
  const t0       = Date.now();
  let   total    = 0n;
  let   peakRate = 0;

  // Random base nonce, tiap GPU dapat slice berbeda
  const BASE = BigInt(Math.floor(Math.random() * 1e15));

  const ticker = setInterval(() => {
    const secs = (Date.now() - t0) / 1000;
    const rate = Math.floor(Number(total) / secs);
    if (rate > peakRate) peakRate = rate;
    process.stdout.write(
      `\r  \x1b[33m${rate.toLocaleString()}\x1b[0m H/s` +
      ` | ${(Number(total)/1e9).toFixed(2)} GH` +
      ` | peak ${peakRate.toLocaleString()} H/s` +
      ` | ${numGPUs} GPU | ${secs.toFixed(0)}s   `
    );
  }, 1000);

  try {
    let round = 0n;
    while (true) {
      // Tiap GPU: start_nonce = BASE + (gpuId + round*numGPUs) * batch
      const promises = gpus.map(gpu => {
        const startNonce = BASE + (BigInt(gpu.id) + round * BigInt(numGPUs)) * batch;
        return gpuBatch(challenge, diffHex, startNonce, gpu.id);
      });

      const results = await Promise.all(promises);
      total += batch * BigInt(numGPUs);

      const found = results.find(r => r.found);
      if (found) {
        clearInterval(ticker);
        process.stdout.write("\n");
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = Math.floor(Number(total) / parseFloat(secs));
        log(`✅ GPU[${found.gpuId}] menemukan nonce!`);
        return { nonce: found.nonce, hash: found.hash, secs, rate, totalAttempts: Number(total), mode: "GPU" };
      }

      round++;
    }
  } catch (e) {
    clearInterval(ticker);
    throw e;
  }
}

// ═══════════════════════════════════════════════════
// CPU FALLBACK (worker_threads)
// ═══════════════════════════════════════════════════
function workerStartNonce(id, total) {
  const MAX   = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  const slice = MAX / BigInt(total);
  return (slice * BigInt(id) + BigInt(Math.floor(Math.random() * 999_999))).toString();
}

function mineWithCPU(challenge, difficulty) {
  log(`🔧 CPU Fallback: ${NUM_CPU_CORES} cores`);
  return new Promise((resolve, reject) => {
    const workers = [];
    const wAttempts = new Array(NUM_CPU_CORES).fill(0);
    let found = false, total = 0, peak = 0;
    const t0 = Date.now();
    const REPORT = 1_000_000;

    const ticker = setInterval(() => {
      const secs = (Date.now() - t0) / 1000;
      const rate = Math.floor(total / secs);
      if (rate > peak) peak = rate;
      process.stdout.write(
        `\r  \x1b[32m${rate.toLocaleString()}\x1b[0m H/s` +
        ` | ${(total/1e6).toFixed(1)}M | peak ${peak.toLocaleString()} H/s` +
        ` | ${NUM_CPU_CORES} CPU | ${secs.toFixed(0)}s   `
      );
    }, 1000);

    for (let i = 0; i < NUM_CPU_CORES; i++) {
      const w = new Worker(__filename, {
        workerData: { challenge, difficulty, startNonce: workerStartNonce(i, NUM_CPU_CORES), workerId: i, REPORT }
      });
      w.on("message", msg => {
        if (msg.type === "progress") { total += msg.attempts - wAttempts[msg.workerId]; wAttempts[msg.workerId] = msg.attempts; }
        if (msg.type === "found" && !found) {
          found = true;
          clearInterval(ticker);
          workers.forEach(w => { try { w.terminate(); } catch(_){} });
          process.stdout.write("\n");
          const secs = ((Date.now()-t0)/1000).toFixed(1);
          resolve({ nonce: msg.nonce, hash: msg.hash, secs, rate: Math.floor(total/parseFloat(secs)), totalAttempts: total, mode: "CPU" });
        }
      });
      w.on("error", err => { if (!found) { found=true; clearInterval(ticker); reject(err); } });
      workers.push(w);
    }
  });
}

// ═══════════════════════════════════════════════════
// CPU WORKER THREAD
// ═══════════════════════════════════════════════════
if (!isMainThread) {
  const { challenge, difficulty, startNonce, workerId, REPORT } = workerData;
  const cb = Buffer.from(challenge.slice(2), "hex");
  const packed = Buffer.allocUnsafe(64); cb.copy(packed, 0);
  const nb = Buffer.allocUnsafe(32);
  const db = Buffer.from(BigInt(difficulty).toString(16).padStart(64,"0"), "hex");
  let nonce = BigInt(startNonce), attempts = 0;

  const wBE = (buf, val) => { let v=val; for(let i=31;i>=0;i--){buf[i]=Number(v&0xffn);v>>=8n;} };
  const ltBuf = (a,b) => { for(let i=0;i<32;i++){if(a[i]<b[i])return true;if(a[i]>b[i])return false;} return false; };

  let hashFn = null;
  try { const {keccak256}=require("js-sha3"); hashFn=(b)=>Buffer.from(keccak256.arrayBuffer(b)); hashFn(Buffer.alloc(1)); } catch(_){}
  if (!hashFn) { try { const K=require("keccak"); hashFn=(b)=>K("keccak256").update(b).digest(); hashFn(Buffer.alloc(1)); } catch(_){} }

  if (hashFn) {
    while (true) {
      wBE(nb,nonce); nb.copy(packed,32);
      const h=hashFn(packed); attempts++;
      if (ltBuf(h,db)) { parentPort.postMessage({type:"found",nonce:nonce.toString(),hash:"0x"+h.toString("hex"),workerId}); break; }
      nonce++;
      if (attempts%REPORT===0) parentPort.postMessage({type:"progress",attempts,workerId});
    }
  } else {
    const {solidityPackedKeccak256}=require("ethers");
    const dBig=BigInt(difficulty);
    while (true) {
      const h=solidityPackedKeccak256(["bytes32","uint256"],[challenge,nonce]); attempts++;
      if (BigInt(h)<dBig) { parentPort.postMessage({type:"found",nonce:nonce.toString(),hash:h,workerId}); break; }
      nonce++;
      if (attempts%REPORT===0) parentPort.postMessage({type:"progress",attempts,workerId});
    }
  }

// ═══════════════════════════════════════════════════
// MAIN THREAD
// ═══════════════════════════════════════════════════
} else {

  function diffToHex(d) { return "0x"+BigInt(d).toString(16).padStart(64,"0"); }

  let totalMints=0, totalHashes=0, peakRate=0;
  const t0session = Date.now();

  async function main() {
    checkEnv();

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    const gpus = await detectGPUs();

    log("==========================================");
    log("  HASH256 Multi-GPU + CPU Hybrid Miner");
    log("==========================================");
    log(`Wallet      : ${wallet.address}`);
    log(`Contract    : ${CONTRACT_ADDRESS}`);
    if (gpus.length > 0) {
      log(`GPUs        : ${gpus.length}x GPU terdeteksi`);
      gpus.forEach(g => log(`  GPU[${g.id}]  : ${g.name}`));
    } else {
      log(`GPUs        : ❌ tidak ada — pakai CPU`);
    }
    log(`CPU Cores   : ${NUM_CPU_CORES} (fallback)`);
    log(`Batch Size  : ${parseInt(BATCH_SIZE).toLocaleString()} nonce/GPU/batch`);
    log(`Log         : ${LOG_FILE}`);
    log("");

    let useGPU = gpus.length > 0;
    let errors = 0;

    while (true) {
      try {
        const [state, challenge] = await Promise.all([
          contract.miningState(),
          contract.getChallenge(wallet.address),
        ]);

        const difficulty = state.difficulty.toString();
        const diffHex    = diffToHex(difficulty);
        const epochNow   = state.epoch.toString();
        const uptime     = ((Date.now()-t0session)/60000).toFixed(1);

        log("------------------------------------------");
        log(`Era        : ${state.era}`);
        log(`Reward     : ${ethers.formatUnits(state.reward,18)} HASH`);
        log(`Difficulty : ${difficulty}`);
        log(`Epoch      : ${epochNow} | Remaining: ${state.remaining} blok`);
        log(`Challenge  : ${challenge}`);
        log(`Session    : ${totalMints} mints | ${(totalHashes/1e9).toFixed(2)} GH | uptime ${uptime} mnt`);
        if (useGPU) log(`Mining dengan ${gpus.length} GPU paralel...`);
        else        log(`Mining dengan ${NUM_CPU_CORES} CPU cores...`);

        let result;
        if (useGPU) {
          try {
            result = await mineWithGPUs(challenge, diffHex, gpus);
          } catch (e) {
            log(`⚠️  GPU error: ${e.message} — fallback CPU`);
            useGPU = false;
            result = await mineWithCPU(challenge, difficulty);
          }
        } else if (CPU_FALLBACK) {
          result = await mineWithCPU(challenge, difficulty);
        } else {
          log("ERROR: GPU tidak ada dan CPU_FALLBACK=false"); process.exit(1);
        }

        totalHashes += result.totalAttempts;
        if (result.rate > peakRate) peakRate = result.rate;

        log(`Nonce      : ${result.nonce}`);
        log(`Hash       : ${result.hash}`);
        log(`Round      : ${result.secs}s | ${result.rate.toLocaleString()} H/s | peak ${peakRate.toLocaleString()} H/s [${result.mode}]`);

        // Cek epoch
        const fresh = await contract.miningState();
        if (fresh.epoch.toString() !== epochNow) {
          log("⚠️  Epoch berubah — skip, ulang ronde..."); errors=0; continue;
        }

        // Kirim TX
        try {
          let gas;
          try { gas = await contract.mine.estimateGas(BigInt(result.nonce)); }
          catch (e) { log(`⚠️  Gas estimate gagal: ${e.shortMessage||e.message}`); continue; }
          log("Mengirim TX...");
          const tx = await contract.mine(BigInt(result.nonce), { gasLimit: gas+15000n });
          log(`TX         : ${tx.hash}`);
          const receipt = await tx.wait();
          if (receipt.status===1) {
            totalMints++;
            const uptime = ((Date.now()-t0session)/60000).toFixed(1);
            log(`✓ MINT #${totalMints} | Block: ${receipt.blockNumber} | Uptime: ${uptime} mnt`);
            log(`  Total: ${(totalHashes/1e9).toFixed(2)} GH | Peak: ${peakRate.toLocaleString()} H/s`);
          } else {
            log("✗ TX reverted");
          }
        } catch (txErr) {
          log(`✗ TX error: ${txErr.shortMessage||txErr.message}`);
        }

        errors = 0;

      } catch (err) {
        errors++;
        log(`ERROR #${errors}: ${err.shortMessage||err.message}`);
        const wait = Math.min(3000*Math.pow(2,errors-1), 60_000);
        log(`Retry dalam ${wait/1000}s...`);
        await new Promise(r=>setTimeout(r,wait));
      }
    }
  }

  process.on("SIGINT",  ()=>{ log(`\nStop. Mints: ${totalMints} | Peak: ${peakRate.toLocaleString()} H/s`); process.exit(0); });
  process.on("SIGTERM", ()=>{ log(`\nStop. Mints: ${totalMints} | Peak: ${peakRate.toLocaleString()} H/s`); process.exit(0); });
  main().catch(err=>{ log(`FATAL: ${err.message}`); process.exit(1); });
}
