"""模型定义：变长球集合 → SetEncoder → 策略头(x 分箱) / 价值头(V(s))。

观测契约（export_data.js 产出，每决策一条）:
  b: [[x, y, vx, vy, tier, angle, overTime], ...]   变长球列表
  p: pending, n: next, s: score, rv: revives
  x: 决策动作（投放横坐标），ret: 该决策后剩余得分

训练目标（双头）:
  policy: cross_entropy(π(x_bin|s), expert_x_bin)   —— 蒸馏搜索专家
  value:  mse(V(s), ret)                            —— 学 afterstate 价值
"""
import torch
import torch.nn as nn

BOARD_W, BOARD_H = 420.0, 700.0
N_TIERS = 11
BALL_DIM = 7          # x,y,vx,vy,tier,angle,overTime
GLOBAL_DIM = 4        # pending,next,score,revives
X_BINS = 40           # 动作离散数
R_ARR = [17, 23, 31, 39, 48, 58, 69, 81, 94, 108, 124]


def encode_obs(o):
    """原始 obs dict -> (ball_feats[N,7], global_feats[4])，已归一化。"""
    import numpy as np
    b = np.asarray(o["b"], dtype=np.float32).reshape(-1, BALL_DIM)
    if len(b):
        b[:, 0] /= BOARD_W
        b[:, 1] /= BOARD_H
        b[:, 2] /= 1000.0
        b[:, 3] /= 1000.0
        b[:, 4] /= (N_TIERS - 1)
        b[:, 5] /= 6.2832
        b[:, 6] /= 1.5
    else:
        b = np.zeros((0, BALL_DIM), dtype=np.float32)
    g = np.asarray([o["p"] / (N_TIERS - 1), o["n"] / (N_TIERS - 1),
                    o["s"] / 50000.0, o["rv"] / 10.0], dtype=np.float32)
    return b, g


class SetEncoder(nn.Module):
    """DeepSet: per-ball MLP → masked mean+max pool → 全局拼接。"""

    def __init__(self, d=128):
        super().__init__()
        self.ball_mlp = nn.Sequential(
            nn.Linear(BALL_DIM + N_TIERS, d), nn.ReLU(),
            nn.Linear(d, d), nn.ReLU())
        self.global_mlp = nn.Sequential(nn.Linear(GLOBAL_DIM, 64), nn.ReLU())
        self.n_tiers = N_TIERS

    def forward(self, balls, mask, glob):
        """balls: [B,N,7]  mask: [B,N] bool  glob: [B,4]"""
        tier = balls[..., 4:5] * (self.n_tiers - 1)
        onehot = torch.zeros(*balls.shape[:2], self.n_tiers, device=balls.device)
        onehot.scatter_(-1, tier.round().long().clamp(0, self.n_tiers - 1), 1.0)
        h = self.ball_mlp(torch.cat([balls, onehot], -1))        # [B,N,d]
        m = mask.unsqueeze(-1).float()
        h_mean = (h * m).sum(1) / m.sum(1).clamp(min=1)
        h_max = h.masked_fill(~mask.unsqueeze(-1), -1e9).max(1).values
        h_max = torch.where(mask.any(1, keepdim=True), h_max, torch.zeros_like(h_max))
        g = self.global_mlp(glob)
        return torch.cat([h_mean, h_max, g], -1)                 # [B,2d+64]


class PolicyValueNet(nn.Module):
    def __init__(self, d=128, x_bins=X_BINS):
        super().__init__()
        self.enc = SetEncoder(d)
        self.pi = nn.Linear(2 * d + 64, x_bins)
        self.v = nn.Linear(2 * d + 64, 1)

    def forward(self, balls, mask, glob):
        h = self.enc(balls, mask, glob)
        return self.pi(h), self.v(h).squeeze(-1)
