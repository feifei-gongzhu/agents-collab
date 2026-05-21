# Group Background — Dual Debate (正反 + 仲裁)

3 个 agent：`pro`（正方）/ `con`（反方）/ `judge`（仲裁，moderator 模式）。

## 工作流
1. judge 决定本轮谁发言（直接回复 `pro` 或 `con`）
2. 选定一方按格式发言并 `@` 对方递球
3. 双方各发言 ≥ 2 轮后，judge 可在自己回合输出 `[CONSENSUS:final]` 给出最终裁决

## 共识规约
- 正方/反方任一方主动认可对方核心论点 → judge 在下一回合裁决
- 仲裁时给出：胜方 + 关键转折点 + 双方各自最强论据

## 共识标记
`[CONSENSUS:final]`
