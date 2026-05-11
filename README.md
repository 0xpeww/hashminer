# ⛏️ hashminer — GPU + CPU Hybrid

HASH256 miner dengan **CUDA GPU** sebagai engine utama + CPU sebagai fallback otomatis.

---

## 🚀 Estimasi Hashrate

| Hardware | Hashrate |
|---|---|
| CPU 128 core (keccak) | ~7 M H/s |
| RTX PRO 4000 (GPU) | ~500 M H/s |
| **A40 (GPU)** | **~1-2 GH/s** |

**GPU ~100-200x lebih cepat dari CPU!**

---

## 📋 Requirements

- NVIDIA GPU (RTX / A40 / dll)
- CUDA Toolkit (nvcc)
- Node.js v18+
- Driver NVIDIA terbaru

---

## ⚡ Install & Setup (Otomatis)

```bash
git clone https://github.com/0xpeww/hashminer
cd hashminer

# Salin file baru
cp miner.js miner.js.bak    # backup lama
# replace dengan miner.js GPU ini

# Auto setup (compile CUDA + install deps)
bash setup.sh

# Edit .env
nano .env
```

---

## ⚙️ Konfigurasi `.env`

```env
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
CORES=64              # CPU cores (fallback)
BATCH_SIZE=67108864   # nonce per GPU batch (64M default)
GPU_BINARY=./miner_gpu
CPU_FALLBACK=true     # false = matikan CPU fallback
```

---

## ▶️ Jalankan

```bash
# Compile dulu (sekali saja)
bash setup.sh

# Jalankan
npm start
```

---

## 🖥️ Output

```
[...] GPU detected: NVIDIA A40
[...] GPU Mode    : ✅ AKTIF
[...] Mining dengan GPU...
  1,234,567,890 H/s | 12.34 GH | 10s [GPU]

[...] Nonce      : 1234567890
[...] ✓ MINT #1 | Block: 123456
```

---

## 🔧 Compile Manual

```bash
# Cek GPU compute capability
nvidia-smi --query-gpu=compute_cap --format=csv,noheader

# Compile (ganti sm_86 sesuai GPU kamu)
# RTX 30xx/A40 = sm_86
# RTX 40xx     = sm_89
# RTX 20xx     = sm_75
nvcc -O3 -arch=sm_86 -o miner_gpu miner.cu

# Test
./miner_gpu
```

---

## 🔄 Cara Kerja

```
miner.js (Node.js)
    ↓
Ambil challenge + difficulty dari kontrak
    ↓
Jalankan miner_gpu (CUDA binary)
    ↓ (64M nonce per batch, ~0.05 detik di A40)
Dapat nonce valid?
    → YA: kirim TX ke kontrak
    → TIDAK: batch berikutnya (nonce += 64M)
    ↓
Fallback ke CPU jika GPU error
```

---

## ⚠️ Tips

- Pastikan **ETH** cukup di wallet untuk gas
- Untuk **vast.ai**: pilih instance dengan GPU NVIDIA dan CUDA pre-installed
- Jalankan `bash setup.sh` setiap ganti instance baru
- `BATCH_SIZE=134217728` (128M) untuk GPU VRAM besar (A40, A100)
