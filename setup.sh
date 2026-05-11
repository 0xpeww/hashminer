#!/bin/bash
# ================================================
# HASH256 Multi-GPU Setup — Titan Xp (sm_61)
# Jalankan: bash setup.sh
# ================================================
set -e

echo "========================================"
echo "  HASH256 Multi-GPU Miner Setup"
echo "========================================"

# 1. Cek GPU
echo ""
echo "[1/5] Cek GPU..."
nvidia-smi --query-gpu=index,name,memory.total,compute_cap --format=csv,noheader || {
    echo "❌ nvidia-smi gagal. Install driver dulu."; exit 1;
}
GPU_COUNT=$(nvidia-smi --query-gpu=name --format=csv,noheader | wc -l)
GPU_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '.')
echo "✅ $GPU_COUNT GPU ditemukan | Compute: ${GPU_CAP}"

# 2. Install CUDA
echo ""
echo "[2/5] Install CUDA toolkit..."
if ! command -v nvcc &>/dev/null; then
    echo "   nvcc tidak ada, install..."
    apt-get update -qq
    # Coba beberapa cara
    apt-get install -y cuda-toolkit-12-0 2>/dev/null || \
    apt-get install -y cuda-nvcc-12-0 2>/dev/null || \
    apt-get install -y nvidia-cuda-toolkit 2>/dev/null || {
        echo "⚠️  Auto install gagal, coba manual:"
        echo "   apt-get install -y cuda-toolkit-12-0"
        echo "   atau: apt-get install -y nvidia-cuda-toolkit"
        exit 1
    }
fi

if command -v nvcc &>/dev/null; then
    echo "✅ CUDA: $(nvcc --version | grep 'release' | awk '{print $5,$6}')"
else
    # Coba cari nvcc di path CUDA
    export PATH=$PATH:/usr/local/cuda/bin
    if command -v nvcc &>/dev/null; then
        echo "✅ CUDA found at /usr/local/cuda/bin"
        echo 'export PATH=$PATH:/usr/local/cuda/bin' >> ~/.bashrc
    else
        echo "❌ nvcc tidak ditemukan setelah install"; exit 1
    fi
fi

# 3. Compile CUDA kernel
echo ""
echo "[3/5] Compile GPU kernel (sm_${GPU_CAP})..."
export PATH=$PATH:/usr/local/cuda/bin

nvcc -O3 -arch=sm_${GPU_CAP} -o miner_gpu miner.cu && \
    echo "✅ Compiled: ./miner_gpu" || {
    echo "❌ Compile gagal!"; exit 1
}

# 4. Install Node deps
echo ""
echo "[4/5] Install Node.js packages..."
npm install
npm install js-sha3 keccak 2>/dev/null || true

# Verifikasi
node -e "require('js-sha3'); console.log('✅ js-sha3 OK')" 2>/dev/null || echo "⚠️  js-sha3 tidak terinstall"
node -e "require('keccak'); console.log('✅ keccak OK')"  2>/dev/null || echo "⚠️  keccak tidak terinstall (CPU fallback akan pakai js-sha3)"

# 5. Setup .env
echo ""
echo "[5/5] Setup .env..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ .env dibuat — edit dulu sebelum mining!"
    echo ""
    echo "   nano .env"
else
    echo "✅ .env sudah ada"
fi

echo ""
echo "========================================"
echo "  Setup selesai! 🚀"
echo "========================================"
echo ""
echo "GPU yang tersedia:"
nvidia-smi --query-gpu=index,name --format=csv,noheader | sed 's/^/  /'
echo ""
echo "Jalankan miner:"
echo "  npm start"
echo ""
echo "Background:"
echo "  apt install -y screen"
echo "  screen -S hash && npm start"
echo "  # Detach: CTRL+A lalu D"
echo ""
