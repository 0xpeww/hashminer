/*
 * HASH256 GPU Miner — CUDA Keccak256
 * Compatible dengan: RTX PRO 4000, A40, dan NVIDIA lainnya
 *
 * Compile:
 *   nvcc -O3 -arch=sm_86 -o miner_gpu miner.cu
 *
 * Usage:
 *   ./miner_gpu <challenge_hex> <difficulty_hex> <start_nonce>
 *   Output: FOUND <nonce> <hash>  atau  NOTFOUND
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

// ═══════════════════════════════════════════════════════════════
// KECCAK-256 CONSTANTS
// ═══════════════════════════════════════════════════════════════

__constant__ uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL,
    0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL,
    0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL,
    0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL,
    0x0000000080000001ULL, 0x8000000080008008ULL
};

#define ROTL64(x, y) (((x) << (y)) | ((x) >> (64 - (y))))

__device__ void keccak256_block(uint64_t state[25]) {
    uint64_t C[5], D[5], tmp;
    #pragma unroll
    for (int round = 0; round < 24; round++) {
        // Theta
        C[0] = state[0] ^ state[5] ^ state[10] ^ state[15] ^ state[20];
        C[1] = state[1] ^ state[6] ^ state[11] ^ state[16] ^ state[21];
        C[2] = state[2] ^ state[7] ^ state[12] ^ state[17] ^ state[22];
        C[3] = state[3] ^ state[8] ^ state[13] ^ state[18] ^ state[23];
        C[4] = state[4] ^ state[9] ^ state[14] ^ state[19] ^ state[24];

        D[0] = C[4] ^ ROTL64(C[1], 1);
        D[1] = C[0] ^ ROTL64(C[2], 1);
        D[2] = C[1] ^ ROTL64(C[3], 1);
        D[3] = C[2] ^ ROTL64(C[4], 1);
        D[4] = C[3] ^ ROTL64(C[0], 1);

        #pragma unroll
        for (int i = 0; i < 25; i++) state[i] ^= D[i % 5];

        // Rho + Pi
        uint64_t B[25];
        B[0]  = state[0];
        B[10] = ROTL64(state[1],  1);
        B[20] = ROTL64(state[2], 62);
        B[5]  = ROTL64(state[3], 28);
        B[15] = ROTL64(state[4], 27);
        B[16] = ROTL64(state[5], 36);
        B[1]  = ROTL64(state[6], 44);
        B[11] = ROTL64(state[7],  6);
        B[21] = ROTL64(state[8], 55);
        B[6]  = ROTL64(state[9], 20);
        B[7]  = ROTL64(state[10],  3);
        B[17] = ROTL64(state[11], 10);
        B[2]  = ROTL64(state[12], 43);
        B[12] = ROTL64(state[13], 25);
        B[22] = ROTL64(state[14], 39);
        B[23] = ROTL64(state[15], 41);
        B[8]  = ROTL64(state[16], 45);
        B[18] = ROTL64(state[17], 15);
        B[3]  = ROTL64(state[18], 21);
        B[13] = ROTL64(state[19],  8);
        B[14] = ROTL64(state[20], 18);
        B[24] = ROTL64(state[21],  2);
        B[9]  = ROTL64(state[22], 61);
        B[19] = ROTL64(state[23], 56);
        B[4]  = ROTL64(state[24], 14);

        // Chi
        #pragma unroll
        for (int i = 0; i < 25; i += 5) {
            state[i+0] = B[i+0] ^ ((~B[i+1]) & B[i+2]);
            state[i+1] = B[i+1] ^ ((~B[i+2]) & B[i+3]);
            state[i+2] = B[i+2] ^ ((~B[i+3]) & B[i+4]);
            state[i+3] = B[i+3] ^ ((~B[i+4]) & B[i+0]);
            state[i+4] = B[i+4] ^ ((~B[i+0]) & B[i+1]);
        }

        // Iota
        state[0] ^= RC[round];
    }
}

// ═══════════════════════════════════════════════════════════════
// KECCAK256 untuk input 64 bytes (challenge 32 + nonce 32)
// ═══════════════════════════════════════════════════════════════
__device__ void keccak256_64(const uint8_t *input, uint8_t *output) {
    uint64_t state[25];
    #pragma unroll
    for (int i = 0; i < 25; i++) state[i] = 0;

    // Absorb 64 bytes (rate = 136 bytes untuk keccak256)
    #pragma unroll
    for (int i = 0; i < 8; i++) {
        uint64_t word = 0;
        #pragma unroll
        for (int j = 0; j < 8; j++) {
            word |= ((uint64_t)input[i*8 + j]) << (j * 8);
        }
        state[i] ^= word;
    }

    // Padding keccak (bukan SHA3!)
    state[8] ^= 0x01ULL;          // keccak padding
    state[16] ^= 0x8000000000000000ULL; // rate = 136, last byte of rate

    keccak256_block(state);

    // Squeeze 32 bytes
    #pragma unroll
    for (int i = 0; i < 4; i++) {
        uint64_t word = state[i];
        #pragma unroll
        for (int j = 0; j < 8; j++) {
            output[i*8 + j] = (word >> (j * 8)) & 0xff;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// COMPARE: hash < difficulty (big-endian 32 bytes)
// ═══════════════════════════════════════════════════════════════
__device__ bool hash_lt_diff(const uint8_t *hash, const uint8_t *diff) {
    #pragma unroll
    for (int i = 0; i < 32; i++) {
        if (hash[i] < diff[i]) return true;
        if (hash[i] > diff[i]) return false;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════
// MAIN KERNEL
// ═══════════════════════════════════════════════════════════════
__global__ void mine_kernel(
    const uint8_t *challenge,   // 32 bytes
    const uint8_t *difficulty,  // 32 bytes big-endian
    uint64_t start_nonce,
    uint64_t batch_size,
    uint64_t *found_nonce,      // output: nonce yg valid (0 = belum)
    uint8_t  *found_hash        // output: hash 32 bytes
) {
    uint64_t idx = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= batch_size) return;
    if (*found_nonce != 0) return; // sudah ada yang ketemu

    uint64_t nonce = start_nonce + idx;

    // Build input: challenge (32 bytes) ++ nonce as uint256 big-endian (32 bytes)
    uint8_t input[64];
    #pragma unroll
    for (int i = 0; i < 32; i++) input[i] = challenge[i];

    // nonce as 32-byte big-endian (ABI encode uint256)
    #pragma unroll
    for (int i = 0; i < 24; i++) input[32 + i] = 0;
    #pragma unroll
    for (int i = 0; i < 8; i++) {
        input[32 + 24 + i] = (nonce >> (56 - i * 8)) & 0xff;
    }

    uint8_t hash[32];
    keccak256_64(input, hash);

    if (hash_lt_diff(hash, difficulty)) {
        // Atomically set found_nonce (first finder wins)
        uint64_t expected = 0;
        // Simple: langsung tulis (race condition minimal, nonce valid semua)
        if (atomicCAS((unsigned long long*)found_nonce,
                      (unsigned long long)0,
                      (unsigned long long)(nonce + 1)) == 0) {
            #pragma unroll
            for (int i = 0; i < 32; i++) found_hash[i] = hash[i];
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// HOST HELPERS
// ═══════════════════════════════════════════════════════════════
void hex_to_bytes(const char *hex, uint8_t *out, int len) {
    // skip 0x prefix
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    for (int i = 0; i < len; i++) {
        char hi = hex[i*2], lo = hex[i*2+1];
        auto hv = [](char c) -> uint8_t {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            return c - 'A' + 10;
        };
        out[i] = (hv(hi) << 4) | hv(lo);
    }
}

void bytes_to_hex(const uint8_t *in, char *out, int len) {
    const char *hex = "0123456789abcdef";
    for (int i = 0; i < len; i++) {
        out[i*2]   = hex[(in[i] >> 4) & 0xf];
        out[i*2+1] = hex[in[i] & 0xf];
    }
    out[len*2] = 0;
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
int main(int argc, char *argv[]) {
    if (argc < 4) {
        fprintf(stderr, "Usage: %s <challenge_hex> <difficulty_hex> <start_nonce> [batch_size]\n", argv[0]);
        fprintf(stderr, "Output: FOUND <nonce> <hash_hex>\n");
        fprintf(stderr, "        NOTFOUND\n");
        return 1;
    }

    uint8_t challenge[32], difficulty[32];
    hex_to_bytes(argv[1], challenge, 32);
    hex_to_bytes(argv[2], difficulty, 32);

    uint64_t start_nonce  = strtoull(argv[3], NULL, 10);
    uint64_t batch_size   = (argc >= 5) ? strtoull(argv[4], NULL, 10) : 67108864ULL; // 64M default

    // GPU setup
    int threads = 512;
    int blocks  = (int)((batch_size + threads - 1) / threads);

    uint8_t *d_challenge, *d_difficulty, *d_found_hash;
    uint64_t *d_found_nonce;

    cudaMalloc(&d_challenge,    32);
    cudaMalloc(&d_difficulty,   32);
    cudaMalloc(&d_found_hash,   32);
    cudaMalloc(&d_found_nonce,  sizeof(uint64_t));

    cudaMemcpy(d_challenge,  challenge,  32, cudaMemcpyHostToDevice);
    cudaMemcpy(d_difficulty, difficulty, 32, cudaMemcpyHostToDevice);
    cudaMemset(d_found_nonce, 0, sizeof(uint64_t));
    cudaMemset(d_found_hash,  0, 32);

    mine_kernel<<<blocks, threads>>>(
        d_challenge, d_difficulty,
        start_nonce, batch_size,
        d_found_nonce, d_found_hash
    );
    cudaDeviceSynchronize();

    uint64_t found_nonce = 0;
    uint8_t  found_hash[32];
    cudaMemcpy(&found_nonce, d_found_nonce, sizeof(uint64_t), cudaMemcpyDeviceToHost);
    cudaMemcpy(found_hash,   d_found_hash,  32,               cudaMemcpyDeviceToHost);

    if (found_nonce != 0) {
        char hash_hex[65];
        bytes_to_hex(found_hash, hash_hex, 32);
        printf("FOUND %llu 0x%s\n", (unsigned long long)(found_nonce - 1), hash_hex);
    } else {
        printf("NOTFOUND\n");
    }

    cudaFree(d_challenge);
    cudaFree(d_difficulty);
    cudaFree(d_found_hash);
    cudaFree(d_found_nonce);

    return 0;
}
