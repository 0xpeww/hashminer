/*
 * HASH256 Multi-GPU Miner — CUDA Keccak256
 *
 * Compile (Titan Xp = sm_61):
 *   nvcc -O3 -arch=sm_61 -o miner_gpu miner.cu
 *
 * Usage:
 *   ./miner_gpu <challenge_hex> <difficulty_hex> <start_nonce> <batch_size> <gpu_id>
 * Output:
 *   FOUND <nonce> <hash_hex>
 *   NOTFOUND
 */

#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

__constant__ uint64_t RC[24] = {
    0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
    0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
    0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
    0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
    0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
    0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL
};

#define ROTL64(x,y) (((x)<<(y))|((x)>>(64-(y))))

__device__ void keccak_f(uint64_t s[25]) {
    uint64_t C[5],D[5],B[25];
    #pragma unroll
    for (int r=0;r<24;r++){
        C[0]=s[0]^s[5]^s[10]^s[15]^s[20]; C[1]=s[1]^s[6]^s[11]^s[16]^s[21];
        C[2]=s[2]^s[7]^s[12]^s[17]^s[22]; C[3]=s[3]^s[8]^s[13]^s[18]^s[23];
        C[4]=s[4]^s[9]^s[14]^s[19]^s[24];
        D[0]=C[4]^ROTL64(C[1],1); D[1]=C[0]^ROTL64(C[2],1); D[2]=C[1]^ROTL64(C[3],1);
        D[3]=C[2]^ROTL64(C[4],1); D[4]=C[3]^ROTL64(C[0],1);
        #pragma unroll
        for(int i=0;i<25;i++) s[i]^=D[i%5];
        B[0]=s[0];          B[10]=ROTL64(s[1],1);   B[20]=ROTL64(s[2],62);
        B[5]=ROTL64(s[3],28);B[15]=ROTL64(s[4],27);  B[16]=ROTL64(s[5],36);
        B[1]=ROTL64(s[6],44);B[11]=ROTL64(s[7],6);   B[21]=ROTL64(s[8],55);
        B[6]=ROTL64(s[9],20);B[7]=ROTL64(s[10],3);   B[17]=ROTL64(s[11],10);
        B[2]=ROTL64(s[12],43);B[12]=ROTL64(s[13],25);B[22]=ROTL64(s[14],39);
        B[23]=ROTL64(s[15],41);B[8]=ROTL64(s[16],45);B[18]=ROTL64(s[17],15);
        B[3]=ROTL64(s[18],21);B[13]=ROTL64(s[19],8); B[14]=ROTL64(s[20],18);
        B[24]=ROTL64(s[21],2);B[9]=ROTL64(s[22],61); B[19]=ROTL64(s[23],56);
        B[4]=ROTL64(s[24],14);
        #pragma unroll
        for(int i=0;i<25;i+=5){
            s[i+0]=B[i+0]^((~B[i+1])&B[i+2]); s[i+1]=B[i+1]^((~B[i+2])&B[i+3]);
            s[i+2]=B[i+2]^((~B[i+3])&B[i+4]); s[i+3]=B[i+3]^((~B[i+4])&B[i+0]);
            s[i+4]=B[i+4]^((~B[i+0])&B[i+1]);
        }
        s[0]^=RC[r];
    }
}

__device__ void keccak256(const uint8_t *in, uint8_t *out) {
    uint64_t s[25]={0};
    #pragma unroll
    for(int i=0;i<8;i++){
        uint64_t w=0;
        #pragma unroll
        for(int j=0;j<8;j++) w|=((uint64_t)in[i*8+j])<<(j*8);
        s[i]^=w;
    }
    s[8] ^=0x01ULL;
    s[16]^=0x8000000000000000ULL;
    keccak_f(s);
    #pragma unroll
    for(int i=0;i<4;i++){
        uint64_t w=s[i];
        #pragma unroll
        for(int j=0;j<8;j++) out[i*8+j]=(w>>(j*8))&0xff;
    }
}

__device__ bool lt32(const uint8_t *a, const uint8_t *b){
    #pragma unroll
    for(int i=0;i<32;i++){
        if(a[i]<b[i]) return true;
        if(a[i]>b[i]) return false;
    }
    return false;
}

