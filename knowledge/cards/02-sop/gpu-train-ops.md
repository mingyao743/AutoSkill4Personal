# gpu-train-ops · 操作SOP

> 知识卡片（组装视图，源：/Users/chenmingyao/Documents/cmy-only/AutoSkill/knowledge/atoms.jsonl 可重建）。原子 4 个，判重合并后 3 个。生成于 2026-10-21。

## vLLM 显存参数经验切片（1）

### vLLM 显存参数经验切片 · atom_ccf56c1d5837

vLLM --gpu-memory-utilization 设置：专用推理卡取 0.85–0.90（默认 0.9），不要设 0.95 以上。原因：① 初始化 profiling 只用单序列 dummy forward 估激活峰值，运行时大 batch/长上下文的瞬时分配（logits、paged attn scratch、cuBLAS workspace）超出估计，需额外 headroom；② CUDA context 每进程另占约 0.5–1GB，NCCL/custom allreduce 缓冲不计入该预算；③ 长跑后显存碎片化只增不减，无余量会导致运行中期随机 OOM → crash loop。与其他进程混部时，utilization ≈ 剩余显存比例再减 0.08–0.1。

  - step: 

- 置信度 0.8｜状态 draft｜来源 agent声明

## prefix caching 取舍判断切片（1）

### prefix caching 取舍判断切片 · atom_2d7a9da6db52

vLLM automatic prefix caching 在低命中率场景反而有害，不是默认该开。有害场景：① 低共享率负载下每步 block hash + 缓存簿记加重 scheduler CPU 开销，高并发时落在调度关键路径上；② 内存吃紧时缓存块挤占 KV 容量 → 更多 preemption、长尾延迟变差；③ prompt 内含时间戳/用户专属字段等随机片段，session 级零复用只剩 churn 和逐出开销；④ prompt_logprobs、beam search、部分版本多 LoRA 与 APC 不兼容或结果不对。启用判据：实测 token cache hit rate 能达约 20–30% 以上且显存宽裕才开，否则关闭。

  - step: 

- 置信度 0.8｜状态 draft｜来源 agent声明

## CUDA graph 启动失败排查切片（1）

### CUDA graph 启动失败排查切片 · atom_5ed82a2616e8

vLLM 启动时 CUDA graph capture 失败排查：先 --enforce-eager 确认是 capture 问题 → 降 gpu-memory-utilization 释放 headroom → 换 VLLM_ATTENTION_BACKEND/升级 kernel → dmesg 查 Xid。五类常见原因：① capture 阶段显存 headroom 不足（utilization 过高或其他进程中途占显存），最常见；② 捕获期间 kernel 做 cudaMalloc/host 同步/.item() 等不兼容操作；③ 更早的异步错误毒化 stream；④ TP 下 custom allreduce 回退或 P2P 禁用；⑤ 驱动过旧。

  - step: 

- 置信度 0.8｜状态 draft｜来源 01a15cad:0bbde7a9→37315091

