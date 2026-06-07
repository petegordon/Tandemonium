# CUDA Learning & Projects Roadmap — RTX 5070 Ti (Blackwell, sm_120, 16 GB)

> Personalized deep-research roadmap compiled 2026-06-07. Tailored for an experienced
> Python/ML practitioner & educator (taught a 2U Python AI bootcamp; works in generative
> 3D via ComfyUI/Hunyuan3D/TRELLIS/Blender/thrixel; background in NLP, LDA, embeddings,
> cosine/dot-product). New to CUDA C++/GPU kernels.
>
> This field moves fast — versions and VRAM numbers shift monthly. Claims below are cited;
> uncertain/volatile items are flagged. Verify version-specific facts at install time.

---

## TL;DR — highest-leverage starting points

1. **Get the environment right first** (this is where 80% of Blackwell pain lives): driver ≥ R570, CUDA Toolkit ≥ 12.8, and **PyTorch ≥ 2.7 installed from the `cu128`+ index URL**. Verify `sm_120` is in `torch.cuda.get_arch_list()`.
2. **Learn the CUDA memory model, then default to Triton** for real kernel work — it suits a Python person and reaches ~90–105% of hand-tuned CUDA for ML kernels.
3. **Anchor your first project to what you already know**: a cosine-similarity / dot-product top-k kernel. It turns your embeddings intuition into GPU code and teaches GEMM + reductions + top-k selection — the core pattern behind every vector-search library.
4. **For your 3D work, the practical CUDA skill is config, not kernels**: VRAM offloading, fp8/quantization, tiled VAE, attention-backend selection, and profiling. That's what makes 16 GB usable.

---

## 1. Environment setup for Blackwell / sm_120

The RTX 5070 Ti is Blackwell, **compute capability 12.0 (`sm_120`)**. Binaries compiled only up to `sm_90` (Hopper) have **no matching kernel image** and fail at runtime.

| Component | Requirement | Notes |
|---|---|---|
| **CUDA Toolkit** | **≥ 12.8** | 12.8 (Jan 2025) is the **first** toolkit with RTX 50-series / sm_120 device code. Anything ≤ 12.6 produces no sm_120 kernels. 12.9 / 13.x continue support. |
| **NVIDIA driver** | **≥ R570** | Linux `570.124.06`+; Windows `572.xx`+. On Linux **use the open kernel module** (`nvidia-driver-570-open` or newer) — Blackwell consumer cards require it. R575/R580 (2026) are fine. |
| **PyTorch** | **≥ 2.7.0, `cu128` wheel** | 2.7.0 (Apr 23 2025) is the first **stable** release shipping prebuilt CUDA 12.8 / Blackwell wheels. |

**Install (verify the current default tag at pytorch.org first — `cu128` is the floor, it drifts cu128 → cu129 → cu130):**

```bash
pip uninstall -y torch torchvision torchaudio
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
# bleeding edge: add --pre and use .../whl/nightly/cu128 (or cu130)
```

**Verify the build actually has sm_120:**

```bash
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_arch_list())"
# arch list MUST include 'sm_120'
```

### The classic Blackwell errors and their fix

- `...RTX 5070 Ti with CUDA capability sm_120 is not compatible with the current PyTorch installation. The current PyTorch install supports ... sm_50 ... sm_90.`
- `CUDA error: no kernel image is available for execution on the device`

**Root cause:** wrong wheel — the default PyPI `torch`, or a `cu124`/`cu126` build, has no sm_120 device code. **Fix:** uninstall and reinstall from the `cu128`+ index URL (above); ensure PyTorch ≥ 2.7 and driver ≥ R570. If building a native extension (flash-attn, SageAttention, spconv) set `TORCH_CUDA_ARCH_LIST="12.0"` and build with CUDA ≥ 12.8.

> **Conflict resolved:** some 2025–2026 reports claim "PyTorch 2.9 stable still lacks sm_120." On inspection these are almost always the **default PyPI wheel** installed instead of the `cu128` build. Stable ≥ 2.7 from the correct index URL works. *Volatility flag:* confirm the current wheel tag at <https://pytorch.org/get-started/locally/> at install time.

