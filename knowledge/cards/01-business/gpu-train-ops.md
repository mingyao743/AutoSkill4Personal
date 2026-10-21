# gpu-train-ops · 业务认知

> 知识卡片（组装视图，源：/Users/chenmingyao/Documents/cmy-only/AutoSkill/knowledge/atoms.jsonl 可重建）。原子 2 个。生成于 2026-10-21。

## 规则切片（1）

### 规则切片 · atom_7ba81b83e4d5

vLLM --gpu-memory-utilization 建议取 0.85–0.90（默认 0.9），不要 ≥0.95：profiling 单序列估计覆盖不了大 batch/长上下文瞬时分配、CUDA context 每进程另占 0.5–1GB 且 NCCL/allreduce 缓冲不在预算内、长跑碎片化只增不减，无余量会运行中期随机 OOM 进 crash loop。

  - concept_name: vLLM --gpu-memory-utilization 显存预算取值规则
  - definition: vLLM 部署时 --gpu-memory-utilization 建议取 0.85–0.90（参数默认 0.9），不要设到 0.95 及以上。原因：① 启动 profiling 仅用单序列 dummy forward 估计激活峰值，运行时大 batch/长上下文的瞬时分配（logits、paged attention scratch、cuBLAS workspace）远超该估计，需预留额外 headroom；② CUDA context 每进程另占约 0.5–1GB，NCCL/custom allreduce 缓冲不计入该参数预算；③ 长时间运行后显存碎片化只增不减，无余量会导致运行中期随机 OOM 并陷入 crash loop。
  - boundary: 成立前提：vLLM 推理部署、该 GPU 卡专用于本实例。混部场景调整：与其他进程共享同一 GPU 时，utilization ≈ 剩余可用显存比例再减 0.08–0.1。
- 置信度 0.7｜状态 draft｜来源 01a15cad:0bbde7a9→98f677bd

## 边界切片（1）

### 边界切片 · atom_f8982d8548f7

vLLM APC 只在前缀共享率高且显存宽裕时有收益：实测 cache hit rate 约 20–30% 以上才开，否则关闭。低命中场景下 block hash/簿记开销落在调度关键路径、缓存块挤占 KV 容量加重 preemption 与长尾延迟、随机前缀零复用，且与 prompt_logprobs/beam search/部分多 LoRA 存在正确性冲突。

  - concept_name: vLLM Automatic Prefix Caching 适用边界
  - definition: vLLM automatic prefix caching（APC）并非默认有益：低 token 命中率场景下为纯负收益。启用判据：实测 cache hit rate 达约 20–30% 以上且显存宽裕才值得开启，否则关闭。
  - boundary: 有害/不适现场景：① 低共享率工作负载——每步对所有请求做 block hash 与缓存簿记，抬高 scheduler CPU 开销，高并发时位于调度关键路径；② 显存吃紧时缓存块挤占 KV cache 容量，导致更多 preemption、长尾延迟恶化；③ prompt 含时间戳、用户专属字段等随机片段，session 级零复用，只剩 churn 与逐出开销；④ 正确性限制——prompt_logprobs、beam search 及部分版本的多 LoRA 与 APC 不兼容或结果不正确。
- 置信度 0.7｜状态 draft｜来源 01a15cad:0bbde7a9→2458c7d7

