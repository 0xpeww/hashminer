require("dotenv").config();

const { ethers }    = require("ethers");
const { execFile }  = require("child_process");
const os            = require("os");
const fs            = require("fs");
const path          = require("path");

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const RPC_URL          = process.env.RPC_URL;
const PRIVATE_KEY      = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const GPU_BINARY       = process.env.GPU_BINARY  || path.join(__dirname, "miner_gpu");
const BATCH_SIZE       = process.env.BATCH_SIZE  || "67108864";   // 64M nonce per batch
const LOG_FILE         = path.join(__dirname, "miner.log");
const USE_CPU_FALLBACK = process.env.CPU_FALLBACK !== "false";
const NUM_CPU_CORES    = parseInt(process.env.CORES) || os.cpus().length;

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era,uint256 reward,uint256 difficulty,uint256 minted,uint256 remaining,uint256 epoch,uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)"
];

// ═══════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + "\n");
}

// ═══════════════════════════════════════════════════════════════
// ENV CHECK
// ═══════════════════════════════════════════════════════════════
function checkEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("ERROR: Set RPC_URL dan PRIVATE_KEY di .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x")) {
    console.error("ERROR: PRIVATE_KEY harus diawali 0x");
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
// GPU MINING: jalankan binary CUDA
// ═══════════════════════════════════════════════════════════════
function gpuMineBatch(challenge, difficultyHex, startNonce) {
  return new Promise((resolve, reject) => {
    execFile(
      GPU_BINARY,
      [challenge, difficultyHex, startNonce.toString(), BATCH_SIZE],
      { timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) return reject(err);
        const out = stdout.trim();
        if (out.startsWith("FOUND")) {
          const parts = out.split(" ");
          resolve({ found: true, nonce: parts[1], hash: parts[2] });
        } else {
          resolve({ found: false });
        }
      }
    );
  });
}

