"""perf_vs_human: 真人提交分布 vs bot 成绩（离线截断 + 真机上榜）。

数据：TinyWebDB 实拉 262 条真人提交（2026-10-04，已剔除 99999999 刷屏）；
bot 真机 = E18 三局 {25548,6468,7023}；bot 离线 = E17 hand_d2 ×3 种子
{6194,6460,6603}（600 投截断）。语义：灰点=真人单局 / 青点=离线截断 /
金星=真机提交；红线=真人最高 6862。

运行：uv run --with matplotlib --with numpy python perf_vs_human.py
依赖 figure-viz skill 的 fvstyle/fvlocate（按 ~/.claude 安装位定位）。
数据文件 leaderboard_snapshot.json 与本脚本同目录。
"""
import os, sys, json, random

_SKILL = os.path.expanduser('~/.claude/skills/figure-viz')
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_SKILL, 'assets/mpl'))
sys.path.insert(0, os.path.join(_SKILL, 'scripts'))
import fvlocate; fvlocate.ensure()
import fvstyle as fv
import matplotlib.pyplot as plt

fv.apply_rc("paper")
snap = json.load(open(os.path.join(_HERE, 'leaderboard_snapshot.json')))
human = [s for _, s in snap['human']]
live = [25548, 6468, 7023]
offline = [6194, 6460, 6603]   # E17 hand_d2, 600 投截断

rng = random.Random(7)
jit = lambda n, a=0.16: [a * (rng.random() * 2 - 1) for _ in range(n)]

fig, ax = plt.subplots(figsize=(8.6, 3.0))
rows = {'真人提交': 1.0, 'bot·离线截断': 2.0, 'bot·真机上榜': 3.0}
ax.scatter(human, [rows['真人提交'] + j for j in jit(len(human))],
           s=9, color=fv.HUES['vgray'], alpha=.45, linewidths=0, zorder=2)
ax.scatter(offline, [rows['bot·离线截断'] + j for j in jit(len(offline))],
           s=42, color=fv.HUES['vteal'], edgecolor='white', linewidths=.6, zorder=4)
ax.scatter(live, [rows['bot·真机上榜'] + j for j in jit(len(live))],
           s=150, color=fv.HUES['vgold'], marker='*', edgecolor=fv.NEUTRALS['vink'],
           linewidths=.5, zorder=5)
ax.axvline(6862, color=fv.HUES['vcoral'], ls=(0, (4, 3)), lw=1.1, zorder=3)
ax.annotate('真人最高 6862', (6862, 3.34), ha='right', va='bottom',
            fontsize=9.5, color=fv.HUES['vcoral'])
ax.annotate('25548', (25548, 3.16), ha='center', va='bottom',
            fontsize=10, fontweight='bold', color=fv.NEUTRALS['vink'])
ax.annotate('n=262', (300, 1.42), fontsize=9, color=fv.HUES['vgray'])
ax.set_yticks(list(rows.values()), list(rows.keys()), fontsize=9.5)
ax.set_xlim(0, 27500); ax.set_ylim(0.55, 3.55)
ax.set_xlabel('单局得分', fontsize=9.5)
for s in ('top', 'right', 'left'): ax.spines[s].set_visible(False)
ax.tick_params(axis='y', length=0); ax.tick_params(axis='x', labelsize=9)
ax.text(0.995, 0.03,
        '合成大奶娃 · bot 与真人榜得分分布（TinyWebDB 实拉，剔除刷屏）· 2026-10-04',
        transform=ax.transAxes, ha='right', va='bottom',
        fontsize=9, color=fv.HUES['vgray'])
fig.tight_layout()
fig.canvas.draw()
problems = fv.audit(fig)
for p in problems: print('audit:', p)
fig.savefig(os.path.join(_HERE, 'perf_vs_human.png'), dpi=200, bbox_inches='tight')
fig.savefig(os.path.join(_HERE, 'perf_vs_human.svg'), bbox_inches='tight')
print('saved')
