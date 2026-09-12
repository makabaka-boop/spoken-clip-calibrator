# 口述史片段切取校准器

纯前端工具：整理员边听**本地录音**边按键记录可引用片段，解决“拖动进度条 / 显示精度差异导致试听范围与导出时间码不一致”的问题。

- 技术栈：TypeScript + React 18 + Vite + `HTMLMediaElement`（`<audio>`）
- 只读取用户在本机选择的音频（`URL.createObjectURL`），**不上传文件、不访问任何在线服务**
- e2e 测试中对任何非同源、非 `blob:` 的网络请求直接失败，守住纯前端红线

## 时间码规则（校准的核心）

1. 打点：捕获时读取 `audio.currentTime`（秒），执行 `Math.round(currentTime * 1000)` 得到**整数毫秒**。
2. 音频时长用同一函数取整，因此加入片段时比较的是**同样的毫秒值**：`0 ≤ 起点 < 终点 ≤ 时长`。
3. 界面同时展示 `HH:MM:SS.mmm` 与整数毫秒；展示串只给人看，计算与导出只用整数毫秒，**绝不吸附整秒**。
4. 试听定位与复位使用 `currentTime = startMs / 1000`（记录的精确毫秒起点）。

## 使用

1. 选择本地音频文件。不可解码 / 无有效时长的文件会就地报错，清单不变。
2. 播放（可拖动进度条），分别点击「捕获起点」「捕获终点」，填写**非空标签**后「加入片段」。
   - 空标签、相等边界（起点 = 终点）、反向边界（起点 > 终点）、超出时长：就地报错，**不改变清单**。
3. 片段清单支持：单选、删除、循环试听、停止试听。
   - 试听从记录起点开始；以 `requestAnimationFrame` 逐帧观测，**首次**看到 `round(currentTime*1000) ≥ 终点` 立即暂停并把游标复位到精确起点，稍作停留后自动从头循环。
   - 「停止试听」暂停并停在精确起点——验收者可直接看到游标复位。
4. 「导出 JSON」下载 `<音频主名>.clips.json`，片段按 **起点 → 终点 → 创建序号** 升序排列。
5. 下次继续时：重新载入同一段原音频，在「恢复上次工作」中选择此前导出的 `.clips.json`。
   - 导入复用同一份毫秒边界规则逐条校验：音频文件名、取整后时长、标签、起止值、创建序号
     （非负整数、不重复，且小于 `Number.MAX_SAFE_INTEGER`——再大一步后续序号就无法可靠续接，
     这样的会话整体拒绝导入）。
   - 读取一开始即暂停播放并记下位置：**全部记录通过**才一次性替换当前清单并选中首条，
     被替换片段的试听随之停止；后续新片段的创建序号接在已有最大值之后。
   - 文件无法解析、音频不匹配、序号重复或任一记录越界：就地指出原因，**导入前的清单、
     选择不变，播放位置恢复为导入前**，不产生部分恢复。
   - 读取与校验期间界面显示处理中，导入输入暂时禁用，避免重复触发。

导出示例：

```json
{
  "audioFileName": "sample.wav",
  "durationMs": 3250,
  "clips": [
    {
      "index": 0,
      "startMs": 200,
      "endMs": 500,
      "durationMs": 300,
      "label": "同起点更早结束",
      "createdAt": 2
    }
  ]
}
```

验收者可对每条记录复算：`durationMs === endMs - startMs`、`0 ≤ startMs < endMs ≤ durationMs`、标签非空。

## 本地开发

```bash
npm ci
npm run dev          # 开发服务器
npm run build        # tsc --noEmit + vite 构建
npm run preview      # 托管 dist（容器内同此命令）
npm run test         # Vitest：取整与边界、导入载荷校验与序号续接（src/**/*.test.ts）
npm run make:audio   # 重新生成 test-assets/sample.wav（3.25s / 8kHz / 单声道 PCM16）
npm run test:e2e     # Playwright：打点、循环试听复位、错误、导出、导入恢复
npm run verify       # Vitest + build + Playwright 一条龙
```

Playwright e2e 使用仓库内 `test-assets/sample.wav`（已生成）与
`test-assets/not-audio.txt`（不可解码夹具），自动启动 `vite preview`，无需联网。

## Docker Compose

```bash
# 启动页面（默认宿主 8080；容器内固定 8080）
docker compose up --build
# 覆盖宿主端口
WEB_PORT=9090 docker compose up --build

# 一次性验收服务（跑完即退出）
docker compose --profile verify run --rm verify
```

`verify` 服务在同一镜像内执行 `npm run verify`：Vitest 校验取整与边界 → 生产构建 →
Playwright 用仓库内短音频走通打点、循环试听（游标回到精确起点）和导出复算。
