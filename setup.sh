#!/bin/bash
# ================================================
# HASH256 GPU Miner — Auto Setup Script
# Jalankan: bash setup.sh
# ================================================

set -e

echo "========================================"
echo "  HASH256 GPU Miner Setup"
echo "========================================"

# 1. Cek NVIDIA GPU
echo ""
echo "[1/5] Cek GPU..."
if nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null; then
    GPU_ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.')
    echo "✅ GPU ditemukan! Compute capability: $(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1)"
else
    echo "❌ GPU NVIDIA tidak ditemukan!"
    echo "   Pastikan driver NVIDIA terinstall."
    exit 1
fi

# 2. Cek CUDA
echo ""
echo "[2/5] Cek CUDA..."
if ! command -v nvcc &> /dev/null; then
    echo "nvcc tidak ditemukan, install CUDA toolkit..."
    apt-get update -qq
    apt-get install -y -qq cuda-toolkit-12-0 2>/dev/null || \
    apt-get install -y -qq nvidia-cuda-toolkit 2>/dev/null || \
    echo "⚠️  Install manual: apt install nvidia-cuda-toolkit"
fi

if command -v nvcc &> /dev/null; then
    echo "✅ CUDA: $(nvcc --version | grep release | awk '{print $6}')"
else
    echo "❌ nvcc tidak tersedia. Coba: apt install nvidia-cuda-toolkit"
    exit 1
fi

# 3. Compile CUDA kernel
echo ""
echo "[3/5] Compile GPU kernel..."
SM="sm_${GPU_ARCH}"
echo "   Target arch: $SM"
nvcc -O3 -arch=$SM -o miner_gpu miner.cu
echo "✅ Compiled: ./miner_gpu"

# 4. Install Node deps
echo ""
echo "[4/5] Install Node.js dependencies..."
npm install
npm install js-sha3 keccak 2>/dev/null || true
echo "✅ npm packages installed"

# 5. Setup .env
echo ""
echo "[5/5] Setup .env..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ .env dibuat dari .env.example"
    echo "⚠️  EDIT .env dulu sebelum jalankan miner!"
    echo "   nano .env"
else
    echo "✅ .env sudah ada"
fi

echo ""
echo "========================================"
echo "  Setup selesai!"
echo "========================================"
echo ""
echo "Test GPU binary:"
echo "  ./miner_gpu --help"
echo ""
echo "Jalankan miner:"
echo "  npm start"
echo ""
echo "Background (screen):"
echo "  screen -S hash"
echo "  npm start"
echo "  CTRL+A lalu D untuk detach"
echo ""
