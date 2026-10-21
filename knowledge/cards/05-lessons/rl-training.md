# rl-training · 问题与复盘

> 知识卡片（组装视图，源：/Users/chenmingyao/Documents/cmy-only/AutoSkill/knowledge/atoms.jsonl 可重建）。原子 1 个。生成于 2026-10-21。

## 根因切片（1）

### 根因切片 · atom_69a16af80313

PPO 训练中 KL 散度在前几十步飙升至 15+ 后崩溃（NaN），最易被忽视的根因：ratio 的"锚点"错位——缓存的 old_log_prob 与真实行为策略不一致。典型形态：①old_log_prob 来自错误的模型（如参考模型）或错误的 token 对齐/tokenizer，而非采样时的那次 forward；②old_log_prob 未 detach/copy，或在 minibatch 循环中被覆盖；③应冻结的参考模型未切 .eval()（dropout/BN 仍生效），甚至其参数被误加入 optimizer.param_groups。该 bug 的日志表象与"学习率过大"完全一致，导致调试者反复调 lr/clip/reward scale 而无效——因为问题不在更新幅度而在更新参照系。5 分钟自检：①首次 update 前打印 mean(exp(new_logp - old_logp))，必须严格等于 1.0；②确认 old_log_prob 在 no_grad 下产生并已脱离计算图；③检查 optimizer 参数组不含冻结模型、冻结模型 .training 为 False；④对 k3 KL 估计同时打印 |ratio-1| 分位数，第一步出现极端值即坐实。兜底排查顺序：锚点检查干净后，再看 advantage 归一化 std≈0 未加 eps、reward 未缩放、lr 过大等常规原因。

- 置信度 0.8｜状态 draft｜来源 agent声明

