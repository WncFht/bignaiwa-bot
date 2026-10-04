# 算法详解：bot 每一步是怎么想的

本文档讲解决策算法的完整机制：单个决策点内部发生什么、搜索的三种深度模式、复活币处理、权重从何而来。系统架构与游戏机制建模见 [design.md](design.md)，全部实验依据见 [experiments.md](experiments.md)。

## 1. 决策点循环

一局游戏 = 一串决策点。每个决策点（盘面沉降完毕、待投水果就绪）执行四步：

```
snapshot ──► for each 候选落点 x ∈ X:
                  restore(snap); dropNow(x); settle()
                  v(x) = w · f(afterstate)
           ──► x* = argmax v(x) ──► 在真实环境投放 x*
```

**为什么可以这样模拟**：游戏物理引擎确定且无随机（随机源只有水果生成序列），全部状态集中在一个普通对象里——`snapshot → 模拟 → restore` 是零误差的免费世界模型（design.md §3）。决策时游戏时钟被 rAF 阻塞天然冻结，推演不占对局时间。

### 1.1 候选生成（~20 个落点）

- **均匀网格**：16 点，覆盖当前待投水果的有效投放区间 `[10+r_eff, 410-r_eff]`；
- **同级对齐**：与 pending 同级的场上球，球心 ±0.55r 偏移（瞄准贴脸合成）；
- 按 4px 去重 → 通常 18-22 个候选。

E10 消融显示对齐候选贡献≈0（均匀网格已覆盖），但无害保留。

### 1.2 逐候选物理模拟

每个候选在快照副本上执行完整 `dropNow + settle`：

- **沉降判据**：全场最大速度 < 55 px/s 持续 9 帧；
- **帧数上限**：110 帧兜底——E14 实测 8.5% 的盘面进入"微抽搐"态（塔在阈值上下振荡永不满足平静判据），延长等待无用，截断的残余速度是全部候选共享的噪声，不影响 argmax；
- 模拟中发生的合成、得分、越线全部真实结算到副本上——评估函数看到的 afterstate 就是"这步真投了会怎样"的精确答案。

### 1.3 评估打分（17 维线性）

沉降后盘面提取 17 维特征 `f`，与权重向量点积 `v = Σ wᵢfᵢ`，取 argmax。特征分四组（eval.js）：

| 组 | 特征 | 语义 |
|---|---|---|
| 收益 | score | 本步模拟的合成得分增量 |
| 安全 | topSafe, overTime, aboveArea, nAboveSoft | 距死线的裕度、判负计时、线上面积/球数 |
| 合成潜力 | sameAdj, maxPair, mergeDist, nMax | 同级贴脸对数、最大可并对、最近可对距离、神奶蛙数 |
| 条件/结构 | pendTgt, pendAdj, nextTgt, orderX, smallUnder, massTotal, bump, cave, freeTop | 与 pending/next 的承接关系、列序单调性、小球垫底、堆质量、剖面起伏/凹陷/可用着陆带 |

**承重结构**（E10 消融）：score 项必要（去掉→崩盘到 1.7k）；安全三件套扛大梁（6273 vs 全量 6381）；v2 结构特征独立承重 ~87%。

### 1.4 投放与局级循环

真实环境执行 argmax 落点 → 等待沉降 → 下一决策点。判负时若持币（`S.revives > 0`）自动复活：清除最顶球 + 所有顶缘在警戒线上 6px 以上的球、`overTime` 清零，继续打，直至币尽。

## 2. 三种深度模式

| 模式 | 机制 | 决策耗时 | 用途 |
|---|---|---|---|
| `depth:1` | 只评本投 afterstate | ~1.7s | 调参、探针、数据导出 |
| `depth:2` | 首轮 top-4 候选利用已知 next 各展开一步 | ~10-20s | **页面部署常开** |
| `dyn` | 危险态（顶距<172px 或 overTime>0.3）才开 depth2 | ≈depth1 | **离线跑批默认** |

机制差异：depth1 只看"这步投完盘面好不好"；depth2 额外检验"这步会不会给下一步留死局"——E10 证明这是唯一显著增益项（中位 6381→6476，左尾 4327→6184），它消灭的是灾难性早夭而非提高上限。E12 证明 dyn 门控能用 depth1 的成本拿到 depth2 ~75% 的增益。

**离线调参与线上部署的分离**：调参在 depth1 空间找权重、部署在 depth2 用。依据：depth2 增益来自前瞻结构而非权重配比，两者基本解耦（E10/E12）。

## 3. 复活币经济学（算法视角）

