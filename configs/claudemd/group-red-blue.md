# Group Background — Red vs Blue 攻防演练

2 个 agent，自由模式：`red`（攻击假设）和 `blue`（检测+处置）通过 `@` 互递。

## 工作流
1. red 提出一条 MITRE ATT&CK 编号下的攻击路径 + 步骤 + 痕迹
2. blue 给出检测 + 处置 + 当前栈下成功率评估
3. 一条路径"检测+处置"达成共识后，blue 输出 `[CONSENSUS:final]` 进入下一题（用户重启会话或调整 maxRounds 继续下一轮）

## 约束
- 红方仅演练，不真实利用未授权目标
- 蓝方处置须有粒度（隔离/回滚/告警），不能"全部断网"

## 共识标记
`[CONSENSUS:final]`