// ═══════════════════════════════════════════════════════════════
// GPU MINING ROUND: loop batch sampai nonce ketemu
// ═══════════════════════════════════════════════════════════════
async function mineWithGPU(challenge, difficultyHex) {
  log("🖥️  Mode: CUDA GPU Mining");

  const batch  = BigInt(BATCH_SIZE);
  let nonce    = BigInt(Math.floor(Math.random() * 1e15)); // random start
  let total    = 0n;
  const t0     = Date.now();

  const ticker = setInterval(() => {
    const secs = (Date.now() - t0) / 1000;
    const rate = Number(total) / secs;
    process.stdout.write(
      `\r  \x1b[33m${Math.floor(rate).toLocaleString()}\x1b[0m H/s` +
      ` | ${(Number(total) / 1e9).toFixed(2)} GH` +
      ` | ${secs.toFixed(0)}s [GPU]   `
    );
  }, 1000);

  try {
    while (true) {
      const result = await gpuMineBatch(challenge, difficultyHex, nonce);
      total += batch;

      if (result.found) {
        clearInterval(ticker);
        process.stdout.write("\n");
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = Math.floor(Number(total) / parseFloat(secs));
        return { nonce: result.nonce, hash: result.hash, secs, rate, totalAttempts: Number(total) };
      }

      nonce += batch;
    }
  } catch (e) {
    clearInterval(ticker);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// CPU FALLBACK (worker_threads)
// ═══════════════════════════════════════════════════════════════
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

function workerStartNonce(id, total) {
  const MAX   = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
  const slice = MAX / BigInt(total);
  return (slice * BigInt(id) + BigInt(Math.floor(Math.random() * 999_999))).toString();
}

function mineWithCPU(challenge, difficulty) {
  log(`🔧  Mode: CPU Fallback (${NUM_CPU_CORES} cores)`);
  return new Promise((resolve, reject) => {
    const workers        = [];
    const workerAttempts = new Array(NUM_CPU_CORES).fill(0);
    let found            = false;
    let totalAttempts    = 0;
    let peakRate         = 0;
    const t0             = Date.now();
    const REPORT_EVERY   = 1_000_000;

    const ticker = setInterval(() => {
      const secs = (Date.now() - t0) / 1000;
      const rate = Math.floor(totalAttempts / secs);
      if (rate > peakRate) peakRate = rate;
      process.stdout.write(
        `\r  \x1b[32m${rate.toLocaleString()}\x1b[0m H/s` +
        ` | ${(totalAttempts / 1e6).toFixed(1)}M hashes` +
        ` | peak ${peakRate.toLocaleString()} H/s` +
        ` | ${NUM_CPU_CORES} cores | ${secs.toFixed(0)}s [CPU]   `
      );
    }, 1000);

    for (let i = 0; i < NUM_CPU_CORES; i++) {
      const w = new Worker(__filename, {
        workerData: { challenge, difficulty, startNonce: workerStartNonce(i, NUM_CPU_CORES), workerId: i, REPORT_EVERY }
      });
      w.on("message", (msg) => {
        if (msg.type === "progress") {
          totalAttempts += msg.attempts - workerAttempts[msg.workerId];
          workerAttempts[msg.workerId] = msg.attempts;
        }
        if (msg.type === "found" && !found) {
          found = true;
          clearInterval(ticker);
          workers.forEach(w => { try { w.terminate(); } catch (_) {} });
          const secs = ((Date.now() - t0) / 1000).toFixed(1);
          const rate = Math.floor(totalAttempts / parseFloat(secs));
          process.stdout.write("\n");
          resolve({ nonce: msg.nonce, hash: msg.hash, secs, rate, totalAttempts });
        }
      });
      w.on("error", (err) => {
        if (!found) { found = true; clearInterval(ticker); reject(err); }
      });
      workers.push(w);
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// CPU WORKER THREAD CODE
// ═══════════════════════════════════════════════════════════════
if (!isMainThread) {
  const { challenge, difficulty, startNonce, workerId, REPORT_EVERY } = workerData;
  const challengeBuf = Buffer.from(challenge.slice(2), "hex");
  const packed       = Buffer.allocUnsafe(64);
  const nonceBuf     = Buffer.allocUnsafe(32);
  challengeBuf.copy(packed, 0);

  const diffBuf = Buffer.from(
    BigInt(difficulty).toString(16).padStart(64, "0"), "hex"
  );

  let nonce    = BigInt(startNonce);
  let attempts = 0;

  function writeBE(buf, val) {
    let v = val;
    for (let i = 31; i >= 0; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  }

  function bufLT(a, b) {
    for (let i = 0; i < 32; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  }

  let hashFn = null;
  try { const { keccak256 } = require("js-sha3"); hashFn = (buf) => Buffer.from(keccak256.arrayBuffer(buf)); hashFn(Buffer.alloc(1)); } catch (_) {}
  if (!hashFn) {
    try { const Keccak = require("keccak"); hashFn = (buf) => Keccak("keccak256").update(buf).digest(); hashFn(Buffer.alloc(1)); } catch (_) {}
  }

  if (hashFn) {
    while (true) {
      writeBE(nonceBuf, nonce); nonceBuf.copy(packed, 32);
      const hash = hashFn(packed); attempts++;
      if (bufLT(hash, diffBuf)) {
        parentPort.postMessage({ type: "found", nonce: nonce.toString(), hash: "0x" + hash.toString("hex"), workerId });
        break;
      }
      nonce++;
      if (attempts % REPORT_EVERY === 0) parentPort.postMessage({ type: "progress", attempts, workerId });
    }
  } else {
    const { solidityPackedKeccak256 } = require("ethers");
    const diffBigInt = BigInt(difficulty);
    while (true) {
      const hash = solidityPackedKeccak256(["bytes32", "uint256"], [challenge, nonce]); attempts++;
      if (BigInt(hash) < diffBigInt) {
        parentPort.postMessage({ type: "found", nonce: nonce.toString(), hash, workerId });
        break;
      }
      nonce++;
      if (attempts % REPORT_EVERY === 0) parentPort.postMessage({ type: "progress", attempts, workerId });
    }
  }

// ═══════════════════════════════════════════════════════════════
// MAIN THREAD
// ═══════════════════════════════════════════════════════════════
} else {

  let gpuAvailable     = false;
  let totalMints       = 0;
  let totalHashes      = 0;
  let peakHashrate     = 0;
  const t0session      = Date.now();

  async function detectGPU() {
    return new Promise((resolve) => {
      if (!fs.existsSync(GPU_BINARY)) { resolve(false); return; }
      execFile("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { timeout: 5000 }, (err, stdout) => {
        if (!err && stdout.trim()) {
          log(`🎮 GPU detected: ${stdout.trim().split("\n")[0]}`);
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
  }

  function difficultyToHex(diffStr) {
    return "0x" + BigInt(diffStr).toString(16).padStart(64, "0");
  }

  async function main() {
    checkEnv();

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

    gpuAvailable = await detectGPU();

    log("==========================================");
    log("  HASH256 Hybrid GPU+CPU Miner");
    log("==========================================");
    log(`Wallet      : ${wallet.address}`);
    log(`Contract    : ${CONTRACT_ADDRESS}`);
    log(`GPU Binary  : ${GPU_BINARY}`);
    log(`GPU Mode    : ${gpuAvailable ? "✅ AKTIF" : "❌ tidak tersedia — pakai CPU"}`);
    log(`CPU Cores   : ${NUM_CPU_CORES} (fallback)`);
    log(`Batch Size  : ${parseInt(BATCH_SIZE).toLocaleString()} nonces/batch`);
    log(`Log file    : ${LOG_FILE}`);
    log("");

    let errors = 0;

    while (true) {
      try {
        const [state, challenge] = await Promise.all([
          contract.miningState(),
          contract.getChallenge(wallet.address),
        ]);

        const difficulty = state.difficulty.toString();
        const diffHex    = difficultyToHex(difficulty);
        const epochNow   = state.epoch.toString();
        const uptime     = ((Date.now() - t0session) / 60000).toFixed(1);

        log("------------------------------------------");
        log(`Era        : ${state.era}`);
        log(`Reward     : ${ethers.formatUnits(state.reward, 18)} HASH`);
        log(`Difficulty : ${difficulty}`);
        log(`Epoch      : ${epochNow} | Remaining: ${state.remaining} blok`);
        log(`Challenge  : ${challenge}`);
        log(`Session    : ${totalMints} mints | ${(totalHashes/1e9).toFixed(2)} GH | uptime ${uptime} mnt`);

        let result;
        if (gpuAvailable) {
          try {
            result = await mineWithGPU(challenge, diffHex);
          } catch (gpuErr) {
            log(`⚠️  GPU error: ${gpuErr.message} — fallback ke CPU`);
            gpuAvailable = false;
            result = await mineWithCPU(challenge, difficulty);
          }
        } else {
          result = await mineWithCPU(challenge, difficulty);
        }

        totalHashes += result.totalAttempts;
        if (result.rate > peakHashrate) peakHashrate = result.rate;

        log(`Nonce      : ${result.nonce}`);
        log(`Hash       : ${result.hash}`);
        log(`Round      : ${result.secs}s | avg ${result.rate.toLocaleString()} H/s | peak ${peakHashrate.toLocaleString()} H/s`);

        // Cek epoch masih sama
        const fresh = await contract.miningState();
        if (fresh.epoch.toString() !== epochNow) {
          log("⚠️  Epoch berubah — skip, ulang ronde...");
          errors = 0;
          continue;
        }

        // Kirim TX
        try {
          let gas;
          try {
            gas = await contract.mine.estimateGas(BigInt(result.nonce));
          } catch (e) {
            log(`⚠️  Gas estimate gagal: ${e.shortMessage || e.message}`);
            continue;
          }
          log("Mengirim TX...");
          const tx = await contract.mine(BigInt(result.nonce), { gasLimit: gas + 15000n });
          log(`TX         : ${tx.hash}`);
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            totalMints++;
            log(`✓ MINT #${totalMints} | Block: ${receipt.blockNumber} | Uptime: ${uptime} mnt`);
            log(`  Total: ${(totalHashes/1e9).toFixed(2)} GH | Peak: ${peakHashrate.toLocaleString()} H/s`);
          } else {
            log("✗ TX reverted");
          }
        } catch (txErr) {
          log(`✗ TX error: ${txErr.shortMessage || txErr.message}`);
        }

        errors = 0;

      } catch (err) {
        errors++;
        log(`ERROR #${errors}: ${err.shortMessage || err.message}`);
        const wait = Math.min(3000 * Math.pow(2, errors - 1), 60_000);
        log(`Retry dalam ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }

  process.on("SIGINT",  () => { log(`\nStop. Mints: ${totalMints} | Peak: ${peakHashrate.toLocaleString()} H/s`); process.exit(0); });
  process.on("SIGTERM", () => { log(`\nStop. Mints: ${totalMints} | Peak: ${peakHashrate.toLocaleString()} H/s`); process.exit(0); });
  main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
}