__global__ void mine_kernel(
    const uint8_t *challenge, const uint8_t *difficulty,
    uint64_t start_nonce, uint64_t batch_size,
    uint64_t *found_nonce, uint8_t *found_hash
){
    uint64_t idx=(uint64_t)blockIdx.x*blockDim.x+threadIdx.x;
    if(idx>=batch_size||*found_nonce!=0) return;
    uint64_t nonce=start_nonce+idx;

    uint8_t input[64];
    #pragma unroll
    for(int i=0;i<32;i++) input[i]=challenge[i];
    #pragma unroll
    for(int i=0;i<24;i++) input[32+i]=0;
    #pragma unroll
    for(int i=0;i<8;i++)  input[56+i]=(nonce>>(56-i*8))&0xff;

    uint8_t hash[32];
    keccak256(input,hash);

    if(lt32(hash,difficulty)){
        if(atomicCAS((unsigned long long*)found_nonce,0ULL,(unsigned long long)(nonce+1))==0){
            #pragma unroll
            for(int i=0;i<32;i++) found_hash[i]=hash[i];
        }
    }
}

void hex2bytes(const char *hex, uint8_t *out, int len){
    if(hex[0]=='0'&&(hex[1]=='x'||hex[1]=='X')) hex+=2;
    auto h=[](char c)->uint8_t{
        if(c>='0'&&c<='9') return c-'0';
        if(c>='a'&&c<='f') return c-'a'+10;
        return c-'A'+10;
    };
    for(int i=0;i<len;i++) out[i]=(h(hex[i*2])<<4)|h(hex[i*2+1]);
}

void bytes2hex(const uint8_t *in, char *out, int len){
    const char *h="0123456789abcdef";
    for(int i=0;i<len;i++){out[i*2]=h[(in[i]>>4)&0xf];out[i*2+1]=h[in[i]&0xf];}
    out[len*2]=0;
}

int main(int argc, char *argv[]){
    if(argc<6){
        fprintf(stderr,"Usage: %s <challenge> <difficulty> <start_nonce> <batch_size> <gpu_id>\n",argv[0]);
        return 1;
    }

    uint8_t challenge[32], difficulty[32];
    hex2bytes(argv[1],challenge,32);
    hex2bytes(argv[2],difficulty,32);
    uint64_t start_nonce=strtoull(argv[3],NULL,10);
    uint64_t batch_size =strtoull(argv[4],NULL,10);
    int      gpu_id     =atoi(argv[5]);

    int gpu_count=0;
    cudaGetDeviceCount(&gpu_count);
    if(gpu_id>=gpu_count){
        fprintf(stderr,"GPU %d tidak ada (total: %d)\n",gpu_id,gpu_count);
        return 1;
    }
    cudaSetDevice(gpu_id);

    // Print GPU info
    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop,gpu_id);
    fprintf(stderr,"GPU[%d]: %s | %.0f MHz | %zu MB\n",
        gpu_id, prop.name, (double)prop.clockRate/1000,
        prop.totalGlobalMem/1024/1024);

    int threads=512;
    int blocks=(int)((batch_size+threads-1)/threads);

    uint8_t  *d_ch,*d_diff,*d_fhash;
    uint64_t *d_fnonce;
    cudaMalloc(&d_ch,32); cudaMalloc(&d_diff,32);
    cudaMalloc(&d_fhash,32); cudaMalloc(&d_fnonce,8);
    cudaMemcpy(d_ch,challenge,32,cudaMemcpyHostToDevice);
    cudaMemcpy(d_diff,difficulty,32,cudaMemcpyHostToDevice);
    cudaMemset(d_fnonce,0,8); cudaMemset(d_fhash,0,32);

    mine_kernel<<<blocks,threads>>>(d_ch,d_diff,start_nonce,batch_size,d_fnonce,d_fhash);
    cudaDeviceSynchronize();

    uint64_t fn=0; uint8_t fh[32];
    cudaMemcpy(&fn,d_fnonce,8,cudaMemcpyDeviceToHost);
    cudaMemcpy(fh,d_fhash,32,cudaMemcpyDeviceToHost);

    if(fn!=0){
        char hx[65]; bytes2hex(fh,hx,32);
        printf("FOUND %llu 0x%s\n",(unsigned long long)(fn-1),hx);
    } else {
        printf("NOTFOUND\n");
    }

    cudaFree(d_ch); cudaFree(d_diff); cudaFree(d_fhash); cudaFree(d_fnonce);
    return 0;
}