### OS choice

- **Native Linux** — best performance, simplest CUDA story. Recommended for serious kernel dev. (Ubuntu 24.04 + open R570 driver + CUDA 12.8.)
- **WSL2** — fully supported for Blackwell. **Critical rule: install ONLY the Windows driver (via the NVIDIA App). Never install a Linux GPU driver inside WSL** — it breaks GPU passthrough (the Windows driver is exposed as a stubbed `libcuda.so`). Inside WSL install only the CUDA *toolkit* (the `wsl-ubuntu` package that omits the driver). Needed for **TensorFlow GPU** (no native-Windows TF GPU since TF 2.10) and stronger `torch.compile`/Triton support.
- **Native Windows** — fine for PyTorch-only inference/training (cu128 Windows wheels exist). Weaker Triton/`torch.compile` story; Triton on Windows needs the **`triton-windows`** fork (woct0rdho).

*Sources:* NVIDIA CUDA 12.8 Blackwell blog & [download archive](https://developer.nvidia.com/cuda-12-8-0-download-archive); [CUDA GPUs/compute capabilities](https://developer.nvidia.com/cuda/gpus); [PyTorch 2.7 release](https://pytorch.org/blog/pytorch-2-7/) (+ official announcement Apr 23 2025); [pytorch #173237](https://github.com/pytorch/pytorch/issues/173237), [#164342](https://github.com/pytorch/pytorch/issues/164342); [ComfyUI #7127](https://github.com/Comfy-Org/ComfyUI/issues/7127); [NVIDIA WSL user guide](https://docs.nvidia.com/cuda/wsl-user-guide/index.html); [5070 Ti Game Ready driver](https://www.nvidia.com/en-us/geforce/news/geforce-rtx-5070-ti-game-ready-driver/); [Blackwell open-driver forum thread](https://forums.developer.nvidia.com/t/cuda-12-4-compatibility-with-rtx-5070-ti-open-kernel-driver-570/337591).

---

## 2. Learning ladder + resources (Python/ML → intermediate CUDA)

**The progression** (community consensus, mirrors GPU MODE's "1st Contact → 2nd Contact → advanced"):

1. **Mental model** — get one kernel running.
2. **Fundamentals** — threads/blocks/grids, memory hierarchy (global vs shared), **coalescing**, **occupancy**, warps.
3. **Performance & concurrency** — Nsight profiling, shared-memory **tiling**, then **streams + CUDA graphs**.
4. **Python on-ramp** — **OpenAI Triton**, once you grasp tiling/coalescing/occupancy conceptually.

### Resources, in order

**Foundations (do first)**
- **"An Even Easier Introduction to CUDA"** — NVIDIA blog, *free*, refreshed ~May 2025. Best 30-minute first contact (+ Colab). <https://developer.nvidia.com/blog/even-easier-introduction-cuda/>
- **freeCodeCamp "CUDA Programming Course – HPC with GPUs"** (Elliot Arledge) — *free*, ~12 h, Sept 24 2024. C/C++ review → architecture → kernels → matmul opt → **Triton** → PyTorch extensions → MNIST MLP. Code: <https://github.com/Infatoshi/cuda-course>

**The spine**
- **Programming Massively Parallel Processors (PMPP), 4th ed.** (Hwu, Kirk, El Hajj; 2023) — *paid*; **get the 4th edition** (3rd/2016 still circulates). Free community solutions: <https://github.com/tugot17/pmpp>

**Reference (consult, don't read cover-to-cover)**
- **CUDA Programming Guide** — *free*. ⚠️ The old **"CUDA C++ Programming Guide" is legacy/frozen at CUDA 13.0**; use the new "CUDA Programming Guide." <https://docs.nvidia.com/cuda/cuda-programming-guide/>
- **CUDA C++ Best Practices Guide** — *free*; authoritative on coalescing/occupancy/streams. <https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/>

**Structured video**
- **GPU MODE** (formerly "CUDA MODE"; Mark Saroufim & Andreas Köpf) — *free*, 100+ lectures, Apache-2.0. Lectures 1–5 (+37) fundamentals; Triton in 14/29/34; advanced (FlashAttention, CUTLASS/CuTe, tensor cores, multi-GPU) later. <https://github.com/gpu-mode/lectures> · notes: <https://christianjmills.com/series/notes/cuda-mode-notes.html>
- **NVIDIA DLI "Fundamentals of Accelerated Computing with CUDA C/C++"** — *paid* (~$90 self-paced), certificate + cloud GPU. Optional given the free alternatives.

**Triton (Python on-ramp)** — official tutorials in order: 01 vector-add → 02 fused-softmax → 03 matmul (autotune) → 04 low-mem dropout → 05 layer-norm → **06 fused-attention (FlashAttention-style)** → 07+ . <https://triton-lang.org/main/getting-started/tutorials/index.html>

**Practice platforms (do problems alongside)**
- **LeetGPU** <https://leetgpu.com/> (free tier) — 50+ in-browser problems on real GPUs.
- **Tensara** <https://tensara.org/> (free, OSS) — 60+ challenges in **CUDA, Triton, and Mojo** on real T4/A100/H100.

### Triton vs raw CUDA C++ (your default decision)
- Triton is **not** "CUDA in Python" — it's a **tile-based DSL**; you reason about tiles, it handles thread assignment/coalescing/most shared memory.
- **Performance:** CUDA C++ is fastest in raw terms, but Triton hits **~90–105% of hand-tuned CUDA** for many ML kernels at a fraction of effort (a 3-day CUDA kernel ≈ 4–8 h in Triton), and **ports across GPU generations** without retuning.
- **Use raw CUDA when** you need warp-level primitives, async-copy pipelines, explicit tensor-core programming, or exotic memory (L2 residency, constant/texture).
- **Recommendation:** learn enough CUDA C++ to reason about *why* a kernel is slow (memory model + profiling), then do most production work in Triton.

**Time expectations:** first kernels in days; comfortable with fundamentals in **4–8 weeks**; genuine **intermediate** competence (profile/optimize non-trivial kernels, streams/graphs, useful Triton) in **~3–4 months** of consistent hands-on practice. The "100 days of CUDA" challenge format maps well to this.

---

## 3. Project ladder (tied to your actual work)

Each project builds on the last and connects to something you already understand.

### 3a. Embeddings / vector-search kernels — *start here; it's closest to your NLP past*

**The concept made precise.** Cosine similarity = **normalized dot product**: `cos(x,y) = ⟨x,y⟩ / (‖x‖‖y‖)`. On **L2-normalized** vectors it is *exactly* the plain dot product — scikit-learn literally says cosine "is equivalent to linear_kernel, only slower" on normalized input. Geometrically, normalization projects vectors onto the unit sphere so only **direction** (the angle) matters; **raw dot product rewards large magnitudes**, so a long vector can win a top-k even at a wide angle. This is exactly your "dot product vs magnitude" question — answered: normalize first if you want angle, keep raw dot if magnitude is signal.

**How GPU kernels handle it (the pattern you'll implement):** **normalize once up front, then run an inner product**, because dot product maps directly onto highly-optimized **GEMM** (matrix-multiply) hardware, whereas per-pair division by norms is wasteful. Libraries expose this as `FlatIP`/InnerProduct and treat cosine as "normalize-then-IP."

**Project (learning arc):**
1. L2-normalize your embeddings.
2. Write a **Triton (then CUDA) GEMM** producing the `query × corpus` similarity matrix → that *is* cosine on normalized data.
3. Add a **top-k selection** pass (the second half of every brute-force KNN).
4. **Benchmark** against `cuvs.neighbors.brute_force` and FAISS-GPU.

This `fused-matmul-for-similarity + selection-kernel-for-top-k` is the exact architecture the libraries use (see Li & Amenta, "Brute-Force k-NN on the GPU", with code at <https://github.com/geomlab-ucd/bf-knn>).

**Libraries to know (use in production; hand-write only to learn):**
- **NVIDIA cuVS** — current GPU vector-search library (**RAFT is its predecessor**). Algorithms: brute-force, IVF-Flat, IVF-PQ, CAGRA; metrics **L2 / InnerProduct / Cosine** (it defines cosine internally). <https://docs.rapids.ai/api/cuvs/>
- **FAISS-GPU + cuVS** — as of **FAISS v1.10.0 (2025)** FAISS ships a **cuVS backend** for Flat/IVF-Flat/IVF-PQ/CAGRA (opt in with `use_cuvs=true`) plus CPU↔GPU interop. HNSW path: build a **CAGRA graph on GPU**, serialize to a **CPU HNSW** index. <https://github.com/facebookresearch/faiss/wiki/GPU-Faiss-with-cuVS>
- **Reality check:** "faster than FAISS/cuVS" hand-written kernels only realistically happen on **small/compact datasets** (cf. the "Cuflat" experiment). Treat your kernel as a learning win, not a production replacement.

**Triton references:** ["Writing custom CUDA kernels with Triton"](https://www.kushajveersingh.com/blog/writing-custom-cuda-kernels-with-triton) · curated [triton-resources](https://github.com/rkinas/triton-resources) · a worked Triton kernel verified against PyTorch cosine ([TurboQuant](https://dejan.ai/blog/turboquant/)).

### 3b. Classic ML / NLP on GPU (RAPIDS) — *map your bootcamp material onto the GPU*

- **No native LDA / topic modeling in cuML.** cuML covers PCA, UMAP, t-SNE, K-Means, DBSCAN, HDBSCAN, Linear/Logistic Regression, Naive Bayes — but **not Latent Dirichlet Allocation**. ⚠️ Beware the acronym collision: cuML may have *Linear Discriminant Analysis* (a classifier), which is **not** *Latent Dirichlet Allocation*.
- **cuML DOES accelerate the NLP front-end:** `cuml.feature_extraction.text` has **CountVectorizer, TfidfVectorizer, HashingVectorizer** (Hashing ~20× faster than sklearn; TF-IDF ~3.3× faster, ~2× less memory — *figures from RAPIDS blogs, moderate confidence*).
- **The modern GPU "topic modeling" path is BERTopic**, not LDA: embeddings → UMAP → HDBSCAN, all GPU-accelerated in cuML. RAPIDS explicitly positions this as the LDA replacement.
- **Use the library** for vectorization, clustering, dim-reduction, ANN. **Hand-write only** (a) the learning-exercise cosine top-k kernel, or (b) classic LDA Gibbs/variational on GPU *if* you specifically need LDA — since cuML doesn't ship it. Great teaching contrast: "here's LDA the way I taught it on CPU; here's why the field moved to embeddings+HDBSCAN on GPU."

*Sources:* [cuML README](https://github.com/rapidsai/cuml); [cuML LDA feature request #4455](https://github.com/rapidsai/cuml/issues/4455) (status unverified); [Faster Topic Modeling with BERTopic + cuML](https://medium.com/rapids-ai/faster-topic-modeling-with-bertopic-and-rapids-cuml-5c7559aba898).

### 3c. Generative-3D performance track — *where CUDA literacy pays off for your real workflow*

**What fits in 16 GB (rules of thumb):**

| Workload | 16 GB verdict |
|---|---|
| SDXL image gen | Fits natively |
| Flux / large diffusion | Fits via fp8 / GGUF + offload |
| **Hunyuan3D mesh/shape** (~10 GB) | **Fits comfortably** (official "2–5 min on a 16 GB GPU") |
| **Hunyuan3D 2.1 texture/PBR** (~21 GB) / full pipeline (~29 GB) | **Needs offload** (`--low_vram_mode`, mmgp) or cloud |
| **TRELLIS** (original) | Right at the **16 GB official minimum** — workable, not roomy |
| **TRELLIS.2** (4B, official **24 GB**, Linux) | 16 GB only via low-VRAM @ 512³ per *third-party* guides — lower confidence |

**Optimization levers, by bang-for-buck:** fp16/bf16 default → **fp8** (~40% cut) → quantization (GGUF/NVFP4) → **model offloading** (`--lowvram`/sequential CPU offload/mmgp; needs ample system RAM, 24 GB+) → **tiled/sequential VAE decode** (kills the VAE OOM spike) → **attention backend** (flash-attn/xformers/**SageAttention**, ~30–35% faster sampling) → **lower 3D resolution** (512³ vs 1024³ is the biggest TRELLIS.2 driver). Combining attention-opt + tiled VAE + offload typically frees 4–8 GB.

**Where CUDA knowledge actually helps you (a learner running these locally):**
- **Environment/kernel-arch literacy** — matching sm_120 + CUDA 12.8 + PyTorch/Triton/SageAttention wheels. *This is the #1 local-setup skill.*
- **Offload/memory-placement tuning** — `--lowvram`/`--normalvram`/`--highvram`, mmgp profiles, sizing system RAM.
- **Quant/attention backend selection** and **tiling**.
- **Profiling** — `nvidia-smi`, PyTorch memory snapshots; learn to read *where* OOM peaks (usually VAE decode or the texture stage).

**Mostly upstream (not worth a learner's time to patch):** custom sparse-conv/fused-attention kernels (spconv/SageAttention/Triton maintainers own these); getting sm_120 into stable PyTorch; NVFP4/Blackwell quant kernels (depend on cu130 + upstream libs). **Bottom line: your wins are config + profiling, not kernel-writing — but the CUDA fundamentals are what let you reason about the config.**

**ComfyUI nodes:** Hunyuan3D 2.1 — [visualbruno/ComfyUI-Hunyuan3d-2-1](https://github.com/visualbruno/ComfyUI-Hunyuan3d-2-1) (+ native ComfyUI support, [docs](https://docs.comfy.org/tutorials/3d/hunyuan3D-2)); low-VRAM fork [Hunyuan3D-2GP](https://github.com/deepbeepmeep/Hunyuan3D-2GP). TRELLIS.2 — [visualbruno/ComfyUI-Trellis2](https://github.com/visualbruno/ComfyUI-Trellis2). Blackwell/ComfyUI setup: discussions [#6643](https://github.com/Comfy-Org/ComfyUI/discussions/6643), [#6980](https://github.com/Comfy-Org/ComfyUI/discussions/6980).

> *Naming caution:* "TRELLIS.2" is Microsoft's real 4B model ([HF card](https://huggingface.co/microsoft/TRELLIS.2-4B), ~Dec 2025). Sites like trellis2.app/.com are promotional SEO — prefer the `microsoft/` GitHub + HF.

---

## 4. Meta SAM 3D

**What it is** (announced **Nov 19 2025**, alongside SAM 3):
- **SAM 3D Objects** — generative model reconstructing a full **3D object (geometry + texture + layout) from a single 2D image**, robust to occlusion/clutter. <https://github.com/facebookresearch/sam-3d-objects>
- **SAM 3D Body** — single-image **full-body 3D human mesh** (body+feet+hands) via the new **MHR (Momentum Human Rig)** representation. <https://github.com/facebookresearch/sam-3d-body>
- **Lineage:** SAM/SAM 2 = 2D (image/video) segmentation; SAM 3 = open-vocab "segment with concepts" (text). SAM 3D **lifts segmentation into 3D** — SAM 3 provides masks that SAM 3D Objects consumes. (Don't confuse with unrelated third-party "SAM3D" repos.)

**Get it:** [Meta blog](https://ai.meta.com/blog/sam-3d/) · GitHub repos above (inference code, checkpoints, notebooks) · Hugging Face `facebook/` checkpoints · the no-code **Segment Anything Playground**. **License:** custom **"SAM License"** (research + commercial with restrictions — no weapons/military-surveillance, attribution required); MHR human model under a separate permissive commercial license. *Verify terms in-repo before commercial use — not OSI-standard.*

**Can it run on your 16 GB 5070 Ti? — Probably not for Objects without heavy modification.** ⚠️
- Secondary sources cite **~32 GB VRAM** for SAM 3D Objects (Linux, CUDA 12.1). GitHub issues show a **20 GB GPU OOM** ([#6](https://github.com/facebookresearch/sam-3d-objects/issues/6)) and an open "is 32 GB strict?" question ([#30](https://github.com/facebookresearch/sam-3d-objects/issues/30)) with **no official minimum and no confirmed sub-32 GB success**.
- **SAM 3D Body** (631M–840M backbones) is far lighter and **more plausible on 16 GB**, though no explicit VRAM figure was published.
- *Flags:* the 32 GB number is community/secondary, not an official spec; **Blackwell/sm_120 compatibility with the repo's CUDA 12.1 build is unverified** (you'd likely need a newer CUDA/PyTorch).

**Integration / output:**
- **ComfyUI wrappers** (community, PozzettiAndrea): [ComfyUI-SAM3DObjects](https://github.com/PozzettiAndrea/ComfyUI-SAM3DObjects), [ComfyUI-SAM3DBody](https://github.com/PozzettiAndrea/ComfyUI-SAM3DBody) (has a **Blender-based "Export FBX"** node for rigged meshes), [ComfyUI-SAM3](https://github.com/PozzettiAndrea/ComfyUI-SAM3).
- **Mesh output:** natively **Gaussian splats (.ply)**; **running locally** it can export **GLB meshes with baked textures** (.obj/.ply/.glb). The **Playground only gives splats** — splat→mesh needs local inference, and baked textures are a known weak spot (can look washed-out). GLB imports straight into Blender.

**Vs Hunyuan3D / TRELLIS for asset gen:** SAM 3D Objects is strongest at **faithful reconstruction of a real object/scene from a photo** (its differentiator; single-image only). For clean, art-directable or text-to-3D "hero" assets, **Hunyuan3D / TRELLIS are generally better**. They complement: SAM 3 (segment) → SAM 3D (real-scene reconstruction) vs Hunyuan/TRELLIS for synthesized/idealized assets.

*Sources:* [Meta SAM 3D blog](https://ai.meta.com/blog/sam-3d/); [Meta newsroom Nov 2025](https://about.fb.com/news/2025/11/new-sam-models-detect-objects-create-3d-reconstructions/); repos & issues above; [fal SAM 3D vs Hunyuan3D-2](https://fal.ai/learn/devs/sam-3d-vs-hunyuan3d-2).

---

## 5. Teaching angle (turn this into bootcamp material)

Your edge: you already teach the ML concepts that GPU parallelism naturally illustrates. Lean on analogies your students hold.

- **"Embeddings → cosine top-k" as the gateway demo.** Students already get cosine similarity from NLP. Show the *same* math three ways — NumPy loop (slow), vectorized NumPy/PyTorch on CPU, then a Triton kernel on GPU — and watch the wall-clock collapse. One concept, three altitudes; the GPU version *earns* its complexity. This doubles as your project 3a.
- **Parallelism analogy that lands:** a `for` loop = one cashier; a GPU = 10,000 cashiers who must all do the *same* operation (SIMT). Great for explaining why branching/divergence is expensive and why "embarrassingly parallel" ops (elementwise, dot products) are the sweet spot.
- **Memory hierarchy = "desk vs filing cabinet vs warehouse."** Registers (desk) → shared memory (filing cabinet) → global VRAM (warehouse). Coalescing = "everyone grabs from the same shelf at once." Tiling = "bring a box to your desk so you stop walking to the warehouse." These map 1:1 onto the PMPP chapters.
- **Normalization as a teachable "gotcha":** show a top-k where an un-normalized long vector wins despite a wide angle, then normalize and watch the ranking flip. Connects directly to the dot-product-vs-magnitude question and to real retrieval bugs (metric/model mismatch hurts recall).
- **Profiling as the scientific method:** hypothesis ("VAE decode is the OOM spike") → measure (`nvidia-smi`, memory snapshot) → intervene (tiled VAE) → re-measure. Students learn that performance is empirical, not folklore.
- **LDA → BERTopic as a "how the field moved" lecture:** teach LDA the classic way, then show why GPU embeddings + UMAP + HDBSCAN replaced it — a memorable arc that ties your NLP past to current GPU practice.
- **Capstone exercise:** "write a cosine-similarity kernel in Triton, verify it matches PyTorch to 6 decimals, then benchmark vs `cuvs.brute_force`." Self-checking, GPU-grounded, and directly useful.
- **Practice infrastructure for a cohort:** **Tensara/LeetGPU** give browser-based real-GPU problems with leaderboards — low-friction homework that doesn't require every student to fight a local Blackwell setup.

---

## 6. Suggested 8–12 week schedule

| Week | Focus | Milestone |
|---|---|---|
| **0** | Environment | Driver R570+, CUDA 12.8+, PyTorch ≥2.7 cu128; `get_arch_list()` shows `sm_120`; one kernel runs |
| **1** | First contact | NVIDIA "Even Easier Intro" + skim freeCodeCamp; write/launch a vector-add kernel |
| **2–3** | Fundamentals I | PMPP ch. 1–5 + GPU MODE 1–3; threads/blocks/grids, global vs shared memory; LeetGPU problems |
| **4–5** | Fundamentals II | Coalescing, occupancy, **shared-memory tiled matmul**; learn **Nsight** profiling; PMPP opt chapters |
| **6** | Concurrency | Streams + **CUDA graphs** (Best Practices Guide); overlap copy/compute |
| **7–8** | **Triton** | Tutorials 01→05; reimplement softmax/layer-norm, benchmark vs PyTorch |
| **8–9** | **Project 3a** | Cosine top-k: normalize → GEMM similarity → top-k; verify vs PyTorch; benchmark vs `cuvs.brute_force` |
| **9–10** | **Project 3b** | Port a bootcamp NLP pipeline to cuML (TF-IDF + HDBSCAN/BERTopic); contrast with CPU LDA |
| **10–12** | **Project 3c** + teach | Get Hunyuan3D mesh→texture working in ComfyUI on 16 GB via offload/fp8/tiling; profile the OOM; write up one teaching demo from §5 |

**Stretch / optional:** Triton fused-attention tutorial (06); attempt SAM 3D **Body** locally (lighter than Objects); evaluate SageAttention on Blackwell for your ComfyUI sampling.

---

## Appendix — confidence & volatility flags

- **High confidence:** CUDA 12.8 = first sm_120 toolkit; driver R570 floor + Linux open module; cosine = normalized dot product; FAISS v1.10 cuVS backend + index types; cuML has TF-IDF but **no native LDA**; SAM 3D released Nov 19 2025 with Objects + Body; Hunyuan3D 2.1 VRAM (~10 GB shape / ~21 GB texture); TRELLIS official 16 GB min, TRELLIS.2 official 24 GB.
- **Resolved conflict:** "stable PyTorch lacks sm_120" reports trace to the wrong wheel; stable ≥2.7 from the `cu128`+ index URL works.
- **Moderate / verify yourself:** exact cuML speedup figures; current cuVS release version; the ~32 GB SAM 3D Objects number (community/secondary, no official spec); TRELLIS.2-on-16 GB claims (promotional guides); HY3D 8 GB low-VRAM (single anecdote).
- **Unverified:** SAM 3D Objects on 16 GB (no confirmed success); SAM 3D Body exact VRAM; SAM 3D repo's CUDA 12.1 build vs Blackwell sm_120; live status of cuML LDA issue #4455.
- **Default wheel tag drifts** (cu128 → cu129 → cu130) and **driver branches advance** (R575/R580 in 2026). Re-check at <https://pytorch.org/get-started/locally/> when you install.

*Several primary pages (NVIDIA blog, pytorch.org, Meta blog, fal.ai) returned HTTP 403 to automated fetch; their content was corroborated via official social posts, download archives, GitHub, and multiple secondary sources rather than read verbatim.*
