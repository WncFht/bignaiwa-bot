"""训练入口（骨架）：蒸馏搜索专家 + 学价值头。
用法: python train.py data/rollouts.jsonl --epochs 20
产出: checkpoints/pvnet.pt —— 回导 JS 侧走 onnx 或手写 forward。
"""
import argparse
import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, random_split
from model import PolicyValueNet
from dataset import RolloutDataset, collate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--vcoef", type=float, default=1e-4, help="价值头损失系数（ret 量纲大）")
    args = ap.parse_args()

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    ds = RolloutDataset(args.data)
    n_tr = int(len(ds) * 0.95)
    tr, va = random_split(ds, [n_tr, len(ds) - n_tr])
    trl = DataLoader(tr, batch_size=args.bs, shuffle=True, collate_fn=collate, num_workers=4)
    val = DataLoader(va, batch_size=args.bs, collate_fn=collate)

    net = PolicyValueNet().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr)

    for ep in range(args.epochs):
        net.train()
        for balls, mask, glob, xb, ret in trl:
            balls, mask, glob, xb, ret = balls.to(dev), mask.to(dev), glob.to(dev), xb.to(dev), ret.to(dev)
            logits, v = net(balls, mask, glob)
            loss_pi = F.cross_entropy(logits, xb)
            loss_v = F.mse_loss(v, ret) * args.vcoef
            (loss_pi + loss_v).backward()
            opt.step(); opt.zero_grad()

        net.eval(); acc = 0; mse = 0; n = 0
        with torch.no_grad():
            for balls, mask, glob, xb, ret in val:
                balls, mask, glob, xb, ret = balls.to(dev), mask.to(dev), glob.to(dev), xb.to(dev), ret.to(dev)
                logits, v = net(balls, mask, glob)
                acc += (logits.argmax(-1) == xb).sum().item()
                mse += F.mse_loss(v, ret, reduction="sum").item()
                n += len(xb)
        print(f"ep{ep}: pi_acc={acc/n:.3f} v_rmse={(mse/n)**.5:.0f}")


if __name__ == "__main__":
    main()