- 每 2000 分得 1 币，爆炸（双神奶蛙合成）再 +1；判负耗 1 币清顶续命。
- **正循环**：活过 ~7k 后币进大于币出 → 分数随局长线性累积。E1 的 12 局双峰分布（<5k 早夭 vs >14k 循环）由此而来。
- **策略含义**：当前是"判负即用"的贪心策略；E17 探针证实 `rv≥3`（存币净+2）是"已入循环"的可靠标记，比终分早 ~100 投可判。
- **猝死**：~40% 的早夭在 d425 时仍表现健康（rv2、顶安全），随后 60-100 投内级联暴毙——任何早停/预警规则对这类死亡不可见（E17）。

## 4. 权重从哪来：CEM 黑盒调优

评估权重的唯一信号是完整对局终分——不可微、高方差、双峰。方法论裁决（E4b/E9b）：**回归拟合路线证伪**（拟合权重实战崩盘至 1-2k），黑盒分数优化是唯一可行来源，与 Tetris 判例一致[^szita06][^thiery09]。

CEM 调参循环（tune_cem.js，对应 docs/figs/tuning_pipeline 图）：

```
每代: incumbent 保底 + 对数正态扰动造 pop=10 候选
     → 10 候选 × 8 混合种子 = 80 局摊 12 worker（~110min/代）
     → 各候选 8 局中位数 → top-25% 精英逐维几何均值 → 新 μ
     → σ×0.92（0.6→0.24，6 代收敛）；runningBest 全程保底回灌
```

- **混合难度种子集**{3000,3033,4000,4033,6000,6033,8000,8039}：E15 教训——单一种子集调出的是"该难度专家"（难集权重在易集上反而掉分），混合集逼候选全难度存活。
- **对数正态扰动** `wᵢ = μᵢ·e^(σN)`：保持各维符号、按量级等比缩放，配合精英几何均值保持符号一致性。
- **裁决纪律**：产物必须在 held-out 种子集（3000s/6000s）复测——调优集中位数是 argmax 选择偏差，E15 实证 +44% 增益可在 OOS 上整体蒸发。

## 5. 页面部署的同步阻塞问题

`inject.js` 在页面内运行同一套代码（dist/bot.js = core+eval+search+inject 拼接）。关键技术点：

- `decide()` 是**同步**的：推演期间 rAF 冻结 → 看起来"页面卡死"（depth2 单决策 10-20s）。解法：决策前画"思考中"徽章 → 让出一帧渲染 → 再进 decide。这不是 bug，是特性——时钟冻结意味着推演不占对局时间。
- `simGuard`：模拟副作用屏蔽——推演中触发的 gameOver/settle 会调 `DanaiwaBoard.onGameOver`（假提交）与写 localStorage 最高分，进 decide 前换成空实现 + `S.best=1e15`，出来恢复。
- `SUBMIT` 开关：是否把真实结算提交排行榜。
- Playwright 侧（live.mjs）只做窗口管理、录屏、`__HECHENG_LOG` 逐投日志回收——**决策完全在页面内**，无 RPC、无远程模型。

## 6. 已验证的边界（开源者应知）

- **线性评估接近饱和**（E15）：cem 与 hand 两套权重各擅半场，继续同空间微调收益枯竭；下一步增益在结构（更深前瞻、分段门控）或换函数类。
- **MC 随机 rollout 估值不可用**（E10'）：本作高分靠长局长累积，30 投短 rollout 增量是噪声，与 ret 机械负相关。
- **端到端 RL 判死刑**：公开文献与独立复现的 DQN 尝试均退化堆角落[^poelsma][^suika-rl]；学习组件的正确位置在搜索内部（蒸馏候选剪枝、价值替代线性评估——`rl/` 预留未启用）。

### 参考文献

[^szita06]: Szita, I., Lörincz, A. Learning Tetris Using the Noisy Cross-Entropy Method. Neural Computation 18(12):2936–2941, 2006. [doi.org](https://doi.org/10.1162/neco.2006.18.12.2936)
[^thiery09]: Thiery, C., Scherrer, B. Building Controllers for Tetris. ICGA Journal 32(1):3–11, 2009. [doi.org](https://doi.org/10.3233/ICG-2009-32102)
[^poelsma]: Poelsma, J. Creating an AI that Plays Suika Game. Master’s thesis, LIACS, Leiden University, 2025. [theses.liacs.nl](https://theses.liacs.nl/3516)
[^suika-rl]: Jacobs, M. SuikaReinforcement: Reinforcement Learning model (DQN) for Suika Game. GitHub. [github.com/MattJacobs30/SuikaReinforcement](https://github.com/MattJacobs30/SuikaReinforcement)
