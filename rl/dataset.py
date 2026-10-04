"""数据侧：读 export_data.js 产出的 JSONL，产出 PolicyValueNet 可用的张量批。"""
import json
import numpy as np
import torch
from torch.utils.data import Dataset
from model import encode_obs, BALL_DIM, X_BINS, R_ARR


class RolloutDataset(Dataset):
    """每行一条决策记录。X 分箱按 pending 水果的可投放区间换算成 bin 索引。"""

    def __init__(self, path, max_balls=64):
        self.recs = []
        with open(path) as f:
            for line in f:
                r = json.loads(line)
                if r["o"]["b"]:
                    self.recs.append(r)
        self.max_balls = max_balls

    def __len__(self):
        return len(self.recs)

    def __getitem__(self, i):
        r = self.recs[i]
        b, g = encode_obs(r["o"])
        n = min(len(b), self.max_balls)
        # 大球优先排序后截断：丢掉信息最少的（先丢小/边缘球）
        if len(b) > n:
            order = np.argsort(-b[:, 4])[:n]          # 按 tier 降序
            b = b[np.sort(order)]
        balls = np.zeros((self.max_balls, BALL_DIM), dtype=np.float32)
        mask = np.zeros(self.max_balls, dtype=bool)
        balls[:n] = b[:n]
        mask[:n] = True
        tier = r["o"]["p"]
        rad = R_ARR[tier]
        lo, hi = 10 + rad + 0.5, 420 - 10 - rad - 0.5
        x_bin = int(round((r["x"] - lo) / max(hi - lo, 1e-6) * (X_BINS - 1)))
        return (torch.from_numpy(balls), torch.from_numpy(mask), torch.from_numpy(g),
                torch.tensor(x_bin), torch.tensor(r["ret"], dtype=torch.float32))


def collate(batch):
    balls = torch.stack([b[0] for b in batch])
    mask = torch.stack([b[1] for b in batch])
    glob = torch.stack([b[2] for b in batch])
    xb = torch.stack([b[3] for b in batch])
    ret = torch.stack([b[4] for b in batch])
    return balls, mask, glob, xb, ret
